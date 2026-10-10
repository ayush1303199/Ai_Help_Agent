import assert from 'node:assert/strict';

const os = await import('node:os');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const net = await import('node:net');
const developerFiles = (await import('../electron/developerFiles.cjs')).default;
const developerContext = (await import('../electron/developerContext.cjs')).default;
const { DevServerManager } = await import('../electron/coding-pipeline/environment.cjs');
const {
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
} = await import('../electron/coding-pipeline/projectProcessIsolation.cjs');
const { assertSandboxProbe } = await import('../electron/coding-pipeline/windowsSandboxRunner.cjs');
const windowsSandboxRunnerSource = await fs.readFile(
  new URL('../electron/coding-pipeline/windowsSandboxRunner.cjs', import.meta.url),
  'utf8',
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-project-isolation-'));
const projectA = path.join(tempRoot, 'project-a');
const projectB = path.join(tempRoot, 'project-b');
await fs.mkdir(projectA, { recursive: true });
await fs.mkdir(projectB, { recursive: true });
await fs.writeFile(path.join(projectA, 'alpha.txt'), 'A');
await fs.writeFile(path.join(projectB, 'beta.txt'), 'B');

await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectA] }) }, 'owner-a');
await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectB] }) }, 'owner-b');
assert.equal(developerFiles.getProjectRoot('owner-a'), projectA);
assert.equal(developerFiles.getProjectRoot('owner-b'), projectB);
assert.equal(developerFiles.getProjectRoot(), null);
assert.equal((await developerFiles.readFile('alpha.txt', 'owner-a')).content, 'A');
assert.equal((await developerFiles.readFile('beta.txt', 'owner-b')).content, 'B');
assert.throws(() => developerFiles.assertProjectOwner('owner-c'), /not owned/i);
assert.equal(developerFiles.normalizeScopedProjectPath(projectA, 'models', 'models'), 'models');
assert.equal(
  developerFiles.normalizeScopedProjectPath(projectA, 'models', 'models/AdmOuPrgList.php'),
  'models/AdmOuPrgList.php',
);
assert.equal(
  developerFiles.normalizeScopedProjectPath(projectA, 'models', 'AdmOuPrgList.php'),
  'models/AdmOuPrgList.php',
);
assert.equal(developerFiles.normalizeScopedProjectPath(projectA, '.', 'models/AdmOuPrgList.php'), 'models/AdmOuPrgList.php');
assert.throws(
  () => developerFiles.normalizeScopedProjectPath(projectA, 'models', '../outside.php'),
  /traversal|outside the selected scope/i,
);

developerFiles.releaseProject('owner-a');
assert.equal(developerFiles.getProjectRoot('owner-a'), null);
assert.throws(() => developerFiles.assertProjectOwner('owner-a'), /not owned/i);
await developerFiles.chooseProjectFolder({ showOpenDialog: async () => ({ canceled: false, filePaths: [projectA] }) }, 'owner-a-reloaded');
assert.equal(developerFiles.getProjectRoot('owner-a-reloaded'), projectA);
assert.equal((await developerFiles.readFile('alpha.txt', 'owner-a-reloaded')).content, 'A');
assert.equal((await developerFiles.readFile('beta.txt', 'owner-b')).content, 'B');

const sharedResult = [{ path: 'src/login.ts', text: 'login timeout is read from config', matchType: 'content' }];
const contextA = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectA, maxTokens: 1200 });
const contextB = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectB, maxTokens: 1200 });
assert.notEqual(contextA.root, contextB.root);
assert.equal(contextA.items[0]?.path, sharedResult[0].path);
assert.equal(contextB.items[0]?.path, sharedResult[0].path);
assert.equal(contextA.cached, false);
assert.equal(contextB.cached, false);
developerContext.invalidateContextCache(projectA);
const contextARefreshed = developerContext.assembleContext({ query: 'timeout', results: sharedResult, root: projectA, maxTokens: 1200 });
assert.equal(contextARefreshed.cached, false);

const projectBContextBeforeClear = developerContext.assembleContext({ query: 'beta', results: [{ path: 'src/beta.ts', text: 'beta service timeout', matchType: 'content' }], root: projectB, maxTokens: 1200 });
developerContext.invalidateContextCache(projectB);
const projectBContextAfterClear = developerContext.assembleContext({ query: 'beta', results: [{ path: 'src/beta.ts', text: 'beta service timeout', matchType: 'content' }], root: projectB, maxTokens: 1200 });
assert.equal(projectBContextBeforeClear.cached, false);
assert.equal(projectBContextAfterClear.cached, false);

const portProbe = net.createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const devServerPort = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
const devProject = path.join(tempRoot, 'dev-project');
await fs.mkdir(devProject, { recursive: true });
await fs.mkdir(path.join(devProject, '.ssh'), { recursive: true });
await fs.writeFile(path.join(devProject, '.env'), 'API_TOKEN=fixture-only\n');
await fs.writeFile(path.join(devProject, '.npmrc'), '//registry.example/:_authToken=fixture-only\n');
await fs.writeFile(path.join(devProject, '.ssh', 'id_rsa'), 'fixture-only-private-key');
await fs.writeFile(
  path.join(devProject, 'package.json'),
  JSON.stringify({
    scripts: {
      dev: `node -e "require('fs').writeFileSync('dev-server-write.txt','isolated');require('http').createServer((_,response)=>response.end('ok')).listen(${devServerPort})" -- --port ${devServerPort}`,
    },
  }),
);
const copiedWorkspace = await developerFiles.createIsolatedWorkspaceCopy(devProject);
await assert.rejects(fs.access(path.join(copiedWorkspace.root, '.env')), { code: 'ENOENT' });
await assert.rejects(fs.access(path.join(copiedWorkspace.root, '.npmrc')), { code: 'ENOENT' });
await assert.rejects(fs.access(path.join(copiedWorkspace.root, '.ssh')), { code: 'ENOENT' });
await assert.ok(await fs.readFile(path.join(copiedWorkspace.root, 'package.json'), 'utf8'));
await copiedWorkspace.cleanup();
const devServerManager = new DevServerManager();
assert.equal(projectProcessIsolationStatus().available, false);
assert.equal(projectProcessIsolationStatus().verified, false);
assert.throws(
  () => requireProjectProcessIsolation('Project test'),
  /no verified operating-system sandbox is configured/i,
);
assert.match(windowsSandboxRunnerSource, /<Networking>Disable<\/Networking>/);
assert.match(windowsSandboxRunnerSource, /<ReadOnly>true<\/ReadOnly>/);
assert.match(windowsSandboxRunnerSource, /Windows Sandbox currently permits only validated npm verification scripts/);
assert.match(windowsSandboxRunnerSource, /CreateProcess|Diagnostics\.Process/);
const sandboxProbeEvidence = {
  administrator: false,
  mediumIntegrity: true,
  readOnlyInput: true,
  resultMountWritable: true,
  hostPathUnavailable: true,
  externalJunctionUnavailable: true,
  hostEnvironmentUnavailable: true,
  ipv4DefaultRoutes: 0,
  ipv6DefaultRoutes: 0,
  outboundBlocked: true,
  guestWorkspaceWritable: true,
  childProcessCreated: true,
};
const successfulSandboxProbe = { exitCode: 0 };
assert.equal(assertSandboxProbe(sandboxProbeEvidence, successfulSandboxProbe), successfulSandboxProbe);
assert.throws(
  () => assertSandboxProbe({ ...sandboxProbeEvidence, administrator: true }, { exitCode: 0 }),
  /guest process was not a standard user/i,
);
await assert.rejects(
  devServerManager.startDevServer('isolated-dev-server-test', devProject),
  /no verified operating-system sandbox is configured/i,
);
assert.equal(devServerManager.getActiveServer('isolated-dev-server-test'), null);
await assert.rejects(fs.access(path.join(devProject, 'dev-server-write.txt')), { code: 'ENOENT' });

developerFiles.clearProject('owner-a');
developerFiles.clearProject('owner-b');
developerFiles.clearProject('owner-a-reloaded');

console.log(JSON.stringify({
  projectIsolation: true,
}));
