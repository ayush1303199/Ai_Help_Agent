import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import index from '../electron/developerIndex.cjs';
import context from '../electron/developerContext.cjs';
import benchmark from '../electron/developerBenchmark.cjs';
import files from '../electron/developerFiles.cjs';
import { config } from '../server/src/config.js';
import { providerOrder } from '../server/src/llm/provider.js';

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
  const ranked = context.assembleContext({ query: 'main', results: [{ path: 'z.ts', text: 'main' }, { path: 'a.ts', text: 'other' }], maxTokens: 10 });
  assert.equal(ranked.items[0].path, 'z.ts');
  assert.equal(context.assembleContext({ query: 'main', results: [{ path: 'z.ts', text: 'main' }], maxTokens: 10 }).cached, false);
  assert.equal(context.assembleContext({ query: 'main', results: [{ path: 'z.ts', text: 'main' }], maxTokens: 10 }).cached, true);
  const providers = await benchmark.discoverProviders([{ id: 'missing' }, { id: 'blocked', probe: async () => { throw new Error('no credential'); } }]);
  assert.deepEqual(providers.map((item) => item.status), ['blocked', 'blocked']);
  const configuredProvidersBeforeEligibilityTest = config.configuredProviders;
  const fallbackEnabledBeforeEligibilityTest = config.fallbackEnabled;
  try {
    const statuses = ['unknown', 'error', 'timeout', 'network-error', 'capacity-503', 'rate-limit'];
    config.fallbackEnabled = false;
    for (const status of statuses) {
      config.configuredProviders = [{
        id: 'developer-eligibility-provider',
        label: 'metadata-only-provider',
        adapterType: 'openai',
        apiKey: 'metadata-only-key',
        model: 'metadata-only-model',
        baseURL: 'https://metadata.invalid/v1',
        enabled: true,
        priority: 1,
        status,
      }];
      const selected = providerOrder({ requireToolCalling: true, allowPreviouslyFailed: true });
      assert.equal(selected.length, 1);
      assert.equal(selected[0].id, 'developer-eligibility-provider');
      assert.equal(selected[0].status, status);
    }
  } finally {
    config.configuredProviders = configuredProvidersBeforeEligibilityTest;
    config.fallbackEnabled = fallbackEnabledBeforeEligibilityTest;
  }
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
