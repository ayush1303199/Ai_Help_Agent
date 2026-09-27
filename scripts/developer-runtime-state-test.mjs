import assert from 'node:assert/strict';

const os = await import('node:os');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const developerFiles = (await import('../electron/developerFiles.cjs')).default;
const developerContext = (await import('../electron/developerContext.cjs')).default;

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

developerFiles.clearProject('owner-a');
developerFiles.clearProject('owner-b');
developerFiles.clearProject('owner-a-reloaded');

console.log(JSON.stringify({
  projectIsolation: true,
}));
