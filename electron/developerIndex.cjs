const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPPORTED = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'logs', 'tmp', 'temp']);
const sensitiveNames = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt|cer|der)|id_rsa(?:\..*)?)$/i;
const sensitiveDirectories = new Set(['.ssh', '.aws', '.azure', '.config']);
function isIgnoredName(name) {
  const normalized = String(name || '').toLowerCase();
  return ignored.has(normalized) || normalized.startsWith('.developer-journal-') || normalized.endsWith('.log');
}
function isSensitivePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)
    .some((segment) => sensitiveDirectories.has(segment.toLowerCase()) || sensitiveNames.test(segment));
}
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const REPO_CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'tsconfig.app.json', 'vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'eslint.config.js', 'eslint.config.mjs', 'playwright.config.js', 'playwright.config.ts', 'README.md', 'README.MD', '.gitignore']);

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
    dependencyEdges: imports.map((item) => ({ from: relativePath, to: item.source, line: item.line })),
    capabilities: { symbols: true, imports: true, exports: true, definitions: true, references: true,
      typeResolution: false, guaranteedCallGraph: false, languages: ['javascript', 'typescript'] },
    unsupported: ['type resolution', 'guaranteed call graph', 'non-JavaScript/TypeScript languages'],
  };
}

async function readProjectMetadata(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nameLookup = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase()));
  const packageJsonPath = path.join(root, 'package.json');
  let packageJson = null;
  try {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  } catch {
    packageJson = null;
  }
  const languages = new Set();
  const featureHints = new Set();
  const entryPoints = [];
  const configFiles = [];
  const sourceDirectories = [];
  const testDirectories = [];
  const directoryNames = new Set();
  const walk = async (directory, depth = 0, maxDepth = 3) => {
    if (depth > maxDepth) return;
    let currentEntries;
    try { currentEntries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of currentEntries) {
      const normalizedName = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
        if (isIgnoredName(normalizedName) || isSensitivePath(relative) || normalizedName.startsWith('.')) continue;
        directoryNames.add(relative);
        if (['src', 'app', 'client', 'server', 'electron', 'scripts', 'tests', 'test', '__tests__', 'lib'].includes(entry.name)) {
          sourceDirectories.push(relative);
          if (entry.name === 'test' || entry.name === 'tests' || normalizedName.includes('test')) testDirectories.push(relative);
          if (entry.name === 'server' || entry.name === 'electron') featureHints.add(entry.name);
        }
        if (['test', 'tests', '__tests__'].includes(entry.name) || normalizedName.includes('test')) testDirectories.push(relative);
        if (depth < maxDepth) await walk(path.join(directory, entry.name), depth + 1, maxDepth);
      } else if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();
        const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
        if (lowerName.endsWith('.ts') || lowerName.endsWith('.tsx') || lowerName.endsWith('.js') || lowerName.endsWith('.jsx')) languages.add(lowerName.endsWith('.ts') || lowerName.endsWith('.tsx') ? 'typescript' : 'javascript');
        if (REPO_CONFIG_FILES.has(entry.name) || lowerName.endsWith('.config.js') || lowerName.endsWith('.config.ts') || lowerName.endsWith('.config.mjs') || lowerName.endsWith('.config.cjs')) configFiles.push(relative);
        if (entry.name === 'package.json' || entry.name === 'tsconfig.json' || entry.name === 'vite.config.ts' || entry.name === 'vite.config.js' || entry.name === 'electron' || relative.includes('/electron/')) featureHints.add(entry.name);
        if (['index.js', 'index.ts', 'main.js', 'main.ts', 'server.js', 'server.ts', 'preload.js', 'preload.cjs', 'electron/main.cjs'].includes(entry.name)) entryPoints.push(relative);
      }
    }
  };
  await walk(root, 0, 2);
  if (packageJson) {
    const depNames = Object.keys({ ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}), ...(packageJson.peerDependencies || {}) });
    if (depNames.some((name) => /react|next|vue|svelte/.test(name))) featureHints.add('ui-framework');
    if (depNames.some((name) => /electron|tauri/.test(name))) featureHints.add('desktop-app');
    if (depNames.some((name) => /express|koa|fastify|ws/.test(name))) featureHints.add('server-runtime');
    if (packageJson.scripts) {
      for (const [name, command] of Object.entries(packageJson.scripts)) {
        if (typeof command === 'string') {
          if (/vite|webpack|rollup|esbuild/.test(command)) featureHints.add('build-tool');
          if (/electron/.test(command)) featureHints.add('electron');
          if (/(test|vitest|jest|mocha|ava)/.test(command)) testDirectories.push('package.json');
        }
      }
    }
  }
  const packageManager = packageJson ? (
    nameLookup.has('pnpm-lock.yaml') ? 'pnpm' :
    nameLookup.has('yarn.lock') ? 'yarn' :
    nameLookup.has('package-lock.json') ? 'npm' : 'unknown'
  ) : 'unknown';
  const sourceSet = [...new Set(sourceDirectories)].slice(0, 32);
  if (sourceSet.length === 0 && (languages.size || entryPoints.length)) sourceSet.push('.');
  const priorityFiles = [...new Set([...configFiles, ...entryPoints, ...sourceSet].filter((value) => value && !value.startsWith('.')))].slice(0, 80);
  return {
    root,
    packageManager,
    packageScripts: packageJson?.scripts && typeof packageJson.scripts === 'object' ? { ...packageJson.scripts } : {},
    languages: [...languages].sort(),
    frameworks: [...featureHints].sort(),
    type: 'repository-map',
    entryPoints: [...new Set(entryPoints)].slice(0, 32),
    sourceDirectories: sourceSet,
    testDirectories: [...new Set(testDirectories)].slice(0, 32),
    configFiles: [...new Set(configFiles)].slice(0, 64),
    importantFiles: priorityFiles,
    directorySummary: [...new Set(directoryNames)].slice(0, 80),
    serverClientBoundary: {
      hasServer: sourceDirectories.some((directory) => directory.toLowerCase().includes('server')),
      hasClient: sourceDirectories.some((directory) => directory.toLowerCase().includes('src') || directory.toLowerCase().includes('client') || directory.toLowerCase().includes('ui')),
      hasElectron: sourceDirectories.some((directory) => directory.toLowerCase().includes('electron')),
    },
  };
}

async function buildRepositoryMap(rootInput, previous = null) {
  const root = await fs.realpath(rootInput);
  const metadata = await readProjectMetadata(root);
  const directorySummary = metadata.directorySummary;
  const structure = directorySummary.slice(0, 200).map((entry) => ({ path: entry, type: entry.includes('.') ? 'file' : 'directory' }));
  const scripts = metadata.packageScripts || {};
  const cacheKey = digest(JSON.stringify({ root, metadata }));
  return { root, generatedAt: new Date().toISOString(), cacheKey, ...metadata, scripts, structure, previousCacheHit: Boolean(previous && previous.cacheKey === cacheKey) };
}

async function buildIndex(rootInput, previous = null) {
  const root = await fs.realpath(rootInput);
  const files = [];
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (isIgnoredName(entry.name) || isSensitivePath(relative)) continue;
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
  const dependencyEdges = Object.values(indexed).flatMap((file) => file.dependencyEdges || []);
  const dependencyGraph = {
    nodes: Object.keys(indexed),
    edges: dependencyEdges.slice(0, 2000),
    capabilities: { staticImports: true, resolvedPaths: false, dynamicImports: false },
  };
  const cacheHits = files.filter((absolute) => {
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    return Boolean(old[relative] && old[relative].hash === indexed[relative].hash);
  }).length;
  return {
    root, createdAt: new Date().toISOString(), files: indexed,
    cacheHits,
    capabilities: { parser: 'deterministic-regex', typeResolution: false, guaranteedCallGraph: false,
      supportedExtensions: [...SUPPORTED] },
    dependencyGraph,
    repositoryMap: await buildRepositoryMap(root),
  };
}
function searchSymbols(index, query) {
  const normalized = String(query || '').toLowerCase();
  if (!normalized) return [];
  return Object.values(index.files).flatMap((file) => file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(normalized)).map((symbol) => ({ ...symbol, relationship: 'symbol' }))).slice(0, 100);
}
function definitions(index, name) {
  return Object.values(index.files).flatMap((file) => file.definitions.filter((item) => item.name === name));
}
function relationships(index, name) {
  return Object.values(index.files).flatMap((file) => file.references.filter((item) => item.name === name).map((item) => ({ ...item, relationship: 'reference' })));
}
function findReferences(index, query) {
  const normalized = String(query || '').trim();
  if (!normalized) return [];
  const matches = [];
  for (const file of Object.values(index.files)) {
    for (const item of file.definitions) {
      if (item.name === normalized) matches.push({ symbol: item.name, kind: item.kind, file: item.path, line: item.line, relationship: 'definition' });
    }
    for (const item of file.references) {
      if (item.name === normalized) matches.push({ symbol: item.name, kind: 'reference', file: item.path, line: item.line, relationship: 'reference' });
    }
  }
  return matches.slice(0, 100);
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
module.exports = { SUPPORTED, parseSource, buildIndex, buildRepositoryMap, searchSymbols, definitions, relationships, findReferences, inside, assertWithinRoot, isIgnoredName, isSensitivePath };
