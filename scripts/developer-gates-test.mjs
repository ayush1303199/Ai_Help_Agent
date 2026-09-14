import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import index from '../electron/developerIndex.cjs';
import context from '../electron/developerContext.cjs';
import benchmark from '../electron/developerBenchmark.cjs';
import files from '../electron/developerFiles.cjs';

const root = await fs.mkdtemp(path.join(process.cwd(), '.developer-gates-'));
try {
  await fs.writeFile(path.join(root, 'main.ts'), 'import { helper } from "./helper";\nexport function main() { return helper(); }\n', 'utf8');
  await fs.writeFile(path.join(root, 'helper.ts'), 'export function helper() { return 1; }\n', 'utf8');
  const first = await index.buildIndex(root);
  assert.equal(first.capabilities.typeResolution, false);
  await assert.rejects(() => index.assertWithinRoot(root, '../outside.ts'), /outside/);
  assert.equal(first.files['main.ts'].imports[0].source, './helper');
  assert.equal(index.definitions(first, 'helper')[0].path, 'helper.ts');
  assert.equal(index.searchSymbols(first, 'main')[0].kind, 'function');
  const second = await index.buildIndex(root, first);
  assert.equal(second.cacheHits, 2);
  const ranked = context.assembleContext({ query: 'main', results: [{ path: 'z.ts', text: 'main' }, { path: 'a.ts', text: 'other' }], maxTokens: 10 });
  assert.equal(ranked.items[0].path, 'z.ts');
  assert.equal(context.assembleContext({ query: 'main', results: [{ path: 'z.ts', text: 'main' }], maxTokens: 10 }).cached, false);
  assert.equal(context.assembleContext({ query: 'main', results: [{ path: 'z.ts', text: 'main' }], maxTokens: 10 }).cached, true);
  const providers = await benchmark.discoverProviders([{ id: 'missing' }, { id: 'blocked', probe: async () => { throw new Error('no credential'); } }]);
  assert.deepEqual(providers.map((item) => item.status), ['blocked', 'blocked']);
  const env = files.safeEnvironment({ PATH: 'safe', API_TOKEN: 'secret', CLIENT_SECRET: 'secret', CI: '1' });
  assert.deepEqual(env, { PATH: 'safe', CI: '1' });
  assert.equal(files.NETWORK_POLICY.mode, 'restricted');
  const measured = await benchmark.benchmark('index', async () => 42);
  assert.equal(measured.status, 'ok');
  const gates = await benchmark.runCodeGates([{ name: 'deterministic-index', run: async () => ({ indexed: true }) }]);
  assert.equal(gates.status, 'pass');
  console.log('developer gates tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
