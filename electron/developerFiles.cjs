const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 2000;
const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'logs', 'tmp', 'temp', '.dev-mode-audit.log']);
function isIgnoredName(name) {
  const normalized = String(name || '').toLowerCase();
  return IGNORED_NAMES.has(normalized) || normalized.startsWith('.developer-journal-') || normalized.endsWith('.log');
}
const MAX_COMMAND_DURATION_MS = 120000;
const MAX_OUTPUT_CHARS = 12000;
const MAX_RUNTIME_FRAMES = 12;
const MAX_RUNTIME_SOURCE_LINES = 9;
const SAFE_SCRIPT_NAMES = new Set(['lint', 'typecheck', 'test', 'build', 'check', 'validate', 'verify']);
const UNSAFE_SCRIPT_PATTERN = /[;&|<>`]|\$\(|\b(?:npm|npm\.cmd|yarn|pnpm|npx|git|rm|del|erase|format|powershell|cmd|install|publish|deploy|release|commit|push|reset|clean|generate|fix|update|write)\b/i;
const SAFE_COMMAND_PATTERN = /^\s*(?:tsc|eslint|vite|vitest|jest|mocha|ava|biome|webpack|rollup|next)(?:\s|$)/i;
const SAFE_ENV_KEYS = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'CI']);
const CREDENTIAL_ENV_PATTERN = /(?:key|token|secret|pass|credential|auth|private|cookie|session|client[_-]?secret|access[_-]?id)/i;
const NETWORK_POLICY = Object.freeze({ mode: 'restricted', outbound: 'not-granted-by-verification-layer' });
const SENSITIVE_NAME_PATTERN = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt|cer|der)|id_rsa(?:\..*)?)$/i;
const SENSITIVE_DIRECTORY_NAMES = new Set(['.ssh', '.aws', '.azure', '.config']);
const LOW_VALUE_PATH_PATTERN = /(?:^|[\\/])(?:\.idea|assets?|fonts?|vendor|node_modules|dist|build|coverage|tmp|cache)(?:[\\/]|$)|\.(?:ttf|woff2?|eot|map|min\.(?:js|css))$/i;

const projectRoots = new Map();

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSensitivePath(relativePath) {
  const segments = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase()) || SENSITIVE_NAME_PATTERN.test(segment));
}

async function realPathOrParent(target) {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await realPathOrParent(parent), path.basename(target));
  }
}

async function resolveWithinRoot(root, requestedPath = '.') {
  const canonicalRoot = await fs.realpath(root);
  if (typeof requestedPath !== 'string' || path.isAbsolute(requestedPath)) {
    throw new Error('Access denied: project paths must be relative.');
  }
  const requested = path.resolve(canonicalRoot, requestedPath || '.');
  const realTarget = await realPathOrParent(requested);
  if (!isInsideRoot(canonicalRoot, realTarget)) {
    throw new Error('Access denied: the requested path is outside the selected project.');
  }
  const relative = path.relative(canonicalRoot, realTarget);
  if (isSensitivePath(relative)) throw new Error('Access denied: sensitive project files are not available to the Coding Agent.');
  return { root: canonicalRoot, target: realTarget };
}

function assertProjectOwner(ownerWebContentsId) {
  if (ownerWebContentsId === undefined) {
    throw new Error('Developer project owner is required.');
  }
  const assignedRoot = projectRoots.get(ownerWebContentsId);
  if (!assignedRoot) {
    throw new Error('Developer project is not owned by this renderer session.');
  }
}

async function validateProjectRoot(ownerWebContentsId) {
  assertProjectOwner(ownerWebContentsId);
  const root = projectRoots.get(ownerWebContentsId);
  if (!root) throw new Error('No project folder selected.');
  const resolvedRoot = await fs.realpath(root);
  const stat = await fs.stat(resolvedRoot);
  if (!stat.isDirectory()) throw new Error('Invalid project path.');
  return resolvedRoot;
}

function appendAudit(root, tool, target, result) {
  return fs.appendFile(
    path.join(root, '.dev-mode-audit.log'),
    `${new Date().toISOString()}\ttool=${tool}\ttarget=${JSON.stringify(target)}\tresult=${result}\n`,
    'utf8',
  ).catch(() => {});
}

async function resolveProjectPath(relativePath = '.', ownerWebContentsId) {
  const root = await validateProjectRoot(ownerWebContentsId);
  return resolveWithinRoot(root, relativePath);
}

async function chooseProjectFolder(dialog, ownerWebContentsId) {
  if (ownerWebContentsId === undefined) throw new Error('Developer project ownership is required.');
  const scaffoldPath = projectRoots.get(ownerWebContentsId) || process.cwd() || require('node:os').homedir();
  const result = await dialog.showOpenDialog({
    title: 'Select project folder',
    defaultPath: scaffoldPath,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, projectRoot: projectRoots.get(ownerWebContentsId) || null };
  }
  const selectedRoot = await fs.realpath(result.filePaths[0]);
  projectRoots.set(ownerWebContentsId, selectedRoot);
  return { canceled: false, projectRoot: selectedRoot };
}

async function listDirectory(relativePath = '.', ownerWebContentsId) {
  const { root, target } = await resolveProjectPath(relativePath, ownerWebContentsId);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('The requested path is not a directory.');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const result = entries
    .filter((entry) => !isIgnoredName(entry.name) && !isSensitivePath(entry.name))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  await appendAudit(root, 'list_directory', relativePath, 'success');
  return result;
}

async function readFile(relativePath, ownerWebContentsId) {
  const { root, target } = await resolveProjectPath(relativePath, ownerWebContentsId);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('The requested path is not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large to read (512KB limit).');
  const result = { path: relativePath, content: await fs.readFile(target, 'utf8') };
  await appendAudit(root, 'read_file', relativePath, 'success');
  return result;
}

async function searchCode(query, ownerWebContentsId) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!normalizedQuery) throw new Error('Search query is required.');
  const root = await validateProjectRoot(ownerWebContentsId);
  const results = [];
  let filesVisited = 0;

  async function walk(relativeDirectory) {
    if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
    const directory = await resolveProjectPath(relativeDirectory, ownerWebContentsId);
    const entries = await fs.readdir(directory.target, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
      const childRelative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
      if (isIgnoredName(entry.name) || isSensitivePath(childRelative)) continue;
      if (LOW_VALUE_PATH_PATTERN.test(childRelative)) continue;
      if (entry.isDirectory()) {
        await walk(childRelative);
        continue;
      }

      if (!entry.isFile()) continue;
      filesVisited += 1;
      const target = await resolveProjectPath(childRelative, ownerWebContentsId);
      const stat = await fs.stat(target.target);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(target.target, 'utf8');
      const lines = content.split(/\r?\n/);
      const nameMatch = entry.name.toLowerCase().includes(normalizedQuery);
      if (nameMatch) {
        results.push({
          path: childRelative,
          line: 0,
          text: entry.name,
          matchType: 'filename',
        });
      }
      lines.forEach((line, lineIndex) => {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        if (line.toLowerCase().includes(normalizedQuery)) {
          results.push({
            path: childRelative,
            line: lineIndex + 1,
            text: line.slice(0, 240),
            matchType: 'content',
          });
        }
      });
    }
  }

  await walk('.');
  if (results.length === 0) {
    async function addPhpScope(relativeDirectory, depth = 0) {
      if (depth > 6 || results.length >= 40) return;
      const directory = await resolveProjectPath(relativeDirectory, ownerWebContentsId);
      const entries = await fs.readdir(directory.target, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= 40 || isIgnoredName(entry.name) || isSensitivePath(entry.name)) continue;
        const childRelative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
        if (LOW_VALUE_PATH_PATTERN.test(childRelative)) continue;
        if (entry.isDirectory()) {
          if (depth < 4) await addPhpScope(childRelative, depth + 1);
          continue;
        }
        if (entry.isFile() && /\.php$/i.test(entry.name)
          && /(?:controllers?|models?|views?|services?|modules?|components?)/i.test(childRelative)) {
          results.push({ path: childRelative, line: 0, text: entry.name, matchType: 'scope-fallback', relationship: 'scope' });
        }
      }
    }
    await addPhpScope('.');
  }
  const result = { query, results, filesVisited, truncated: results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES };
  await appendAudit(root, 'search_code', query, 'success');
  return result;
}

function limitOutput(value) {
  const text = String(value || '');
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = Math.floor(MAX_OUTPUT_CHARS * 0.7);
  const tail = MAX_OUTPUT_CHARS - head;
  return `${text.slice(0, head)}\n... output truncated ...\n${text.slice(-tail)}`;
}
function redactOutput(value) {
  return limitOutput(value).replace(/(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*\S+|\$_(?:ENV|SERVER)\s*\[[^\]]+\]\s*=>\s*[^\r\n]+)/gi, '[REDACTED]');
}
function redactRuntimeValue(value, key = '') {
  if (CREDENTIAL_ENV_PATTERN.test(key) || /authorization|cookie|session|^\$_(?:env|server)$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactRuntimeValue(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, childValue]) => [childKey, redactRuntimeValue(childValue, childKey)]));
  }
  return redactOutput(String(value ?? '')).slice(0, 1000);
}
function parseRuntimeFailure(output) {
  const text = String(output || '');
  const frames = [];
  const seen = new Set();
  const patterns = [
    /(?:at\s+(?:[^()\r\n]+\s+\()?|File\s+["'])([A-Za-z]:[\\/][^()\r\n"']+|\/[^()\r\n"']+|[^()\s:"']+\.[cm]?[jt]sx?|[^()\s:"']+\.py):(\d+)(?::(\d+))?/g,
    /File\s+["']([^"']+)["'],\s*line\s+(\d+)/g,
    /(?:PHP\s+(?:Fatal error|Parse error|Warning|Notice):.*?\s+in\s+|#\d+\s+)([A-Za-z]:[\\/][^()\r\n]+|\/[^()\r\n]+|[^()\s:()]+\.php)\s*(?:on line\s+|\()(\d+)/gi,
    /([A-Za-z]:[\\/][^()\r\n]+|\/[^()\r\n]+|[^()\s:()]+\.php):(\d+)(?::(\d+))?/gi,
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(text)) && frames.length < MAX_RUNTIME_FRAMES) {
      const frameKey = `${match[1]}:${match[2]}:${match[3] || ''}`;
      if (seen.has(frameKey)) continue;
      seen.add(frameKey);
      frames.push({ file: match[1], line: Number(match[2]), column: match[3] ? Number(match[3]) : null });
    }
  });
  const message = text.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && !/^(?:at\s|file\s|npm\s+(?:error|warn)|#\d+\s)/i.test(line)) || '';
  return { message: redactOutput(message).slice(0, 1000), frames, frameCount: frames.length };
}
async function mapRuntimeSource(root, runtimeFailure) {
  const mapped = [];
  for (const frame of runtimeFailure.frames || []) {
    try {
      const absolute = path.isAbsolute(frame.file) ? frame.file : path.resolve(root, frame.file);
      if (!isInsideRoot(root, await realPathOrParent(absolute))) continue;
      const relative = path.relative(root, absolute);
      if (isSensitivePath(relative)) continue;
      const target = await resolveWithinRoot(root, relative);
      const lines = (await fs.readFile(target.target, 'utf8')).split(/\r?\n/);
      const start = Math.max(0, frame.line - 1 - Math.floor(MAX_RUNTIME_SOURCE_LINES / 2));
      const end = Math.min(lines.length, start + MAX_RUNTIME_SOURCE_LINES);
      mapped.push({ file: relative, line: frame.line, column: frame.column, source: lines.slice(start, end).map((text, index) => ({ line: start + index + 1, text: redactOutput(text).slice(0, 240) })) });
    } catch {
      // Omit missing, inaccessible, or sensitive source locations.
    }
  }
  return mapped;
}
async function enrichRuntimeEvidence(root, stdout, stderr, options = {}) {
  const runtimeFailure = parseRuntimeFailure(`${stderr}\n${stdout}`);
  return {
    status: 'captured',
    observed: true,
    message: runtimeFailure.message,
    frames: runtimeFailure.frames,
    mapped: await mapRuntimeSource(root, runtimeFailure),
    redacted: true,
    debugger: {
      requested: Boolean(options.debuggerCapture),
      captured: false,
      reason: options.debuggerCapture ? 'Debugger locals capture requires a separately approved hook.' : 'Debugger locals capture is off by default.',
    },
  };
}
function safeEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env)
    .filter(([key]) => SAFE_ENV_KEYS.has(key) && !CREDENTIAL_ENV_PATTERN.test(key)));
}

async function runGit(args, ownerWebContentsId) {
  const root = await validateProjectRoot(ownerWebContentsId);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid git inspection request.');
  const allowed = args[0] === 'status' || (args[0] === 'diff' && args.every((arg) => ['diff', '--stat', '--name-only', '--no-ext-diff'].includes(arg)));
  if (!allowed) throw new Error('Only read-only git status and diff are permitted.');
  const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = limitOutput(stdout + chunk.toString()); });
  child.stderr.on('data', (chunk) => { stderr = limitOutput(stderr + chunk.toString()); });
  const result = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, error: error.message }));
    child.on('close', (code) => resolve({ code }));
  });
  await appendAudit(root, 'git_inspection', args.join(' '), result.code === 0 ? 'success' : 'failure');
  if (result.code !== 0) throw new Error(limitOutput(stderr || result.error || 'git inspection failed'));
  return { args, stdout, stderr };
}

async function detectProjectType(root) {
  let hasPhpFile = false;
  let hasPhpUnitConfig = false;
  let composer = null;
  let hasPackageJson = false;
  try { await fs.stat(path.join(root, 'package.json')); hasPackageJson = true; } catch {}
  async function walk(relativeDirectory, depth = 0) {
    if (depth > 8 || hasPhpFile && hasPhpUnitConfig && composer) return;
    const directory = await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    for (const entry of directory) {
      if (isIgnoredName(entry.name) || isSensitivePath(entry.name)) continue;
      const relative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === 'composer.json') composer = relative;
      if (lower === 'phpunit.xml' || lower === 'phpunit.xml.dist') hasPhpUnitConfig = true;
      if (lower.endsWith('.php')) hasPhpFile = true;
    }
  }
  await walk('.');
  return { ...classifyProjectSignals({ hasPackageJson, composer: Boolean(composer), hasPhpFile, hasPhpUnitConfig }), composer, hasPackageJson };
}

function classifyProjectSignals({ hasPackageJson = false, composer = false, hasPhpFile = false, hasPhpUnitConfig = false } = {}) {
  return { isPhp: !hasPackageJson && Boolean(composer || hasPhpFile), hasPhpUnitConfig };
}

async function readComposer(root, relativePath) {
  if (!relativePath) return null;
  try {
    const file = await resolveWithinRoot(root, relativePath);
    return JSON.parse(await fs.readFile(file.target, 'utf8'));
  } catch {
    return null;
  }
}

async function hasProjectExecutable(root, relativePath) {
  try {
    const target = await resolveWithinRoot(root, relativePath);
    const stat = await fs.stat(target.target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findChangedPhpFiles(root) {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain', '--', '*.php'], { cwd: root, shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(0, MAX_OUTPUT_CHARS); });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(output.split(/\r?\n/).map((item) => item.slice(3).trim())
      .filter((item) => item && /\.php$/i.test(item) && !isSensitivePath(item)).slice(0, 20)));
  });
}

async function runVerification(script, ownerWebContentsId, options = {}) {
  const root = await validateProjectRoot(ownerWebContentsId);
  if (typeof script !== 'string' || !/^[a-z][a-z0-9:_-]{0,31}$/i.test(script)) throw new Error('Verification script name is invalid.');
  const projectType = await detectProjectType(root);
  let phpCommand = null;
  if (projectType.isPhp) {
    if (script === 'phpunit' && projectType.hasPhpUnitConfig
      && await hasProjectExecutable(root, process.platform === 'win32' ? 'vendor/bin/phpunit.bat' : 'vendor/bin/phpunit')) {
      phpCommand = { executable: process.platform === 'win32' ? 'vendor\\bin\\phpunit.bat' : './vendor/bin/phpunit', args: [] };
    } else if (script === 'phpunit' && projectType.hasPhpUnitConfig) {
      throw new Error('PHPUnit is not installed for this project (vendor/bin/phpunit not found); use php-lint instead.');
    } else if (script === 'composer-test' && projectType.composer) {
      const composer = await readComposer(root, projectType.composer);
      if (typeof composer?.scripts?.test === 'string' && composer.scripts.test.trim()
        && !UNSAFE_SCRIPT_PATTERN.test(composer.scripts.test)) {
        phpCommand = { executable: process.platform === 'win32' ? 'composer.bat' : 'composer', args: ['run-script', 'test'] };
      }
    } else if (script === 'php-lint') {
      const changedFiles = await findChangedPhpFiles(root);
      if (!changedFiles.length) throw new Error('NOT_AVAILABLE (no changed PHP files available for syntax lint).');
      phpCommand = { executable: 'php', args: changedFiles.map((file) => ['-l', file]).flat(), lintFiles: changedFiles };
    }
    if (!phpCommand) throw new Error('PHP verification is not available for the selected project or requested check.');
  }
  if (phpCommand) {
    const startedAt = Date.now();
    const safeEnv = safeEnvironment(process.env);
    const child = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(phpCommand.executable)
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${phpCommand.executable} ${phpCommand.args.join(' ')}`], { cwd: root, windowsHide: true, env: safeEnv })
      : spawn(phpCommand.executable, phpCommand.args, { cwd: root, shell: false, windowsHide: true, env: safeEnv });
    let stdout = '';
    let stderr = '';
    const appendBounded = (current, chunk) => current.length >= MAX_OUTPUT_CHARS ? current : (current + chunk.toString()).slice(0, MAX_OUTPUT_CHARS);
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish({ timedOut: true, exitCode: null }); }, MAX_COMMAND_DURATION_MS);
      child.on('error', (error) => finish({ error: error.message, exitCode: null }));
      child.on('close', (code) => finish({ exitCode: code }));
    });
    const durationMs = Date.now() - startedAt;
    if (result.timedOut) return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: 'Verification command timed out.', durationMs, timedOut: true, networkPolicy: NETWORK_POLICY };
    if (result.error) {
      const missing = /enoent|not found/i.test(result.error);
      return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: missing ? `${phpCommand.executable} not found in PATH.` : redactOutput(result.error), durationMs, spawnError: true, reason: missing ? `NOT_AVAILABLE (${phpCommand.executable} not found in PATH)` : undefined, networkPolicy: NETWORK_POLICY };
    }
    const ok = result.exitCode === 0;
    await appendAudit(root, 'run_php_verification', script, ok ? 'success' : `failure:exit-${result.exitCode}`);
    const runtimeEvidence = ok ? null : await enrichRuntimeEvidence(root, stdout, stderr, options);
    const phpunitPath = process.platform === 'win32' ? 'vendor/bin/phpunit.bat' : 'vendor/bin/phpunit';
    const reason = script === 'php-lint' && projectType.hasPhpUnitConfig && !await hasProjectExecutable(root, phpunitPath)
      ? 'PHPUnit is not installed for this project (vendor/bin/phpunit not found); php-lint fallback used.'
      : null;
    return { ok, script, exitCode: result.exitCode, stdout: redactOutput(stdout), stderr: redactOutput(stderr), durationMs, runtimeEvidence, reason, networkPolicy: NETWORK_POLICY, lintFiles: phpCommand.lintFiles };
  }
  let packageJson;
  try {
    const packageFile = await resolveWithinRoot(root, 'package.json');
    packageJson = JSON.parse(await fs.readFile(packageFile.target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Selected project has no package.json.');
    throw new Error('Selected project package.json is invalid.');
  }

  const command = packageJson.scripts?.[script];
  if (typeof command !== 'string' || !command.trim()) throw new Error(`Verification script "${script}" is not defined.`);
  if (!SAFE_SCRIPT_NAMES.has(script.toLowerCase()) || UNSAFE_SCRIPT_PATTERN.test(command) || !SAFE_COMMAND_PATTERN.test(command)) {
    throw new Error(`Verification script "${script}" is not permitted.`);
  }

  async function runGit(args) {
    const root = await validateProjectRoot(ownerWebContentsId);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid git inspection request.');
    const allowed = args[0] === 'status' || (args[0] === 'diff' && args.every((arg) => ['diff', '--stat', '--name-only', '--no-ext-diff'].includes(arg)));
    if (!allowed) throw new Error('Only read-only git status and diff are permitted.');
    const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const result = await new Promise((resolve) => {
      child.on('error', (error) => resolve({ code: null, error: error.message }));
      child.on('close', (code) => resolve({ code }));
    });
    await appendAudit(root, 'git_inspection', args.join(' '), result.code === 0 ? 'success' : 'failure');
    if (result.code !== 0) throw new Error(limitOutput(stderr || result.error || 'git inspection failed'));
    return { args, stdout: limitOutput(stdout), stderr: limitOutput(stderr) };
  }
  const startedAt = Date.now();
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Windows exposes npm as a .cmd shim. Invoke it through the fixed command
  // interpreter, while the script name remains strictly validated above.
  const safeEnv = safeEnvironment(process.env);
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `${executable} run ${script}`], { cwd: root, windowsHide: true, env: safeEnv })
    : spawn(executable, ['run', script], { cwd: root, shell: false, windowsHide: true, env: safeEnv });
  let stdout = '';
  let stderr = '';
  const appendBounded = (current, chunk) => current.length >= MAX_OUTPUT_CHARS
    ? current
    : (current + chunk.toString()).slice(0, MAX_OUTPUT_CHARS);
  child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
  const result = await new Promise((resolve) => {
    let settled = false;
    let cancellationTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      resolve(value);
    };
    const terminate = () => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(() => {
      terminate();
      finish({ timedOut: true, exitCode: null });
    }, MAX_COMMAND_DURATION_MS);
    if (typeof options.isCancelled === 'function') {
      cancellationTimer = setInterval(() => {
        if (!options.isCancelled()) return;
        terminate();
        finish({ cancelled: true, exitCode: null });
      }, 100);
    }
    child.on('error', (error) => finish({ error: error.message, exitCode: null }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
  const durationMs = Date.now() - startedAt;
  const project = path.basename(root);
  if (result.timedOut) {
    console.warn(`[DEV][VERIFY] project=${project} script=${script} exitCode=null durationMs=${durationMs} success=false timedOut=true`);
    await appendAudit(root, 'run_command', script, 'failure:timeout');
    return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: 'Verification command timed out.', durationMs, timedOut: true, networkPolicy: NETWORK_POLICY };
  }
  if (result.cancelled) {
    await appendAudit(root, 'run_command', script, 'cancelled');
    return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: 'Verification command cancelled.', durationMs, cancelled: true, networkPolicy: NETWORK_POLICY };
  }
  if (result.error) {
    console.warn(`[DEV][VERIFY] project=${project} script=${script} exitCode=null durationMs=${durationMs} success=false`);
    await appendAudit(root, 'run_command', script, 'failure:spawn');
    return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: redactOutput(result.error), durationMs, spawnError: true, networkPolicy: NETWORK_POLICY };
  }
  const ok = result.exitCode === 0;
  console.info(`[DEV][VERIFY] project=${project} script=${script} exitCode=${result.exitCode} durationMs=${durationMs} success=${ok}`);
  await appendAudit(root, 'run_command', script, ok ? 'success' : `failure:exit-${result.exitCode}`);
  const runtimeEvidence = ok ? null : await enrichRuntimeEvidence(root, stdout, stderr, options);
  return { ok, script, exitCode: result.exitCode, stdout: redactOutput(stdout), stderr: redactOutput(stderr), durationMs, runtimeEvidence, networkPolicy: NETWORK_POLICY };
}

async function getVerificationScripts(ownerWebContentsId, requested = []) {
  const root = await validateProjectRoot(ownerWebContentsId);
  const projectType = await detectProjectType(root);
  if (projectType.isPhp) {
    const composer = await readComposer(root, projectType.composer);
    const available = [];
    const phpunitPath = process.platform === 'win32' ? 'vendor/bin/phpunit.bat' : 'vendor/bin/phpunit';
    const phpunitInstalled = projectType.hasPhpUnitConfig && await hasProjectExecutable(root, phpunitPath);
    if (phpunitInstalled) available.push('phpunit');
    if (typeof composer?.scripts?.test === 'string' && composer.scripts.test.trim()
      && !UNSAFE_SCRIPT_PATTERN.test(composer.scripts.test)) available.push('composer-test');
    available.push('php-lint');
    const hasRequestedScripts = Array.isArray(requested) && requested.length > 0;
    const requestedNames = hasRequestedScripts
      ? requested.map((script) => String(script).trim().toLowerCase())
      : available;
    const unavailablePhpUnit = requestedNames.includes('phpunit') && !phpunitInstalled;
    const fallbackRequested = unavailablePhpUnit || (!hasRequestedScripts && !available.includes('phpunit'));
    const scripts = [...new Set([...requestedNames, ...(fallbackRequested ? ['php-lint'] : [])])]
      .filter((script) => available.includes(script) || script === 'php-lint');
    const missing = hasRequestedScripts
      ? [...new Set(requestedNames)].filter((script) => !scripts.includes(script) && script !== 'phpunit')
      : [];
    return {
      scripts,
      missing,
      reason: unavailablePhpUnit
        ? 'PHPUnit is not installed for this project (vendor/bin/phpunit not found); using php-lint fallback.'
        : scripts.length ? (missing.length ? `Verification checks are unavailable: ${missing.join(', ')}.` : null) : 'NOT_AVAILABLE (PHP verification tools/configuration unavailable).',
    };
  }
  let packageJson;
  try {
    const packageFile = await resolveWithinRoot(root, 'package.json');
    packageJson = JSON.parse(await fs.readFile(packageFile.target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { scripts: [], reason: 'Selected project has no package.json.' };
    throw new Error('Selected project package.json is invalid.');
  }
  const hasRequestedScripts = Array.isArray(requested) && requested.length > 0;
  const scriptNames = hasRequestedScripts
    ? requested
    : ['typecheck', 'lint', 'test', 'build'];
  const normalizedScripts = [...new Set(scriptNames.map((script) => String(script).trim().toLowerCase()))];
  const scripts = normalizedScripts
    .filter((script) => SAFE_SCRIPT_NAMES.has(script))
    .filter((script) => typeof packageJson.scripts?.[script] === 'string' && packageJson.scripts[script].trim());
  const missing = hasRequestedScripts ? normalizedScripts.filter((script) => !scripts.includes(script)) : [];
  return {
    scripts,
    missing,
    reason: scripts.length ? (missing.length ? `Verification scripts are unavailable: ${missing.join(', ')}.` : null) : 'No safe verification scripts are defined in package.json.',
  };
}

function clearProject(ownerWebContentsId) {
  if (ownerWebContentsId !== undefined) {
    projectRoots.delete(ownerWebContentsId);
  }
}

function releaseProject(ownerWebContentsId) {
  if (ownerWebContentsId !== undefined) {
    projectRoots.delete(ownerWebContentsId);
  }
}

function getProjectRoot(ownerWebContentsId = null) {
  if (ownerWebContentsId !== null && ownerWebContentsId !== undefined) {
    return projectRoots.get(ownerWebContentsId) || null;
  }
  if (projectRoots.size === 1) return [...projectRoots.values()][0];
  return null;
}

module.exports = {
  chooseProjectFolder, listDirectory, readFile, searchCode, runVerification, runGit,
  getVerificationScripts, resolveWithinRoot, clearProject, releaseProject,
  assertProjectOwner, getProjectRoot, safeEnvironment, NETWORK_POLICY, isSensitivePath,
  redactRuntimeValue, parseRuntimeFailure, mapRuntimeSource, classifyProjectSignals,
};
