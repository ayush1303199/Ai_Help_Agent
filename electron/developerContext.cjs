const crypto = require('node:crypto');
const cache = new Map();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function tokens(text) { return Math.ceil(String(text || '').length / 4); }
function normalizeRoot(root) {
  const value = typeof root === 'string' && root.trim() ? root.trim() : '__global__';
  return value.replace(/\\/g, '/');
}
function rankResults(results, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return [...results].map((item) => {
    const path = String(item.path || '');
    const name = String(item.name || '');
    const text = String(item.text || item.content || '');
    const haystack = `${path} ${text} ${name}`.toLowerCase();
    let score = terms.reduce((total, term) => total + (haystack.includes(term) ? 10 : 0), 0)
      + (item.matchType === 'content' ? 2 : 1)
      + (item.isDependency || item.dependency ? 3 : 0)
      + (item.isTest || /(?:^|[./_-])(test|spec)(?:[./_-]|$)/i.test(path) ? 2 : 0)
      + (path.toLowerCase().includes('src/') || path.toLowerCase().includes('/src') ? 4 : 0)
      + (path.toLowerCase().includes('electron') ? 5 : 0)
      + (path.toLowerCase().includes('server') ? 4 : 0)
      + (name && terms.some((term) => name.toLowerCase().includes(term)) ? 8 : 0);
    const symbolBoost = /(?:function|class|component|hook|service|provider|model|context|route|index)/i.test(path + ' ' + name);
    if (symbolBoost) score += 3;
    return { ...item, score };
  }).sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0));
}
function assembleContext({ query, results = [], files = [], maxTokens = 4000, root = '__global__' } = {}) {
  if (typeof query !== 'string' || query.length > 200 || !Array.isArray(results) || results.length > 500) {
    throw new Error('Invalid bounded Developer context request.');
  }
  maxTokens = Math.max(64, Math.min(Number(maxTokens) || 4000, 12000));
  const scopedRoot = normalizeRoot(root);
  const key = digest(JSON.stringify({ root: scopedRoot, query, results, files, maxTokens }));
  if (cache.has(key)) return { ...cache.get(key), cached: true, root: scopedRoot };
  const ranked = rankResults(results, query);
  const selected = []; let used = 0;
  for (const item of ranked) {
    const text = String(item.text || item.content || '');
    const cost = tokens(text);
    if (used + cost > maxTokens) continue;
    selected.push(item); used += cost;
  }
  const context = { root: scopedRoot, query, tokenCount: used, budget: maxTokens, items: selected, diversity: new Set(selected.map((item) => item.path)).size };
  cache.set(key, context);
  return { ...context, cached: false };
}
function invalidateContextCache(root = null) {
  if (root === null || root === undefined) {
    cache.clear();
    return;
  }
  const scopedRoot = normalizeRoot(root);
  for (const key of [...cache.keys()]) {
    const value = cache.get(key);
    if (value && value.root === scopedRoot) cache.delete(key);
  }
}
module.exports = { tokens, rankResults, assembleContext, invalidateContextCache };
