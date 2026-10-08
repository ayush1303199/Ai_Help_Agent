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
  const map = await index.buildRepositoryMap(root);
  assert.equal(map.type, 'repository-map');
  assert.ok(Array.isArray(map.structure));
  assert.ok(map.sourceDirectories.length >= 1);
  const refs = index.findReferences(first, 'helper');
  assert.ok(refs.some((item) => item.file === 'main.ts' && item.relationship === 'reference'));
  const second = await index.buildIndex(root, first);
  assert.equal(second.cacheHits, 2);
  const semanticRoot = path.join(root, 'semantic-project');
  const semanticCacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-semantic-cache-'));
  await fs.mkdir(path.join(semanticRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(semanticRoot, 'src', 'colors.ts'), 'export const palette = "blue";\n// privateCodeToken\n', 'utf8');
  await fs.writeFile(path.join(semanticRoot, 'src', 'payments.ts'), 'export function chargeCard() { return true; }\n', 'utf8');
  let embeddedTextCount = 0;
  const createFakePipeline = async () => async (texts) => {
    embeddedTextCount += texts.length;
    const vectors = texts.map((text) => {
      const vector = [0, 0, 0, 0];
      if (/\b(?:blue|azure|color|palette)\b/i.test(text)) vector[0] += 1;
      if (/\b(?:payment|charge|card)\b/i.test(text)) vector[1] += 1;
      const length = Math.hypot(...vector) || 1;
      return vector.map((value) => value / length);
    });
    return { tolist: () => vectors };
  };
  index.configureSemanticSearch({
    cacheDirectory: semanticCacheDirectory,
    modelCacheDirectory: path.join(semanticCacheDirectory, 'models'),
    createPipeline: createFakePipeline,
  });
  const semanticSnapshot = await index.buildIndex(semanticRoot);
  const semanticFirst = await index.searchSemantic(semanticSnapshot, 'azure colors', { scope: 'src' });
  assert.equal(semanticFirst.status, 'ready');
  assert.equal(semanticFirst.results[0].path, 'src/colors.ts');
  assert.equal(semanticFirst.indexedFiles, 2);
  const storedCacheFile = (await fs.readdir(semanticCacheDirectory)).find((entry) => entry.endsWith('.json'));
  const storedSemanticCache = await fs.readFile(path.join(semanticCacheDirectory, storedCacheFile), 'utf8');
  assert.equal(storedSemanticCache.includes('privateCodeToken'), false);
  index.configureSemanticSearch({
    cacheDirectory: semanticCacheDirectory,
    modelCacheDirectory: path.join(semanticCacheDirectory, 'models'),
    createPipeline: createFakePipeline,
  });
  const semanticPersisted = await index.searchSemantic(semanticSnapshot, 'azure colors', { scope: 'src' });
  assert.equal(semanticPersisted.cachedFiles, 2);
  assert.equal(semanticPersisted.indexedChunks, 0);
  await fs.writeFile(path.join(semanticRoot, 'src', 'colors.ts'), 'export const palette = "green";\n', 'utf8');
  await fs.rm(path.join(semanticRoot, 'src', 'payments.ts'));
  const semanticChangedSnapshot = await index.buildIndex(semanticRoot, semanticSnapshot);
  const semanticChanged = await index.searchSemantic(semanticChangedSnapshot, 'azure colors', { scope: 'src' });
  assert.equal(semanticChanged.indexedFiles, 1);
  assert.equal(semanticChanged.cachedFiles, 0);
  assert.ok(semanticChanged.results.every((item) => item.path.startsWith('src/')));
  const isolatedRoot = path.join(root, 'isolated-project');
  await fs.mkdir(isolatedRoot, { recursive: true });
  await fs.writeFile(path.join(isolatedRoot, 'other.ts'), '// payment card charge lookup\nexport function chargeCard() { return true; }\n', 'utf8');
  const isolatedSnapshot = await index.buildIndex(isolatedRoot);
  const isolatedSemantic = await index.searchSemantic(isolatedSnapshot, 'payment processing');
  assert.deepEqual(isolatedSemantic.results.map((item) => item.path), ['other.ts']);
  await fs.rm(semanticCacheDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  assert.ok(embeddedTextCount >= 5);
  const combinedResults = index.mergeSearchResults(
    [{ path: 'src/colors.ts', line: 1, text: 'lexical' }],
    [{ path: 'src/colors.ts', line: 1, text: 'semantic', score: 0.9 }, { path: 'src/payments.ts', line: 1, text: 'other', score: 0.8 }],
  );
  assert.equal(combinedResults[0].matchType, 'hybrid');
  assert.equal(combinedResults[0].text, 'lexical');
  assert.equal(combinedResults.length, 2);
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
  const agentMetrics = benchmark.buildAgentMetrics({
    taskSuccessRate: 0.9,
    firstAttemptSuccessRate: 0.8,
    repairSuccessRate: 0.75,
    falseCompletionRate: 0.05,
    toolCalls: 12,
    usefulToolCalls: 9,
    duplicateToolCalls: 1,
    unnecessaryToolCalls: 1,
    filesRead: 14,
    usefulFilesRead: 11,
    irrelevantFilesRead: 1,
    filesChanged: 2,
    unnecessaryFilesChanged: 0,
    linesChanged: 28,
    verificationPassRate: 0.9,
    averageRepairAttempts: 0.3,
    contextPrecision: 0.8,
    contextRecall: 0.75,
    tokenEfficiency: 0.7,
    taskLatency: 2100,
  });
  assert.equal(agentMetrics.summary.taskSuccessRate, 0.9);
  assert.ok(agentMetrics.agentEfficiency > 0.5);
  const regressionReport = benchmark.compareBenchmarkSnapshots(
    { taskSuccessRate: 0.8, firstAttemptSuccessRate: 0.75, repairSuccessRate: 0.7, verificationPassRate: 0.8, contextPrecision: 0.7, contextRecall: 0.65, tokenEfficiency: 0.6, toolCalls: 15, duplicateToolCalls: 3, unnecessaryToolCalls: 2, irrelevantFilesRead: 2, unnecessaryFilesChanged: 1, averageRepairAttempts: 1 },
    { taskSuccessRate: 0.9, firstAttemptSuccessRate: 0.85, repairSuccessRate: 0.8, verificationPassRate: 0.9, contextPrecision: 0.8, contextRecall: 0.75, tokenEfficiency: 0.7, toolCalls: 12, duplicateToolCalls: 1, unnecessaryToolCalls: 1, irrelevantFilesRead: 1, unnecessaryFilesChanged: 0, averageRepairAttempts: 0.3 },
  );
  assert.equal(regressionReport.regression, true);
  const gates = await benchmark.runCodeGates([{ name: 'deterministic-index', run: async () => ({ indexed: true }) }]);
  assert.equal(gates.status, 'pass');
  console.log('developer gates tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
