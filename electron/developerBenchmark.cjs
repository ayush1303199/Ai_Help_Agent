const { performance } = require('node:perf_hooks');
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
module.exports = { discoverProviders, benchmark, runCodeGates };
