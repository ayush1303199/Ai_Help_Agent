const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { requireProjectProcessIsolation } = require('./projectProcessIsolation.cjs');
const {
  createResultEnvelope,
  normalizeTimeoutMs,
} = require('./executionEvidenceContract.cjs');
const {
  createSandboxResourceLifecycle,
} = require('./sandboxResourceLifecycle.cjs');

const SANDBOX_STARTUP_TIMEOUT_MS = 120_000;
const SANDBOX_POLL_INTERVAL_MS = 100;
const SANDBOX_CLEANUP_TIMEOUT_MS = 180_000;
const SANDBOX_EXECUTABLE = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
const HOST_PROBE_ENVIRONMENT_MARKER = 'AI_HELP_AGENT_SANDBOX_HOST_MARKER';
const projectCommandAuthorizations = new WeakSet();

const guestBootstrap = String.raw`$ErrorActionPreference = 'Stop'
$control = 'C:\ai-help-agent-control'
$results = 'C:\ai-help-agent-results'
$progressPath = Join-Path $results 'progress.log'
$cleanupOutcomePath = Join-Path $results 'cleanup.json'
function Write-ProgressBestEffort([string]$message) {
  try {
    Add-Content -LiteralPath $progressPath -Value $message -ErrorAction Stop
  } catch {}
}
function Write-CleanupOutcomeBestEffort([string]$accountStatus, [string]$shutdownStatus, [bool]$complete) {
  try {
    [ordered]@{
      version = 1
      runId = [string]$config.runId
      complete = $complete
      accountCleanup = $accountStatus
      shutdownCommand = $shutdownStatus
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $cleanupOutcomePath -Encoding UTF8 -ErrorAction Stop
  } catch {}
}
Write-ProgressBestEffort 'bootstrap-start'
$config = Get-Content -LiteralPath (Join-Path $control 'command.json') -Raw | ConvertFrom-Json
$user = 'Aha-' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
$passwordBytes = New-Object byte[] 11
$randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $randomGenerator.GetBytes($passwordBytes)
  $password = 'A7!' + [Convert]::ToBase64String($passwordBytes).Replace('+', 'A').Replace('/', 'B').Substring(0, 11)
}
finally {
  $randomGenerator.Dispose()
}
$created = $false
try {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $provisionOutput = & "$env:WINDIR\System32\net.exe" user $user $password /add 2>&1
    $provisionExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($provisionExitCode -ne 0) { throw "Unable to create the restricted guest account (net user exited with $provisionExitCode): $($provisionOutput | Out-String)" }
  Write-ProgressBestEffort 'guest-account-created'
  $created = $true
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$user", $securePassword)
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $control 'invoke.ps1'))
  $process = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -ArgumentList $arguments -PassThru -WindowStyle Hidden
  Write-ProgressBestEffort 'guest-child-started'
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
  $failure = [ordered]@{ runId = [string]$config.runId; exitCode = $null; stdout = ''; stderr = $_.Exception.Message; timedOut = $false; cancelled = $false; durationMs = 0 }
  $failure | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $results 'result.json') -Encoding UTF8
}
finally {
  $accountCleanupFailure = $null
  $shutdownFailure = $null
  $accountCleanupStatus = 'unknown'
  $shutdownCommandStatus = 'unknown'
  Write-ProgressBestEffort 'guest-bootstrap-cleanup-start'
  if ($created) {
    $accountCleanupStatus = 'failed'
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $accountDeleteExitCode = $null
      & "$env:WINDIR\System32\net.exe" user $user /delete | Out-Null
      $accountDeleteExitCode = $LASTEXITCODE
      if ($accountDeleteExitCode -ne 0) {
        $accountCleanupFailure = "Guest account cleanup failed (net.exe exited with $accountDeleteExitCode)."
        $accountCleanupStatus = 'failed'
      } else {
        $accountCleanupStatus = 'succeeded'
      }
    }
    catch {
      $accountCleanupFailure = 'Guest account cleanup failed while invoking net.exe.'
    }
    finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($null -ne $accountDeleteExitCode) {
      Write-ProgressBestEffort "guest-account-delete-exit-$accountDeleteExitCode"
    }
  }
  if ($accountCleanupFailure) {
    Write-ProgressBestEffort 'guest-account-delete-failed'
  }
  Write-CleanupOutcomeBestEffort $accountCleanupStatus $shutdownCommandStatus $false
  Write-ProgressBestEffort 'guest-shutdown-start'
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $shutdownExitCode = $null
    & "$env:WINDIR\System32\shutdown.exe" /s /t 0 /f | Out-Null
    $shutdownExitCode = $LASTEXITCODE
    if ($shutdownExitCode -ne 0) {
      $shutdownFailure = "Guest shutdown failed (shutdown.exe exited with $shutdownExitCode)."
      $shutdownCommandStatus = 'failed'
    } else {
      $shutdownCommandStatus = 'succeeded'
    }
  }
  catch {
    $shutdownFailure = 'Guest shutdown failed while invoking shutdown.exe.'
    $shutdownCommandStatus = 'failed'
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -ne $shutdownExitCode) {
    Write-ProgressBestEffort "guest-shutdown-exit-$shutdownExitCode"
  }
  if ($shutdownFailure) {
    Write-ProgressBestEffort 'guest-shutdown-failed'
  }
  Write-CleanupOutcomeBestEffort $accountCleanupStatus $shutdownCommandStatus $true
  if ($accountCleanupFailure -and $shutdownFailure) {
    throw "$accountCleanupFailure $shutdownFailure"
  }
  if ($accountCleanupFailure) { throw $accountCleanupFailure }
  if ($shutdownFailure) { throw $shutdownFailure }
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
    runId = [string]$config.runId
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

async function waitForSandboxResult({
  runId,
  resultPath,
  cleanupOutcomePath,
  cancelPath,
  process,
  timeoutMs,
  isCancelled,
  startupTimeoutMs = SANDBOX_STARTUP_TIMEOUT_MS,
  pollIntervalMs = SANDBOX_POLL_INTERVAL_MS,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  readFile = fs.readFile,
  writeFile = fs.writeFile,
}) {
  if (typeof runId !== 'string' || !runId.trim()) throw new TypeError('Windows Sandbox run identity is required.');
  const executionTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const startupDeadline = now() + startupTimeoutMs + executionTimeoutMs;
  let projectResultReceived = false;
  let cleanupOutcomeInvalid = false;
  let cancellationRequested = false;
  let hostCancelled = false;
  let hostTerminationAttempt = null;
  while (now() < startupDeadline) {
    try {
      const json = await readFile(resultPath, 'utf8');
      const result = JSON.parse(json.replace(/^\uFEFF/, ''));
      if (!isValidSandboxGuestResult(result, runId)) {
        cleanupOutcomeInvalid = true;
        throw Object.assign(
          new Error('Windows Sandbox returned malformed or cross-run guest result evidence.'),
          { code: 'INVALID_GUEST_RESULT' },
        );
      }
      projectResultReceived = true;
      const cleanupJson = await readFile(cleanupOutcomePath, 'utf8');
      const cleanupOutcome = parseSandboxCleanupOutcome(cleanupJson, runId);
      if (!cleanupOutcome) {
        cleanupOutcomeInvalid = true;
      } else {
        return {
          result: { ...result, timedOut: false, cancelled: hostCancelled },
          cleanupOutcome,
          hostWait: { timedOut: false, cancelled: hostCancelled, deadlineObserved: false },
        };
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        cleanupOutcomeInvalid = true;
      } else if (error.code === 'INVALID_GUEST_RESULT') {
        throw error;
      } else if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
        throw error;
      }
    }
    if (typeof isCancelled === 'function' && isCancelled()) {
      hostCancelled = true;
      if (!cancellationRequested) {
        await writeFile(cancelPath, `${runId}\n`, 'utf8');
        cancellationRequested = true;
        hostTerminationAttempt = requestSandboxLauncherTermination(process);
      }
    }
    if ((process.exitCode !== null && process.exitCode !== undefined)
      || (process.signalCode !== null && process.signalCode !== undefined)) {
      const termination = process.signalCode
        ? `signal ${process.signalCode}`
        : `code ${process.exitCode}`;
      const missing = projectResultReceived ? 'a complete cleanup outcome' : 'a project result';
      throw Object.assign(
        new Error(`Windows Sandbox exited before returning ${missing} (${termination}).`),
        {
          code: 'SANDBOX_EXITED_WITHOUT_RESULT',
          hostWait: {
            timedOut: false,
            cancelled: hostCancelled,
            terminationAttempt: hostTerminationAttempt,
          },
        },
      );
    }
    await sleep(pollIntervalMs);
  }
  await writeFile(cancelPath, `${runId}\n`, 'utf8').catch(() => {});
  if (!hostTerminationAttempt) hostTerminationAttempt = requestSandboxLauncherTermination(process);
  const progress = await readFile(path.join(path.dirname(resultPath), 'progress.log'), 'utf8').catch(() => '');
  const outcomeState = cleanupOutcomeInvalid ? ' The cleanup outcome was malformed or incomplete.' : '';
  throw Object.assign(
    new Error(`Windows Sandbox did not complete with a valid project result and cleanup outcome before the startup/command deadline.${outcomeState}${progress ? ` Guest progress: ${progress.trim().replace(/\r?\n/g, ', ')}` : ''}`),
    {
      code: 'SANDBOX_HOST_DEADLINE',
      timedOut: true,
      hostWait: {
        timedOut: true,
        cancelled: hostCancelled,
        terminationAttempt: hostTerminationAttempt,
      },
    },
  );
}

function isValidSandboxGuestResult(value, expectedRunId) {
  const expectedKeys = ['runId', 'exitCode', 'stdout', 'stderr', 'timedOut', 'cancelled', 'durationMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  return typeof expectedRunId === 'string'
    && value.runId === expectedRunId
    && (value.exitCode === null || Number.isInteger(value.exitCode))
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
    && typeof value.timedOut === 'boolean'
    && typeof value.cancelled === 'boolean'
    && Number.isFinite(value.durationMs)
    && value.durationMs >= 0;
}

function isValidSandboxCleanupOutcome(value, expectedRunId) {
  const expectedKeys = ['version', 'runId', 'complete', 'accountCleanup', 'shutdownCommand'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return false;
  }
  return Number.isInteger(value.version)
    && value.version === 1
    && typeof expectedRunId === 'string'
    && value.runId === expectedRunId
    && value.complete === true
    && (value.accountCleanup === 'succeeded' || value.accountCleanup === 'failed')
    && (value.shutdownCommand === 'succeeded' || value.shutdownCommand === 'failed');
}

function parseSandboxCleanupOutcome(json, expectedRunId) {
  const outcome = JSON.parse(json.replace(/^\uFEFF/, ''));
  return isValidSandboxCleanupOutcome(outcome, expectedRunId) ? outcome : null;
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

function hasLauncherTerminated(process) {
  return !process
    || (process.exitCode !== null && process.exitCode !== undefined)
    || (process.signalCode !== null && process.signalCode !== undefined);
}

function requestSandboxLauncherTermination(process) {
  if (!process?.pid || hasLauncherTerminated(process)) {
    return Object.freeze({ requested: false, accepted: false, processId: process?.pid || null });
  }
  let accepted = false;
  try {
    accepted = process.kill();
  } catch {
    accepted = false;
  }
  return Object.freeze({ requested: true, accepted, processId: process.pid });
}

async function waitForSandboxShutdown(process, baselinePids, temporaryRoot, {
  listClients = listSandboxClientPids,
  cleanupTimeoutMs = SANDBOX_CLEANUP_TIMEOUT_MS,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const baseline = new Set(baselinePids);
  const deadline = now() + cleanupTimeoutMs;
  let remaining = [];
  let launcherExited = hasLauncherTerminated(process);
  while (now() < deadline) {
    remaining = listClients().filter((pid) => !baseline.has(pid));
    launcherExited = hasLauncherTerminated(process);
    if (launcherExited && !remaining.length) {
      return Object.freeze({
        launcherTerminated: true,
        launcherPid: process?.pid || null,
        sandboxClientsRemaining: 0,
        observedAt: new Date(now()).toISOString(),
      });
    }
    await sleep(250);
  }
  remaining = listClients().filter((pid) => !baseline.has(pid));
  launcherExited = hasLauncherTerminated(process);
  const launcherState = launcherExited
    ? 'the Windows Sandbox launcher exited'
    : `the Windows Sandbox launcher is still running (PID ${process.pid || 'unknown'})`;
  const clientState = remaining.length
    ? `guest client(s) are still running: ${remaining.join(', ')}`
    : 'no guest clients remain';
  throw new Error(
    `Windows Sandbox cleanup timed out after ${cleanupTimeoutMs}ms: ${launcherState}; ${clientState}. `
      + `Isolation is not verified. Temporary probe data was retained at "${temporaryRoot}".`,
  );
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

async function verifySandboxTemporaryRootRemoved(temporaryRoot) {
  try {
    await fs.access(temporaryRoot);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

const sandboxResourceLifecycle = createSandboxResourceLifecycle({
  createTemporaryRoot: () => fs.mkdtemp(path.join(os.tmpdir(), 'ai-help-agent-sandbox-')),
  waitForShutdown: waitForSandboxShutdown,
  removeTemporaryRoot: removeSandboxTemporaryRoot,
  verifyTemporaryRootRemoved: verifySandboxTemporaryRootRemoved,
});

function combineSandboxRunAndCleanupFailures(runFailure, cleanupFailure) {
  const runMessage = runFailure instanceof Error ? runFailure.message : String(runFailure);
  const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
  const combined = new AggregateError(
    [runFailure, cleanupFailure],
    `Windows Sandbox run failed (${runMessage}) and cleanup failed (${cleanupMessage}).`,
  );
  combined.isolationFailure = true;
  return combined;
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
  authorization,
}) {
  if (mode !== 'command') {
    throw new Error('Windows Sandbox provider probing is disabled pending separate authorization.');
  }
  if (!authorization || !projectCommandAuthorizations.has(authorization)) {
    throw new Error('Windows Sandbox project command authorization is unavailable.');
  }
  requireProjectProcessIsolation('Windows Sandbox project command');
  if (process.platform !== 'win32') {
    throw new Error('Windows Sandbox execution is only available on Windows.');
  }
  if (!path.isAbsolute(projectRoot)) throw new TypeError('Sandbox project root must be absolute.');
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('Sandbox command arguments must be strings.');
  }
  timeoutMs = normalizeTimeoutMs(timeoutMs);
  const relativeWorkingDirectory = String(workingDirectory || '.').replace(/\\/g, '/');
  if (path.posix.isAbsolute(relativeWorkingDirectory)
    || relativeWorkingDirectory.split('/').some((segment) => segment === '..')) {
    throw new Error('Sandbox working directory must stay inside the isolated project.');
  }
  const runId = crypto.randomUUID();
  const resource = await sandboxResourceLifecycle.createResource({ runId });
  const temporaryRoot = sandboxResourceLifecycle.getTemporaryRoot(resource);
  const controlRoot = path.join(temporaryRoot, 'control');
  const resultsRoot = path.join(temporaryRoot, 'results');
  const resultPath = path.join(resultsRoot, 'result.json');
  const cleanupOutcomePath = path.join(resultsRoot, 'cleanup.json');
  const cancelPath = path.join(resultsRoot, 'cancel.request');
  const wsbPath = path.join(temporaryRoot, 'run.wsb');
  let baselineSandboxClients = [];
  let sandboxProcess;
  let cleanupOutcome;
  let hostWait;
  let commandResult;
  let hostLifecycleObservation;
  let runFailed = false;
  let runFailure;
  try {
    baselineSandboxClients = listSandboxClientPids();
    sandboxResourceLifecycle.setBaselinePids(resource, baselineSandboxClients);
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
      runId,
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
    sandboxResourceLifecycle.markLaunchStarting(resource);
    sandboxProcess = spawn(SANDBOX_EXECUTABLE, [wsbPath], {
      env: sandboxEnvironment,
      stdio: 'ignore',
      windowsHide: true,
    });
    sandboxProcess.once('spawn', () => {
      sandboxResourceLifecycle.markLauncherStarted(resource, sandboxProcess);
    });
    sandboxProcess.once('error', () => sandboxResourceLifecycle.markLaunchFailed(resource));
    const spawnFailure = new Promise((_, reject) => {
      sandboxProcess.once('error', reject);
    });
    const {
      result,
      cleanupOutcome: receivedCleanupOutcome,
      hostWait: receivedHostWait,
    } = await Promise.race([
      waitForSandboxResult({
        runId,
        resultPath,
        cleanupOutcomePath,
        cancelPath,
        process: sandboxProcess,
        timeoutMs,
        isCancelled,
      }),
      spawnFailure,
    ]);
    cleanupOutcome = receivedCleanupOutcome;
    hostWait = receivedHostWait;
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
      const resultEnvelope = createResultEnvelope({
        untrustedWorkerClaims: [
          JSON.stringify({
            runId: result.runId,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            durationMs: result.durationMs,
          }),
          result.stdout || '',
          result.stderr || '',
          cleanupOutcome ? JSON.stringify(cleanupOutcome) : '',
        ].filter((entry) => typeof entry === 'string' && entry.trim().length > 0),
        providerObservedState: {
          launcherExited: sandboxProcess ? (sandboxProcess.exitCode !== null && sandboxProcess.exitCode !== undefined) || (sandboxProcess.signalCode !== null && sandboxProcess.signalCode !== undefined) : null,
          processId: sandboxProcess ? sandboxProcess.pid : null,
          sandboxMode: mode,
          runId,
        },
      });
      commandResult = { ...result, checks, resultEnvelope };
    } else {
      const resultEnvelope = createResultEnvelope({
        untrustedWorkerClaims: [
          JSON.stringify({
            runId: result.runId,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            durationMs: result.durationMs,
          }),
          result.stdout || '',
          result.stderr || '',
          cleanupOutcome ? JSON.stringify(cleanupOutcome) : '',
        ].filter((entry) => typeof entry === 'string' && entry.trim().length > 0),
        providerObservedState: {
          launcherExited: sandboxProcess ? (sandboxProcess.exitCode !== null && sandboxProcess.exitCode !== undefined) || (sandboxProcess.signalCode !== null && sandboxProcess.signalCode !== undefined) : null,
          processId: sandboxProcess ? sandboxProcess.pid : null,
          sandboxMode: mode,
          runId,
          hostWait,
        },
      });
      commandResult = {
        ...result,
        cleanupOutcome,
        hostWait,
        runId,
        executionResultAuthenticated: false,
        resultEnvelope,
      };
    }
  } catch (error) {
    runFailed = true;
    runFailure = error;
    if (sandboxProcess && error instanceof Error) {
      if (!error.hostWait?.terminationAttempt?.requested) {
        error.hostTerminationAttempt = requestSandboxLauncherTermination(sandboxProcess);
      }
      error.isolationFailure = true;
    }
  } finally {
    let cleanupError;
    try {
      hostLifecycleObservation = await sandboxResourceLifecycle.cleanup(resource);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      const outcome = cleanupOutcome
        ? ` Guest cleanup outcome: accountCleanup=${cleanupOutcome.accountCleanup}, shutdownCommand=${cleanupOutcome.shutdownCommand}.`
        : '';
      const error = new Error(`${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}${outcome}`);
      error.isolationFailure = true;
      if (runFailed) {
        throw combineSandboxRunAndCleanupFailures(runFailure, error);
      }
      throw error;
    }
  }
  if (runFailed) throw runFailure;
  if (commandResult) {
    commandResult.hostLifecycleObservation = hostLifecycleObservation;
    if (commandResult.resultEnvelope) {
      commandResult.resultEnvelope.providerObservedState.hostLifecycleObservation = hostLifecycleObservation;
    }
    return commandResult;
  }
  throw new Error(`Windows Sandbox run ${runId} produced no command result.`);
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
  combineSandboxRunAndCleanupFailures,
  isValidSandboxGuestResult,
  HOST_PROBE_ENVIRONMENT_MARKER,
  parseSandboxCleanupOutcome,
  requestSandboxLauncherTermination,
  runWindowsSandboxCommand,
  waitForSandboxResult,
  waitForSandboxShutdown,
};
