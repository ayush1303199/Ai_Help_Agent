const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 2000;
const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.dev-mode-audit.log']);
const MAX_COMMAND_DURATION_MS = 120000;
const MAX_OUTPUT_CHARS = 12000;
const SAFE_SCRIPT_NAMES = new Set(['lint', 'typecheck', 'test', 'build', 'check', 'validate', 'verify']);
const UNSAFE_SCRIPT_PATTERN = /[;&|<>`]|\$\(|\b(?:npm|npm\.cmd|yarn|pnpm|npx|git|rm|del|erase|format|powershell|cmd|install|publish|deploy|release|commit|push|reset|clean|generate|fix|update|write)\b/i;
const SAFE_COMMAND_PATTERN = /^\s*(?:tsc|eslint|vite|vitest|jest|mocha|ava|biome|webpack|rollup|next)(?:\s|$)/i;
const SAFE_ENV_KEYS = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'CI']);
const CREDENTIAL_ENV_PATTERN = /(?:key|token|secret|pass|credential|auth|private|cookie|session|client[_-]?secret|access[_-]?id)/i;
const NETWORK_POLICY = Object.freeze({ mode: 'restricted', outbound: 'not-granted-by-verification-layer' });

let projectRoot = null;

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
  return { root: canonicalRoot, target: realTarget };
}

async function validateProjectRoot() {
  if (!projectRoot) throw new Error('No project folder selected.');
  const root = await fs.realpath(projectRoot);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('Invalid project path.');
  return root;
}

function appendAudit(root, tool, target, result) {
  return fs.appendFile(
    path.join(root, '.dev-mode-audit.log'),
    `${new Date().toISOString()}\ttool=${tool}\ttarget=${JSON.stringify(target)}\tresult=${result}\n`,
    'utf8',
  ).catch(() => {});
}

async function resolveProjectPath(relativePath = '.') {
  const root = await validateProjectRoot();
  return resolveWithinRoot(root, relativePath);
}

async function chooseProjectFolder(dialog) {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, projectRoot };
  projectRoot = await fs.realpath(result.filePaths[0]);
  return { canceled: false, projectRoot };
}

async function listDirectory(relativePath = '.') {
  const { root, target } = await resolveProjectPath(relativePath);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('The requested path is not a directory.');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const result = entries
    .filter((entry) => !IGNORED_NAMES.has(entry.name))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  await appendAudit(root, 'list_directory', relativePath, 'success');
  return result;
}

async function readFile(relativePath) {
  const { root, target } = await resolveProjectPath(relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('The requested path is not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large to read (512KB limit).');
  const result = { path: relativePath, content: await fs.readFile(target, 'utf8') };
  await appendAudit(root, 'read_file', relativePath, 'success');
  return result;
}

async function searchCode(query) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!normalizedQuery) throw new Error('Search query is required.');
  const root = await validateProjectRoot();
  const results = [];
  let filesVisited = 0;

  async function walk(relativeDirectory) {
    if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
    const directory = await resolveProjectPath(relativeDirectory);
    const entries = await fs.readdir(directory.target, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || filesVisited >= MAX_SEARCH_FILES) return;
      if (IGNORED_NAMES.has(entry.name)) continue;
      const childRelative = relativeDirectory === '.' ? entry.name : path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(childRelative);
        continue;
      }

      if (!entry.isFile()) continue;
      filesVisited += 1;
      const target = await resolveProjectPath(childRelative);
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
  return limitOutput(value).replace(/(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi, '[REDACTED]');
}
function safeEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env)
    .filter(([key]) => SAFE_ENV_KEYS.has(key) && !CREDENTIAL_ENV_PATTERN.test(key)));
}

async function runGit(args) {
  const root = await validateProjectRoot();
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

async function runVerification(script) {
  const root = await validateProjectRoot();
  if (typeof script !== 'string' || !/^[a-z][a-z0-9:_-]{0,31}$/i.test(script)) throw new Error('Verification script name is invalid.');
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
    const root = await validateProjectRoot();
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
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else child.kill('SIGTERM');
      finish({ timedOut: true, exitCode: null });
    }, MAX_COMMAND_DURATION_MS);
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
  if (result.error) {
    console.warn(`[DEV][VERIFY] project=${project} script=${script} exitCode=null durationMs=${durationMs} success=false`);
    await appendAudit(root, 'run_command', script, 'failure:spawn');
    return { ok: false, script, exitCode: null, stdout: redactOutput(stdout), stderr: redactOutput(result.error), durationMs, spawnError: true, networkPolicy: NETWORK_POLICY };
  }
  const ok = result.exitCode === 0;
  console.info(`[DEV][VERIFY] project=${project} script=${script} exitCode=${result.exitCode} durationMs=${durationMs} success=${ok}`);
  await appendAudit(root, 'run_command', script, ok ? 'success' : `failure:exit-${result.exitCode}`);
  return { ok, script, exitCode: result.exitCode, stdout: redactOutput(stdout), stderr: redactOutput(stderr), durationMs, networkPolicy: NETWORK_POLICY };
}

function clearProject() {
  projectRoot = null;
}

module.exports = { chooseProjectFolder, listDirectory, readFile, searchCode, runVerification, runGit, resolveWithinRoot, clearProject, getProjectRoot: () => projectRoot, safeEnvironment, NETWORK_POLICY };
