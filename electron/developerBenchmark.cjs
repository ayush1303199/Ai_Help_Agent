const { performance } = require('node:perf_hooks');
const { parseRuntimeFailure, redactRuntimeValue, classifyProjectSignals } = require('./developerFiles.cjs');

function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function toPercent(value) {
  return Number(clamp(Number(value || 0), 0, 1).toFixed(3));
}

async function discoverProviders(providers = []) {
  const results = [];
  for (const provider of providers) {
    const started = performance.now();
    if (typeof provider.probe !== 'function') {
      results.push({ id: provider.id || 'unknown', status: 'blocked', reason: 'No provider probe configured.' });
      continue;
    }
    try { await provider.probe(); results.push({ id: provider.id, status: 'available', latencyMs: Math.round(performance.now() - started) }); }
    catch (error) { results.push({ id: provider.id, status: 'blocked', reason: String(error.message || error) }); }
  }
  return results;
}

async function benchmark(operation, fn, metadata = {}) {
  const started = performance.now();
  try { const value = await fn(); return { operation, status: 'ok', durationMs: Math.round(performance.now() - started), ...metadata, value }; }
  catch (error) { return { operation, status: 'failed', durationMs: Math.round(performance.now() - started), ...metadata, error: String(error.message || error) }; }
}

function buildAgentMetrics(metrics = {}) {
  const summary = {
    taskSuccessRate: toPercent(metrics.taskSuccessRate),
    firstAttemptSuccessRate: toPercent(metrics.firstAttemptSuccessRate),
    repairSuccessRate: toPercent(metrics.repairSuccessRate),
    falseCompletionRate: toPercent(metrics.falseCompletionRate),
    toolCalls: Number(metrics.toolCalls || 0),
    usefulToolCalls: Number(metrics.usefulToolCalls || 0),
    duplicateToolCalls: Number(metrics.duplicateToolCalls || 0),
    unnecessaryToolCalls: Number(metrics.unnecessaryToolCalls || 0),
    filesRead: Number(metrics.filesRead || 0),
    usefulFilesRead: Number(metrics.usefulFilesRead || 0),
    irrelevantFilesRead: Number(metrics.irrelevantFilesRead || 0),
    filesChanged: Number(metrics.filesChanged || 0),
    unnecessaryFilesChanged: Number(metrics.unnecessaryFilesChanged || 0),
    linesChanged: Number(metrics.linesChanged || 0),
    verificationPassRate: toPercent(metrics.verificationPassRate),
    averageRepairAttempts: Number(metrics.averageRepairAttempts || 0),
    contextPrecision: toPercent(metrics.contextPrecision),
    contextRecall: toPercent(metrics.contextRecall),
    tokenEfficiency: toPercent(metrics.tokenEfficiency),
    taskLatency: Number(metrics.taskLatency || 0),
  };

  const changeMinimality = summary.filesChanged > 0
    ? clamp(1 - (summary.unnecessaryFilesChanged / summary.filesChanged), 0, 1)
    : 1;
  const toolEfficiency = summary.toolCalls > 0
    ? clamp((summary.usefulToolCalls + summary.verificationPassRate * 2) / Math.max(summary.toolCalls, 1), 0, 1)
    : 1;
  const efficiencyScore = Number(((summary.taskSuccessRate * 0.32)
    + (summary.verificationPassRate * 0.24)
    + (summary.contextPrecision * 0.18)
    + (summary.contextRecall * 0.12)
    + (changeMinimality * 0.08)
    + (toolEfficiency * 0.06))
    .toFixed(3));

  return {
    summary,
    changeMinimality,
    toolEfficiency,
    agentEfficiency: efficiencyScore,
    status: efficiencyScore >= 0.75 ? 'strong' : efficiencyScore >= 0.5 ? 'acceptable' : 'weak',
  };
}

function compareBenchmarkSnapshots(current = {}, previous = {}) {
  const currentMetrics = buildAgentMetrics(current).summary;
  const previousMetrics = buildAgentMetrics(previous).summary;
  const deltas = {};
  for (const key of Object.keys(currentMetrics)) {
    const currentValue = Number(currentMetrics[key] ?? 0);
    const previousValue = Number(previousMetrics[key] ?? 0);
    deltas[key] = Number((currentValue - previousValue).toFixed(3));
  }
  const regression = Object.entries(deltas).some(([key, delta]) => {
    if (['taskSuccessRate', 'firstAttemptSuccessRate', 'repairSuccessRate', 'verificationPassRate', 'contextPrecision', 'contextRecall', 'tokenEfficiency'].includes(key)) {
      return delta < -0.05;
    }
    if (['toolCalls', 'duplicateToolCalls', 'unnecessaryToolCalls', 'irrelevantFilesRead', 'unnecessaryFilesChanged', 'averageRepairAttempts'].includes(key)) {
      return delta > 0.1;
    }
    return false;
  });
  return {
    delta: deltas,
    regression,
    currentScore: buildAgentMetrics(current).agentEfficiency,
    previousScore: buildAgentMetrics(previous).agentEfficiency,
  };
}

async function runCodeGates(gates = []) {
  const started = performance.now();
  const results = [];
  for (const gate of gates) {
    if (!gate || typeof gate.name !== 'string' || typeof gate.run !== 'function') {
      results.push({ name: gate?.name || 'unknown', status: 'blocked', reason: 'Invalid deterministic gate.' });
      continue;
    }
    results.push(await benchmark(gate.name, gate.run, { deterministic: true }));
  }
  return {
    status: results.every((result) => result.status === 'ok') ? 'pass' : 'fail',
    durationMs: Math.round(performance.now() - started),
    gates: results,
    provider: 'code-side',
  };
}

function runCodingAgentBenchmark() {
  const cases = [
    {
      name: 'focused-context',
      current: {
        taskSuccessRate: 1, firstAttemptSuccessRate: 1, verificationPassRate: 1,
        contextPrecision: 0.9, contextRecall: 0.8, tokenEfficiency: 0.85,
        toolCalls: 4, usefulToolCalls: 4, duplicateToolCalls: 0, unnecessaryToolCalls: 0,
        filesRead: 3, usefulFilesRead: 3, irrelevantFilesRead: 0, filesChanged: 1,
      },
      expected: { status: 'strong', regression: false },
    },
    {
      name: 'duplicate-read-regression',
      current: {
        taskSuccessRate: 0.8, verificationPassRate: 0.7,
        contextPrecision: 0.7, contextRecall: 0.6, tokenEfficiency: 0.5,
        toolCalls: 8, usefulToolCalls: 4, duplicateToolCalls: 3, unnecessaryToolCalls: 2,
        filesRead: 7, usefulFilesRead: 4, irrelevantFilesRead: 3, filesChanged: 2,
      },
      previous: {
        taskSuccessRate: 0.8, verificationPassRate: 0.7,
        contextPrecision: 0.7, contextRecall: 0.6, tokenEfficiency: 0.5,
        toolCalls: 5, usefulToolCalls: 4, duplicateToolCalls: 0, unnecessaryToolCalls: 0,
        filesRead: 4, usefulFilesRead: 4, irrelevantFilesRead: 0, filesChanged: 2,
      },
      expected: { status: 'acceptable', regression: true },
    },
    {
      name: 'false-completion',
      current: {
        taskSuccessRate: 0.2, verificationPassRate: 0, falseCompletionRate: 1,
        contextPrecision: 0.3, contextRecall: 0.2, tokenEfficiency: 0.2,
        toolCalls: 3, usefulToolCalls: 1, filesRead: 2, irrelevantFilesRead: 1,
      },
      expected: { status: 'weak', regression: false },
    },
    {
      name: 'repair-and-verify',
      current: {
        taskSuccessRate: 0.9, firstAttemptSuccessRate: 0.5, repairSuccessRate: 1,
        verificationPassRate: 1, averageRepairAttempts: 1,
        contextPrecision: 0.8, contextRecall: 0.8, tokenEfficiency: 0.75,
        toolCalls: 6, usefulToolCalls: 5, repairAttempts: 1, filesRead: 4,
        usefulFilesRead: 4, filesChanged: 2,
      },
      expected: { status: 'strong', regression: false },
    },
  ];
  const results = cases.map((item) => {
    const metrics = buildAgentMetrics(item.current);
    const comparison = item.previous ? compareBenchmarkSnapshots(item.current, item.previous) : null;
    const passed = metrics.status === item.expected.status
      && (comparison ? comparison.regression === item.expected.regression : true);
    return {
      name: item.name,
      passed,
      status: metrics.status,
      regression: comparison?.regression || false,
      score: metrics.agentEfficiency,
    };
  });
  const runtimeCases = [
    {
      name: 'runtime-node-stack-mapping',
      passed: parseRuntimeFailure('TypeError: boom\n    at run (src/app.js:12:8)').frames[0]?.line === 12,
    },
    {
      name: 'runtime-python-traceback-mapping',
      passed: parseRuntimeFailure('Traceback\n  File "src/app.py", line 7, in main').frames[0]?.line === 7,
    },
    {
      name: 'runtime-locals-redaction',
      passed: redactRuntimeValue({ apiKey: 'sk-test-secret', value: 'safe' }).apiKey === '[REDACTED]',
    },
    {
      name: 'runtime-php-fatal-mapping',
      passed: parseRuntimeFailure('PHP Fatal error: boom in app/controllers/SiteController.php on line 42').frames[0]?.line === 42,
    },
    {
      name: 'runtime-phpunit-failure-mapping',
      passed: parseRuntimeFailure('There was 1 failure:\n1) SiteTest::testIndex\napp/tests/SiteTest.php:18').frames[0]?.file === 'app/tests/SiteTest.php',
    },
    {
      name: 'runtime-php-superglobal-redaction',
      passed: redactRuntimeValue({ '$_ENV': { DB_PASSWORD: 'hidden' }, '$_SERVER': 'hidden' }).$_ENV === '[REDACTED]',
    },
    {
      name: 'project-type-node-vs-php',
      passed: classifyProjectSignals({ hasPackageJson: true, composer: true, hasPhpFile: true }).isPhp === false
        && classifyProjectSignals({ composer: true, hasPhpFile: true, hasPhpUnitConfig: true }).isPhp === true,
    },
  ];
  results.push(...runtimeCases.map((item) => ({ ...item, status: item.passed ? 'strong' : 'weak', regression: false, score: item.passed ? 1 : 0 })));
  return {
    name: 'coding-agent-quality',
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed),
    results,
  };
}

module.exports = { discoverProviders, benchmark, buildAgentMetrics, compareBenchmarkSnapshots, runCodeGates, runCodingAgentBenchmark };
