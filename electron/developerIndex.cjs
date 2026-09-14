const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPPORTED = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function symbolKind(match) {
  return match[1] || 'symbol';
}
function parseSource(relativePath, content) {
  const symbols = [];
  const imports = [];
  const exports = [];
  const definitions = [];
  const references = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const declaration = line.match(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) {
      const kind = symbolKind(line.match(/\b(function|class|interface|type|enum|const|let|var)\b/));
      const symbol = { name: declaration[1], kind, path: relativePath, line: index + 1, column: Math.max(0, line.indexOf(declaration[1])) + 1 };
      symbols.push(symbol); definitions.push(symbol);
      if (/^\s*export\b/.test(line)) exports.push({ name: declaration[1], path: relativePath, line: index + 1 });
    }
    const imported = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
    const required = line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/);
    if (imported || required) imports.push({ source: (imported || required)[1], path: relativePath, line: index + 1 });
    for (const reference of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) references.push({ name: reference[1], path: relativePath, line: index + 1 });
  });
  return {
    path: relativePath, hash: digest(content), symbols, imports, exports, definitions, references,
    capabilities: { symbols: true, imports: true, exports: true, definitions: true, references: true,
      typeResolution: false, guaranteedCallGraph: false, languages: ['javascript', 'typescript'] },
    unsupported: ['type resolution', 'guaranteed call graph', 'non-JavaScript/TypeScript languages'],
  };
}

async function buildIndex(rootInput, previous = null) {
  const root = await fs.realpath(rootInput);
  const files = [];
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const canonical = await fs.realpath(absolute);
        if (!inside(root, canonical) || canonical !== absolute) continue;
        await walk(canonical);
      }
      else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
    }
  };
  await walk(root);
  const old = previous?.files || {};
  const indexed = {};
  for (const absolute of files) {
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    const content = await fs.readFile(absolute, 'utf8');
    const oldEntry = old[relative];
    indexed[relative] = oldEntry?.hash === digest(content) ? oldEntry : parseSource(relative, content);
  }
  const cacheHits = files.filter((absolute) => {
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    return Boolean(old[relative] && old[relative].hash === indexed[relative].hash);
  }).length;
  return {
    root, createdAt: new Date().toISOString(), files: indexed,
    cacheHits,
    capabilities: { parser: 'deterministic-regex', typeResolution: false, guaranteedCallGraph: false,
      supportedExtensions: [...SUPPORTED] },
  };
}
function searchSymbols(index, query) {
  const normalized = String(query || '').toLowerCase();
  return Object.values(index.files).flatMap((file) => file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(normalized)).map((symbol) => ({ ...symbol, relationship: 'symbol' })));
}
function definitions(index, name) {
  return Object.values(index.files).flatMap((file) => file.definitions.filter((item) => item.name === name));
}
function relationships(index, name) {
  return Object.values(index.files).flatMap((file) => file.references.filter((item) => item.name === name).map((item) => ({ ...item, relationship: 'reference' })));
}
async function assertWithinRoot(rootInput, relativePath) {
  const root = await fs.realpath(rootInput);
  const lexical = path.resolve(root, String(relativePath || ''));
  if (!inside(root, lexical)) throw new Error('Path is outside the indexed root.');
  let target;
  try { target = await fs.realpath(lexical); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    target = await fs.realpath(path.dirname(lexical)).then((parent) => path.join(parent, path.basename(lexical)));
  }
  if (!inside(root, target)) throw new Error('Path is outside the indexed root.');
  return target;
}
module.exports = { SUPPORTED, parseSource, buildIndex, searchSymbols, definitions, relationships, inside, assertWithinRoot };
