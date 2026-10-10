const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SANDBOX_STARTUP_TIMEOUT_MS = 120_000;
const SANDBOX_POLL_INTERVAL_MS = 100;
const SANDBOX_KILL_GRACE_MS = 10_000;
const SANDBOX_EXECUTABLE = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
const HOST_PROBE_ENVIRONMENT_MARKER = 'AI_HELP_AGENT_SANDBOX_HOST_MARKER';
let sandboxLeaseActive = false;

const guestBootstrap = String.raw`$ErrorActionPreference = 'Stop'
$control = 'C:\ai-help-agent-control'
$results = 'C:\ai-help-agent-results'
$progressPath = Join-Path $results 'progress.log'
Set-Content -LiteralPath $progressPath -Value 'bootstrap-start' -Encoding UTF8
$config = Get-Content -LiteralPath (Join-Path $control 'command.json') -Raw | ConvertFrom-Json
$user = 'Aha-' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
$password = 'A7!' + [Guid]::NewGuid().ToString('N') + 'x'
$created = $false
try {
  $provisionOutput = & "$env:WINDIR\System32\net.exe" user $user $password /add 2>&1
  $provisionExitCode = $LASTEXITCODE
  if ($provisionExitCode -ne 0) { throw "Unable to create the restricted guest account (net user exited with $provisionExitCode): $($provisionOutput | Out-String)" }
  Add-Content -LiteralPath $progressPath -Value 'guest-account-created'
  $created = $true
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$user", $securePassword)
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $control 'invoke.ps1'))
  $process = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -ArgumentList $arguments -PassThru -WindowStyle Hidden
  Add-Content -LiteralPath $progressPath -Value 'guest-child-started'
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(30000, [int]$config.timeoutMs + 30000))
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if (Test-Path -LiteralPath (Join-Path $results 'cancel.request')) {
      & "$env:WINDIR\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
      break
    }
    Start-Sleep -Milliseconds 100
  }
  $process.Refresh()
  if (-not $process.HasExited) {
    & "$env:WINDIR\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
  }
  $resultPath = Join-Path $results 'result.json'
  $resultDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $resultDeadline) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $resultPath)) {
    throw 'The restricted guest process did not produce a result.'
  }
}
catch {
  $failure = [ordered]@{ exitCode = $null; stdout = ''; stderr = $_.Exception.Message; timedOut = $false; cancelled = $false }
  $failure | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $results 'result.json') -Encoding UTF8
}
finally {
  if ($created) {
    & "$env:WINDIR\System32\net.exe" user $user /delete | Out-Null
  }
  & "$env:WINDIR\System32\shutdown.exe" /s /t 0 /f | Out-Null
}`;

const guestInvoke = String.raw`$ErrorActionPreference = 'Stop'
$control = 'C:\ai-help-agent-control'
$results = 'C:\ai-help-agent-results'
$config = Get-Content -LiteralPath (Join-Path $control 'command.json') -Raw | ConvertFrom-Json
$outputPath = Join-Path $results 'stdout.txt'
$errorPath = Join-Path $results 'stderr.txt'
$resultPath = Join-Path $results 'result.json'
$startedAt = [DateTime]::UtcNow
$exitCode = $null
$timedOut = $false
$cancelled = $false
try {
  $projectRoot = 'C:\ai-help-agent-project'
  $workspace = Join-Path $env:USERPROFILE 'workspace'
  Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'guest-child-entered'
  New-Item -ItemType Directory -Path $workspace -Force | Out-Null
  $projectItems = Get-ChildItem -LiteralPath $projectRoot -Force
  if ($config.mode -eq 'probe') {
    $projectItems = $projectItems | Where-Object { $_.Name -ne '.sandbox-host-escape' }
  }
  $projectItems | Copy-Item -Destination $workspace -Recurse -Force
  Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'project-copied'
  $workingDirectory = [IO.Path]::GetFullPath((Join-Path $workspace ([string]$config.workingDirectory)))
  $workspacePrefix = [IO.Path]::GetFullPath($workspace) + [IO.Path]::DirectorySeparatorChar
  if (-not $workingDirectory.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase) -and $workingDirectory -ne [IO.Path]::GetFullPath($workspace)) {
    throw 'The command working directory is outside the isolated project workspace.'
  }
  if (-not (Test-Path -LiteralPath $workingDirectory -PathType Container)) {
    throw 'The requested project working directory does not exist in the isolated workspace.'
  }

  $env:PATH = "C:\ai-help-agent-control\tools;$env:WINDIR\System32;$env:WINDIR;$env:WINDIR\System32\Wbem;$env:WINDIR\System32\WindowsPowerShell\v1.0"
  $env:CI = '1'
  $env:HOME = $env:USERPROFILE
  $env:TEMP = $env:USERPROFILE
  $env:TMP = $env:USERPROFILE
  if ($config.command.environment.CI) { $env:CI = [string]$config.command.environment.CI }

  if ($config.mode -eq 'probe') {
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-started'
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-identity'
    $groups = & "$env:WINDIR\System32\whoami.exe" /groups 2>&1 | Out-String
    $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $mediumIntegrity = $groups.Contains('S-1-16-8192')
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-groups'
    $inputWriteBlocked = $false
    try {
      [IO.File]::WriteAllText('C:\ai-help-agent-project\__sandbox_write_probe', 'probe')
    } catch { $inputWriteBlocked = $true }
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-readonly'
    $resultMountWritable = $false
    try {
      [IO.File]::WriteAllText((Join-Path $results 'guest-write-probe.txt'), 'probe')
      $resultMountWritable = $true
    } catch {}
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-result-mount'
    $hostPathUnavailable = -not (Test-Path -LiteralPath ([string]$config.hostProbePath))
    $junctionTargetUnavailable = -not (Test-Path -LiteralPath 'C:\ai-help-agent-project\.sandbox-host-escape\marker.txt')
    $hostEnvironmentUnavailable = -not (Test-Path Env:\AI_HELP_AGENT_SANDBOX_HOST_MARKER)
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-host-paths'
    $ipv4Routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue).Count
    $ipv6Routes = @(Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue).Count
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-routes'
    $outboundBlocked = $true
    $tcp = $null
    try {
      $tcp = New-Object Net.Sockets.TcpClient
      $attempt = $tcp.BeginConnect('1.1.1.1', 443, $null, $null)
      if ($attempt.AsyncWaitHandle.WaitOne(1200)) {
        try { $tcp.EndConnect($attempt); $outboundBlocked = $false } catch {}
      }
    } catch {} finally { if ($tcp) { $tcp.Dispose() } }
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-outbound'
    $workspaceProbe = Join-Path $workspace 'child-process-probe.txt'
    [IO.File]::WriteAllText($workspaceProbe, 'child')
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-workspace'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = "$env:WINDIR\System32\cmd.exe"
    $process.StartInfo.Arguments = '/d /c exit 0'
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.UseShellExecute = $false
    $childCreated = $process.Start()
    $childProcessCompleted = $false
    if ($childCreated) {
      $process.WaitForExit(5000) | Out-Null
      $childProcessCompleted = $process.HasExited
    }
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-child-process'
    $result = [ordered]@{
      mode = 'probe'
      identity = $identity.Name
      administrator = $admin
      mediumIntegrity = $mediumIntegrity
      readOnlyInput = $inputWriteBlocked
      resultMountWritable = $resultMountWritable
      hostPathUnavailable = $hostPathUnavailable
      externalJunctionUnavailable = $junctionTargetUnavailable
      hostEnvironmentUnavailable = $hostEnvironmentUnavailable
      ipv4DefaultRoutes = $ipv4Routes
      ipv6DefaultRoutes = $ipv6Routes
      outboundBlocked = $outboundBlocked
      guestWorkspaceWritable = (Test-Path -LiteralPath $workspaceProbe)
      childProcessCreated = ($childCreated -and $childProcessCompleted -and $process.ExitCode -eq 0)
    }
    $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $outputPath -Encoding UTF8
    Add-Content -LiteralPath (Join-Path $results 'progress.log') -Value 'probe-complete'
    $exitCode = 0
  } else {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = [string]$config.command.executable
    $psi.WorkingDirectory = $workingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Arguments = [string]$config.command.argumentLine
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
      if (Test-Path -LiteralPath (Join-Path $results 'cancel.request')) {
        $cancelled = $true
      } else {
        [void]$process.Start()
        $stdoutBuilder = New-Object System.Text.StringBuilder
        $stderrBuilder = New-Object System.Text.StringBuilder
        $process.add_OutputDataReceived({
          param($sender, $eventArgs)
          if ($null -ne $eventArgs.Data -and $stdoutBuilder.Length -lt 2000000) {
            [void]$stdoutBuilder.AppendLine($eventArgs.Data)
          }
        }.GetNewClosure())
        $process.add_ErrorDataReceived({
          param($sender, $eventArgs)
          if ($null -ne $eventArgs.Data -and $stderrBuilder.Length -lt 2000000) {
            [void]$stderrBuilder.AppendLine($eventArgs.Data)
          }
        }.GetNewClosure())
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$config.timeoutMs)
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
          if (Test-Path -LiteralPath (Join-Path $results 'cancel.request')) {
            $cancelled = $true
            & "$env:WINDIR\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
            break
          }
          Start-Sleep -Milliseconds 100
        }
        $process.Refresh()
        if (-not $process.HasExited) {
          $timedOut = -not $cancelled
          & "$env:WINDIR\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $stdout = $stdoutBuilder.ToString()
        $stderr = $stderrBuilder.ToString()
        [IO.File]::WriteAllText($outputPath, $stdout)
        [IO.File]::WriteAllText($errorPath, $stderr)
      }
  }
} catch {
  $message = $_.Exception.Message
  [IO.File]::WriteAllText($errorPath, $message)
  if ($null -eq $exitCode) { $exitCode = 1 }
}
finally {
  $result = [ordered]@{
    exitCode = $exitCode
    stdout = if (Test-Path -LiteralPath $outputPath) { [IO.File]::ReadAllText($outputPath) } else { '' }
    stderr = if (Test-Path -LiteralPath $errorPath) { [IO.File]::ReadAllText($errorPath) } else { '' }
    timedOut = $timedOut
    cancelled = $cancelled
    durationMs = [int]([DateTime]::UtcNow - $startedAt).TotalMilliseconds
  }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
}`;

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

function locateNodeRuntime() {
  const where = spawnSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.status !== 0) {
    const error = new Error('A host Node.js runtime is required to stage the Node toolchain into Windows Sandbox.');
    error.code = 'SANDBOX_TOOLCHAIN_UNAVAILABLE';
    throw error;
  }
  const candidates = where.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const npmRoot = path.join(path.dirname(candidate), 'node_modules', 'npm');
    try {
      fsSync.accessSync(path.join(npmRoot, 'bin', 'npm-cli.js'));
      return { executable: candidate, npmRoot };
    } catch {
      continue;
    }
  }
  const error = new Error('Node.js was found, but its npm CLI could not be located for Windows Sandbox.');
  error.code = 'SANDBOX_TOOLCHAIN_UNAVAILABLE';
  throw error;
}

async function stageNodeRuntime(controlRoot) {
  const node = locateNodeRuntime();
  const toolsRoot = path.join(controlRoot, 'tools');
  const npmRoot = path.join(toolsRoot, 'node_modules', 'npm');
  await fs.mkdir(path.dirname(npmRoot), { recursive: true });
  await fs.copyFile(node.executable, path.join(toolsRoot, 'node.exe'));
  await fs.cp(node.npmRoot, npmRoot, { recursive: true });
  await fs.writeFile(
    path.join(toolsRoot, 'npm.cmd'),
    '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n',
    'utf8',
  );
}

function buildSandboxConfiguration({ projectRoot, controlRoot, resultsRoot }) {
  return `<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ProtectedClient>Enable</ProtectedClient>
  <MappedFolders>
    <MappedFolder><HostFolder>${escapeXml(projectRoot)}</HostFolder><SandboxFolder>C:\\ai-help-agent-project</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${escapeXml(controlRoot)}</HostFolder><SandboxFolder>C:\\ai-help-agent-control</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${escapeXml(resultsRoot)}</HostFolder><SandboxFolder>C:\\ai-help-agent-results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\ai-help-agent-control\\bootstrap.ps1</Command></LogonCommand>
</Configuration>`;
}

async function waitForSandboxResult({ resultPath, cancelPath, process, timeoutMs, isCancelled }) {
  const startupDeadline = Date.now() + SANDBOX_STARTUP_TIMEOUT_MS + timeoutMs;
  while (Date.now() < startupDeadline) {
    try {
      const json = await fs.readFile(resultPath, 'utf8');
      return JSON.parse(json.replace(/^\uFEFF/, ''));
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
    if (typeof isCancelled === 'function' && isCancelled()) {
      await fs.writeFile(cancelPath, 'cancel\n', 'utf8');
    }
    if (process.exitCode !== null && process.exitCode !== undefined) {
      throw new Error(`Windows Sandbox exited before returning a result (code ${process.exitCode}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, SANDBOX_POLL_INTERVAL_MS));
  }
  await fs.writeFile(cancelPath, 'cancel\n', 'utf8').catch(() => {});
  const progress = await fs.readFile(path.join(path.dirname(resultPath), 'progress.log'), 'utf8').catch(() => '');
  throw new Error(`Windows Sandbox did not complete before the startup/command deadline.${progress ? ` Guest progress: ${progress.trim().replace(/\r?\n/g, ', ')}` : ''}`);
}

async function stopSandbox(process) {
  if (!process || process.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.kill();
      resolve();
    }, SANDBOX_KILL_GRACE_MS);
    process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function listSandboxClientPids() {
  const tasklist = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tasklist.exe');
  const result = spawnSync(tasklist, ['/FI', 'IMAGENAME eq WindowsSandboxClient.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Unable to inspect Windows Sandbox clients: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Unable to inspect Windows Sandbox clients (tasklist exited with ${result.status}).`);
  return result.stdout.split(/\r?\n/)
    .map((line) => Number(line.split('","')[1]?.replaceAll('"', '')))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForSandboxClientsToClose(baselinePids) {
  const baseline = new Set(baselinePids);
  const deadline = Date.now() + SANDBOX_KILL_GRACE_MS;
  let remaining = [];
  while (Date.now() < deadline) {
    remaining = listSandboxClientPids().filter((pid) => !baseline.has(pid));
    if (!remaining.length) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Windows Sandbox did not close its guest client(s): ${remaining.join(', ')}. No unowned Sandbox processes were terminated.`);
}

async function removeSandboxTemporaryRoot(temporaryRoot) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function runWindowsSandboxCommand({
  projectRoot,
  workingDirectory = '.',
  executable,
  args = [],
  environment = {},
  timeoutMs = 120_000,
  isCancelled,
  mode = 'command',
  hostProbePath = '',
}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows Sandbox execution is only available on Windows.');
  }
  if (!path.isAbsolute(projectRoot)) throw new TypeError('Sandbox project root must be absolute.');
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('Sandbox command arguments must be strings.');
  }
  const relativeWorkingDirectory = String(workingDirectory || '.').replace(/\\/g, '/');
  if (path.posix.isAbsolute(relativeWorkingDirectory)
    || relativeWorkingDirectory.split('/').some((segment) => segment === '..')) {
    throw new Error('Sandbox working directory must stay inside the isolated project.');
  }
  if (sandboxLeaseActive) throw new Error('Another Coding Agent Windows Sandbox operation is already active.');
  sandboxLeaseActive = true;

  let temporaryRoot;
  try {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-sandbox-'));
  } catch (error) {
    sandboxLeaseActive = false;
    throw error;
  }
  const controlRoot = path.join(temporaryRoot, 'control');
  const resultsRoot = path.join(temporaryRoot, 'results');
  const resultPath = path.join(resultsRoot, 'result.json');
  const cancelPath = path.join(resultsRoot, 'cancel.request');
  const wsbPath = path.join(temporaryRoot, 'run.wsb');
  let baselineSandboxClients = [];
  let sandboxProcess;
  try {
    baselineSandboxClients = listSandboxClientPids();
    if (baselineSandboxClients.length) {
      throw new Error('Close existing Windows Sandbox guests before running Coding Agent verification.');
    }
    await fs.mkdir(controlRoot, { recursive: true });
    await fs.mkdir(resultsRoot, { recursive: true });
    await fs.writeFile(path.join(controlRoot, 'bootstrap.ps1'), guestBootstrap, 'utf8');
    await fs.writeFile(path.join(controlRoot, 'invoke.ps1'), guestInvoke, 'utf8');
    const command = mode === 'probe'
      ? { executable: '', argumentLine: '', environment: {} }
      : {
        executable: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe'),
        argumentLine: '/d /s /c ""C:\\ai-help-agent-control\\run-command.cmd""',
        environment: { CI: typeof environment.CI === 'string' ? environment.CI : '' },
      };
    await fs.writeFile(path.join(controlRoot, 'command.json'), JSON.stringify({
      mode,
      workingDirectory: relativeWorkingDirectory === '.' ? '' : relativeWorkingDirectory,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      hostProbePath,
      command,
    }), 'utf8');
    if (mode !== 'probe') await stageNodeRuntime(controlRoot);
    if (mode !== 'probe') {
      const script = args[1];
      if (path.basename(String(executable || '')).toLowerCase() !== 'npm.cmd'
        || args.length !== 2 || args[0] !== 'run'
        || typeof script !== 'string' || !/^[a-z][a-z0-9:_-]{0,31}$/i.test(script)) {
        throw new Error('Windows Sandbox currently permits only validated npm verification scripts.');
      }
      await fs.writeFile(
        path.join(controlRoot, 'run-command.cmd'),
        `@echo off\r\ncall "C:\\ai-help-agent-control\\tools\\npm.cmd" run ${script}\r\nexit /b %ERRORLEVEL%\r\n`,
        'utf8',
      );
    }
    await fs.writeFile(wsbPath, buildSandboxConfiguration({ projectRoot, controlRoot, resultsRoot }), 'utf8');
    await fs.access(SANDBOX_EXECUTABLE);
    const sandboxEnvironment = mode === 'probe'
      ? { ...process.env, [HOST_PROBE_ENVIRONMENT_MARKER]: `${Date.now()}-${Math.random()}` }
      : process.env;
    sandboxProcess = spawn(SANDBOX_EXECUTABLE, [wsbPath], {
      env: sandboxEnvironment,
      stdio: 'ignore',
      windowsHide: true,
    });
    const spawnFailure = new Promise((_, reject) => {
      sandboxProcess.once('error', reject);
    });
    const result = await Promise.race([
      waitForSandboxResult({
        resultPath,
        cancelPath,
        process: sandboxProcess,
        timeoutMs,
        isCancelled,
      }),
      spawnFailure,
    ]);
    if (result.exitCode === null && !result.cancelled && !result.timedOut) {
      throw new Error(result.stderr || 'The restricted Windows Sandbox process returned no exit status.');
    }
    if (mode === 'probe') {
      const stdout = result.stdout || '';
      let checks;
      try {
        checks = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      } catch {
        throw new Error(`Windows Sandbox returned invalid process-isolation probe evidence: ${(result.stderr || stdout).slice(0, 300)}`);
      }
      return { ...result, checks };
    }
    return result;
  } catch (error) {
    if (sandboxProcess && error instanceof Error) error.isolationFailure = true;
    throw error;
  } finally {
    let cleanupError;
    try {
      await stopSandbox(sandboxProcess);
      if (sandboxProcess?.pid) await waitForSandboxClientsToClose(baselineSandboxClients);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await removeSandboxTemporaryRoot(temporaryRoot);
    } catch (error) {
      cleanupError ||= error;
    }
    sandboxLeaseActive = false;
    if (cleanupError) {
      if (cleanupError instanceof Error) cleanupError.isolationFailure = true;
      throw cleanupError;
    }
  }
}

async function probeWindowsSandbox(projectRoot) {
  const markerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-sandbox-marker-'));
  const markerPath = path.join(markerRoot, 'host-marker.txt');
  const outsideRoot = path.join(markerRoot, 'outside');
  const junctionPath = path.join(projectRoot, '.sandbox-host-escape');
  await fs.mkdir(outsideRoot);
  await fs.writeFile(markerPath, 'host-only-probe-marker', 'utf8');
  await fs.writeFile(path.join(outsideRoot, 'marker.txt'), 'junction-escape-marker', 'utf8');
  try {
    await fs.symlink(outsideRoot, junctionPath, 'junction');
    const result = await runWindowsSandboxCommand({
      projectRoot,
      mode: 'probe',
      timeoutMs: 30_000,
      hostProbePath: markerPath,
    });
    const checks = result.checks;
    if (checks?.externalJunctionUnavailable !== true) {
      throw new Error('Windows Sandbox boundary probe failed: a host junction escaped the read-only project mount.');
    }
    return checks;
  } finally {
    await fs.rm(junctionPath, { recursive: true, force: true }).catch(() => {});
    await fs.rm(markerRoot, { recursive: true, force: true });
  }
}

function assertSandboxProbe(checks, result) {
  const failures = [];
  if (result.exitCode !== 0) failures.push('The restricted guest process did not complete.');
  if (!checks || checks.administrator !== false) failures.push('The guest process was not a standard user.');
  if (checks?.mediumIntegrity !== true) failures.push('The guest process did not have medium integrity.');
  if (checks?.readOnlyInput !== true) failures.push('The project input mount was writable.');
  if (checks?.resultMountWritable !== true) failures.push('The result-only output mount was not writable.');
  if (checks?.hostPathUnavailable !== true) failures.push('The guest could access an unmounted host path.');
  if (checks?.externalJunctionUnavailable !== true) failures.push('A host junction escaped the read-only project mount.');
  if (checks?.hostEnvironmentUnavailable !== true) failures.push('A host environment marker reached the guest.');
  if (checks?.ipv4DefaultRoutes !== 0 || checks?.ipv6DefaultRoutes !== 0) failures.push('The guest had a default network route.');
  if (checks?.outboundBlocked !== true) failures.push('The guest could establish an outbound connection.');
  if (checks?.guestWorkspaceWritable !== true) failures.push('The guest workspace was not writable.');
  if (checks?.childProcessCreated !== true) failures.push('The standard user could not create a child process.');
  if (failures.length) throw new Error(`Windows Sandbox boundary probe failed: ${failures.join(' ')}`);
  return result;
}

module.exports = {
  assertSandboxProbe,
  HOST_PROBE_ENVIRONMENT_MARKER,
  probeWindowsSandbox,
  runWindowsSandboxCommand,
};
