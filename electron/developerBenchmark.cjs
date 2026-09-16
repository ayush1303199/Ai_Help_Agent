const { performance } = require('node:perf_hooks');

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
module.exports = { discoverProviders, benchmark, buildAgentMetrics, compareBenchmarkSnapshots, runCodeGates };
