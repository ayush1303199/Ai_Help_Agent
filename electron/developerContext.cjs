const crypto = require('node:crypto');
const cache = new Map();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function tokens(text) { return Math.ceil(String(text || '').length / 4); }
function normalizeRoot(root) {
  const value = typeof root === 'string' && root.trim() ? root.trim() : '__global__';
  return value.replace(/\\/g, '/');
}
function isLowValuePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  return /(?:^|\/)(?:\.idea|assets?|fonts?|vendor|node_modules|dist|build|coverage|tmp|cache)(?:\/|$)/.test(normalized)
    || /\.(?:ttf|woff2?|eot|map|min\.(?:js|css))$/.test(normalized);
}
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.php', '.java', '.kt', '.go', '.rb', '.cs', '.fs', '.vb', '.rs', '.py']);
const SOURCE_DIRECTORIES = /(?:^|\/)(?:src|app|lib|cmd|internal|pkg|controllers?|models?|views?|services?|components?|modules?|routes?|crates?)(?:\/|$)/i;
function rankResults(results, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return [...results].map((item, index) => {
    const path = String(item.path || '');
    const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
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
      + (SOURCE_EXTENSIONS.has(normalizedPath.slice(normalizedPath.lastIndexOf('.'))) ? 5 : 0)
      + (SOURCE_DIRECTORIES.test(normalizedPath) ? 6 : 0)
      - (isLowValuePath(normalizedPath) ? 18 : 0)
      - (/\.(?:ttf|woff2?|eot|map|min\.(?:js|css))$/.test(normalizedPath) ? 12 : 0)
      + (name && terms.some((term) => name.toLowerCase().includes(term)) ? 8 : 0);
    if (item.relationship === 'definition') score += 6;
    if (item.relationship === 'reference') score += 4;
    if (item.relationship === 'import') score += 3;
    if (item.relatedTo) score += 2;
    const symbolBoost = /(?:function|class|component|hook|service|provider|model|context|route|index)/i.test(path + ' ' + name);
    if (symbolBoost) score += 3;
    return { ...item, score, rank: index };
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
  const selected = []; const selectedPaths = new Set(); let used = 0;
  for (const item of ranked) {
    if (isLowValuePath(item.path)) continue;
    if (selectedPaths.has(item.path)) continue;
    const text = String(item.text || item.content || '');
    const cost = tokens(text);
    if (used + cost > maxTokens) continue;
    selected.push(item); used += cost;
    selectedPaths.add(item.path);
  }
  const candidatePaths = [...new Set(ranked.map((item) => item.path).filter(Boolean))];
  const context = {
    root: scopedRoot, query, tokenCount: used, budget: maxTokens, items: selected,
    diversity: selectedPaths.size,
    candidateCount: candidatePaths.length,
    selectedCount: selected.length,
    coverage: candidatePaths.length ? Number((selected.length / candidatePaths.length).toFixed(3)) : 0,
    selectionReason: 'ranked path, symbol, relationship, and architecture relevance',
  };
  cache.set(key, context);
  return { ...context, cached: false };
}
function assembleRuntimeEvidenceContext(evidence = {}, maxTokens = 1800) {
  const budget = Math.max(64, Math.min(Number(maxTokens) || 1800, 4000));
  const mapped = Array.isArray(evidence.mapped) ? evidence.mapped.slice(0, 8) : [];
  const lines = [
    `[runtime-observed] ${String(evidence.message || 'Runtime failure captured.').slice(0, 1000)}`,
    ...mapped.map((item) => `[mapped] ${item.file}:${item.line}${item.column ? `:${item.column}` : ''}\n${(item.source || []).map((line) => `${line.line}: ${line.text}`).join('\n')}`),
  ];
  const content = lines.join('\n').slice(0, budget * 4);
  return { content, tokenCount: tokens(content), budget, observed: Boolean(evidence.observed), redacted: evidence.redacted !== false };
}
function assemblePreferenceContext(preferences = [], maxTokens = 600) {
  const budget = Math.max(64, Math.min(Number(maxTokens) || 600, 1200));
  const content = preferences.filter((item) => item && item.enabled && typeof item.text === 'string')
    .slice(0, 20)
    .map((item) => `- [${String(item.category || 'other').slice(0, 32)}] ${item.text.slice(0, 240)}`)
    .join('\n')
    .slice(0, budget * 4);
  return { content: content ? `[user-style-guidance]\n${content}` : '', tokenCount: tokens(content), budget };
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
module.exports = { tokens, rankResults, assembleContext, assembleRuntimeEvidenceContext, assemblePreferenceContext, invalidateContextCache };
