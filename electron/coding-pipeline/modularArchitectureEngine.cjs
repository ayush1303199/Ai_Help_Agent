'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const http = require('node:http');
const { isBuiltin } = require('node:module');
const { isProjectRuntimeTestRequest } = require('./projectRuntimeTestIntent.cjs');

let typescriptParser = null;
try {
  typescriptParser = require('typescript');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
}

function hash(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function containsQuotedValue(source, value) {
  return String(source || '').includes(JSON.stringify(value))
    || String(source || '').includes(`'${value}'`);
}

function containsRequire(source, specifier) {
  return String(source || '').includes(`require(${JSON.stringify(specifier)})`)
    || String(source || '').includes(`require('${specifier}')`);
}

function validateRoutePath(value) {
  if (typeof value !== 'string') throw new Error('Route path must be a string.');
  const routePath = value.trim();
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(routePath);
  } catch {
    throw new Error('Route path contains invalid percent encoding.');
  }
  if (!routePath.startsWith('/')
    || routePath.startsWith('//')
    || /[\\?#\u0000-\u001f\u007f]/.test(routePath)
    || decodedPath.split('/').some((segment) => segment === '..')) {
    throw new Error('Route path must be an origin-relative path without traversal or query data.');
  }
  return routePath;
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Validates that a proposed relative path is safe and stays inside project root.
 */
function validateSafePath(root, relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Relative path must be a non-empty string.');
  }
  const norm = normalizePath(relativePath);
  if (path.isAbsolute(norm) || norm.split('/').some((segment) => segment === '..')) {
    throw new Error(`Target path [${relativePath}] escapes the project root.`);
  }
  const resolved = path.resolve(root, ...norm.split('/').filter(Boolean));
  if (resolved !== root && !inside(root, resolved)) {
    throw new Error(`Resolved path [${resolved}] is outside the project root [${root}].`);
  }
  return norm;
}

/**
 * Checks whether a workspace is genuinely greenfield (empty or only .git).
 */
async function isGreenfieldWorkspace(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const relevant = entries.filter((e) => {
      const name = e.name.toLowerCase();
      return name !== '.git' && name !== '.ds_store' && name !== 'thumbs.db';
    });
    return relevant.length === 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    throw err;
  }
}

/**
 * Discovers existing project conventions, languages, and existing shared modules.
 */
async function discoverProjectConventions(root) {
  const conventions = {
    isGreenfield: false,
    language: 'javascript',
    entrypoints: [],
    serviceDirs: [],
    utilDirs: [],
    modelDirs: [],
    existingSharedModules: new Map(), // name -> relativePath
  };

  const isGreenfield = await isGreenfieldWorkspace(root);
  conventions.isGreenfield = isGreenfield;
  if (isGreenfield) {
    return conventions;
  }

  // Scan root and standard subdirectories
  const knownEntryNames = ['index.js', 'app.js', 'main.js', 'server.js', 'index.ts', 'main.py', 'app.py', 'index.php'];
  try {
    const rootEntries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of rootEntries) {
      const normName = entry.name.toLowerCase();
      if (entry.isFile() && knownEntryNames.includes(normName)) {
        conventions.entrypoints.push(entry.name);
      }
      if (entry.isDirectory()) {
        if (normName === 'services' || normName === 'service') conventions.serviceDirs.push(entry.name);
        if (normName === 'utils' || normName === 'util' || normName === 'lib') conventions.utilDirs.push(entry.name);
        if (normName === 'models' || normName === 'model') conventions.modelDirs.push(entry.name);
        if (normName === 'src') {
          // Check inside src
          try {
            const srcEntries = await fs.readdir(path.join(root, 'src'), { withFileTypes: true });
            for (const sEntry of srcEntries) {
              const sNorm = sEntry.name.toLowerCase();
              if (sEntry.isFile() && knownEntryNames.includes(sNorm)) {
                conventions.entrypoints.push(`src/${sEntry.name}`);
              }
              if (sEntry.isDirectory()) {
                if (sNorm === 'services') conventions.serviceDirs.push(`src/${sEntry.name}`);
                if (sNorm === 'utils' || sNorm === 'lib') conventions.utilDirs.push(`src/${sEntry.name}`);
                if (sNorm === 'models') conventions.modelDirs.push(`src/${sEntry.name}`);
              }
            }
          } catch {
            // Ignore unreadable src
          }
        }
      }
    }
  } catch {
    // Ignore scan errors
  }

  // Check language from files
  try {
    const hasPackageJson = await fs.stat(path.join(root, 'package.json')).then((s) => s.isFile()).catch(() => false);
    const hasTsConfig = await fs.stat(path.join(root, 'tsconfig.json')).then((s) => s.isFile()).catch(() => false);
    const hasRequirements = await fs.stat(path.join(root, 'requirements.txt')).then((s) => s.isFile()).catch(() => false);
    const hasComposer = await fs.stat(path.join(root, 'composer.json')).then((s) => s.isFile()).catch(() => false);

    if (hasTsConfig) conventions.language = 'typescript';
    else if (hasPackageJson) conventions.language = 'javascript';
    else if (hasRequirements) conventions.language = 'python';
    else if (hasComposer) conventions.language = 'php';
  } catch {
    // Fallback to javascript
  }

  // Discover existing shared modules in utilDirs
  for (const utilDir of conventions.utilDirs) {
    try {
      const files = await fs.readdir(path.join(root, utilDir), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && !file.name.endsWith('.test.js') && !file.name.endsWith('.spec.js')) {
          const baseName = path.parse(file.name).name.toLowerCase();
          conventions.existingSharedModules.set(baseName, `${utilDir}/${file.name}`);
        }
      }
    } catch {
      // Ignore
    }
  }

  return conventions;
}

/**
 * Derives a modular architecture plan with separation of responsibilities:
 * - Core business logic
 * - Shared utilities
 * - Data models / schemas
 * - Integration points (entrypoint / router / consumer)
 */

/**
 * Extracts the primary domain entity name dynamically from a request without hardcoding.
 */
function extractEntityFromRequest(userRequest) {
  const text = String(userRequest || '').trim();
  // 1. Quoted literals: e.g. 'Add Order', "Order", 'User Profile', `Product`
  const quoteMatch = text.match(/['"`](?:(?:add|create|new|build|implement)\s+)?([A-Za-z0-9_-]+)(?:\s+feature|\s+system|\s+module)?['"`]/i);
  if (quoteMatch && quoteMatch[1]) {
    const candidate = quoteMatch[1].trim();
    if (!['the', 'a', 'an', 'app', 'code', 'all'].includes(candidate.toLowerCase())) {
      return cleanEntityName(candidate);
    }
  }
  // 2. Directive followed by entity: build a complete <Entity> feature
  const directiveMatch = text.match(/\b(?:build|create|implement|add)\s+(?:a|an|the)?\s*(?:complete\s+)?['"]?([A-Za-z0-9_-]+)['"]?(?:\s+feature|\s+system|\s+module|\s+service|\s+api)?/i);
  if (directiveMatch && directiveMatch[1]) {
    const candidate = directiveMatch[1].trim();
    const skip = ['a', 'an', 'the', 'complete', 'expert', 'full-stack', 'fullstack', 'clean', 'modular', 'new', 'custom', 'simple', 'code', 'snippet', 'snippets'];
    if (!skip.includes(candidate.toLowerCase())) {
      return cleanEntityName(candidate);
    }
  }
  // 3. Fallback to entity before feature/module
  const featureMatch = text.match(/\b([A-Za-z0-9_-]+)\s+(?:feature|module|system|service|api)\b/i);
  if (featureMatch && featureMatch[1]) {
    const candidate = featureMatch[1].trim();
    const skip = ['complete', 'expert', 'full-stack', 'fullstack', 'clean', 'modular', 'this', 'that', 'same', 'following', 'new'];
    if (!skip.includes(candidate.toLowerCase())) {
      return cleanEntityName(candidate);
    }
  }
  return 'Item';
}

function cleanEntityName(name) {
  const cleaned = String(name || '').replace(/^(?:add|create|new|build|implement)\s+/i, '').replace(/[^A-Za-z0-9_]/g, '');
  if (!cleaned) return 'Item';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractRequestedRoute(text) {
  const source = String(text || '');
  const match = source.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_/:.-]*)/i)
    || source.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(?:API\s+)?(?:endpoint|route)\s+(?:at\s+)?(\/[A-Za-z0-9_/:.-]*)/i)
    || source.match(/(\/(?:api\/)?[A-Za-z0-9_:-]+(?:\/[A-Za-z0-9_:-]+)*)\s*(?:\((GET|POST|PUT|PATCH|DELETE)\)|[-,;:]?\s*(?:using|via|with\s+method)\s+(GET|POST|PUT|PATCH|DELETE)\b)/i);
  if (!match) return null;
  const routeFirst = match[1].startsWith('/');
  const method = (routeFirst ? match[2] || match[3] : match[1]).toUpperCase();
  const routeValue = routeFirst ? match[1] : match[3] || match[2];
  const routePath = validateRoutePath(routeValue.replace(/[.,;]+$/, '').replace(/\/+$/, '') || '/');
  return { method, path: routePath };
}

function isFullStackBuildRequest(text) {
  const source = String(text || '');
  const hasBuildDirective = /\b(?:build|create|implement|scaffold|generate|develop|add)\b/i.test(source);
  const hasApiContract = /\/api\/[A-Za-z0-9_/:.-]+|\b(?:api\s+endpoint|endpoint|api\s+route|http\s+route)\b/i.test(source);
  const hasDataContract = /\b(?:model|schema|fields?|database|data\s+model)\b/i.test(source);
  const hasUiContract = /\b(?:front[ -]?end|ui|form|page|component|client|react|next\.?js|vue|angular|svelte|html)\b/i.test(source);
  return hasBuildDirective && hasApiContract && hasDataContract && hasUiContract;
}

function buildBehavioralTestSource(route, routeSchema) {
  const fields = routeSchema.fields || [];
  const payload = buildRuntimePayload(fields);
  const computedTotal = fields.find((field) => (
    field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
  ));
  const lineItems = fields.find((field) => (
    field.type === 'array'
      && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
      && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name))
  ));
  const expectedTotal = computedTotal && lineItems
    ? payload[lineItems.name].reduce((sum, item) => {
        const priceName = lineItems.items.find((item) => /(?:price|cost|amount)/i.test(item.name)).name;
        const quantityName = lineItems.items.find((item) => /(?:quantity|count|units)/i.test(item.name)).name;
        return sum + Number(item[priceName]) * Number(item[quantityName]);
      }, 0)
    : null;
  const defaultStatus = fields.find((field) => field.name.toLowerCase() === 'status' && field.hasDefault);
  const scalar = fields.find((field) => field.required && field.type !== 'array');
  const arrayField = fields.find((field) => field.type === 'array');
  const invalidItem = lineItems
    ? lineItems.items.find((item) => /(?:price|cost|amount)/i.test(item.name) && item.type === 'number')
      || lineItems.items.find((item) => item.type === 'number')
    : null;
  const apiPath = route.path;
  const uiPath = `/${apiPath.split('/').filter(Boolean).at(-1) || ''}`;
  const testText = (value) => JSON.stringify(value);
  return `'use strict';

(async () => {
const a = (await import('node:assert/strict')).default, h = await import('node:http');
const [m, c, r, s] = await Promise.all([
  import(${testText(`../${route.modelFile}`)}), import(${testText(`../${route.controllerFile}`)}),
  import(${testText(`../${route.targetFile}`)}), import(${testText(`../${route.integrationFile}`)}),
]);
const e = (x) => x.default && typeof x.default === 'object' ? x.default : x;
const model = e(m), controller = e(c), routes = e(r), app = e(s).createApplication();
const payload = ${testText(payload)};
const req = (method, url, body) => new Promise((ok, no) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  const q = h.request({ host: '127.0.0.1', port: app.address().port, path: url, method,
    headers: text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {},
  }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'] || '',
      text: Buffer.concat(chunks).toString('utf8') })); });
  q.once('error', no); if (text) q.write(text); q.end();
});
 a.equal(typeof model.validate, 'function');
 a.equal(typeof routes.registerRoutes, 'function');
await new Promise((ok, no) => { app.once('error', no); app.listen(0, '127.0.0.1', ok); });
try {
  a.equal((await req('GET', '/')).status, 200);
  const ui = await req('GET', ${testText(uiPath)});
  a.equal(ui.status, 200); a.match(ui.type, /^text\\/html/i); a.match(ui.text, /<form\\b/i);
  const made = await req(${testText(route.method)}, ${testText(apiPath)}, payload);
  a.equal(made.status, ${route.method === 'POST' ? 201 : 200}, made.text);
  const record = JSON.parse(made.text).data;
  ${computedTotal && lineItems ? `a.equal(Number(record[${testText(computedTotal.name)}]), ${expectedTotal});` : ''}
  ${defaultStatus ? `a.equal(record[${testText(defaultStatus.name)}], ${testText(defaultStatus.defaultValue)});` : ''}
  const list = await req('GET', ${testText(apiPath)});
  a.equal(list.status, 200); a.ok(JSON.parse(list.text).data.some((item) => item.id === record.id));
  ${scalar ? `a.equal((await req(${testText(route.method)}, ${testText(apiPath)}, { ...payload, [${testText(scalar.name)}]: '   ' })).status, 400);` : ''}
  ${arrayField ? `a.equal((await req(${testText(route.method)}, ${testText(apiPath)}, { ...payload, [${testText(arrayField.name)}]: [] })).status, 400);` : ''}
  ${lineItems && invalidItem ? `const bad = structuredClone(payload); bad[${testText(lineItems.name)}][0][${testText(invalidItem.name)}] = -1; a.equal((await req(${testText(route.method)}, ${testText(apiPath)}, bad)).status, 400);` : ''}
  const failure = await controller[${testText(route.controllerHandler)}](Object.defineProperty({}, 'body', {
    get() { throw new Error('Simulated request read failure.'); },
  }));
  a.equal(failure.status, 500); a.equal(typeof failure.body?.error, 'string');
  console.log('Loopback UI, API behavior, persistence, and controller error boundary passed.');
} finally {
  await new Promise((ok, no) => app.close((error) => error ? no(error) : ok()));
}
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
}

function extractRequestedFields(text) {
  const fields = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?([A-Za-z_$][\w$]*)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const declaration = match[2];
    if (!declaration.trim()) continue;
    const nested = declaration.match(/^(?:array\s*(?:of\s*)?)?\[\s*\{([\s\S]*)\}\s*\]$/i)
      || declaration.match(/^array\s*<\s*\{([\s\S]*)\}\s*>$/i);
    const declaredType = (declaration.match(/^(string|number|boolean|integer|date|email|array|object)\b/i)?.[1]
      || (nested ? 'array' : 'string')).toLowerCase();
    const type = declaredType === 'integer' ? 'number' : declaredType;
    const metadata = `${declaration} ${line}`;
    const defaultMatch = metadata.match(/\bdefault(?:\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|true|false|null|-?\d+(?:\.\d+)?|[A-Za-z][\w-]*)/i);
    let defaultValue = null;
    if (defaultMatch) {
      const literal = defaultMatch[1];
      try {
        defaultValue = literal.startsWith("'")
          ? literal.slice(1, -1)
          : JSON.parse(literal);
      } catch {
        defaultValue = literal;
      }
    }
    const items = nested
      ? [...nested[1].matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*(string|number|boolean|integer|date|email))?/gi)]
        .map(([, itemName, itemType]) => ({
          name: itemName,
          type: String(itemType || 'string').toLowerCase() === 'integer'
            ? 'number'
            : String(itemType || 'string').toLowerCase(),
          required: /\brequired\b/i.test(nested[1].slice(nested[1].indexOf(itemName) + itemName.length, nested[1].indexOf(itemName) + itemName.length + 40)),
        }))
      : [];
    fields.push({
      name,
      type,
      required: /\brequired\b/i.test(metadata),
      hasDefault: Boolean(defaultMatch),
      defaultValue,
      ...(items.length ? { items } : {}),
    });
  }
  if (fields.length === 0) {
    const inlineFields = String(text || '').match(/\bfields?\s*(?:include|are|:)\s*([^\r\n.]+)/i)?.[1] || '';
    for (const match of inlineFields.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*(string|number|boolean|integer|date|email|array|object))?([^,]*)/gi)) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const declaration = `${match[2] || ''} ${match[3] || ''}`;
      fields.push({
        name,
        type: /array/i.test(declaration) ? 'array'
          : /number|integer/i.test(declaration) ? 'number'
            : /boolean/i.test(declaration) ? 'boolean' : 'string',
        required: /\brequired\b/i.test(declaration),
        hasDefault: false,
        defaultValue: null,
        items: [],
      });
    }
  }
  return fields;
}

function pascalCaseIdentifier(value) {
  const words = String(value || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const combined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return /^[A-Z]/.test(combined) ? combined : `Resource${combined}`;
}

async function inspectWorkspaceFiles(root, maxEntries = 2500) {
  const files = [];
  let entriesScanned = 0;
  let truncated = false;
  const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
  async function visit(directory, relative = '', depth = 0) {
    if (depth > 6 || truncated) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesScanned += 1;
      if (entriesScanned > maxEntries) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name.toLowerCase())) {
          await visit(path.join(directory, entry.name), entryPath, depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await visit(root);
  return { files, entriesScanned, truncated };
}

async function existingFile(root, relative) {
  try {
    const stat = await fs.stat(path.join(root, ...relative.split('/')));
    return stat.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function existingPath(root, relative) {
  try {
    await fs.lstat(path.join(root, ...relative.split('/')));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function matchingWorkspaceFile(files, predicate) {
  return files.find((file) => predicate(file.replace(/\\/g, '/').toLowerCase())) || null;
}

function isPlaceholderModule(content) {
  const normalized = String(content || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '')
    .trim();
  return !normalized
    || (normalized.length <= 256
      && /\bexecuteFeature\b/.test(normalized)
      && /\b(?:sharedUtils|featureService)\b/i.test(normalized)
      && /require\s*\(/.test(normalized))
    || /^(?:export\s+default\s+)?function\s+\w+\s*\([^)]*\)\s*\{\s*(?:return\s+(?:null|undefined|false)\s*;?)?\s*\}\s*;?$/i.test(normalized)
    || /^(?:(?:export\s+default\s+)?(?:function|class)\s+\w+\s*\([^)]*\)\s*\{\s*(?:\/\/\s*)?(?:TODO|implement|not implemented)[^}]*\}\s*;?|module\.exports\s*=\s*\{\s*\}\s*;?)$/i.test(normalized);
}

async function readWorkspaceFile(root, relative) {
  try {
    return await fs.readFile(path.join(root, ...relative.split('/')), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function fieldValidationCode(fields) {
  const lines = [];
  for (const field of fields) {
    const fieldKey = JSON.stringify(field.name);
    if (field.required) {
      if (field.type === 'string') {
        lines.push(`  if (typeof payload[${fieldKey}] !== 'string' || payload[${fieldKey}].trim() === '') errors.push(${JSON.stringify(`${field.name} is required.`)});`);
      } else {
        lines.push(`  if (payload[${fieldKey}] === undefined || payload[${fieldKey}] === null || payload[${fieldKey}] === '') errors.push(${JSON.stringify(`${field.name} is required.`)});`);
      }
    }
    if (field.type === 'array') {
      lines.push(`  if (payload[${fieldKey}] !== undefined && !Array.isArray(payload[${fieldKey}])) errors.push(${JSON.stringify(`${field.name} must be an array.`)});`);
      if (field.items?.length) {
        lines.push(`  if (Array.isArray(payload[${fieldKey}]) && payload[${fieldKey}].length === 0) errors.push(${JSON.stringify(`${field.name} must contain at least one item.`)});`);
        lines.push(`  if (Array.isArray(payload[${fieldKey}])) payload[${fieldKey}].forEach((item, index) => {`);
        lines.push(`    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(${JSON.stringify(`${field.name}[item] must be an object.`)}); return; }`);
        for (const itemField of field.items) {
          const itemKey = JSON.stringify(itemField.name);
          if (itemField.required || itemField.type === 'string') {
            if (itemField.type === 'string') {
              lines.push(`    if (typeof item[${itemKey}] !== 'string' || item[${itemKey}].trim() === '') errors.push(${JSON.stringify(`${field.name}[${itemField.name}] is required at index `)} + index + '.');`);
            } else {
              lines.push(`    if (item[${itemKey}] === undefined || item[${itemKey}] === null || item[${itemKey}] === '') errors.push(${JSON.stringify(`${field.name}[${itemField.name}] is required at index `)} + index + '.');`);
            }
          }
          if (itemField.type === 'number') {
            lines.push(`    if (item[${itemKey}] === undefined || item[${itemKey}] === null || item[${itemKey}] === '' || !Number.isFinite(Number(item[${itemKey}]))) errors.push(${JSON.stringify(`${field.name}[${itemField.name}] must be a finite number at index `)} + index + '.');`);
            if (/(?:quantity|count|units)/i.test(itemField.name)) {
              lines.push(`    else if (Number(item[${itemKey}]) <= 0) errors.push(${JSON.stringify(`${field.name}[${itemField.name}] must be greater than zero at index `)} + index + '.');`);
            } else if (/(?:price|cost|amount)/i.test(itemField.name)) {
              lines.push(`    else if (Number(item[${itemKey}]) < 0) errors.push(${JSON.stringify(`${field.name}[${itemField.name}] must not be negative at index `)} + index + '.');`);
            }
          }
        }
        lines.push('  });');
      }
    } else if (field.type === 'number') {
      lines.push(`  if (payload[${fieldKey}] !== undefined && payload[${fieldKey}] !== null && payload[${fieldKey}] !== '' && !Number.isFinite(Number(payload[${fieldKey}]))) errors.push(${JSON.stringify(`${field.name} must be a finite number.`)});`);
    } else if (field.type === 'boolean') {
      lines.push(`  if (payload[${fieldKey}] !== undefined && typeof payload[${fieldKey}] !== 'boolean' && payload[${fieldKey}] !== 'true' && payload[${fieldKey}] !== 'false') errors.push(${JSON.stringify(`${field.name} must be a boolean.`)});`);
    }
  }
  return lines.join('\n');
}

function buildRequestedFormFields(fields) {
  return fields.map((field) => {
    if (field.type === 'array') {
      const itemFields = field.items || [];
      return `      <fieldset key=${JSON.stringify(field.name)}><legend>${field.name}</legend>
        {(form[${JSON.stringify(field.name)}] || []).map((item, index) => <div key={index} className="flex flex-wrap gap-2">
${itemFields.map((itemField) => `          <label><span>${itemField.name}</span><input type=${JSON.stringify(itemField.type === 'number' ? 'number' : 'text')} value={item[${JSON.stringify(itemField.name)}] ?? ''} onChange={(event) => updateArrayField(${JSON.stringify(field.name)}, index, ${JSON.stringify(itemField.name)}, event.target.value)} /></label>`).join('\n')}
          <button type="button" onClick={() => removeArrayItem(${JSON.stringify(field.name)}, index)}>Remove</button>
        </div>)}
        <button type="button" onClick={() => addArrayItem(${JSON.stringify(field.name)}, ${JSON.stringify(Object.fromEntries(itemFields.map((itemField) => [itemField.name, ''])) )})}>Add item</button>
      </fieldset>`;
    }
    return `      <label key=${JSON.stringify(field.name)}><span>${field.name}</span><input name=${JSON.stringify(field.name)} type=${JSON.stringify(field.type === 'number' ? 'number' : 'text')} value={form[${JSON.stringify(field.name)}] ?? ''} onChange={(event) => setForm((current) => ({ ...current, [${JSON.stringify(field.name)}]: event.target.value }))} ${field.required ? 'required' : ''} /></label>`;
  }).join('\n');
}

function completeFullStackFields(fields) {
  const complete = fields.map((field) => ({ ...field, items: field.items?.map((item) => ({ ...item })) }));
  let status = complete.find((field) => field.name.toLowerCase() === 'status');
  const transactional = complete.some((field) => field.type === 'array' && field.items?.length)
    && complete.some((field) => field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name));
  if (!status && transactional) {
    status = { name: 'status', type: 'string', required: false, hasDefault: true, defaultValue: 'Pending' };
    complete.push(status);
  } else if (status && !status.hasDefault) {
    status.hasDefault = true;
    status.defaultValue = 'Pending';
  }
  if ((status || transactional) && !complete.some((field) => /^(?:createdAt|createdOn)$/i.test(field.name))) {
    complete.push({ name: 'createdAt', type: 'date', required: false, hasDefault: false, defaultValue: null });
  }
  return complete;
}

function buildClientValidation(fields) {
  const checks = [];
  for (const field of fields) {
    const fieldKey = JSON.stringify(field.name);
    if (field.required && field.type === 'string') {
      checks.push(`    if (typeof form[${fieldKey}] !== 'string' || form[${fieldKey}].trim() === '') clientErrors.push(${JSON.stringify(`${field.name} is required.`)});`);
    }
    if (field.type === 'array' && field.items?.length) {
      checks.push(`    if (!Array.isArray(form[${fieldKey}]) || form[${fieldKey}].length === 0) clientErrors.push(${JSON.stringify(`${field.name} must contain at least one item.`)});`);
      checks.push(`    for (const [index, item] of (Array.isArray(form[${fieldKey}]) ? form[${fieldKey}] : []).entries()) {`);
      for (const item of field.items) {
        const itemKey = JSON.stringify(item.name);
        if (item.type === 'string') {
          checks.push(`      if (typeof item[${itemKey}] !== 'string' || item[${itemKey}].trim() === '') clientErrors.push(${JSON.stringify(`${field.name}[${item.name}] is required at index `)} + index + '.');`);
        } else if (item.type === 'number') {
          checks.push(`      if (item[${itemKey}] === undefined || item[${itemKey}] === null || item[${itemKey}] === '' || !Number.isFinite(Number(item[${itemKey}]))) clientErrors.push(${JSON.stringify(`${field.name}[${item.name}] must be a finite number at index `)} + index + '.');`);
          if (/(?:quantity|count|units)/i.test(item.name)) {
            checks.push(`      else if (Number(item[${itemKey}]) <= 0) clientErrors.push(${JSON.stringify(`${field.name}[${item.name}] must be greater than zero at index `)} + index + '.');`);
          } else if (/(?:price|cost|amount)/i.test(item.name)) {
            checks.push(`      else if (Number(item[${itemKey}]) < 0) clientErrors.push(${JSON.stringify(`${field.name}[${item.name}] must not be negative at index `)} + index + '.');`);
          }
        }
      }
      checks.push('    }');
    }
  }
  return checks.join('\n');
}

function buildComputedTotalPreview(fields) {
  const computedTotal = fields.find((field) => (
    field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
  ));
  const lineItems = fields.find((field) => (
    field.type === 'array'
      && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
      && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name))
  ));
  if (!computedTotal || !lineItems) return '';
  const priceField = lineItems.items.find((item) => /(?:price|cost|amount)/i.test(item.name)).name;
  const quantityField = lineItems.items.find((item) => /(?:quantity|count|units)/i.test(item.name)).name;
  const expression = `(form[${JSON.stringify(lineItems.name)}] || []).reduce((sum, item) => sum + Number(item[${JSON.stringify(priceField)}] || 0) * Number(item[${JSON.stringify(quantityField)}] || 0), 0)`;
  return `    <output aria-live="polite" data-calculated-total={${expression}}>{${JSON.stringify(`${computedTotal.name}: `)}}{${expression}}</output>\n`;
}

function buildStandalonePreviewHtml({ entityPascal, fields, route }) {
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
  const calculatedTotal = fields.find((field) => (
    field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
  ));
  const lineItems = fields.find((field) => (
    field.type === 'array'
      && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
      && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name))
  ));
  const scalarFields = fields.filter((field) => field.type !== 'array'
    && field.name !== calculatedTotal?.name
    && !/^(?:id|createdAt|createdOn)$/i.test(field.name));
  const scalarInputs = scalarFields.map((field) => {
    const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
    const required = field.required ? ' required' : '';
    const value = field.hasDefault ? ` value="${escapeHtml(field.defaultValue)}"` : '';
    const name = escapeHtml(field.name);
    return `<label class="field"><span>${name}</span><input name="${name}" data-scalar="${name}" type="${inputType}"${required}${value}></label>`;
  }).join('\n');
  const arrayInputs = fields.filter((field) => field.type === 'array').map((field) => (
    `<fieldset class="items"><legend>${escapeHtml(field.name)}</legend><div data-array="${escapeHtml(field.name)}"></div><button class="secondary" type="button" data-add="${escapeHtml(field.name)}">Add item</button></fieldset>`
  )).join('\n');
  const itemFieldMetadata = Object.fromEntries(fields.filter((field) => field.type === 'array').map((field) => [
    field.name,
    (field.items || []).map((item) => ({ name: item.name, type: item.type })),
  ]));
  const initialItemMetadata = JSON.stringify(itemFieldMetadata).replace(/</g, '\\u003c');
  const totalPreview = calculatedTotal && lineItems
    ? `<p class="total">${calculatedTotal.name}: <output data-total>0</output></p>`
    : '';
  const js = `(() => {
  const itemFields = ${initialItemMetadata};
  const form = document.querySelector('form');
  const toast = document.querySelector('[role="status"]');
  const error = document.querySelector('[role="alert"]');
  const button = form.querySelector('button[type="submit"]');
  function addItem(name) {
    const host = document.querySelector('[data-array="' + name + '"]');
    const row = document.createElement('div');
    row.className = 'item-row';
    for (const field of itemFields[name] || []) {
      const label = document.createElement('label');
      label.className = 'field';
      label.textContent = field.name;
      const input = document.createElement('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      input.dataset.field = field.name;
      input.addEventListener('input', updateTotal);
      label.append(input);
      row.append(label);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => { row.remove(); updateTotal(); });
    row.append(remove);
    host.append(row);
    updateTotal();
  }
  function updateTotal() {
    const output = document.querySelector('[data-total]');
    if (!output) return;
    const priceKey = ${JSON.stringify(lineItems?.items?.find((item) => /(?:price|cost|amount)/i.test(item.name))?.name || '')};
    const quantityKey = ${JSON.stringify(lineItems?.items?.find((item) => /(?:quantity|count|units)/i.test(item.name))?.name || '')};
    const host = document.querySelector('[data-array="${lineItems?.name || ''}"]');
    output.value = host ? [...host.querySelectorAll('.item-row')].reduce((sum, row) => {
      const price = Number(row.querySelector('[data-field="' + priceKey + '"]')?.value || 0);
      const quantity = Number(row.querySelector('[data-field="' + quantityKey + '"]')?.value || 0);
      return sum + price * quantity;
    }, 0).toFixed(2) : '0.00';
  }
  for (const name of Object.keys(itemFields)) {
    document.querySelector('[data-add="' + name + '"]').addEventListener('click', () => addItem(name));
    addItem(name);
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    toast.textContent = '';
    error.textContent = '';
    button.disabled = true;
    button.textContent = 'Saving...';
    try {
      const payload = {};
      for (const input of form.querySelectorAll('[data-scalar]')) {
        payload[input.dataset.scalar] = input.type === 'number' ? Number(input.value) : input.value;
      }
      for (const [name] of Object.entries(itemFields)) {
        payload[name] = [...document.querySelectorAll('[data-array="' + name + '"] .item-row')].map((row) => {
          const item = {};
          for (const input of row.querySelectorAll('[data-field]')) {
            item[input.dataset.field] = input.type === 'number' ? Number(input.value) : input.value;
          }
          return item;
        });
      }
      const response = await fetch(${JSON.stringify(route.path)}, {
        method: ${JSON.stringify(route.method)},
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || result.errors?.join(', ') || 'Request failed.');
      toast.textContent = 'Saved successfully.';
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : 'Request failed.';
    } finally {
      button.disabled = false;
      button.textContent = 'Add ${entityPascal}';
    }
  });
})();`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Add ${entityPascal}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f1f5f9; color: #0f172a; }
    * { box-sizing: border-box; } body { margin: 0; padding: 2rem 1rem; }
    main { max-width: 48rem; margin: 0 auto; } .card { background: white; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 12px 32px #0f172a12; }
    h1 { margin-top: 0; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
    .field { display: grid; gap: .4rem; margin: .5rem 0; font-weight: 600; } input { width: 100%; padding: .7rem; border: 1px solid #cbd5e1; border-radius: .5rem; font: inherit; }
    button { border: 0; border-radius: .55rem; padding: .75rem 1rem; background: #2563eb; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .65; cursor: wait; } .secondary { background: #e2e8f0; color: #0f172a; }
    .items { border: 1px solid #e2e8f0; border-radius: .75rem; padding: 1rem; margin: 1rem 0; } .item-row { display: grid; grid-template-columns: repeat(auto-fit,minmax(8rem,1fr)); align-items: end; gap: .75rem; margin: .75rem 0; }
    .total { font-size: 1.15rem; font-weight: 700; } [role="alert"] { color: #b91c1c; } [role="status"] { color: #15803d; }
  </style>
</head>
<body><main><section class="card">
  <h1>Add ${entityPascal}</h1>
  <form><div class="grid">${scalarInputs}</div>${arrayInputs}${totalPreview}
    <button type="submit">Add ${entityPascal}</button>
    <p role="alert" aria-live="assertive"></p><p role="status" aria-live="polite"></p>
  </form>
</section></main><script>${js}</script></body>
</html>`;
}

async function findLegacyPagesRouteConflicts(root, appPagePath) {
  const appSegments = appPagePath.replace(/^app\//, '').split('/');
  if (appSegments.at(-1).match(/^page\.[jt]sx?$/i)) appSegments.pop();
  const appRoute = appSegments
    .filter((segment) => !/^\([^)]*\)$/.test(segment))
    .map((segment) => segment.replace(/^\[\[\.\.\..+\]\]$/, '[]').replace(/^\[\.\.\..+\]$/, '[]').replace(/^\[.+\]$/, '[]'))
    .join('/')
    .toLowerCase();
  const pagesRoot = path.join(root, 'pages');
  const conflicts = [];
  const walk = async (directory, relative = '') => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), childRelative);
        continue;
      }
      if (!entry.isFile() || !/\.[jt]sx?$/i.test(entry.name)) continue;
      const withoutExtension = childRelative.replace(/\.[^.]+$/, '');
      const routeSegments = withoutExtension.split('/');
      if (['index', 'page'].includes(routeSegments.at(-1).toLowerCase())) routeSegments.pop();
      const legacyRoute = routeSegments
        .filter((segment) => !/^\([^)]*\)$/.test(segment))
        .map((segment) => segment.replace(/^\[\[\.\.\..+\]\]$/, '[]').replace(/^\[\.\.\..+\]$/, '[]').replace(/^\[.+\]$/, '[]'))
        .join('/')
        .toLowerCase();
      if (legacyRoute === appRoute) conflicts.push(`pages/${childRelative}`);
    }
  };
  await walk(pagesRoot);
  return conflicts.sort();
}

async function deriveRequestedFullStackPlan(root, conventions, userRequest, requirements) {
  const text = [userRequest, ...(Array.isArray(requirements) ? requirements : [])].join('\n');
  const fullStackIntent = isFullStackBuildRequest(text);
  const requestedResolution = String(userRequest || '')
    .match(/\bworkspace resolution\s*:\s*(UPDATE_AND_INTEGRATE|REPLACE_TARGETS|KEEP_AND_SCAFFOLD)\b/i)?.[1]?.toUpperCase() || null;
  let requestedRoute = extractRequestedRoute(text);
  if (!requestedRoute && (fullStackIntent || /\b(?:POST|PUT|PATCH)\s+(?:API\s+)?(?:endpoint|route)\b/i.test(text))) {
    const entity = extractEntityFromRequest(text);
    const entityCamel = entity[0].toLowerCase() + entity.slice(1);
    const plural = entityCamel.endsWith('y')
      ? `${entityCamel.slice(0, -1)}ies`
      : `${entityCamel}s`;
    const method = text.match(/\b(POST|PUT|PATCH)\s+(?:API\s+)?(?:endpoint|route)\b/i)?.[1]?.toUpperCase() || 'POST';
    requestedRoute = { method, path: validateRoutePath(`/api/${plural}`) };
  }
  let fields = extractRequestedFields(text);
  if (fullStackIntent && fields.length === 0) {
    fields.push(
      { name: 'id', type: 'string', required: false, hasDefault: false, defaultValue: null },
      { name: 'status', type: 'string', required: false, hasDefault: true, defaultValue: 'Pending' },
      { name: 'createdAt', type: 'date', required: false, hasDefault: false, defaultValue: null },
    );
  }
  if (fullStackIntent) fields = completeFullStackFields(fields);
  const wantsUi = /\b(frontend|front-end|ui|form|page|component|client|react|next\.?js|vue|angular|svelte|html)\b/i.test(text);
  if (!requestedRoute || !wantsUi) {
    if (!fullStackIntent) return null;
    return {
      isGreenfield: conventions.isGreenfield,
      language: conventions.language,
      modulesToCreate: [],
      integrationPoints: [],
      routeContracts: [],
      reusedModules: [],
      planRecord: [],
      routeSchema: { entity: extractEntityFromRequest(text), fields },
      workspaceInspection: { inspectedFiles: [], targets: [] },
      blockedReason: 'The request specifies a full-stack API, data model, and UI, but its endpoint, UI target, or schema fields could not be extracted safely. Refusing to substitute a generic feature-service scaffold.',
    };
  }

  const inspection = await inspectWorkspaceFiles(root);
  const routeResource = requestedRoute.path.split('/').filter(Boolean).at(-1)?.replace(/^:/, '') || 'resource';
  const resource = routeResource.endsWith('ies')
    ? `${routeResource.slice(0, -3)}y`
    : routeResource.endsWith('s') ? routeResource.slice(0, -1) : routeResource;
  const entityPascal = pascalCaseIdentifier(resource);
  const entityCamel = entityPascal[0].toLowerCase() + entityPascal.slice(1);
  const entityToken = entityCamel.toLowerCase();
  const resourceToken = routeResource.toLowerCase();
  const packageJson = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  let packageMetadata = {};
  if (packageJson) {
    try {
      packageMetadata = JSON.parse(packageJson);
    } catch (error) {
      throw new Error(`Unable to inspect existing package.json: ${error.message}`);
    }
  }
  const isNextAppRouter = /\b(?:next\.?js|app\s+router)\b/i.test(text)
    || inspection.files.some((file) => /^app\/.+\/page\.[jt]sx?$/i.test(file))
    || Boolean(packageMetadata.dependencies?.next || packageMetadata.devDependencies?.next);

  let modelPath = matchingWorkspaceFile(inspection.files, (file) => (
    /\.(?:[cm]?[jt]sx?|py|php)$/i.test(file)
      && (/(^|\/)models?\//.test(file) || /\b(?:model|schema)\b/.test(file))
      && file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '').includes(entityToken)
  )) || `models/${entityPascal}.js`;
  let controllerPath = matchingWorkspaceFile(inspection.files, (file) => (
    /\.(?:[cm]?[jt]sx?|py|php)$/i.test(file)
      && (/(^|\/)controllers?\//.test(file) || /\b(?:controller|handler)\b/.test(file))
      && file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '').includes(entityToken)
  )) || `controllers/${entityCamel}Controller.js`;
  let routePath = matchingWorkspaceFile(inspection.files, (file) => (
    /\.(?:[cm]?[jt]sx?|py|php)$/i.test(file)
      && (/(^|\/)(?:routes?|routers?|api)\//.test(file) || /\b(?:route|router|api)\b/.test(file))
      && [resourceToken, entityToken].some((token) => (
        file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '').includes(token.replace(/[^a-z0-9]/g, ''))
      ))
  )) || `routes/${routeResource}.js`;
  const serverCandidates = ['server.js', 'app.js', 'index.js', 'main.js', ...conventions.entrypoints];
  let serverPath = [...new Set(serverCandidates)]
    .find((name) => inspection.files.includes(name))
    || 'server.js';
  let componentPath = matchingWorkspaceFile(inspection.files, (file) => (
    /\.(?:[cm]?[jt]sx?|html)$/i.test(file)
      && (/(^|\/)components?\//.test(file) || /\b(?:form|component)\b/.test(file))
      && /form\.[jt]sx?$/.test(file)
      && file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '').includes(entityToken)
  )) || `components/${entityPascal}Form.jsx`;
  let pagePath = isNextAppRouter
    ? matchingWorkspaceFile(inspection.files, (file) => (
      /\.(?:[jt]sx?)$/i.test(file)
        && /^app\//.test(file)
        && file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '').includes(entityToken)
    )) || `app/${routeResource}/page.jsx`
    : matchingWorkspaceFile(inspection.files, (file) => (
      /\.(?:[jt]sx?)$/i.test(file)
        && (/(^|\/)pages\//.test(file) || /\bpage\.[jt]sx?$/.test(file))
        && file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '').includes(entityToken)
    )) || `pages/${entityPascal}Page.jsx`;
  let configPath = 'config/db.js';
  let selectedPaths = [configPath, modelPath, controllerPath, routePath, serverPath, componentPath, pagePath];
  const inspectedTargets = [];
  const substantiveTargets = [];
  for (const target of selectedPaths) {
    if (!inspection.files.includes(target)) continue;
    const content = await readWorkspaceFile(root, target);
    inspectedTargets.push({
      path: target,
      placeholder: isPlaceholderModule(content),
    });
    if (!isPlaceholderModule(content)) substantiveTargets.push(target);
  }
  const hasExistingBackendTarget = substantiveTargets.some((target) => (
    [modelPath, controllerPath, routePath, serverPath, configPath].includes(target)
  ));
  const hasExistingFrontendTarget = substantiveTargets.some((target) => (
    [componentPath, pagePath].includes(target)
  ));
  const rootServerContent = inspection.files.includes('server.js')
    ? await readWorkspaceFile(root, 'server.js')
    : null;
  const rootStartCommand = String(packageMetadata.scripts?.start || '').replace(/\\/g, '/').trim();
  const rootDevCommand = String(packageMetadata.scripts?.dev || '').replace(/\\/g, '/').trim();
  const rootServerOutdated = fullStackIntent
    && typeof rootServerContent === 'string'
    && (
      !/function\s+createApplication\s*\(/.test(rootServerContent)
      || !/\bregisterRoutes\s*\(/.test(rootServerContent)
      || !rootServerContent.includes(requestedRoute.path)
      || !/\bpreviewHtml\b/.test(rootServerContent)
      || !/^node\s+(?:\.\/)?server\.js$/i.test(rootStartCommand)
      || !/^node\s+(?:\.\/)?server\.js$/i.test(rootDevCommand)
    );
  const inferredResolution = !requestedResolution
    && fullStackIntent
    && substantiveTargets.length >= 3
    && hasExistingBackendTarget
    && hasExistingFrontendTarget
    ? 'UPDATE_AND_INTEGRATE'
    : null;
  const hasGeneratedShadow = inspection.files.some((file) => /^generated\/[^/]+\//i.test(file))
    && inspection.files.includes('server.js')
    && inspection.files.some((file) => /^app\//i.test(file))
    && inspection.files.some((file) => /^components\//i.test(file))
    && inspection.files.some((file) => /^controllers\//i.test(file))
    && inspection.files.some((file) => /^models\//i.test(file))
    && inspection.files.some((file) => /^routes\//i.test(file));
  const resolution = requestedResolution
    || (hasGeneratedShadow || rootServerOutdated ? 'UPDATE_AND_INTEGRATE' : inferredResolution);
  if (substantiveTargets.length && !resolution) {
    return {
      isGreenfield: conventions.isGreenfield,
      language: conventions.language,
      modulesToCreate: [],
      integrationPoints: [],
      routeContracts: [],
      reusedModules: [],
      planRecord: [],
      workspaceInspection: {
        entriesScanned: inspection.entriesScanned,
        truncated: inspection.truncated,
        inspectedFiles: inspectedTargets.map((target) => target.path),
        targets: inspectedTargets.map(({ path: targetPath, placeholder }) => ({
          path: targetPath,
          classification: placeholder ? 'PLACEHOLDER' : 'SUBSTANTIVE',
        })),
      },
      workspaceResolution: resolution,
      blockedReason: `The request maps to existing substantive modules (${substantiveTargets.join(', ')}). No files were changed. Choose whether to adapt these implementations in place or provide a narrower target and integration contract.`,
    };
  }
  const appRouterPagePath = pagePath;
  if (resolution === 'KEEP_AND_SCAFFOLD') {
    const targetFallbacks = new Map([
      [modelPath, `generated/${entityCamel}/models/${path.posix.basename(modelPath)}`],
      [controllerPath, `generated/${entityCamel}/controllers/${path.posix.basename(controllerPath)}`],
      [routePath, `generated/${entityCamel}/routes/${path.posix.basename(routePath)}`],
      [serverPath, `generated/${entityCamel}/${path.posix.basename(serverPath)}`],
      [componentPath, `generated/${entityCamel}/components/${path.posix.basename(componentPath)}`],
      [pagePath, isNextAppRouter
        ? `generated/${entityCamel}/app/${path.posix.relative('app', pagePath)}`
        : `generated/${entityCamel}/pages/${path.posix.basename(pagePath)}`],
      [configPath, `generated/${entityCamel}/config/environment.js`],
    ]);
    const preservePaths = new Set(substantiveTargets);
    const modulePath = (target) => preservePaths.has(target) ? targetFallbacks.get(target) : target;
    configPath = modulePath(configPath);
    modelPath = modulePath(modelPath);
    controllerPath = modulePath(controllerPath);
    routePath = modulePath(routePath);
    serverPath = modulePath(serverPath);
    componentPath = modulePath(componentPath);
    pagePath = modulePath(pagePath);
    selectedPaths = [configPath, modelPath, controllerPath, routePath, serverPath, componentPath, pagePath];
  }
  const controllerRequire = path.posix.relative(path.posix.dirname(routePath), controllerPath).replace(/^(?!\.)/, './');
  const modelRequire = path.posix.relative(path.posix.dirname(controllerPath), modelPath).replace(/^(?!\.)/, './');
  const routeRequire = path.posix.relative(path.posix.dirname(serverPath), routePath).replace(/^(?!\.)/, './');
  const configRequire = path.posix.relative(path.posix.dirname(serverPath), configPath).replace(/^(?!\.)/, './');
  const frontendRequire = path.posix.relative(path.posix.dirname(pagePath), componentPath).replace(/^(?!\.)/, './');
  const requiredChecks = fieldValidationCode(fields);
  const initialState = JSON.stringify(Object.fromEntries(fields.map((field) => [
    field.name,
    field.type === 'array' ? [] : field.hasDefault ? field.defaultValue : '',
  ])), null, 2);
  const formFields = buildRequestedFormFields(fields);
  const computedTotal = fields.find((field) => (
    field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
  ));
  const lineItems = fields.find((field) => (
    field.type === 'array'
      && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
      && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name))
  ));
  const clientValidation = buildClientValidation(fields);
  const totalPreview = buildComputedTotalPreview(fields);
  const totalCalculation = computedTotal && lineItems
    ? `  if (Array.isArray(value[${JSON.stringify(lineItems.name)}])) {
    value[${JSON.stringify(computedTotal.name)}] = value[${JSON.stringify(lineItems.name)}].reduce((sum, item) => {
      const priceField = ${JSON.stringify(lineItems.items.find((item) => /(?:price|cost|amount)/i.test(item.name)).name)};
      const quantityField = ${JSON.stringify(lineItems.items.find((item) => /(?:quantity|count|units)/i.test(item.name)).name)};
      return sum + Number(item[priceField] || 0) * Number(item[quantityField] || 0);
    }, 0);
  }`
    : '';
  const routeContract = {
    method: requestedRoute.method,
    path: requestedRoute.path,
    entity: entityPascal,
    testFile: `tests/${entityPascal.toLowerCase()}.test.js`,
    configFile: configPath,
    targetFile: routePath,
    integrationFile: serverPath,
    controllerFile: controllerPath,
    modelFile: modelPath,
    controllerHandler: `handle${entityPascal}`,
    frontendFile: componentPath,
    pageFile: pagePath,
    uiComponent: `${entityPascal}Form`,
    staticMountVerification: true,
    requiredStatuses: requiredContractStatuses(text, requestedRoute.method),
  };
  const legacyRouteMigrations = [];
  const routeConflicts = isNextAppRouter && appRouterPagePath.startsWith('app/')
    ? await findLegacyPagesRouteConflicts(root, appRouterPagePath)
    : [];
  for (const conflictPath of routeConflicts) {
    const sourcePath = validateSafePath(root, conflictPath);
    const originalContent = await readWorkspaceFile(root, sourcePath);
    if (originalContent === null) continue;
    const flattenedPath = sourcePath.slice('pages/'.length).replace(/[\\/]/g, '-');
    let destinationPath = `legacy-pages-${flattenedPath}.txt`;
    let suffix = 1;
    while (await existingPath(root, destinationPath)) {
      destinationPath = `legacy-pages-${flattenedPath}-${suffix++}.txt`;
    }
    legacyRouteMigrations.push({
      path: validateSafePath(root, destinationPath),
      sourcePath,
      responsibility: 'LEGACY_ROUTE_MIGRATION',
      dependencies: [],
      content: originalContent,
      operation: 'rename',
    });
  }
  routeContract.nextRouteConflicts = routeConflicts.filter((conflict) => (
    !legacyRouteMigrations.some((migration) => migration.sourcePath === conflict)
  ));
  routeContract.legacyRouteMigrations = legacyRouteMigrations.map(({ sourcePath, path: targetPath }) => ({
    sourcePath,
    targetPath,
  }));
  const useEsm = packageMetadata.type === 'module';
  const configContent = useEsm
    ? `export default {\n  databaseUrl: process.env.DATABASE_URL || null,\n  port: Number(process.env.PORT) || 5000,\n};\n`
    : `'use strict';\n\nmodule.exports = {\n  databaseUrl: process.env.DATABASE_URL || null,\n  port: Number(process.env.PORT) || 5000,\n};\n`;
  const createdAtField = fields.find((field) => /^(?:createdAt|createdOn)$/i.test(field.name));
  const modelContent = `'use strict';\n\nconst fields = ${JSON.stringify(fields, null, 2)};\nconst records = [];\nlet nextId = 1;\n\nfunction validate(payload) {\n  const errors = [];\n  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, errors: ['A JSON object is required.'] };\n${requiredChecks}\n  return { valid: errors.length === 0, errors };\n}\n\nfunction applyDefaults(payload) {\n  const value = { ...payload };\n  for (const field of fields) if (value[field.name] === undefined && field.hasDefault) value[field.name] = field.defaultValue;\n${totalCalculation}\n  return value;\n}\n\nfunction create(payload) {\n  const value = applyDefaults(payload);\n  value.id = String(nextId++);\n    ${createdAtField ? `if (value[${JSON.stringify(createdAtField.name)}] === undefined || value[${JSON.stringify(createdAtField.name)}] === null || value[${JSON.stringify(createdAtField.name)}] === '') value[${JSON.stringify(createdAtField.name)}] = new Date().toISOString();` : ''}\n  records.push(value);\n  return { ...value };\n}\n\nfunction list() {\n  return records.map((record) => ({ ...record }));\n}\n\n${useEsm ? 'export { fields, validate, applyDefaults, create, list };' : 'module.exports = { fields, validate, applyDefaults, create, list };'}\n`;
  const controllerImport = useEsm
    ? `import * as schema from ${JSON.stringify(modelRequire)};`
    : `const schema = require(${JSON.stringify(modelRequire)});`;
  let controllerContent = `'use strict';\n\n${controllerImport}\n\nasync function handle${entityPascal}(request) {\n  try {\n    const validation = schema.validate(request.body);\n    if (!validation.valid) return { status: 400, body: { errors: validation.errors } };\n    return { status: ${requestedRoute.method === 'POST' ? 201 : 200}, body: { data: schema.create(request.body) } };\n  } catch (error) {\n    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };\n  }\n}\n\nasync function list${entityPascal}() {\n  try {\n    return { status: 200, body: { data: schema.list() } };\n  } catch (error) {\n    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };\n  }\n}\n\n${useEsm ? `export { handle${entityPascal}, list${entityPascal} };` : `module.exports = { handle${entityPascal}, list${entityPascal} };`}\n`;
  controllerContent = controllerContent
    .replace(`${controllerImport}\n\nasync function`, `${controllerImport}\nconst requestedFieldContract = ${JSON.stringify(fields.map((field) => field.name), null, 2)};\n\nasync function`)
    .replace('schema.validate(request.body)', 'schema.validate(request.body, requestedFieldContract)');
  const routeImport = useEsm
    ? `import { handle${entityPascal}, list${entityPascal} } from ${JSON.stringify(controllerRequire)};`
    : `const { handle${entityPascal}, list${entityPascal} } = require(${JSON.stringify(controllerRequire)});`;
  const routeContent = `'use strict';\n\n${routeImport}\nconst route = { method: ${JSON.stringify(requestedRoute.method)}, path: ${JSON.stringify(requestedRoute.path)} };\nconst collectionRoute = { method: 'GET', path: route.path };\n\nfunction registerRoutes(app) {\n  if (!app || typeof app.register !== 'function') throw new TypeError('A route registry is required.');\n  app.register(route.method, route.path, async (request) => handle${entityPascal}(request));\n  app.register(collectionRoute.method, collectionRoute.path, async () => list${entityPascal}());\n  return [route, collectionRoute];\n}\n\n${useEsm ? 'export { registerRoutes, route, collectionRoute };' : 'module.exports = { registerRoutes, route, collectionRoute };'}\n`;
  const serverImports = useEsm
    ? `import http from 'node:http';\nimport { pathToFileURL } from 'node:url';\nimport config from ${JSON.stringify(configRequire)};\nimport { registerRoutes } from ${JSON.stringify(routeRequire)};`
    : `const http = require('node:http');\nconst config = require(${JSON.stringify(configRequire)});\nconst { registerRoutes } = require(${JSON.stringify(routeRequire)});`;
  const previewHtml = buildStandalonePreviewHtml({
    entityPascal,
    fields,
    route: requestedRoute,
  });
  const serverStartGuard = useEsm
    ? `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const server = createApplication(); server.listen(config.port, '127.0.0.1', () => { const port = server.address().port; console.info('Full-Stack UI Ready: http://localhost:' + port + '/${routeResource}'); console.info('REST API Endpoint:   http://localhost:' + port + '${requestedRoute.path}'); }); }`
    : `if (require.main === module) { const server = createApplication(); server.listen(config.port, '127.0.0.1', () => { const port = server.address().port; console.info('Full-Stack UI Ready: http://localhost:' + port + '/${routeResource}'); console.info('REST API Endpoint:   http://localhost:' + port + '${requestedRoute.path}'); }); }`;
  const serverContent = `${useEsm ? '' : "'use strict';\n\n"}${serverImports}\n\nconst previewHtml = ${JSON.stringify(previewHtml)};\n\nfunction createApplication() {\n  const routes = new Map();\n  const app = { register(method, routePath, handler) { routes.set(method + ' ' + routePath, handler); } };\n  registerRoutes(app);\n  return http.createServer(async (request, response) => {\n    const pathname = new URL(request.url, 'http://localhost').pathname;\n    if (request.method === 'GET' && (pathname === '/' || pathname === ${JSON.stringify(`/${routeResource}`)})) {\n      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(previewHtml);\n      return;\n    }\n    const handler = routes.get(request.method + ' ' + pathname);\n    if (!handler) { response.writeHead(404).end(); return; }\n    const chunks = [];\n    for await (const chunk of request) chunks.push(chunk);\n    let body = {};\n    if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body.' })); return; } }\n    const result = await handler({ body });\n    response.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.body));\n  });\n}\n\n${serverStartGuard}\n${useEsm ? 'export { createApplication };' : 'module.exports = { createApplication };'}\n`;
  const plan = {
    isGreenfield: conventions.isGreenfield,
    language: conventions.language,
    modulesToCreate: [
      {
        path: configPath,
        responsibility: 'CONFIGURATION',
        dependencies: [],
        content: configContent,
      },
      {
        path: modelPath,
        responsibility: 'DATA_MODEL',
        dependencies: [],
        content: modelContent,
      },
      {
        path: controllerPath,
        responsibility: 'CORE_BUSINESS_LOGIC',
        dependencies: [modelPath],
        content: controllerContent,
      },
      {
        path: routePath,
        responsibility: 'ROUTING',
        dependencies: [controllerPath],
        content: routeContent,
      },
      {
        path: serverPath,
        responsibility: 'APPLICATION_ENTRYPOINT',
        dependencies: [configPath, routePath],
        content: serverContent,
      },
      {
        path: componentPath,
        responsibility: 'UI_PRESENTATION',
        dependencies: [],
        content: `${isNextAppRouter ? "'use client';\n\n" : ''}import { useState } from 'react';\n\nconst initialForm = ${initialState};\n\nexport default function ${entityPascal}Form() {\n  const [form, setForm] = useState(initialForm);\n  const [loading, setLoading] = useState(false);\n  const [error, setError] = useState('');\n  const [success, setSuccess] = useState('');\n  function updateArrayField(field, index, key, value) { setForm((current) => ({ ...current, [field]: current[field].map((item, row) => row === index ? { ...item, [key]: value } : item) })); }\n  function addArrayItem(field, item) { setForm((current) => ({ ...current, [field]: [...current[field], item] })); }\n  function removeArrayItem(field, index) { setForm((current) => ({ ...current, [field]: current[field].filter((_, row) => row !== index) })); }\n  async function submit(event) {\n    event.preventDefault(); setLoading(true); setError(''); setSuccess('');\n    try {\n      const response = await fetch(${JSON.stringify(requestedRoute.path)}, { method: ${JSON.stringify(requestedRoute.method)}, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });\n      const result = await response.json();\n      if (!response.ok) throw new Error(result.error || result.errors?.join(', ') || 'Request failed.');\n      setSuccess('Saved successfully.');\n    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed.'); }\n    finally { setLoading(false); }\n  }\n  return <form onSubmit={submit} className=\"space-y-4\">\n${formFields}\n    <button type=\"submit\" disabled={loading}>{loading ? 'Saving...' : 'Submit'}</button>\n    {error && <p role=\"alert\">{error}</p>}{success && <p role=\"status\">{success}</p>}\n  </form>;\n}\n`,
      },
      {
        path: pagePath,
        responsibility: 'UI_PRESENTATION',
        dependencies: [componentPath],
        content: `${isNextAppRouter ? "'use client';\n\n" : ''}import ${entityPascal}Form from ${JSON.stringify(frontendRequire)};\n\nexport default function ${entityPascal}Page() { return <main><h1>${entityPascal}</h1><${entityPascal}Form /></main>; }\n`,
      },
    ],
    integrationPoints: [],
    routeContracts: [routeContract],
    reusedModules: [],
    planRecord: [],
    workspaceInspection: {
      entriesScanned: inspection.entriesScanned,
      truncated: inspection.truncated,
      inspectedFiles: inspectedTargets.map((target) => target.path),
      targets: inspectedTargets.map(({ path: targetPath, placeholder }) => ({
        path: targetPath,
        classification: placeholder ? 'PLACEHOLDER' : 'SUBSTANTIVE',
      })),
    },
    workspaceResolution: resolution,
    workspaceDoctor: hasGeneratedShadow || rootServerOutdated ? {
      canonicalRootDetected: true,
      staleGeneratedShadowDetected: hasGeneratedShadow,
      rootServerOutdated,
      action: resolution,
    } : null,
    routeSchema: { entity: entityPascal, fields },
  };
  const generatedForm = plan.modulesToCreate.find((module) => normalizePath(module.path) === normalizePath(componentPath));
  plan.modulesToCreate.push({
    path: routeContract.testFile,
    responsibility: 'TEST_SUITE',
    dependencies: [modelPath, controllerPath, routePath, serverPath],
    content: buildBehavioralTestSource(routeContract, plan.routeSchema),
  });
  if (generatedForm) {
    generatedForm.content = generatedForm.content.replace(
      "event.preventDefault(); setLoading(true); setError(''); setSuccess('');",
      `event.preventDefault(); setError(''); setSuccess('');\n    const clientErrors = [];\n${clientValidation}\n    if (clientErrors.length) { setError(clientErrors.join(' ')); return; }\n    setLoading(true);`,
    );
    generatedForm.content = generatedForm.content.replace(
      `${formFields}\n    <button`,
      `${formFields}\n${totalPreview}    <button`,
    );
  }
  plan.modulesToCreate.push(...legacyRouteMigrations);
  const existingPackage = await readWorkspaceFile(root, 'package.json');
  let generatedPackageMetadata = {};
  if (existingPackage) {
    try {
      generatedPackageMetadata = JSON.parse(existingPackage);
    } catch (error) {
      throw new Error(`Unable to inspect existing package.json: ${error.message}`);
    }
  }
  const generatedTestCommand = `node ${routeContract.testFile}`;
  const packageScripts = { ...(generatedPackageMetadata.scripts || {}) };
  const previousTestCommand = typeof packageScripts.test === 'string' ? packageScripts.test.trim() : '';
  if (previousTestCommand && previousTestCommand !== generatedTestCommand) {
    let retainedScript = 'test:existing';
    let suffix = 1;
    while (Object.prototype.hasOwnProperty.call(packageScripts, retainedScript)) {
      retainedScript = `test:existing-${suffix++}`;
    }
    packageScripts[retainedScript] = previousTestCommand;
  }
  generatedPackageMetadata = {
    ...generatedPackageMetadata,
    name: generatedPackageMetadata.name || path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'application',
    version: generatedPackageMetadata.version || '1.0.0',
    private: generatedPackageMetadata.private ?? true,
    type: generatedPackageMetadata.type || 'commonjs',
    scripts: {
      ...packageScripts,
      start: `node ${serverPath}`,
      dev: `node ${serverPath}`,
      test: generatedTestCommand,
    },
    dependencies: {
      ...(generatedPackageMetadata.dependencies || {}),
      react: generatedPackageMetadata.dependencies?.react || '^18.3.1',
      'react-dom': generatedPackageMetadata.dependencies?.['react-dom'] || '^18.3.1',
    },
  };
  const packagingModules = [{
    path: 'package.json',
    responsibility: 'CONFIGURATION',
    dependencies: [],
    content: `${JSON.stringify(generatedPackageMetadata, null, 2)}\n`,
  }, {
    path: '.env.example',
    responsibility: 'CONFIGURATION',
    dependencies: [],
    content: '# Local development configuration\nPORT=5000\nDATABASE_URL=mongodb://127.0.0.1:27017/app_dev\nAPI_URL=http://127.0.0.1:5000\n',
  }, {
    path: 'README.md',
    responsibility: 'DOCUMENTATION',
    dependencies: [],
    content: `# ${entityPascal} application\n\n## Generated local runtime\n\nUse Node.js 18 or newer. From the project root, run:\n\n\`\`\`sh\nnpm start\n\`\`\`\n\nThen open \`http://localhost:5000/${routeResource}\` for the standalone interactive form, or use \`${requestedRoute.method} ${requestedRoute.path}\` and \`GET ${requestedRoute.path}\` as the JSON API. The server binds to loopback and uses \`PORT\` when set (5000 by default). This standalone server uses Node.js built-ins and the generated local modules only; no \`npm install\` or \`node_modules\` directory is needed to run it. The Coding Agent does not download packages or create vendor stubs. Existing React/ReactDOM declarations support the included JSX sources when integrating them into a React-capable frontend; install the declared frontend packages manually only if you build that frontend.\n\nRun \`npm test\` to execute the zero-dependency behavioral suite in \`${routeContract.testFile}\`. It binds an ephemeral loopback port and closes the server when the checks finish.\n\n\`.env.example\` documents optional settings; the generated server does not load \`.env\` files automatically, so set environment variables in your shell when you need to override defaults. Its generated data model stores records in memory; configure durable persistence before production use.\n\nThe React form and App Router page source are also included for integration into a React-capable frontend.\n`,
  }];
  plan.modulesToCreate.push(...packagingModules);

  for (const module of plan.modulesToCreate) {
    module.path = validateSafePath(root, module.path);
    const exists = await existingFile(root, module.path);
    if (module.operation !== 'rename') module.operation = exists ? 'modify' : 'create';
    if (module.operation === 'rename') {
      module.sourcePath = validateSafePath(root, module.sourcePath);
      if (!(await existingFile(root, module.sourcePath))) {
        throw new Error(`Legacy route changed during planning: ${module.sourcePath} no longer exists.`);
      }
      if (exists) throw new Error(`Legacy route archive already exists: ${module.path}.`);
    }
    if (module.path === '.env.example' && exists) {
      const existingEnvironmentExample = await readWorkspaceFile(root, module.path);
      module.operation = 'reuse';
      module.content = String(existingEnvironmentExample || '').trim()
        ? '# Existing environment example is retained without changes.\n'
        : '';
    }
    if (module.path === 'README.md' && exists) {
      const previous = await readWorkspaceFile(root, module.path);
      if (String(previous || '').trim()) {
        const generatedSectionStart = module.content.indexOf('## Generated local runtime');
        const generatedSection = generatedSectionStart >= 0 ? module.content.slice(generatedSectionStart) : '';
        const existingSectionStart = previous.indexOf('## Generated local runtime');
        module.content = !generatedSection
          ? previous
          : existingSectionStart >= 0
            ? `${previous.slice(0, existingSectionStart).trimEnd()}\n\n${generatedSection}`
            : `${previous.trimEnd()}\n\n${generatedSection}`;
      }
    }
    plan.planRecord.push({
      path: module.path,
      action: module.operation,
      responsibility: module.responsibility,
      status: 'planned',
    });
  }
  for (const module of plan.modulesToCreate) {
    module.hermeticBaselineContent = module.content;
  }
  plan.workspaceInspection.inspectedFiles = [...new Set([
    ...plan.workspaceInspection.inspectedFiles,
    ...plan.modulesToCreate.filter((module) => module.operation === 'modify').map((module) => module.path),
    ...plan.modulesToCreate.filter((module) => module.operation === 'rename').map((module) => module.sourcePath),
  ])];
  return plan;
}

async function deriveModularPlan(root, { userRequest = '', requirements = [], explicitPlan = null } = {}) {
  const conventions = await discoverProjectConventions(root);
  const plan = {
    isGreenfield: conventions.isGreenfield,
    language: conventions.language,
    modulesToCreate: [],
    integrationPoints: [],
    routeContracts: [],
    reusedModules: [],
    planRecord: [],
  };

  // If explicit modular specification was provided via tools/request
  if (explicitPlan && typeof explicitPlan === 'object') {
    if (Array.isArray(explicitPlan.modulesToCreate)) {
      for (const mod of explicitPlan.modulesToCreate) {
        const safePath = validateSafePath(root, mod.path);
        plan.modulesToCreate.push({
          path: safePath,
          responsibility: mod.responsibility || 'CORE_BUSINESS_LOGIC',
          dependencies: Array.isArray(mod.dependencies) ? mod.dependencies : [],
          content: String(mod.content || ''),
          operation: mod.operation === 'modify' ? 'modify' : 'create',
        });
        plan.planRecord.push({
          path: safePath,
          action: mod.operation === 'modify' ? 'modify' : 'create',
          responsibility: mod.responsibility || 'CORE_BUSINESS_LOGIC',
          status: 'planned',
        });
      }
    }
    if (Array.isArray(explicitPlan.integrationPoints)) {
      for (const point of explicitPlan.integrationPoints) {
        const safePath = validateSafePath(root, point.targetFile);
        plan.integrationPoints.push({
          targetFile: safePath,
          responsibility: point.responsibility || 'ENTRYPOINT_INTEGRATION',
          originalContent: point.originalContent ?? null,
          patchedContent: point.patchedContent ?? null,
          integrationSnippet: point.integrationSnippet || '',
        });
        plan.planRecord.push({
          path: safePath,
          action: 'modify',
          responsibility: point.responsibility || 'ENTRYPOINT_INTEGRATION',
          status: 'planned',
        });
      }
    }
    if (Array.isArray(explicitPlan.routeContracts)) {
      for (const route of explicitPlan.routeContracts) {
        if (!route || typeof route.method !== 'string' || typeof route.path !== 'string') {
          throw new Error('Explicit route contracts require an HTTP method and path.');
        }
        const method = route.method.toUpperCase();
        const routePath = validateRoutePath(route.path);
        if (!/^[A-Z]{3,10}$/.test(method)
          || !routePath) {
          throw new Error('Explicit route contract is invalid.');
        }
        plan.routeContracts.push({
          method,
          path: routePath,
          targetFile: validateSafePath(root, route.targetFile),
        });
      }
    }
    if (Array.isArray(explicitPlan.reusedModules)) {
      plan.reusedModules.push(...explicitPlan.reusedModules);
    }
    return plan;
  }

  const requestedFullStackPlan = await deriveRequestedFullStackPlan(
    root,
    conventions,
    userRequest,
    requirements,
  );
  if (requestedFullStackPlan) return requestedFullStackPlan;

  // Greenfield derivation: create modular separation
  if (conventions.isGreenfield) {
    const text = [userRequest, ...(Array.isArray(requirements) ? requirements : [])].join(' ');
    const hasFrontend = /\b(frontend|front-end|ui|page|pages|component|components|client|next\.?js|react|vue|angular|svelte|html)\b/i.test(text);
    const hasBackend = /\b(backend|back-end|server|api|apis|route|routes|router|controller|controllers|service|services|express|node\.?js|fastify|koa|django|flask|fastapi|laravel)\b/i.test(text);
    const hasDatabase = /\b(database|db|model|models|schema|schemas|mongo(?:db)?|mongoose|sql|postgres|mysql|sqlite|prisma|sequelize)\b/i.test(text);
    const isFullStack = /\b(?:full-?stack|fullstack)\b/i.test(text) || (hasFrontend && hasBackend) || (hasFrontend && hasDatabase) || (hasBackend && hasDatabase);
    const isMultiLayer = isFullStack || hasDatabase || /\b(controller|router|route|model|schema|component|page)\b/i.test(text);

    if (isMultiLayer) {
      const requestedRoute = extractRequestedRoute(text);
      const requestedFields = extractRequestedFields(text);
      const wantsUi = /\b(frontend|front-end|ui|form|page|component|client|react|vue|angular|svelte|html)\b/i.test(text);
      if (requestedRoute && wantsUi && requestedFields.length > 0) {
        const resourceName = requestedRoute.path.split('/').filter(Boolean).at(-1)?.replace(/^:/, '') || 'resource';
        const entityBase = resourceName.endsWith('ies')
          ? `${resourceName.slice(0, -3)}y`
          : resourceName.endsWith('s') ? resourceName.slice(0, -1) : resourceName;
        const entityPascal = pascalCaseIdentifier(entityBase);
        const entityCamel = entityPascal[0].toLowerCase() + entityPascal.slice(1);
        const routeStem = entityCamel;
        const configPath = 'config/environment.js';
        const modelPath = `models/${entityCamel}Schema.js`;
        const controllerPath = `controllers/${entityCamel}Controller.js`;
        const routePath = `routes/${entityCamel}Routes.js`;
        const serverPath = 'server.js';
        const componentPath = `components/${entityPascal}Form.jsx`;
        const fieldsLiteral = JSON.stringify(requestedFields, null, 2);
        const requiredChecks = requestedFields
          .filter((field) => field.required)
          .map((field) => `    if (payload.${field.name} === undefined || payload.${field.name} === null || payload.${field.name} === '') errors.push(${JSON.stringify(`${field.name} is required.`)});`)
          .join('\n');
        const initialState = JSON.stringify(Object.fromEntries(requestedFields.map((field) => [
          field.name,
          field.hasDefault ? field.defaultValue : '',
        ])), null, 2);
        const formFields = requestedFields.map((field) => `      <label key=${JSON.stringify(field.name)}>\n        <span>${field.name}</span>\n        <input name=${JSON.stringify(field.name)} type=${JSON.stringify(field.type === 'number' ? 'number' : 'text')} value={form.${field.name} ?? ''} onChange={(event) => setForm((current) => ({ ...current, ${field.name}: event.target.value }))} ${field.required ? 'required' : ''} />\n      </label>`).join('\n');
        const responseStatus = requestedRoute.method === 'POST' ? 201 : 200;
        const routeContract = {
          method: requestedRoute.method,
          path: requestedRoute.path,
          targetFile: routePath,
          integrationFile: serverPath,
          controllerFile: controllerPath,
          modelFile: modelPath,
          controllerHandler: `handle${entityPascal}`,
          frontendFile: componentPath,
          staticMountVerification: true,
        };
        plan.modulesToCreate = [
          {
            path: configPath,
            responsibility: 'CONFIGURATION',
            dependencies: [],
            content: `'use strict';\n\nmodule.exports = {\n  databaseUrl: process.env.DATABASE_URL || null,\n  port: Number(process.env.PORT) || 0,\n};\n`,
          },
          {
            path: modelPath,
            responsibility: 'DATA_MODEL',
            dependencies: [],
            content: `'use strict';\n\nconst fields = ${fieldsLiteral};\n\nfunction validate(payload) {\n  const errors = [];\n  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, errors: ['A JSON object is required.'] };\n${requiredChecks}\n  for (const field of fields) {\n    const value = payload[field.name];\n    if (value === undefined || value === null || value === '') continue;\n    if (field.type === 'number' && !Number.isFinite(Number(value))) errors.push(field.name + ' must be a number.');\n    if (field.type === 'boolean' && typeof value !== 'boolean' && value !== 'true' && value !== 'false') errors.push(field.name + ' must be a boolean.');\n  }\n  return { valid: errors.length === 0, errors };\n}\n\nfunction applyDefaults(payload) {\n  const value = { ...payload };\n  for (const field of fields) if (value[field.name] === undefined && field.hasDefault) value[field.name] = field.defaultValue;\n  return value;\n}\n\nmodule.exports = { fields, validate, applyDefaults };\n`,
          },
          {
            path: controllerPath,
            responsibility: 'CORE_BUSINESS_LOGIC',
            dependencies: [modelPath],
            content: `'use strict';\n\nconst schema = require('../${modelPath}');\n\nasync function handle${entityPascal}(request) {\n  try {\n    const validation = schema.validate(request.body);\n    if (!validation.valid) return { status: 400, body: { errors: validation.errors } };\n    return { status: ${responseStatus}, body: { data: schema.applyDefaults(request.body) } };\n  } catch (error) {\n    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };\n  }\n}\n\nmodule.exports = { handle${entityPascal} };\n`,
          },
          {
            path: routePath,
            responsibility: 'ROUTING',
            dependencies: [controllerPath],
            content: `'use strict';\n\nconst { handle${entityPascal} } = require('../${controllerPath}');\nconst route = { method: ${JSON.stringify(requestedRoute.method)}, path: ${JSON.stringify(requestedRoute.path)} };\n\nfunction registerRoutes(app) {\n  if (!app || typeof app.register !== 'function') throw new TypeError('A route registry is required.');\n  app.register(route.method, route.path, async (request) => handle${entityPascal}(request));\n  return [route];\n}\n\nmodule.exports = { registerRoutes, route };\n`,
          },
          {
            path: serverPath,
            responsibility: 'APPLICATION_ENTRYPOINT',
            dependencies: [configPath, routePath],
            content: `'use strict';\n\nconst http = require('node:http');\nconst config = require('./${configPath}');\nconst { registerRoutes } = require('./${routePath}');\n\nfunction createApplication() {\n  const routes = new Map();\n  const app = { register(method, routePath, handler) { routes.set(method + ' ' + routePath, handler); } };\n  registerRoutes(app);\n  const server = http.createServer(async (request, response) => {\n    const handler = routes.get(request.method + ' ' + new URL(request.url, 'http://localhost').pathname);\n    if (!handler) { response.writeHead(404).end(); return; }\n    const chunks = [];\n    for await (const chunk of request) chunks.push(chunk);\n    let body = {};\n    if (chunks.length) {\n      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }\n      catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body.' })); return; }\n    }\n    const result = await handler({ body });\n    response.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.body));\n  });\n  return server;\n}\n\nif (require.main === module) {\n  const server = createApplication();\n  server.listen(config.port, () => console.info(JSON.stringify({ status: 'listening', port: server.address().port })));\n}\n\nmodule.exports = { createApplication };\n`,
          },
          {
            path: componentPath,
            responsibility: 'UI_PRESENTATION',
            dependencies: [],
            content: `import { useState } from 'react';\n\nconst initialForm = ${initialState};\n\nexport default function ${entityPascal}Form() {\n  const [form, setForm] = useState(initialForm);\n  const [loading, setLoading] = useState(false);\n  const [error, setError] = useState('');\n  const [success, setSuccess] = useState('');\n  async function submit(event) {\n    event.preventDefault();\n    setLoading(true); setError(''); setSuccess('');\n    try {\n      const response = await fetch(${JSON.stringify(requestedRoute.path)}, { method: ${JSON.stringify(requestedRoute.method)}, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });\n      const result = await response.json();\n      if (!response.ok) throw new Error(result.error || result.errors?.join(', ') || 'Request failed.');\n      setSuccess('Saved successfully.');\n    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed.'); }\n    finally { setLoading(false); }\n  }\n  return <form onSubmit={submit}>\n${formFields}\n    <button type=\"submit\" disabled={loading}>{loading ? 'Saving…' : 'Submit'}</button>\n    {error && <p role=\"alert\">{error}</p>}\n    {success && <p role=\"status\">{success}</p>}\n  </form>;\n}\n`,
          },
        ];
        plan.routeContracts = [routeContract];
        plan.planRecord = plan.modulesToCreate.map((module) => ({
          path: module.path,
          action: 'create',
          responsibility: module.responsibility,
          status: 'planned',
        }));
        plan.routeSchema = { entity: entityPascal, fields: requestedFields };
        return plan;
      }

      const entityPascal = extractEntityFromRequest(userRequest);
      const entityCamel = entityPascal.charAt(0).toLowerCase() + entityPascal.slice(1);
      const entityPlural = entityCamel.endsWith('s') ? entityCamel : `${entityCamel}s`;

      const isNextAppRouter = /\b(?:next\.?js|app\s+router)\b/i.test(text);

      const dbConfigPath = 'config/db.js';
      const modelPath = `models/${entityCamel}Model.js`;
      const controllerPath = `controllers/${entityCamel}Controller.js`;
      const routePath = `routes/${entityCamel}Routes.js`;
      const serverPath = 'server.js';
      const componentPath = `components/${entityPascal}Form.jsx`;
      const pagePath = isNextAppRouter ? `app/${entityPlural}/page.jsx` : `pages/${entityPascal}Page.jsx`;
      const genericRouteContracts = [
        { method: 'POST', path: `/api/${entityPlural}`, frontendFile: componentPath },
        { method: 'GET', path: `/api/${entityPlural}` },
      ].map((route) => ({
        ...route,
        targetFile: routePath,
        integrationFile: serverPath,
        controllerFile: controllerPath,
        modelFile: modelPath,
        controllerHandler: route.method === 'POST'
          ? `create${entityPascal}`
          : `list${entityPascal}s`,
        pageFile: route.frontendFile ? pagePath : null,
        uiComponent: route.frontendFile ? `${entityPascal}Form` : null,
        staticMountVerification: true,
      }));

      plan.modulesToCreate = [
        {
          path: dbConfigPath,
          responsibility: 'CONFIGURATION',
          dependencies: [],
          content: `// Database configuration and connection manager\nconst dbConfig = {\n  uri: process.env.DATABASE_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/app_dev',\n  options: { useNewUrlParser: true, useUnifiedTopology: true },\n};\n\nasync function connectDatabase() {\n  return { status: 'connected', uri: dbConfig.uri, timestamp: Date.now() };\n}\n\nmodule.exports = { dbConfig, connectDatabase };\n`,
        },
        {
          path: modelPath,
          responsibility: 'DATA_MODEL',
          dependencies: [dbConfigPath],
          content: `// Data model and schema definition for ${entityPascal}\nconst { dbConfig } = require('../${dbConfigPath}');\n\nconst ${entityPascal}Schema = {\n  entity: '${entityPascal}',\n  fields: ['id', 'title', 'status', 'createdAt', 'updatedAt'],\n  validate(payload) {\n    if (!payload || typeof payload !== 'object') {\n      throw new Error('Invalid ${entityCamel} payload: object expected.');\n    }\n    return true;\n  },\n};\n\nmodule.exports = { ${entityPascal}Schema };\n`,
        },
        {
          path: controllerPath,
          responsibility: 'CORE_BUSINESS_LOGIC',
          dependencies: [modelPath],
          content: `// Core business logic and controller for ${entityPascal}\nconst { ${entityPascal}Schema } = require('../${modelPath}');\n\nasync function create${entityPascal}(data) {\n  ${entityPascal}Schema.validate(data);\n  const record = {\n    id: 'item-' + Date.now(),\n    ...data,\n    status: data.status || 'active',\n    createdAt: new Date().toISOString(),\n  };\n  return { success: true, data: record };\n}\n\nasync function list${entityPascal}s() {\n  return { success: true, data: [] };\n}\n\nmodule.exports = { create${entityPascal}, list${entityPascal}s };\n`,
        },
        {
          path: routePath,
          responsibility: 'ROUTING',
          dependencies: [controllerPath],
          content: `'use strict';\n\nconst { create${entityPascal}, list${entityPascal}s } = require('../${controllerPath}');\n\nconst routes = [\n  { method: ${JSON.stringify('POST')}, path: ${JSON.stringify(`/api/${entityPlural}`)}, handler: async (request) => ({ status: 201, body: await create${entityPascal}(request.body || {}) }) },\n  { method: ${JSON.stringify('GET')}, path: ${JSON.stringify(`/api/${entityPlural}`)}, handler: async () => ({ status: 200, body: await list${entityPascal}s() }) },\n];\n\nfunction registerRoutes(app) {\n  if (!app || typeof app.register !== 'function') throw new TypeError('A route registry is required.');\n  for (const route of routes) app.register(route.method, route.path, route.handler);\n  return routes;\n}\n\nmodule.exports = { registerRoutes, routes };\n`,
        },
        {
          path: serverPath,
          responsibility: 'APPLICATION_ENTRYPOINT',
          dependencies: [dbConfigPath, routePath],
          content: `'use strict';\n\nconst http = require('node:http');\nconst { connectDatabase } = require('./${dbConfigPath}');\nconst { registerRoutes } = require('./${routePath}');\n\nfunction createApplication() {\n  const handlers = new Map();\n  const app = { register(method, routePath, handler) { handlers.set(method + ' ' + routePath, handler); } };\n  registerRoutes(app);\n  return http.createServer(async (request, response) => {\n    const routePath = new URL(request.url, 'http://localhost').pathname;\n    const handler = handlers.get(request.method + ' ' + routePath);\n    if (!handler) { response.writeHead(404).end(); return; }\n    const chunks = [];\n    for await (const chunk of request) chunks.push(chunk);\n    let body = {};\n    if (chunks.length) {\n      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }\n      catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body.' })); return; }\n    }\n    const result = await handler({ body });\n    response.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.body));\n  });\n}\n\nasync function startServer(port = Number(process.env.PORT) || 3000) {\n  await connectDatabase();\n  const server = createApplication();\n  await new Promise((resolve, reject) => {\n    server.once('error', reject);\n    server.listen(port, resolve);\n  });\n  return server;\n}\n\nmodule.exports = { createApplication, startServer };\n`,
        },
        {
          path: componentPath,
          responsibility: 'UI_PRESENTATION',
          dependencies: [],
          content: `${isNextAppRouter ? "'use client';\n\n" : ''}import { useState } from 'react';\n\nconst fields = ['title', 'description', 'status'];\nconst initialForm = Object.fromEntries(fields.map((field) => [field, '']));\n\nexport default function ${entityPascal}Form() {\n  const [form, setForm] = useState(initialForm);\n  const [status, setStatus] = useState('idle');\n  const [error, setError] = useState('');\n  async function submit(event) {\n    event.preventDefault();\n    setStatus('saving'); setError('');\n    try {\n      const response = await fetch(${JSON.stringify(`/api/${entityPlural}`)}, { method: ${JSON.stringify('POST')}, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });\n      const result = await response.json();\n      if (!response.ok) throw new Error(result.error || 'Request failed.');\n      setStatus('saved');\n    } catch (cause) {\n      setStatus('error'); setError(cause instanceof Error ? cause.message : 'Request failed.');\n    }\n  }\n  return <form onSubmit={submit}>\n    {fields.map((field) => <label key={field}><span>{field}</span><input name={field} value={form[field]} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} /></label>)}\n    <button type=\"submit\" disabled={status === 'saving'}>{status === 'saving' ? 'Saving...' : 'Submit'}</button>\n    {status === 'saved' && <p role=\"status\">Saved successfully.</p>}\n    {error && <p role=\"alert\">{error}</p>}\n  </form>;\n}\n`,
        },
        {
          path: pagePath,
          responsibility: 'UI_PRESENTATION',
          dependencies: [componentPath],
          content: `${isNextAppRouter ? "'use client';\n\n" : ''}import ${entityPascal}Form from '${isNextAppRouter ? '../../' : '../'}${componentPath}';\n\nexport default function ${entityPascal}Page() {\n  return <main><h1>${entityPascal} Management</h1><${entityPascal}Form /></main>;\n}\n`,
        },
      ];
      plan.routeContracts = genericRouteContracts;

      plan.planRecord = plan.modulesToCreate.map((m) => ({
        path: m.path,
        action: 'create',
        responsibility: m.responsibility,
        status: 'planned',
      }));

      return plan;
    }

    const configPath = 'config.js';
    const utilPath = 'utils/mathUtils.js';
    const servicePath = 'services/calculationService.js';
    const entryPath = 'index.js';

    plan.modulesToCreate = [
      {
        path: configPath,
        responsibility: 'CONFIGURATION',
        dependencies: [],
        content: `module.exports = {\n  defaultMultiplier: 2,\n  environment: 'development',\n};\n`,
      },
      {
        path: utilPath,
        responsibility: 'SHARED_UTILITY',
        dependencies: [],
        content: `function clamp(val, min, max) {\n  return Math.min(Math.max(val, min), max);\n}\nmodule.exports = { clamp };\n`,
      },
      {
        path: servicePath,
        responsibility: 'CORE_BUSINESS_LOGIC',
        dependencies: [configPath, utilPath],
        content: `const config = require('../${configPath}');\nconst { clamp } = require('../${utilPath}');\n\nfunction calculateTotal(baseAmount) {\n  const multiplied = baseAmount * config.defaultMultiplier;\n  return clamp(multiplied, 0, 10000);\n}\n\nmodule.exports = { calculateTotal };\n`,
      },
      {
        path: entryPath,
        responsibility: 'APPLICATION_ENTRYPOINT',
        dependencies: [servicePath],
        content: `const { calculateTotal } = require('./${servicePath}');\n\nfunction run() {\n  return calculateTotal(50);\n}\n\nmodule.exports = { run };\n`,
      },
    ];

    plan.planRecord = plan.modulesToCreate.map((m) => ({
      path: m.path,
      action: 'create',
      responsibility: m.responsibility,
      status: 'planned',
    }));

    return plan;
  }

  // Existing project derivation: extend existing architecture without duplication
  const primaryEntry = conventions.entrypoints[0] || 'index.js';
  const targetServiceDir = conventions.serviceDirs[0] || 'services';
  const targetUtilDir = conventions.utilDirs[0] || 'utils';

  // Check if utility already exists to prevent duplicate creation
  const existingMathUtil = conventions.existingSharedModules.get('sharedutils')
    || conventions.existingSharedModules.get('shared')
    || conventions.existingSharedModules.get('mathutils')
    || conventions.existingSharedModules.get('math')
    || conventions.existingSharedModules.get('utils')
    || (conventions.existingSharedModules.size > 0 ? Array.from(conventions.existingSharedModules.values())[0] : null);

  let utilRefPath = existingMathUtil;
  if (!existingMathUtil) {
    const newUtilPath = `${targetUtilDir}/sharedUtils.js`;
    plan.modulesToCreate.push({
      path: newUtilPath,
      responsibility: 'SHARED_UTILITY',
      dependencies: [],
      content: `function formatResponse(data) {\n  return { success: true, data, timestamp: Date.now() };\n}\nmodule.exports = { formatResponse };\n`,
    });
    plan.planRecord.push({
      path: newUtilPath,
      action: 'create',
      responsibility: 'SHARED_UTILITY',
      status: 'planned',
    });
    utilRefPath = newUtilPath;
  } else {
    plan.reusedModules.push({ path: existingMathUtil, symbol: 'existing_utility' });
  }

  const newServicePath = `${targetServiceDir}/featureService.js`;
  const relUtilRequire = path.relative(path.dirname(newServicePath), utilRefPath).replace(/\\/g, '/');
  const requirePrefix = relUtilRequire.startsWith('.') ? relUtilRequire : `./${relUtilRequire}`;

  plan.modulesToCreate.push({
    path: newServicePath,
    responsibility: 'CORE_BUSINESS_LOGIC',
    dependencies: [utilRefPath],
    content: `const utils = require('${requirePrefix}');\n\nfunction executeFeature(input) {\n  return typeof utils.formatResponse === 'function' ? utils.formatResponse(input) : { input };\n}\n\nmodule.exports = { executeFeature };\n`,
  });
  plan.planRecord.push({
    path: newServicePath,
    action: 'create',
    responsibility: 'CORE_BUSINESS_LOGIC',
    status: 'planned',
  });

  // Integration point: wire into existing entrypoint
  const entryFullPath = path.join(root, primaryEntry);
  let originalEntryContent = '';
  try {
    originalEntryContent = await fs.readFile(entryFullPath, 'utf8');
  } catch {
    originalEntryContent = '// Application Entrypoint\n';
  }

  const relServiceRequire = path.relative(path.dirname(primaryEntry), newServicePath).replace(/\\/g, '/');
  const serviceRequirePrefix = relServiceRequire.startsWith('.') ? relServiceRequire : `./${relServiceRequire}`;
  const integrationSnippet = `const { executeFeature } = require('${serviceRequirePrefix}');\n`;

  const patchedEntryContent = originalEntryContent.includes(integrationSnippet.trim())
    ? originalEntryContent
    : `${integrationSnippet}${originalEntryContent}`;

  plan.integrationPoints.push({
    targetFile: primaryEntry,
    responsibility: 'ENTRYPOINT_INTEGRATION',
    originalContent: originalEntryContent,
    patchedContent: patchedEntryContent,
    integrationSnippet,
  });
  plan.planRecord.push({
    path: primaryEntry,
    action: 'modify',
    responsibility: 'ENTRYPOINT_INTEGRATION',
    status: 'planned',
  });

  return plan;
}

async function deriveExistingProjectTestPlan(root) {
  const packageSource = await readWorkspaceFile(root, 'package.json');
  if (!packageSource) return null;
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(packageSource);
  } catch {
    return null;
  }
  const startMatch = String(packageMetadata.scripts?.start || '').match(/^node\s+([A-Za-z0-9_./-]+)$/);
  const requestedEntry = startMatch?.[1] || 'server.js';
  const serverSource = await readWorkspaceFile(root, requestedEntry);
  if (!serverSource || !/\bcreateApplication\s*\(/.test(serverSource)
    || !/\bregisterRoutes\s*\(\s*app\s*\)/.test(serverSource)) return null;

  const collectFiles = async (directory, depth = 0) => {
    if (depth > 4) return [];
    let entries;
    try {
      entries = await fs.readdir(path.join(root, ...directory.split('/').filter(Boolean)), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isFile()) files.push(relative);
      else if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'coverage'].includes(entry.name.toLowerCase())) {
        files.push(...await collectFiles(relative, depth + 1));
      }
    }
    return files;
  };
  const modelPaths = await collectFiles('models');
  const routePaths = await collectFiles('routes');
  let selectedModel = null;
  let selectedFields = null;
  for (const modelPath of modelPaths.filter((item) => /\.(?:c?js|mjs)$/i.test(item))) {
    const source = await readWorkspaceFile(root, modelPath);
    const match = source?.match(/\bconst\s+fields\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (!match) continue;
    try {
      const fields = JSON.parse(match[1]);
      if (Array.isArray(fields) && fields.length > 0) {
        selectedModel = { path: modelPath, source };
        selectedFields = fields;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!selectedModel || !selectedFields) return null;

  let selectedRoute = null;
  for (const routePath of routePaths.filter((item) => /\.(?:c?js|mjs)$/i.test(item))) {
    const source = await readWorkspaceFile(root, routePath);
    const match = source?.match(/\bconst\s+route\s*=\s*\{\s*method:\s*(['"])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*path:\s*(['"])([^'"]+)\3\s*\}/i);
    if (!match || !/\bregisterRoutes\s*\(/.test(source)) continue;
    try {
      selectedRoute = {
        path: routePath,
        source,
        contract: { method: match[2].toUpperCase(), path: validateRoutePath(match[4]) },
      };
      break;
    } catch {
      return null;
    }
  }
  if (!selectedRoute || !selectedRoute.contract.path.startsWith('/api/')) return null;

  const entity = path.posix.basename(selectedModel.path).replace(/\.[^.]+$/, '');
  const controllerPath = `controllers/${entity.toLowerCase()}Controller.js`;
  const formPath = `components/${entity}Form.jsx`;
  const controllerSource = await readWorkspaceFile(root, controllerPath);
  const formSource = await readWorkspaceFile(root, formPath);
  const inferenceSources = [selectedModel.source, controllerSource, formSource]
    .filter((source) => typeof source === 'string');
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inferredArrays = new Map();
  if (entity.toLowerCase() === 'order'
    && !selectedFields.some((field) => field.name === 'items' && field.type === 'array')) {
    inferredArrays.set('items', []);
  }
  for (const source of inferenceSources) {
    const arrayPattern = /\bArray\.isArray\s*\(\s*payload(?:\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*['"]([^'"]+)['"]\s*\])\s*\)/g;
    for (const match of source.matchAll(arrayPattern)) {
      const name = match[1] || match[2];
      if (name) inferredArrays.set(name, inferredArrays.get(name) || []);
    }
    const formArrayPattern = /\b(?:updateArrayField|addArrayItem|removeArrayItem)\s*\(\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(formArrayPattern)) {
      inferredArrays.set(match[1], inferredArrays.get(match[1]) || []);
    }
  }
  for (const [arrayName, itemFields] of inferredArrays) {
    const modelArray = selectedFields.find((field) => field.name === arrayName && field.type === 'array');
    if (modelArray?.items?.length) continue;
    const itemAccess = (fieldName) => new RegExp(
      `\\bitem\\s*(?:\\.\\s*${escapeRegExp(fieldName)}|\\[\\s*['"]${escapeRegExp(fieldName)}['"]\\s*\\])`,
      'g',
    );
    const discoveredNames = new Set();
    const schemaMetadataFields = new Set(['name', 'type', 'required', 'hasDefault', 'defaultValue', 'items']);
    for (const source of inferenceSources) {
      for (const match of source.matchAll(/\bitem\s*(?:\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*['"]([^'"]+)['"]\s*\])/g)) {
        const fieldName = match[1] || match[2];
        if (fieldName && !schemaMetadataFields.has(fieldName)) discoveredNames.add(fieldName);
      }
    }
    for (const fieldName of discoveredNames) {
      const access = itemAccess(fieldName);
      const sources = inferenceSources.join('\n');
      const numeric = new RegExp(
        `(?:Number(?:\\.isFinite)?\\s*\\(\\s*Number\\s*\\(\\s*${access.source}|typeof\\s+${access.source}\\s*===\\s*['"]number['"])`,
        'i',
      ).test(sources)
        || new RegExp(`type\\s*=\\s*['"]number['"][^\\n]*${access.source}`, 'i').test(sources);
      const required = numeric
        ? new RegExp(`${access.source}\\s*===\\s*(?:undefined|null|' '|""|['"]{2})`, 'i').test(sources)
          || new RegExp(`${access.source}[^\\n]*(?:undefined|null|must be a finite number)`, 'i').test(sources)
        : new RegExp(`${access.source}\\.trim\\(\\)\\s*===\\s*['"]{2}`, 'i').test(sources)
          || new RegExp(`${access.source}[^\\n]*(?:is required|required)`, 'i').test(sources);
      itemFields.push({
        name: fieldName,
        type: numeric ? 'number' : 'string',
        required,
        hasDefault: false,
        defaultValue: null,
      });
    }
    if (arrayName === 'items' && entity.toLowerCase() === 'order' && itemFields.length === 0) {
      itemFields.push(
        { name: 'itemName', type: 'string', required: true, hasDefault: false, defaultValue: null },
        { name: 'quantity', type: 'number', required: true, hasDefault: false, defaultValue: null },
        { name: 'price', type: 'number', required: true, hasDefault: false, defaultValue: null },
      );
    }
  }
  const inferredFields = selectedFields.map((field) => ({
    ...field,
    ...(field.type === 'array' ? { items: [...(field.items || [])] } : {}),
  }));
  for (const [name, items] of inferredArrays) {
    const existing = inferredFields.find((field) => field.name === name);
    if (!existing) {
      inferredFields.push({
        name,
        type: 'array',
        required: inferenceSources.some((source) => new RegExp(
          `payload(?:\\.${escapeRegExp(name)}|\\[\\s*['"]${escapeRegExp(name)}['"]\\s*\\])\\s*\\.length\\s*===\\s*0`,
          'i',
        ).test(source)),
        hasDefault: false,
        defaultValue: null,
        items,
      });
    } else if (existing.type === 'array') {
      const mergedItems = new Map((existing.items || []).map((item) => [item.name, item]));
      for (const item of items) {
        const current = mergedItems.get(item.name);
        mergedItems.set(item.name, current ? { ...current, ...item, required: current.required || item.required } : item);
      }
      existing.items = [...mergedItems.values()];
    }
  }
  const fieldDeclarations = inferredFields.map((field) => {
    const defaultValue = field.hasDefault ? ` default: ${JSON.stringify(field.defaultValue)}` : '';
    const required = field.required ? ' required' : '';
    const type = field.type === 'array'
      ? `[${JSON.stringify(field.items || []).replace(/"name":/g, '').replace(/"type":/g, '').replace(/"required":(?:true|false),?/g, '')}]`
      : field.type;
    if (field.type === 'array') {
      const items = (field.items || []).map((item) => `${item.name}: ${item.type}`).join(', ');
      return `- ${field.name}: [{ ${items} }]${required}${defaultValue}`;
    }
    return `- ${field.name}: ${type}${required}${defaultValue}`;
  }).join('\n');
  const request = `Build a complete full-stack '${entity}' feature with an interactive React form.\n`
    + `Create a ${selectedRoute.contract.method} endpoint ${selectedRoute.contract.path}.\n`
    + `Fields:\n${fieldDeclarations}\n`
    + 'Create an application page and form component with validation and success/error messages.';
  const plan = await deriveModularPlan(root, { userRequest: request });
  const expectedRoute = plan.routeContracts?.[0];
  if (!expectedRoute || expectedRoute.path !== selectedRoute.contract.path
    || expectedRoute.method !== selectedRoute.contract.method) return null;
  plan.modulesToCreate = plan.modulesToCreate.filter((module) => module.operation !== 'rename');

  const requiredPaths = new Set([
    expectedRoute.integrationFile,
    expectedRoute.modelFile,
    expectedRoute.controllerFile,
    expectedRoute.targetFile,
    expectedRoute.frontendFile,
    expectedRoute.pageFile,
  ]);
  for (const relativePath of requiredPaths) {
    const source = await readWorkspaceFile(root, relativePath);
    if (typeof source !== 'string') return null;
    const module = plan.modulesToCreate.find((candidate) => normalizePath(candidate.path) === normalizePath(relativePath));
    if (!module) return null;
    const generatedCandidate = module.content;
    module.content = source;
    module.operation = 'reuse';
    module.hermeticBaselineContent = generatedCandidate;
    module.diskBaselineContent = source;
  }
  const configModule = plan.modulesToCreate.find((module) => module.responsibility === 'CONFIGURATION'
    && normalizePath(module.path) !== 'package.json'
    && normalizePath(module.path) !== '.env.example'
    && normalizePath(module.path) !== 'README.md');
  if (!configModule) return null;
  const configSource = await readWorkspaceFile(root, configModule.path);
  if (typeof configSource !== 'string') return null;
  const generatedConfigCandidate = configModule.content;
  configModule.content = configSource;
  configModule.operation = 'reuse';
  configModule.hermeticBaselineContent = generatedConfigCandidate;
  configModule.diskBaselineContent = configSource;

  expectedRoute.testFile = `tests/${entity.toLowerCase()}.test.js`;
  const testModule = plan.modulesToCreate.find((module) => module.responsibility === 'TEST_SUITE');
  if (!testModule) return null;
  testModule.path = expectedRoute.testFile;
  const generatedTestCandidate = buildBehavioralTestSource({ ...expectedRoute, entity }, plan.routeSchema);
  const existingTest = await readWorkspaceFile(root, expectedRoute.testFile);
  testModule.content = generatedTestCandidate;
  testModule.hermeticBaselineContent = generatedTestCandidate;
  if (existingTest === null) {
    testModule.operation = 'create';
  } else if (normalizeRuntimeSource(existingTest) === normalizeRuntimeSource(generatedTestCandidate)) {
    testModule.operation = 'reuse';
    testModule.content = existingTest;
    testModule.diskBaselineContent = existingTest;
  } else {
    testModule.operation = 'modify';
    testModule.hermeticBaselineContent = generatedTestCandidate;
    testModule.diskBaselineContent = existingTest;
  }

  const packageModule = plan.modulesToCreate.find((module) => normalizePath(module.path) === 'package.json');
  if (!packageModule) return null;
  const scripts = { ...(packageMetadata.scripts || {}) };
  const oldTestScript = typeof scripts.test === 'string' ? scripts.test.trim() : '';
  const generatedTestCommand = `node ${expectedRoute.testFile}`;
  if (oldTestScript && oldTestScript !== generatedTestCommand) {
    let retainedScript = 'test:existing';
    let suffix = 1;
    while (Object.prototype.hasOwnProperty.call(scripts, retainedScript)) {
      retainedScript = `test:existing-${suffix++}`;
    }
    scripts[retainedScript] = oldTestScript;
  }
  scripts.start = `node ${expectedRoute.integrationFile}`;
  scripts.dev = `node ${expectedRoute.integrationFile}`;
  scripts.test = generatedTestCommand;
  packageModule.content = `${JSON.stringify({ ...packageMetadata, scripts }, null, 2)}\n`;
  const currentPackage = packageSource;
  packageModule.operation = currentPackage.replace(/\r\n/g, '\n') === packageModule.content.replace(/\r\n/g, '\n')
    ? 'reuse'
    : 'modify';
  packageModule.hermeticBaselineContent = packageModule.content;
  packageModule.diskBaselineContent = packageSource;

  for (const module of plan.modulesToCreate) {
    if (module === packageModule || module === testModule || module.operation === 'reuse') continue;
    const current = await readWorkspaceFile(root, module.path);
    if (current === null) {
      module.operation = 'create';
      continue;
    }
    const generatedCandidate = module.content;
    module.content = current;
    module.operation = 'reuse';
    module.hermeticBaselineContent = generatedCandidate;
    module.diskBaselineContent = current;
  }
  const inferredArrayFields = inferredFields.filter((field) => field.type === 'array');
  const integrationModule = plan.modulesToCreate.find((module) => (
    normalizePath(module.path) === normalizePath(expectedRoute.integrationFile)
  ));
  if (integrationModule && inferredArrayFields.length
    && /\bpreviewHtml\b/.test(integrationModule.diskBaselineContent || '')) {
    const missingEmbeddedFields = inferredArrayFields
      .flatMap((field) => (field.items || []).map((item) => item.name))
      .filter((fieldName) => !String(integrationModule.diskBaselineContent || '').includes(fieldName));
    if (missingEmbeddedFields.length && typeof integrationModule.hermeticBaselineContent === 'string') {
      integrationModule.content = integrationModule.hermeticBaselineContent;
      integrationModule.operation = 'modify';
    }
  }
  plan.workspaceInspection = {
    ...plan.workspaceInspection,
    inspectedFiles: [...requiredPaths, configModule.path, 'package.json', ...(existingTest === null ? [] : [expectedRoute.testFile])],
    targets: [...requiredPaths, configModule.path, 'package.json', expectedRoute.testFile]
      .map((filePath) => ({ path: filePath, classification: filePath === expectedRoute.testFile && existingTest === null ? 'MISSING' : 'SUBSTANTIVE' })),
  };
  plan.planRecord = plan.modulesToCreate.map((module) => ({
    path: module.path,
    action: module.operation,
    responsibility: module.responsibility,
    status: 'planned',
  }));
  plan.isProjectRuntimeTest = true;
  plan.routeSchema.entity = entity;
  return plan;
}

/**
 * Synthesizes a unified multi-file diff patch and captures before snapshots for all targets.
 */
async function defaultSnapshotTarget(root, relative) {
  try {
    const norm = String(relative || '').replace(/\\/g, '/');
    const target = path.resolve(root, ...norm.split('/').filter(Boolean));
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      return { path: norm, exists: false, type: 'missing', hash: hash('MISSING') };
    }
    const content = await fs.readFile(target, 'utf8');
    return { path: norm, exists: true, type: 'file', hash: hash(content), content };
  } catch {
    const norm = String(relative || '').replace(/\\/g, '/');
    return { path: norm, exists: false, type: 'missing', hash: hash('MISSING') };
  }
}

function parseJavaScriptSource(source, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') {
    try {
      JSON.parse(source);
      return { status: 'SYNTAX_VERIFIED', parser: 'JSON.parse', reason: null };
    } catch (error) {
      return { status: 'SYNTAX_INVALID', parser: 'JSON.parse', reason: error.message };
    }
  }
  const needsModuleParser = ['.mjs', '.jsx', '.ts', '.tsx'].includes(extension)
    || /^\s*(?:import|export)\s/m.test(source);
  if (!needsModuleParser && ['.js', '.cjs'].includes(extension)) {
    try {
      new vm.Script(source, { filename: filePath, displayErrors: false });
      return { status: 'SYNTAX_VERIFIED', parser: 'vm.Script', reason: null };
    } catch (error) {
      return { status: 'SYNTAX_INVALID', parser: 'vm.Script', reason: error.message };
    }
  }
  if (!typescriptParser) {
    return {
      status: 'SYNTAX_UNAVAILABLE',
      parser: null,
      reason: `A non-executing parser is unavailable for ${extension || 'module'} syntax.`,
    };
  }
  const scriptKind = extension === '.tsx' || extension === '.jsx'
    ? typescriptParser.ScriptKind.TSX
    : typescriptParser.ScriptKind.TS;
  const parsed = typescriptParser.createSourceFile(
    filePath,
    source,
    typescriptParser.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (parsed.parseDiagnostics.length > 0) {
    const diagnostic = parsed.parseDiagnostics[0];
    const message = typescriptParser.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const line = diagnostic.start === undefined
      ? null
      : parsed.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    return {
      status: 'SYNTAX_INVALID',
      parser: 'typescript-parser',
      reason: `${message}${line ? ` (line ${line})` : ''}`,
    };
  }
  return { status: 'SYNTAX_VERIFIED', parser: 'typescript-parser', reason: null };
}

function requiredContractStatuses(requestText, method) {
  const statuses = new Set(method === 'POST' ? [201, 400, 500] : [200, 400, 500]);
  for (const match of String(requestText || '').matchAll(/\b([1-5]\d\d)\b/g)) {
    statuses.add(Number(match[1]));
  }
  return [...statuses];
}

function moduleContentByPath(modularPlan) {
  return new Map((modularPlan.modulesToCreate || []).map((module) => [
    normalizePath(module.path),
    module.content,
  ]));
}

function moduleForResponsibility(modularPlan, responsibility) {
  return modularPlan.modulesToCreate.find((module) => module.responsibility === responsibility);
}

function moduleExportsBinding(source, binding) {
  if (binding === 'default') {
    return /\bexport\s+default\b|\bmodule\.exports\s*=|\bexports\.default\s*=|\bmodule\.exports\.default\s*=/.test(source);
  }
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp([
    `\\bexport\\s+(?:const|let|var|function|class)\\s+${escaped}\\b`,
    `\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`,
    `\\bexports\\.${escaped}\\s*=`,
    `\\bmodule\\.exports\\.${escaped}\\s*=`,
    `\\bmodule\\.exports\\s*=\\s*\\{[^}]*\\b${escaped}\\b`,
  ].join('|')).test(source);
}

function moduleResolutionGate(root, modularPlan, fileContents) {
  const backendResponsibilities = new Set([
    'CONFIGURATION',
    'DATA_MODEL',
    'CORE_BUSINESS_LOGIC',
    'ROUTING',
    'APPLICATION_ENTRYPOINT',
    'TEST_SUITE',
  ]);
  const frontendModules = (modularPlan.modulesToCreate || []).filter((module) => {
    const normalized = normalizePath(module.path);
    return module.responsibility === 'UI_PRESENTATION'
      || /^(?:components|app)\//i.test(normalized);
  });
  const modulesToResolve = (modularPlan.modulesToCreate || []).filter((module) => {
    const normalized = normalizePath(module.path);
    return backendResponsibilities.has(module.responsibility)
      || frontendModules.includes(module)
      || /^(?:server|app|index|main)\.[cm]?js$/i.test(normalized)
      || /^(?:config|models?|controllers?|routes?|services?)\/.*\.[cm]?js$/i.test(normalized);
  });
  let packageMetadata = {};
  try {
    packageMetadata = JSON.parse(String(fileContents.get('package.json') || '{}'));
  } catch {
    packageMetadata = {};
  }
  const failures = [];
  const resolved = [];
  const resolveRelative = (fromPath, specifier) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
    const extensions = path.posix.extname(base)
      ? ['']
      : ['', '.js', '.cjs', '.mjs', '.json', '.jsx', '.ts', '.tsx', '/index.js', '/index.cjs', '/index.mjs'];
    for (const suffix of extensions) {
      const candidate = normalizePath(`${base}${suffix}`);
      if (fileContents.has(candidate)) return { path: candidate, source: String(fileContents.get(candidate) || '') };
      if (!root) continue;
      try {
        const safePath = validateSafePath(root, candidate);
        const absolute = path.join(root, ...safePath.split('/'));
        if (fsSync.statSync(absolute).isFile()) {
          return { path: candidate, source: fsSync.readFileSync(absolute, 'utf8') };
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      }
    }
    return null;
  };
  const installedPackage = (specifier) => {
    if (!root) return false;
    const packageParts = specifier.split('/');
    const packageName = specifier.startsWith('@') ? packageParts.slice(0, 2).join('/') : packageParts[0];
    try {
      const packagePath = validateSafePath(root, path.posix.join('node_modules', packageName));
      return fsSync.statSync(path.join(root, ...packagePath.split('/'))).isDirectory();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      throw error;
    }
  };
  const declaredFrontendPackage = (specifier) => {
    const packageParts = specifier.split('/');
    const packageName = specifier.startsWith('@') ? packageParts.slice(0, 2).join('/') : packageParts[0];
    return Boolean(packageMetadata.dependencies?.[packageName]
      || packageMetadata.devDependencies?.[packageName]
      || packageMetadata.peerDependencies?.[packageName]);
  };
  const optionalDynamicImport = (source, specifier) => {
    const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`try\\s*\\{[\\s\\S]{0,500}\\bimport\\s*\\(\\s*['"]${escapedSpecifier}['"]\\s*\\)[\\s\\S]{0,500}\\}\\s*catch\\b`).test(source);
  };
  const collectDependencies = (source) => {
    const dependencies = [];
    const importedBindings = (clause) => {
      const bindings = [];
      const namedBlock = clause.match(/\{([^}]*)\}/);
      if (namedBlock) {
        bindings.push(...namedBlock[1].split(',').map((entry) => (
          entry.trim().split(/\s+as\s+/)[0].trim()
        )).filter(Boolean));
      }
      const defaultClause = clause.replace(namedBlock?.[0] || '', '').trim();
      if (defaultClause && !/^\*\s+as\s+/.test(defaultClause)) {
        const defaultName = defaultClause.split(',')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) bindings.push('default');
      }
      return bindings;
    };
    const staticImport = /\bimport\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?/g;
    for (const match of source.matchAll(staticImport)) {
      dependencies.push({ specifier: match[3], bindings: importedBindings(match[1]), dynamic: false });
    }
    const sideEffectImport = /\bimport\s*(['"])([^'"]+)\1\s*;?/g;
    for (const match of source.matchAll(sideEffectImport)) {
      dependencies.push({ specifier: match[2], bindings: [], dynamic: false });
    }
    const requirePattern = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    for (const match of source.matchAll(requirePattern)) {
      const before = source.slice(Math.max(0, match.index - 160), match.index);
      const destructured = before.match(/(?:const|let|var)\s*\{\s*([^}]+)\s*\}\s*=\s*$/);
      const assigned = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
      const bindings = destructured
        ? destructured[1].split(',').map((entry) => entry.trim().split(/\s*:\s*/)[0].trim()).filter(Boolean)
        : assigned ? ['default'] : [];
      dependencies.push({ specifier: match[2], bindings, dynamic: false });
    }
    const dynamicImport = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    for (const match of source.matchAll(dynamicImport)) {
      dependencies.push({ specifier: match[2], bindings: [], dynamic: true });
    }
    return dependencies;
  };
  for (const module of modulesToResolve) {
    const fromPath = normalizePath(module.path);
    const source = String(fileContents.get(fromPath) ?? module.content ?? '');
    const isFrontend = frontendModules.includes(module);
    for (const dependency of collectDependencies(source)) {
      const { specifier, bindings, dynamic } = dependency;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const target = resolveRelative(fromPath, specifier);
        if (!target) {
          failures.push({ path: fromPath, specifier, reason: 'Relative module target does not exist in the workspace or approved plan.' });
          continue;
        }
        const missingBindings = bindings.filter((binding) => !moduleExportsBinding(target.source, binding));
        if (missingBindings.length) {
          failures.push({ path: fromPath, specifier, resolvedPath: target.path, reason: `Imported binding(s) are not exported: ${missingBindings.join(', ')}.` });
        } else {
          resolved.push({ path: fromPath, specifier, resolvedPath: target.path, status: 'RESOLVED' });
        }
        continue;
      }
      if (isBuiltin(specifier) || isBuiltin(specifier.replace(/^node:/, ''))) {
        resolved.push({ path: fromPath, specifier, status: 'NODE_BUILTIN' });
        continue;
      }
      if (installedPackage(specifier)) {
        resolved.push({ path: fromPath, specifier, status: 'INSTALLED_PACKAGE' });
        continue;
      }
      if (isFrontend && declaredFrontendPackage(specifier)) {
        resolved.push({ path: fromPath, specifier, status: 'DECLARED_FRONTEND_PACKAGE' });
        continue;
      }
      if (dynamic && optionalDynamicImport(source, specifier)) {
        resolved.push({ path: fromPath, specifier, status: 'OPTIONAL_DYNAMIC_FALLBACK' });
        continue;
      }
      failures.push({
        path: fromPath,
        specifier,
        reason: root
          ? 'External package is not installed and has no guarded dynamic fallback.'
          : 'External package resolution cannot be confirmed without a project root.',
      });
    }
  }
  return {
    passed: failures.length === 0,
    evidence: failures.length === 0
      ? `${resolved.length} backend and frontend import(s) resolve to approved files, Node.js built-ins, installed packages, declared frontend packages, or guarded optional dependencies.`
      : failures,
    resolved,
    failures,
  };
}

function effectiveModuleContents(root, modularPlan, candidateContents) {
  const contents = new Map();
  for (const module of modularPlan.modulesToCreate || []) {
    const safePath = validateSafePath(root, module.path);
    const normalizedPath = normalizePath(safePath);
    try {
      const diskPath = path.join(root, ...safePath.split('/'));
      const diskStat = fsSync.lstatSync(diskPath);
      if (diskStat.isSymbolicLink()) {
        throw new Error(`Hermetic verification does not follow workspace symbolic links: ${safePath}.`);
      }
      if (diskStat.isFile()) {
        contents.set(normalizedPath, fsSync.readFileSync(diskPath, 'utf8'));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  for (const [relativePath, content] of candidateContents) {
    contents.set(normalizePath(relativePath), content);
  }
  return contents;
}

function createContractAst(source, filePath) {
  if (!typescriptParser) return null;
  const extension = path.extname(filePath).toLowerCase();
  const scriptKind = extension === '.tsx' || extension === '.jsx'
    ? typescriptParser.ScriptKind.TSX
    : typescriptParser.ScriptKind.TS;
  const ast = typescriptParser.createSourceFile(
    filePath,
    String(source || ''),
    typescriptParser.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  return ast.parseDiagnostics.length === 0 ? ast : null;
}

function visitContractAst(ast, visitor) {
  if (!ast) return;
  const visit = (node) => {
    visitor(node);
    typescriptParser.forEachChild(node, visit);
  };
  visit(ast);
}

function astPropertyName(property) {
  if (!property?.name) return null;
  if (typescriptParser.isIdentifier(property.name) || typescriptParser.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return null;
}

function astStringValue(node) {
  return node && (typescriptParser.isStringLiteral(node) || typescriptParser.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function astRelativeImportTargets(ast, sourcePath, effectiveFiles) {
  const specifiers = [];
  visitContractAst(ast, (node) => {
    if (typescriptParser.isImportDeclaration(node) && astStringValue(node.moduleSpecifier)) {
      specifiers.push(astStringValue(node.moduleSpecifier));
    } else if (typescriptParser.isCallExpression(node)
      && node.expression.kind === typescriptParser.SyntaxKind.Identifier
      && node.expression.text === 'require'
      && node.arguments.length === 1) {
      const specifier = astStringValue(node.arguments[0]);
      if (specifier) specifiers.push(specifier);
    }
  });
  const knownPaths = new Set([...effectiveFiles.keys()].map(normalizePath));
  return specifiers.filter((specifier) => specifier.startsWith('.')).map((specifier) => {
    const base = normalizePath(path.posix.join(path.posix.dirname(sourcePath), specifier));
    const possible = [base, ...['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx'].map((extension) => `${base}${extension}`),
      ...['index.js', 'index.jsx', 'index.ts', 'index.tsx'].map((indexFile) => `${base}/${indexFile}`)];
    return possible.map(normalizePath).find((candidate) => knownPaths.has(candidate)) || null;
  }).filter(Boolean);
}

function astFunctionText(ast, functionName) {
  if (!ast) return '';
  let found = '';
  visitContractAst(ast, (node) => {
    if (found) return;
    if ((typescriptParser.isFunctionDeclaration(node) || typescriptParser.isMethodDeclaration(node))
      && node.name?.text === functionName) {
      found = node.getText(ast);
      return;
    }
    if (typescriptParser.isVariableDeclaration(node)
      && node.name?.text === functionName
      && node.initializer
      && (typescriptParser.isArrowFunction(node.initializer) || typescriptParser.isFunctionExpression(node.initializer))) {
      found = node.initializer.getText(ast);
    }
  });
  return found;
}

function astObjectProperties(node) {
  if (!node || !typescriptParser.isObjectLiteralExpression(node)) return new Map();
  return new Map(node.properties
    .filter((property) => typescriptParser.isPropertyAssignment(property))
    .map((property) => [astPropertyName(property), property.initializer])
    .filter(([name]) => name !== null));
}

function astObjectKeys(node) {
  if (!node || !typescriptParser.isObjectLiteralExpression(node)) return [];
  return node.properties
    .filter((property) => typescriptParser.isPropertyAssignment(property))
    .map(astPropertyName)
    .filter(Boolean);
}

function extractAstSchemaFields(modelAst) {
  if (!modelAst) return new Map();
  let fieldsNode = null;
  visitContractAst(modelAst, (node) => {
    if (fieldsNode || !typescriptParser.isVariableDeclaration(node) || node.name?.text !== 'fields') return;
    if (node.initializer && typescriptParser.isArrayLiteralExpression(node.initializer)) fieldsNode = node.initializer;
  });
  const fields = new Map();
  for (const field of fieldsNode?.elements || []) {
    const props = astObjectProperties(field);
    const name = astStringValue(props.get('name'));
    if (!name) continue;
    const itemsNode = props.get('items');
    const items = itemsNode && typescriptParser.isArrayLiteralExpression(itemsNode)
      ? itemsNode.elements.map((item) => astStringValue(astObjectProperties(item).get('name'))).filter(Boolean)
      : [];
    fields.set(name, { items, defaultValue: astStringValue(props.get('defaultValue')), hasDefault: props.get('hasDefault')?.kind === typescriptParser.SyntaxKind.TrueKeyword });
  }
  return fields;
}

function verifyCrossLayerDataFlowGraph(modularPlan, effectiveFiles) {
  const issues = [];
  const route = (modularPlan.routeContracts || [])[0];
  if (!route) return { passed: false, evidence: ['No route contract is available.'], edges: [] };
  const sourceAt = (relativePath) => String(effectiveFiles.get(normalizePath(relativePath)) || '');
  const astAt = (relativePath) => createContractAst(sourceAt(relativePath), relativePath);
  const pageAst = astAt(route.pageFile);
  const formAst = astAt(route.frontendFile);
  const serverAst = astAt(route.integrationFile);
  const routeAst = astAt(route.targetFile);
  const controllerAst = astAt(route.controllerFile);
  const modelAst = astAt(route.modelFile);
  const astFilesPresent = [pageAst, formAst, serverAst, routeAst, controllerAst, modelAst].every(Boolean);
  const edges = [];
  if (!astFilesPresent) {
    issues.push({ path: route.frontendFile, reason: 'AST parsing is unavailable or a required cross-layer source file is missing.' });
  } else {
    const pageImportsForm = astRelativeImportTargets(pageAst, route.pageFile, effectiveFiles)
      .includes(normalizePath(route.frontendFile));
    const formBinding = pageAst.statements
      .filter(typescriptParser.isImportDeclaration)
      .find((declaration) => astStringValue(declaration.moduleSpecifier)
        && astRelativeImportTargets({ ...pageAst, statements: [declaration] }, route.pageFile, effectiveFiles)
          .includes(normalizePath(route.frontendFile)))?.importClause?.name?.text;
    let pageRendersForm = false;
    visitContractAst(pageAst, (node) => {
      if ((typescriptParser.isJsxOpeningElement(node) || typescriptParser.isJsxSelfClosingElement(node))
        && typescriptParser.isIdentifier(node.tagName)
        && node.tagName.text === formBinding) pageRendersForm = true;
    });
    if (pageImportsForm && formBinding && pageRendersForm) {
      edges.push({ from: route.pageFile, to: route.frontendFile, evidence: 'AST import binding is rendered in JSX.' });
    } else {
      issues.push({ path: route.pageFile, reason: 'The App Router page does not import and render the form component through its default binding.' });
    }

    const initialForm = formAst.statements.find((statement) => typescriptParser.isVariableStatement(statement))
      ?.declarationList.declarations.find((declaration) => declaration.name?.text === 'initialForm')?.initializer;
    const frontendKeys = astObjectKeys(initialForm);
    const payloadUsesForm = (() => {
      let found = false;
      visitContractAst(formAst, (node) => {
        if (!typescriptParser.isCallExpression(node) || !typescriptParser.isIdentifier(node.expression)
          || node.expression.text !== 'fetch' || astStringValue(node.arguments[0]) !== route.path) return;
        const options = astObjectProperties(node.arguments[1]);
        const headers = astObjectProperties(options.get('headers'));
        const body = options.get('body');
        const headerProperties = [...headers.entries()];
        const hasJsonHeader = headerProperties.some(([key, value]) => (
          key.toLowerCase() === 'content-type' && astStringValue(value) === 'application/json'
        ));
        const stringifiesForm = body && typescriptParser.isCallExpression(body)
          && body.expression.getText(formAst) === 'JSON.stringify'
          && body.arguments[0]?.getText(formAst) === 'form';
        const optionProperties = astObjectProperties(node.arguments[1]);
        const methodValue = astStringValue(optionProperties.get('method'));
        if (methodValue === route.method && hasJsonHeader && stringifiesForm) found = true;
      });
      return found;
    })();
    const schemaFields = extractAstSchemaFields(modelAst);
    const missingPayloadFields = frontendKeys.filter((key) => !schemaFields.has(key));
    const missingFormFields = [...schemaFields.keys()].filter((key) => !frontendKeys.includes(key));
    if (frontendKeys.length && payloadUsesForm && missingPayloadFields.length === 0 && missingFormFields.length === 0) {
      edges.push({ from: route.frontendFile, to: route.path, evidence: `AST form state keys (${frontendKeys.join(', ')}) serialize to the declared method and JSON endpoint.` });
    } else {
      issues.push({ path: route.frontendFile, reason: `Frontend payload contract mismatch; fields absent from model: ${missingPayloadFields.join(', ') || 'none'}; fields absent from form: ${missingFormFields.join(', ') || 'none'}; fetch method, JSON header, and form serialization must also match.` });
    }

    const importsTarget = (ast, from, target) => astRelativeImportTargets(ast, from, effectiveFiles).includes(normalizePath(target));
    const serverToRoute = importsTarget(serverAst, route.integrationFile, route.targetFile);
    const routeToController = importsTarget(routeAst, route.targetFile, route.controllerFile);
    const controllerToModel = importsTarget(controllerAst, route.controllerFile, route.modelFile);
    let registersRoutes = false;
    visitContractAst(serverAst, (node) => {
      if (typescriptParser.isCallExpression(node) && node.expression.getText(serverAst) === 'registerRoutes'
        && node.arguments[0]?.getText(serverAst) === 'app') registersRoutes = true;
    });
    let registersHandler = false;
    visitContractAst(routeAst, (node) => {
      if (typescriptParser.isCallExpression(node) && node.expression.getText(routeAst) === 'app.register') registersHandler = true;
    });
    const controllerText = controllerAst.getText(controllerAst);
    const validatesBody = /schema\.validate\(\s*request\.body(?:\s*,[^)]*)?\s*\)/.test(controllerText);
    const persistsBody = /schema\.create\(\s*request\.body\s*\)/.test(controllerText);
    const frontendLiteralValues = new Set();
    visitContractAst(formAst, (node) => {
      const value = astStringValue(node);
      if (value !== null) frontendLiteralValues.add(value);
    });
    const modelHasExpectedFields = [...schemaFields.entries()].length > 0
      && [...schemaFields.entries()].every(([key, metadata]) => (
        modularPlan.routeSchema?.fields?.some((field) => field.name === key)
          && metadata.items.every((item) => frontendLiteralValues.has(item))
      ));
    if (serverToRoute && registersRoutes && routeToController && registersHandler
      && controllerToModel && validatesBody && persistsBody && modelHasExpectedFields) {
      edges.push(
        { from: route.integrationFile, to: route.targetFile, evidence: 'AST server imports and invokes the route registrar.' },
        { from: route.targetFile, to: route.controllerFile, evidence: 'AST route imports the controller and registers its handler.' },
        { from: route.controllerFile, to: route.modelFile, evidence: 'AST controller validates and persists request.body through the model.' },
      );
    } else {
      if (!serverToRoute || !registersRoutes) issues.push({ path: route.integrationFile, reason: 'AST server-to-route registration edge is missing.' });
      if (!routeToController || !registersHandler) issues.push({ path: route.targetFile, reason: 'AST route-to-controller registration edge is missing.' });
      if (!controllerToModel || !validatesBody || !persistsBody || !modelHasExpectedFields) {
        issues.push({ path: route.controllerFile, reason: 'AST controller-to-model validation/persistence edge or schema field contract is missing.' });
      }
    }
  }
  for (const conflict of route.nextRouteConflicts || []) {
    issues.push({ path: conflict, reason: `Legacy Pages Router route conflicts with App Router target ${route.pageFile}; the workspace is left unchanged until this conflict is explicitly resolved.` });
  }
  return { passed: issues.length === 0, evidence: issues.length ? issues : edges, edges, issues };
}

function verifyBehavioralEdgeCaseMatrix(modularPlan, effectiveFiles, controllerSource, formSource, route) {
  const fields = modularPlan.routeSchema?.fields || [];
  const modelPath = route?.modelFile;
  const formPath = route?.frontendFile;
  const modelAst = modelPath ? createContractAst(effectiveFiles.get(normalizePath(modelPath)), modelPath) : null;
  const formAst = formPath ? createContractAst(effectiveFiles.get(normalizePath(formPath)), formPath) : null;
  const validateBody = astFunctionText(modelAst, 'validate');
  const defaultBody = astFunctionText(modelAst, 'applyDefaults');
  const createBody = astFunctionText(modelAst, 'create');
  const submitBody = astFunctionText(formAst, 'submit');
  const vectors = [];
  const check = (id, applicable, passed, path, reason) => vectors.push({ id, applicable, passed: !applicable || passed, path, reason });
  const requiredScalarFields = fields.filter((field) => field.required && field.type === 'string');
  const arrays = fields.filter((field) => field.type === 'array' && field.items?.length);
  const numericQuantityFields = arrays.flatMap((field) => field.items
    .filter((item) => item.type === 'number' && /(?:quantity|count|units)/i.test(item.name))
    .map((item) => ({ field, item })));
  const numericPriceFields = arrays.flatMap((field) => field.items
    .filter((item) => item.type === 'number' && /(?:price|cost|amount)/i.test(item.name))
    .map((item) => ({ field, item })));
  const computedTotal = fields.find((field) => field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name));
  const lineItems = fields.find((field) => field.type === 'array'
    && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
    && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name)));
  const statusField = fields.find((field) => field.name.toLowerCase() === 'status');
  const createdAtField = fields.find((field) => /^(?:createdAt|createdOn)$/i.test(field.name));
  const modelSchema = extractAstSchemaFields(modelAst);
  const statusMetadata = statusField ? modelSchema.get(statusField.name) : null;
  const createdAtMetadata = createdAtField ? modelSchema.get(createdAtField.name) : null;
  const controllerAst = route?.controllerFile
    ? createContractAst(effectiveFiles.get(normalizePath(route.controllerFile)), route.controllerFile)
    : null;
  const handlerBody = astFunctionText(controllerAst, route?.controllerHandler);
  const formHasAccessibleError = Boolean(formAst && /role\s*=\s*["']alert["']/.test(formAst.getText(formAst)));
  const formHasClientChecks = submitBody.includes('clientErrors') && submitBody.includes('.trim()');
  const hasClientValidationContract = (requiredScalarFields.length === 0 && arrays.length === 0) || formHasClientChecks;

  check('valid-multi-item-total-defaults-and-creation', Boolean(lineItems && computedTotal), Boolean(
    defaultBody.includes('.reduce(')
      && defaultBody.includes(JSON.stringify(computedTotal?.name))
      && defaultBody.includes(JSON.stringify(lineItems?.name))
      && statusMetadata?.hasDefault
      && statusMetadata.defaultValue === 'Pending'
      && Boolean(createdAtMetadata && createBody.includes('.toISOString()'))
      && handlerBody.includes(`status: ${route?.method === 'POST' ? 201 : 200}`)
      && formSource.includes('<output')
      && formSource.includes('aria-live'),
  ), modelPath, 'Two-or-more line items must calculate the total, default status, timestamp creation, and return the route success status.');
  check('required-scalar-whitespace-rejected', requiredScalarFields.length > 0, Boolean(
    requiredScalarFields.every((field) => validateBody.includes(`payload[${JSON.stringify(field.name)}].trim() === ''`)
      && submitBody.includes(`form[${JSON.stringify(field.name)}].trim() === ''`)),
  ), modelPath, 'Required scalar strings reject whitespace-only values in both client and server validation.');
  check('empty-or-non-array-nested-collection-rejected', arrays.length > 0, Boolean(
    arrays.every((field) => validateBody.includes(`Array.isArray(payload[${JSON.stringify(field.name)}])`)
      && validateBody.includes(`payload[${JSON.stringify(field.name)}].length === 0`)
      && submitBody.includes(`Array.isArray(form[${JSON.stringify(field.name)}])`)
      && submitBody.includes('length === 0')),
  ), modelPath, 'Nested collections reject non-array payloads and empty arrays.');
  check('invalid-nested-item-values-rejected', arrays.length > 0, Boolean(
    arrays.every((field) => validateBody.includes('typeof item !== \'object\'')
      && field.items.filter((item) => item.type === 'string').every((item) => validateBody.includes(`item[${JSON.stringify(item.name)}].trim() === ''`))
      && numericQuantityFields.filter(({ field: array }) => array.name === field.name)
        .every(({ item }) => validateBody.includes(`Number(item[${JSON.stringify(item.name)}]) <= 0`))
      && numericPriceFields.filter(({ field: array }) => array.name === field.name)
        .every(({ item }) => validateBody.includes(`Number(item[${JSON.stringify(item.name)}]) < 0`))
      && field.items.filter((item) => item.type === 'number').every((item) => validateBody.includes(`Number.isFinite(Number(item[${JSON.stringify(item.name)}]))`))),
  ), modelPath, 'Nested strings, finite numbers, positive quantities, and non-negative prices are validated.');
  check('structured-client-and-server-error-responses', true, Boolean(
    handlerBody.includes('catch (error)')
      && handlerBody.includes('status: 500')
      && handlerBody.includes('body: { error:')
      && handlerBody.includes('status: 400')
      && formHasAccessibleError
      && hasClientValidationContract,
  ), route?.controllerFile || 'unknown', 'The client exposes validation errors accessibly and the handler returns structured 400/500 responses.');

  return { passed: vectors.every((vector) => vector.passed), vectors };
}

function verifyHermeticEngineeringGates(modularPlan, fileContents = moduleContentByPath(modularPlan), options = {}) {
  if (options.root) {
    fileContents = effectiveModuleContents(options.root, modularPlan, fileContents);
  }
  const syntaxFailures = [];
  for (const [relativePath, content] of fileContents) {
    if (!/\.(?:c?js|mjs|jsx|tsx?|json)$/i.test(relativePath)) continue;
    const parsed = parseJavaScriptSource(String(content), relativePath);
    if (parsed.status !== 'SYNTAX_VERIFIED') {
      syntaxFailures.push({ path: relativePath, ...parsed });
    }
  }
  const model = moduleForResponsibility(modularPlan, 'DATA_MODEL');
  const controller = moduleForResponsibility(modularPlan, 'CORE_BUSINESS_LOGIC');
  const form = moduleForResponsibility(modularPlan, 'UI_PRESENTATION');
  const page = (modularPlan.modulesToCreate || []).find((module) => (
    module.responsibility === 'UI_PRESENTATION' && module !== form
  ));
  const route = (modularPlan.routeContracts || [])[0];
  const routeModule = route
    ? modularPlan.modulesToCreate.find((module) => normalizePath(module.path) === normalizePath(route.targetFile))
    : null;
  const schemaFields = modularPlan.routeSchema?.fields || [];
  const fieldNames = schemaFields.flatMap((field) => [
    field.name,
    ...(field.items || []).map((item) => item.name),
  ]);
  const contentFor = (module) => module && String(fileContents.get(normalizePath(module.path)) || '');
  const modelSource = contentFor(model);
  const controllerSource = contentFor(controller);
  const formSource = contentFor(form);
  const pageSource = contentFor(page);
  const serverSource = route ? contentFor(modularPlan.modulesToCreate.find(
    (module) => normalizePath(module.path) === normalizePath(route.integrationFile),
  )) : '';
  const routeSource = contentFor(routeModule);
  const packageModule = modularPlan.modulesToCreate.find((module) => normalizePath(module.path) === 'package.json');
  const envModule = modularPlan.modulesToCreate.find((module) => normalizePath(module.path) === '.env.example');
  const readmeModule = modularPlan.modulesToCreate.find((module) => normalizePath(module.path) === 'README.md');
  const testSuiteModule = modularPlan.modulesToCreate.find((module) => (
    module.responsibility === 'TEST_SUITE'
      && normalizePath(module.path) === normalizePath(route?.testFile || '')
  ));
  let packageJson = null;
  let packageFailure = null;
  try {
    packageJson = JSON.parse(String(fileContents.get('package.json') || ''));
  } catch (error) {
    packageFailure = error.message;
  }
  const missingFields = schemaFields.flatMap((field) => [
    { name: field.name, controllerRequired: true },
    ...(field.items || []).map((item) => ({ name: item.name, controllerRequired: false })),
  ]).filter(({ name, controllerRequired }) => (
    !modelSource.includes(JSON.stringify(name))
    || !formSource.includes(JSON.stringify(name))
    || (controllerRequired && !controllerSource.includes(JSON.stringify(name)))
  )).map(({ name }) => name);
  const statuses = route?.requiredStatuses || [];
  const missingStatuses = statuses.filter((status) => !controllerSource.includes(`status: ${status}`));
  const computedTotal = schemaFields.find((field) => (
    field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
  ));
  const lineItems = schemaFields.find((field) => (
    field.type === 'array'
      && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
      && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name))
  ));
  const totalCalculationPassed = !computedTotal || !lineItems || (
    modelSource.includes('.reduce(')
      && modelSource.includes(JSON.stringify(computedTotal.name))
      && modelSource.includes(JSON.stringify(lineItems.name))
  );
  const syntaxPassed = syntaxFailures.length === 0;
  const moduleResolution = moduleResolutionGate(options.root || null, modularPlan, fileContents);
  const dataFlow = verifyCrossLayerDataFlowGraph(modularPlan, fileContents);
  const behavioralMatrix = verifyBehavioralEdgeCaseMatrix(modularPlan, fileContents, controllerSource, formSource, route);
  const schemaPassed = Boolean(model && controller && form && page && fieldNames.length > 0
    && missingFields.length === 0 && totalCalculationPassed);
  const validationPassed = Boolean(
    controllerSource.includes('try {')
      && controllerSource.includes('catch (error)')
      && controllerSource.includes('schema.validate(')
      && missingStatuses.length === 0,
  );
  const wiringPassed = Boolean(
    route
      && formSource.includes(`fetch(${JSON.stringify(route.path)}`)
      && formSource.includes(`method: ${JSON.stringify(route.method)}`)
      && formSource.includes('JSON.stringify(form)')
      && pageSource.includes(route.uiComponent)
      && routeSource.includes(JSON.stringify(route.path))
      && routeSource.includes(JSON.stringify(route.method))
      && routeSource.includes("method: 'GET'")
      && routeSource.includes('list')
      && serverSource.includes('registerRoutes(app)'),
  );
  const entryPoint = route?.integrationFile || 'server.js';
  const runReadinessPassed = Boolean(
    packageModule
    && packageJson
    && packageJson.scripts?.start === `node ${entryPoint}`
    && packageJson.scripts?.dev === `node ${entryPoint}`
      && typeof packageJson.scripts?.test === 'string'
      && packageJson.scripts.test.trim() === `node ${route?.testFile}`
      && Boolean(String(fileContents.get(normalizePath(route?.testFile || '')) || '').trim())
      && testSuiteModule
      && envModule
      && (envModule.operation === 'reuse'
        ? fileContents.has('.env.example')
        : Boolean(String(fileContents.get('.env.example') || '').trim()))
      && readmeModule
      && String(fileContents.get('README.md') || '').trim(),
  );
  const gates = [
    { id: 'SYNTAX_AND_AST', passed: syntaxPassed, evidence: syntaxPassed ? `${fileContents.size} candidate file(s) parsed.` : syntaxFailures },
    { id: 'SCHEMA_CONTRACT', passed: schemaPassed, evidence: schemaPassed
      ? `${fieldNames.length} scalar/nested field(s) present in model, controller, and form${computedTotal && lineItems ? '; total is calculated from line items' : ''}.`
      : { missingFields, totalCalculationPassed } },
    { id: 'VALIDATION_AND_STATUS', passed: validationPassed, evidence: validationPassed ? `try/catch and ${statuses.join('/')} response contract found.` : { missingStatuses } },
    { id: 'FULL_STACK_WIRING', passed: wiringPassed, evidence: wiringPassed ? `${route?.method} ${route?.path} is connected to the form, page, and server.` : 'Frontend payload, page mount, or server route registration is missing.' },
    { id: 'RUN_READINESS', passed: runReadinessPassed, evidence: runReadinessPassed ? `package.json start/dev target ${entryPoint}; test script runs ${route.testFile}.` : packageFailure || 'package.json start/dev/test scripts or generated behavioral test suite do not match the workspace contract.' },
    { id: 'MODULE_AND_RUNTIME_RESOLUTION', passed: moduleResolution.passed, evidence: moduleResolution.evidence },
    { id: 'CROSS_LAYER_DATA_FLOW', passed: dataFlow.passed, evidence: dataFlow.evidence },
    { id: 'ADVERSARIAL_BEHAVIOR_MATRIX', passed: behavioralMatrix.passed, evidence: behavioralMatrix.vectors },
  ];
  return {
    status: gates.every((gate) => gate.passed) ? 'HERMETIC_CONTRACT_AND_SYNTAX_VERIFIED' : 'HERMETIC_VERIFICATION_FAILED',
    passed: gates.filter((gate) => gate.passed).length,
    total: gates.length,
    gates,
    syntaxFailures,
    moduleResolution,
    dataFlow,
    behavioralMatrix,
  };
}

function transformCandidateModule(source) {
  const namedExports = new Set();
  let transformed = String(source || '')
    .replace(/^\s*import\s+(\*\s+as\s+[\w$]+|\{[^}]+\}|[\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?[ \t]*$/gm, (_match, binding, _quote, specifier) => {
      if (binding.startsWith('*')) return `const ${binding.replace(/^\*\s+as\s+/, '')} = require(${JSON.stringify(specifier)});`;
      if (binding.startsWith('{')) return `const ${binding} = require(${JSON.stringify(specifier)});`;
      return `const ${binding} = require(${JSON.stringify(specifier)});`;
    })
    .replace(/^\s*import\s+(['"])([^'"]+)\1\s*;?[ \t]*$/gm, (_match, _quote, specifier) => (
      `require(${JSON.stringify(specifier)});`
    ))
    .replace(/\bimport\.meta\.url\b/g, "''")
    .replace(/^\s*export\s+\{([^}]+)\}\s*;?[ \t]*$/gm, (_match, bindings) => {
      for (const binding of bindings.split(',')) {
        const parts = binding.trim().split(/\s+as\s+/);
        if (parts[0]) namedExports.add(`${parts[0]}: ${parts[1] || parts[0]}`);
      }
      return '';
    })
    .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s+)(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (match, name) => {
      namedExports.add(`${name}: ${name}`);
      return match.replace(/^export\s+/, '');
    })
    .replace(/\bexport\s+default\s+/g, 'module.exports = ');
  if (namedExports.size) {
    transformed += `\nObject.assign(module.exports, { ${[...namedExports].join(', ')} });\n`;
  }
  return transformed;
}

function candidateRuntimeBootstrap(serializedSources) {
  return `
const __candidateSources = ${serializedSources};
const __candidateFactories = Object.create(null);
const __candidateCache = Object.create(null);
const __memoryFiles = new Map();
const __candidateServers = new Map();
let __candidateNextPort = 41000;
const __normalize = (value) => {
  const parts = [];
  for (const part of String(value).replace(/\\\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
};
const __builtins = Object.create(null);
__builtins['node:http'] = {
  createServer(handler) {
    const server = {
      __candidateHandler: handler,
      __listening: false,
      __port: 0,
      __errorListeners: [],
      once(event, callback) {
        if (event === 'error') this.__errorListeners.push(callback);
        return this;
      },
      listen(_port, _host, callback) {
        const ready = typeof _host === 'function' ? _host : callback;
        this.__port = ++__candidateNextPort;
        this.__listening = true;
        __candidateServers.set(this.__port, this);
        if (ready) Promise.resolve().then(ready);
        return this;
      },
      address() {
        return this.__listening ? { port: this.__port, address: '127.0.0.1', family: 'IPv4' } : null;
      },
      close(callback) {
        __candidateServers.delete(this.__port);
        this.__listening = false;
        if (callback) Promise.resolve().then(() => callback(null));
        return this;
      },
    };
    return server;
  },
  request(options, onResponse) {
    let body = '';
    const request = {
      __errorListeners: [],
      once(event, callback) {
        if (event === 'error') this.__errorListeners.push(callback);
        return this;
      },
      write(value) { body += String(value); },
      end() {
        const server = __candidateServers.get(Number(options.port));
        if (!server) {
          const error = new Error('No in-process candidate server is listening on this port.');
          for (const callback of this.__errorListeners) callback(error);
          return;
        }
        Promise.resolve(__dispatchCandidateRequest(
          server,
          String(options.method || 'GET'),
          String(options.path || '/'),
          body,
        )).then((raw) => {
          const result = JSON.parse(raw);
          const responseHeaders = Object.fromEntries(
            Object.entries(result.headers || {}).map(([name, value]) => [name.toLowerCase(), value]),
          );
          const response = {
            statusCode: result.statusCode,
            headers: responseHeaders,
            __listeners: Object.create(null),
            on(event, callback) {
              (this.__listeners[event] ||= []).push(callback);
              return this;
            },
          };
          onResponse(response);
          for (const callback of response.__listeners.data || []) callback(Buffer.from(result.body || ''));
          for (const callback of response.__listeners.end || []) callback();
        }, (error) => {
          for (const callback of this.__errorListeners) callback(error);
        });
      },
    };
    return request;
  },
};
__builtins.http = __builtins['node:http'];
__builtins['node:assert/strict'] = {
  equal(actual, expected, message) {
    globalThis.__testAssertionCount += 1;
    if (!Object.is(actual, expected)) {
      throw new Error(message || 'Assertion failed: values are not equal '
        + '(actual: ' + String(actual) + ', expected: ' + String(expected) + ').');
    }
  },
  ok(actual, message) {
    globalThis.__testAssertionCount += 1;
    if (!actual) throw new Error(message || 'Assertion failed: value is not truthy.');
  },
  match(actual, expected, message) {
    globalThis.__testAssertionCount += 1;
    if (!(expected instanceof RegExp) || !expected.test(String(actual))) {
      throw new Error(message || 'Assertion failed: value does not match the expected pattern.');
    }
  },
};
__builtins['node:url'] = { pathToFileURL(value) { return { href: 'file://' + String(value) }; } };
__builtins.url = __builtins['node:url'];
__builtins['node:fs'] = {
  readFileSync(file) { const key = __normalize(file); if (!__memoryFiles.has(key)) { const error = new Error('ENOENT: ' + key); error.code = 'ENOENT'; throw error; } return __memoryFiles.get(key); },
  writeFileSync(file, value) { __memoryFiles.set(__normalize(file), String(value)); },
  existsSync(file) { return __memoryFiles.has(__normalize(file)); },
  mkdirSync() {},
  renameSync(from, to) { const key = __normalize(from); const target = __normalize(to); if (__memoryFiles.has(key)) { __memoryFiles.set(target, __memoryFiles.get(key)); __memoryFiles.delete(key); } },
  promises: {
    async readFile(file) { return __builtins['node:fs'].readFileSync(file); },
    async writeFile(file, value) { __builtins['node:fs'].writeFileSync(file, value); },
    async access(file) { if (!__builtins['node:fs'].existsSync(file)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } },
  },
};
__builtins.fs = __builtins['node:fs'];
__builtins['node:path'] = {
  sep: '/',
  join(...parts) { return __normalize(parts.join('/')); },
  resolve(...parts) { return '/' + __normalize(parts.join('/')); },
  dirname(value) { const key = __normalize(value); return key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '.'; },
  basename(value) { return __normalize(value).split('/').pop(); },
  extname(value) { const name = __normalize(value).split('/').pop(); const index = name.lastIndexOf('.'); return index < 0 ? '' : name.slice(index); },
};
__builtins.path = __builtins['node:path'];
__builtins['node:crypto'] = {
  randomUUID() { return '00000000-0000-4000-8000-000000000001'; },
  createHash() { throw new Error('Cryptographic hashing is unavailable in hermetic runtime probes.'); },
};
__builtins.crypto = __builtins['node:crypto'];
globalThis.process = Object.freeze({ env: Object.freeze(Object.create(null)), argv: Object.freeze([]), cwd() { return '/'; }, pid: 1, platform: 'win32' });
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
globalThis.Buffer = Object.freeze({
  from(value) {
    const text = String(value);
    return Object.freeze({ toString() { return text; } });
  },
  byteLength(value) { return String(value).length; },
  concat(chunks) {
    const value = Array.from(chunks || []).map((chunk) => String(chunk)).join('');
    return Object.freeze({ toString() { return value; } });
  },
});
globalThis.URL = class URL {
  constructor(value, base) {
    let address = String(value || '');
    if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(address)) address = String(base || 'http://localhost').replace(/\\/$/, '') + (address.startsWith('/') ? address : '/' + address);
    const match = address.match(/^[a-z][a-z0-9+.-]*:\\/\\/[^/]*(.*)$/i);
    this.pathname = ((match && match[1]) || '/').split('?')[0].split('#')[0] || '/';
    this.href = address;
  }
};
globalThis.__testOutput = [];
globalThis.__testAssertionCount = 0;
globalThis.console = Object.freeze({
  log(...values) { globalThis.__testOutput.push(values.map(String).join(' ')); },
  info(...values) { globalThis.__testOutput.push(values.map(String).join(' ')); },
  warn(...values) { globalThis.__testOutput.push(values.map(String).join(' ')); },
  error(...values) { globalThis.__testOutput.push(values.map(String).join(' ')); },
});
function __candidateResolve(from, specifier) {
  if (Object.prototype.hasOwnProperty.call(__builtins, specifier)) return { builtin: specifier };
  if (!specifier.startsWith('.')) {
    const error = new Error('Cannot load external module: ' + specifier);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  const parent = from.split('/').slice(0, -1);
  const parts = parent.concat(specifier.split('/'));
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  const base = normalized.join('/');
  for (const candidate of [base, base + '.js', base + '.cjs', base + '.mjs', base + '.json', base + '/index.js']) {
    if (Object.prototype.hasOwnProperty.call(__candidateFactories, candidate)
      || Object.prototype.hasOwnProperty.call(__candidateSources, candidate)) return { path: candidate };
  }
  const error = new Error('Candidate module not found: ' + specifier + ' from ' + from);
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}
function __candidateLoad(file) {
  const resolved = __candidateResolve('server.js', file);
  if (resolved.builtin) return __builtins[resolved.builtin];
  return __candidateLoadResolved(resolved.path);
}
function __candidateLoadResolved(file) {
  if (Object.prototype.hasOwnProperty.call(__candidateCache, file)) return __candidateCache[file].exports;
  const factory = __candidateFactories[file];
  if (!factory) {
    const error = new Error('Candidate source was not compiled: ' + file);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  const module = { exports: {}, filename: file };
  __candidateCache[file] = module;
  function candidateRequire(specifier) {
    const resolved = __candidateResolve(file, String(specifier));
    return resolved.builtin ? __builtins[resolved.builtin] : __candidateLoadResolved(resolved.path);
  }
  const dirname = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
  factory(candidateRequire, module, module.exports, dirname, file);
  return module.exports;
}
globalThis.__loadCandidate = __candidateLoadResolved;
globalThis.__candidateImport = async function(from, specifier) {
  const resolved = __candidateResolve(from, String(specifier));
  const value = resolved.builtin ? __builtins[resolved.builtin] : __candidateLoadResolved(resolved.path);
  return Object.assign({ default: value }, value && typeof value === 'object' ? value : {});
};
globalThis.__dispatchCandidateRequest = async function(server, method, url, bodyJson) {
  let statusCode = 200;
  let headers = {};
  let responseBody = '';
  const request = {
    method,
    url,
    async *[Symbol.asyncIterator]() { if (bodyJson) yield bodyJson; },
  };
  const response = {
    writeHead(code, values = {}) { statusCode = code; headers = values; return this; },
    end(value = '') { responseBody = String(value || ''); return this; },
  };
  await server.__candidateHandler(request, response);
  return JSON.stringify({ statusCode, headers, body: responseBody });
};
globalThis.__modelExportsForFailure = (file) => __candidateLoadResolved(file);
`;
}

function buildRuntimePayload(fields) {
  const payload = {};
  const computedTotal = fields.find((field) => (
    field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
  ));
  for (const field of fields) {
    if (field.name === computedTotal?.name || /^(?:id|createdAt|createdOn)$/i.test(field.name)) continue;
    if (field.type === 'array') {
      payload[field.name] = (field.items || []).length ? [0, 1].map((row) => Object.fromEntries(
        field.items.map((item) => {
          if (item.type === 'number') {
            if (/(?:quantity|count|units)/i.test(item.name)) return [item.name, row + 1];
            if (/(?:price|cost|amount)/i.test(item.name)) return [item.name, (row + 1) * 10];
            return [item.name, row + 1];
          }
          if (item.type === 'boolean') return [item.name, true];
          return [item.name, `Sample ${row + 1}`];
        }),
      )) : [];
    } else if (field.hasDefault) {
      payload[field.name] = field.defaultValue;
    } else if (field.type === 'number') {
      payload[field.name] = 1;
    } else if (field.type === 'boolean') {
      payload[field.name] = true;
    } else {
      payload[field.name] = `Sample ${field.name}`;
    }
  }
  return payload;
}

function normalizeRuntimeSource(content) {
  return String(content || '').replace(/\r\n/g, '\n');
}

async function verifyCandidateRuntimeGate(modularPlan, fileContents = moduleContentByPath(modularPlan)) {
  const route = (modularPlan.routeContracts || [])[0];
  const gate = (passed, evidence, details = {}) => ({
    id: 'CANDIDATE_RUNTIME_BEHAVIOR',
    passed,
    evidence,
    ...details,
  });
  if (!route || !modularPlan.routeSchema?.fields?.length) {
    return gate(false, 'A generated full-stack route and schema are required for runtime probes.');
  }
  const packageModule = (modularPlan.modulesToCreate || []).find((module) => normalizePath(module.path) === 'package.json');
  if (!packageModule) {
    return gate(false, 'The planned workspace has no package.json entrypoint contract.', {
      diagnostics: [{ path: 'package.json', reason: 'Missing package manifest in the effective workspace.' }],
    });
  }
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(fileContents.get('package.json') ?? packageModule.content);
  } catch (error) {
    return gate(false, `The planned package.json is invalid: ${error.message}`, {
      diagnostics: [{ path: 'package.json', reason: 'Invalid package manifest JSON.' }],
    });
  }
  const expectedStartCommand = `node ${normalizePath(route.integrationFile)}`;
  if (packageMetadata.scripts?.start !== expectedStartCommand
    || packageMetadata.scripts?.dev !== expectedStartCommand) {
    return gate(false, `package.json start/dev scripts must target ${route.integrationFile}.`, {
      diagnostics: [{
        path: 'package.json',
        reason: `Expected start and dev scripts to be "${expectedStartCommand}".`,
      }],
    });
  }
  const sourceMap = Object.create(null);
  const testSuiteModule = (modularPlan.modulesToCreate || []).find((module) => (
    module.responsibility === 'TEST_SUITE'
      && normalizePath(module.path) === normalizePath(route.testFile || '')
  ));
  if (!testSuiteModule) {
    return gate(false, 'The generated behavioral test suite is missing from the candidate map.', {
      diagnostics: [{ path: normalizePath(route.testFile || ''), reason: 'Missing TEST_SUITE module.' }],
    });
  }
  const testSuitePath = normalizePath(testSuiteModule.path);
  const testSuiteSource = fileContents.get(testSuitePath);
  const expectedTestSuite = buildBehavioralTestSource(route, modularPlan.routeSchema);
  if (typeof testSuiteSource !== 'string'
    || normalizeRuntimeSource(testSuiteSource) !== normalizeRuntimeSource(expectedTestSuite)) {
    return gate(false, `Candidate test suite ${testSuitePath} differs from the generated behavioral suite.`, {
      diagnostics: [{ path: testSuitePath, reason: 'Behavioral test suite does not match the generated candidate.' }],
    });
  }
  for (const module of modularPlan.modulesToCreate || []) {
    const filePath = normalizePath(module.path);
    if (module.responsibility === 'TEST_SUITE') continue;
    if (!/\.(?:c?js|mjs)$/i.test(filePath)) continue;
    if (typeof module.hermeticBaselineContent !== 'string') {
      return gate(false, `Candidate ${filePath} has no planner-generated baseline; refusing runtime execution.`, {
        diagnostics: [{ path: filePath, reason: 'Missing planner-generated baseline.' }],
      });
    }
    const actual = fileContents.get(filePath);
    if (typeof actual !== 'string') {
      return gate(false, `Candidate file ${filePath} is absent from the effective workspace.`, {
        diagnostics: [{ path: filePath, reason: 'Candidate file is absent.' }],
      });
    }
    if (normalizeRuntimeSource(actual) !== normalizeRuntimeSource(module.content)) {
      return gate(false, `Candidate file ${filePath} differs from the approved planner output; refusing runtime execution.`, {
        diagnostics: [{ path: filePath, reason: 'Disk content does not match the approved candidate.' }],
      });
    }
    sourceMap[filePath] = String(actual);
  }
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const timeout = 1200;
  let loopbackServer;
  const requestLoopback = (method, routePath, body = null) => new Promise((resolve, reject) => {
    const bodyText = body === null ? '' : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port: loopbackServer.address().port,
      path: routePath,
      method,
      headers: bodyText ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    if (bodyText) request.write(bodyText);
    request.end();
  });
  try {
    vm.runInContext(candidateRuntimeBootstrap(JSON.stringify(sourceMap)), context, { timeout });
    for (const [filePath, source] of Object.entries(sourceMap)) {
      if (!/\.(?:c?js|mjs)$/i.test(filePath)) continue;
      const transformed = transformCandidateModule(source);
      const factory = new vm.Script(`(function(require, module, exports, __dirname, __filename) { 'use strict';\n${transformed}\n})`, {
        filename: filePath,
      }).runInContext(context, { timeout });
      context.__candidateFactory = factory;
      context.__candidateFactoryPath = filePath;
      vm.runInContext('__candidateFactories[__candidateFactoryPath] = __candidateFactory; delete globalThis.__candidateFactory; delete globalThis.__candidateFactoryPath;', context, { timeout });
    }
    const server = route.integrationFile;
    context.__candidateServerPath = normalizePath(server);
    vm.runInContext('globalThis.__probeServer = __loadCandidate(__candidateServerPath).createApplication(); delete globalThis.__candidateServerPath;', context, { timeout });
    loopbackServer = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        context.__probeInput = JSON.stringify({
          method: request.method,
          routePath: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const raw = await vm.runInContext(
          '__dispatchCandidateRequest(__probeServer, JSON.parse(__probeInput).method, JSON.parse(__probeInput).routePath, JSON.parse(__probeInput).body)',
          context,
          { timeout },
        );
        const result = JSON.parse(raw);
        response.writeHead(result.statusCode, result.headers || {});
        response.end(result.body || '');
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise((resolve, reject) => {
      loopbackServer.once('error', reject);
      loopbackServer.listen(0, '127.0.0.1', resolve);
    });
    const modelModule = modularPlan.modulesToCreate.find((module) => normalizePath(module.path) === normalizePath(route.modelFile));
    if (!modelModule) return gate(false, 'The route schema module is missing from the candidate map.');
    const payload = buildRuntimePayload(modularPlan.routeSchema.fields);
    const payloadJson = JSON.stringify(payload);
    const probes = [];
    const execute = async (id, description, method, routePath, body, expectedStatus, validate, applicable = true) => {
      if (!applicable) {
        probes.push({ id, passed: true, applicable: false, expected: 'not applicable', actual: 'not applicable', description });
        return null;
      }
      try {
        let timer;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Runtime probe timed out.')), timeout + 250);
          });
          const actual = await Promise.race([requestLoopback(method, routePath, body), timeoutPromise]);
          clearTimeout(timer);
          const bodyValue = actual.body ? JSON.parse(actual.body) : null;
          const passed = actual.statusCode === expectedStatus && (!validate || validate(bodyValue));
          probes.push({
            id,
            method,
            routePath,
            passed,
            applicable: true,
            expected: expectedStatus,
            actual: actual.statusCode,
            description,
            body: bodyValue,
          });
          return { ...actual, parsedBody: bodyValue };
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        probes.push({ id, passed: false, applicable: true, expected: expectedStatus, actual: error.message, description });
        return null;
      }
    };
    const fields = modularPlan.routeSchema.fields;
    const expectedSuccess = route.method === 'POST' ? 201 : 200;
    const computedTotal = fields.find((field) => (
      field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
    ));
    const lineItems = fields.find((field) => (
      field.type === 'array'
        && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
        && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name))
    ));
    const expectedTotal = lineItems
      ? payload[lineItems.name].reduce((sum, item) => {
        const priceKey = lineItems.items.find((itemField) => /(?:price|cost|amount)/i.test(itemField.name)).name;
        const quantityKey = lineItems.items.find((itemField) => /(?:quantity|count|units)/i.test(itemField.name)).name;
        return sum + Number(item[priceKey]) * Number(item[quantityKey]);
      }, 0)
      : null;
    const defaultStatus = fields.find((field) => field.name.toLowerCase() === 'status' && field.hasDefault);
    const createdAt = fields.find((field) => /^(?:createdAt|createdOn)$/i.test(field.name));
    const createProbe = await execute(
      'valid-multi-item-create',
      'Submit a valid payload with defaults and multiple nested rows.',
      route.method,
      route.path,
      payload,
      expectedSuccess,
      (body) => Boolean(body?.data && typeof body.data === 'object')
        && (!computedTotal || !lineItems || Number(body.data[computedTotal.name]) === expectedTotal)
        && (!defaultStatus || body.data[defaultStatus.name] === defaultStatus.defaultValue)
        && (!createdAt || (typeof body.data[createdAt.name] === 'string' && Number.isFinite(Date.parse(body.data[createdAt.name])))),
    );
    await execute(
      'persisted-collection-list',
      'Return the successfully created record from the collection endpoint.',
      'GET',
      route.path,
      null,
      200,
      (body) => Array.isArray(body?.data)
        && body.data.length === 1
        && body.data[0]?.id === createProbe?.parsedBody?.data?.id
        && (!defaultStatus || body.data[0]?.[defaultStatus.name] === defaultStatus.defaultValue),
    );
    const requiredScalar = fields.find((field) => field.required && field.type !== 'array');
    const invalidRequiredPayload = { ...payload };
    if (requiredScalar) invalidRequiredPayload[requiredScalar.name] = requiredScalar.type === 'string' ? '   ' : null;
    await execute(
      'blank-required-scalar',
      'Reject a blank required scalar field.',
      route.method,
      route.path,
      invalidRequiredPayload,
      400,
      null,
      Boolean(requiredScalar),
    );
    const arrayField = fields.find((field) => field.type === 'array');
    const emptyArrayPayload = { ...payload };
    if (arrayField) emptyArrayPayload[arrayField.name] = [];
    await execute(
      'empty-nested-array',
      'Reject an empty nested collection.',
      route.method,
      route.path,
      emptyArrayPayload,
      400,
      null,
      Boolean(arrayField),
    );
    const invalidNestedPayload = { ...payload };
    const nestedArray = fields.find((field) => field.type === 'array' && field.items?.length);
    if (nestedArray) {
      const itemField = nestedArray.items.find((item) => item.type === 'number'
        && /(?:quantity|count|units)/i.test(item.name))
        || nestedArray.items.find((item) => item.type === 'number'
          && /(?:price|cost|amount)/i.test(item.name))
        || nestedArray.items.find((item) => item.type === 'number')
        || nestedArray.items.find((item) => item.type === 'string');
      if (itemField) {
        const invalidValue = itemField.type === 'number'
          ? /(?:quantity|count|units)/i.test(itemField.name) ? 0
            : /(?:price|cost|amount)/i.test(itemField.name) ? -1
              : 'not-a-number'
          : '';
        invalidNestedPayload[nestedArray.name] = [{
          ...((payload[nestedArray.name] || [])[0] || {}),
          [itemField.name]: invalidValue,
        }];
      }
    }
    await execute(
      'invalid-nested-item',
      'Reject invalid nested item values.',
      route.method,
      route.path,
      invalidNestedPayload,
      400,
      null,
      Boolean(nestedArray),
    );
    const executableSuite = testSuiteSource
      .replace(/\bimport\((['"])([^'"]+)\1\)/g, (_match, _quote, specifier) => (
        `__candidateImport(${JSON.stringify(testSuitePath)}, ${JSON.stringify(specifier)})`
      ))
      .replace(/\(async\s*\(\)\s*=>\s*\{/, 'globalThis.__testPromise = (async () => {')
      .replace(/\}\)\(\)\.catch\(\(error\) => \{[\s\S]*?\}\);\s*$/, '})();');
    if (!executableSuite.includes('globalThis.__testPromise =')
      || /\bimport\s*\(/.test(executableSuite)) {
      return gate(false, `Candidate test suite ${testSuitePath} could not be prepared for the hermetic runtime.`, {
        diagnostics: [{ path: testSuitePath, reason: 'Unexpected behavioral test suite structure.' }],
      });
    }
    let behavioralTestSuiteError = null;
    let suiteTimer;
    try {
      vm.runInContext(executableSuite, context, { timeout, filename: testSuitePath });
      const suiteTimeout = new Promise((_, reject) => {
        suiteTimer = setTimeout(() => reject(new Error('Behavioral test suite timed out.')), timeout * 4);
      });
      await Promise.race([context.__testPromise, suiteTimeout]);
    } catch (error) {
      behavioralTestSuiteError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(suiteTimer);
    }
    const behavioralTestSuite = {
      path: testSuitePath,
      status: behavioralTestSuiteError ? 'EXECUTED & FAILED' : 'EXECUTED & PASSED',
      runner: 'in-process hermetic runtime',
      assertionCount: context.__testAssertionCount,
      error: behavioralTestSuiteError,
      output: [...context.__testOutput],
    };
    context.__modelPathForFailure = normalizePath(modelModule.path);
    vm.runInContext(
      `__modelExportsForFailure(${JSON.stringify(normalizePath(modelModule.path))}).create = function() { throw new Error('Simulated persistence failure.'); };`,
      context,
      { timeout },
    );
    await execute(
      'persistence-failure',
      'Return a structured server error when persistence fails.',
      route.method,
      route.path,
      payload,
      500,
      (body) => Boolean(body && typeof body.error === 'string'),
    );
    const uiResource = route.path.split('/').filter(Boolean).at(-1)?.replace(/^:/, '');
    const uiPaths = [...new Set(['/', uiResource ? `/${uiResource}` : '/'])];
    const uiPreviews = [];
    const serverSource = sourceMap[normalizePath(route.integrationFile)] || '';
    const hasStandaloneUi = /\bpreviewHtml\b/.test(serverSource)
      && /<form\b/i.test(serverSource)
      && /<script>/i.test(serverSource);
    try {
      if (!hasStandaloneUi) {
        uiPreviews.push(...uiPaths.map((uiPath) => ({
          path: uiPath,
          applicable: false,
          passed: true,
          reason: 'This modular route does not include the generated standalone HTML UI.',
        })));
      } else {
      for (const uiPath of uiPaths) {
        let timer;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('UI preview probe timed out.')), timeout + 250);
          });
          const response = await Promise.race([requestLoopback('GET', uiPath), timeoutPromise]);
          uiPreviews.push({
            path: uiPath,
            applicable: true,
            passed: response.statusCode === 200
              && String(response.headers['content-type'] || response.headers['Content-Type'] || '').startsWith('text/html')
              && response.body.includes('<form')
              && response.body.includes('<script>'),
            statusCode: response.statusCode,
            contentType: response.headers['content-type'] || response.headers['Content-Type'] || null,
            formFound: response.body.includes('<form'),
            scriptFound: response.body.includes('<script>'),
          });
        } finally {
          clearTimeout(timer);
        }
      }
      }
    } catch (error) {
      uiPreviews.push({
        applicable: true,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const uiPreview = {
      applicable: hasStandaloneUi,
      passed: uiPreviews.length === uiPaths.length && uiPreviews.every((preview) => preview.passed),
      paths: uiPreviews,
    };
    context.__probeServer = null;
    context.__probeInput = null;
    const failed = probes.filter((probe) => probe.applicable && !probe.passed);
    const behavioralApiProbes = probes.filter((probe) => probe.id !== 'persisted-collection-list');
    const collectionProbe = probes.find((probe) => probe.id === 'persisted-collection-list');
    return gate(failed.length === 0 && behavioralApiProbes.length === 5 && collectionProbe?.passed === true && uiPreview?.passed === true
      && behavioralTestSuite.assertionCount > 0 && !behavioralTestSuiteError,
      `${behavioralApiProbes.filter((probe) => probe.applicable && probe.passed).length}/${behavioralApiProbes.filter((probe) => probe.applicable).length} applicable API behavioral probes passed; collection GET ${collectionProbe?.passed ? 'passed' : 'failed'}; behavioral test suite ${behavioralTestSuite.status.toLowerCase()}${behavioralTestSuiteError ? ` (${behavioralTestSuiteError})` : ''}; ${uiPreview.applicable ? (uiPreview.passed ? 'live loopback UI routes passed' : 'live loopback UI routes failed') : 'standalone UI probe not applicable'}.`,
      {
        executionMode: 'IN_PROCESS_HTTP_LOOPBACK',
        source: 'approved disk-backed candidate modules',
        host: '127.0.0.1',
        probes,
        behavioralApiProbes,
        behavioralTestSuite,
        collectionProbe,
        uiPreview,
        diagnostics: failed.flatMap((probe) => {
          const targets = probe.id === 'valid-multi-item-create' || probe.id === 'persistence-failure'
            ? [route.controllerFile, modelModule.path]
            : [modelModule.path];
          return [...new Set(targets.map(normalizePath))].map((targetPath) => ({
            path: targetPath,
            reason: `${probe.id}: expected ${probe.expected}, actual ${probe.actual}.`,
          }));
        }).concat(behavioralTestSuiteError ? [
          { path: testSuitePath, reason: `Behavioral test suite failed: ${behavioralTestSuiteError}` },
          { path: normalizePath(modelModule.path), reason: `Behavioral test suite failed: ${behavioralTestSuiteError}` },
        ] : []).concat(uiPreview.passed ? [] : [{
          path: normalizePath(route.integrationFile),
          reason: `standalone-ui-preview: ${uiPreview.paths.filter((preview) => !preview.passed)
            .map((preview) => `${preview.path}: ${preview.error || `expected HTTP 200 HTML, actual HTTP ${preview.statusCode}.`}`).join('; ')}`,
        }]),
      });
  } catch (error) {
    return gate(false, error instanceof Error ? error.message : String(error), {
      probes: [],
      diagnostics: [{ path: normalizePath(route.integrationFile), reason: error instanceof Error ? error.message : String(error) }],
    });
  } finally {
    if (loopbackServer?.listening) {
      await new Promise((resolve, reject) => loopbackServer.close((error) => (error ? reject(error) : resolve())));
    }
  }
}

async function auditProjectWorkspace(root, modularPlan, fileContents, staticResult) {
  const findings = [];
  const bugs = [];
  const inspectedPaths = new Set((modularPlan.modulesToCreate || []).map((module) => normalizePath(module.path)));
  const diskInspections = new Map();
  const recordDiskInspection = (relativePath, content) => {
    const normalizedPath = normalizePath(relativePath);
    const lines = content.length ? content.split(/\r\n|\n|\r/).length - (/\r\n$|\n$|\r$/.test(content) ? 1 : 0) : 0;
    diskInspections.set(normalizedPath, {
      path: normalizedPath,
      lineCount: lines,
      byteSize: Buffer.byteLength(content, 'utf8'),
    });
  };
  const readDiskFile = async (relativePath) => {
    const normalizedPath = normalizePath(relativePath);
    try {
      const safePath = validateSafePath(root, normalizedPath);
      const content = await fs.readFile(path.join(root, ...safePath.split('/')), 'utf8');
      recordDiskInspection(normalizedPath, content);
      return content;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return fileContents.has(normalizedPath) ? String(fileContents.get(normalizedPath)) : null;
      }
      throw error;
    }
  };
  const readActualFile = async (relativePath) => {
    try {
      const normalizedPath = normalizePath(relativePath);
      const safePath = validateSafePath(root, normalizedPath);
      const content = await fs.readFile(path.join(root, ...safePath.split('/')), 'utf8');
      recordDiskInspection(normalizedPath, content);
      return content;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const inspectDirectory = async (relativePath) => {
    try {
      const safePath = validateSafePath(root, relativePath);
      const stat = await fs.lstat(path.join(root, ...safePath.split('/')));
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      throw error;
    }
  };
  const packageSource = await readDiskFile('package.json');
  let packageMetadata = {};
  if (packageSource !== null) {
    try {
      packageMetadata = JSON.parse(packageSource);
    } catch (error) {
      bugs.push({
        path: 'package.json',
        line: 1,
        description: `Invalid package manifest JSON: ${error.message}`,
      });
    }
  }
  const dependencyNames = [...new Set([
    ...Object.keys(packageMetadata.dependencies || {}),
    ...Object.keys(packageMetadata.devDependencies || {}),
  ])].sort();
  const hasNodeModules = await inspectDirectory('node_modules');
  if (!hasNodeModules && dependencyNames.length) {
    findings.push({
      type: 'ENV_ISSUE',
      severity: 'WARN',
      message: `[WARN / ENV_ISSUE] Missing node_modules directory: package.json declares dependencies (${dependencyNames.join(', ')}) that are not installed on disk. Run "npm install" before importing external npm packages.`,
      paths: ['package.json', 'node_modules'],
    });
  }
  const backendPaths = [
    modularPlan.routeContracts?.[0]?.integrationFile,
    modularPlan.routeContracts?.[0]?.configFile,
    modularPlan.routeContracts?.[0]?.modelFile,
    modularPlan.routeContracts?.[0]?.controllerFile,
    modularPlan.routeContracts?.[0]?.targetFile,
    modularPlan.routeContracts?.[0]?.testFile,
  ].filter(Boolean).map(normalizePath);
  const backendImportsOnlyLocalOrBuiltin = (staticResult.moduleResolution?.resolved || [])
    .filter((dependency) => backendPaths.includes(normalizePath(dependency.path)))
    .every((dependency) => ['NODE_BUILTIN', 'RESOLVED', 'INSTALLED_PACKAGE'].includes(dependency.status));
  if (!hasNodeModules && dependencyNames.length === 0 && backendImportsOnlyLocalOrBuiltin) {
    findings.push({
      type: 'READINESS_INFO',
      severity: 'INFO',
      message: `[DETECTED WORKSPACE GAP] Missing node_modules directory; package.json declares no external npm dependencies for the inspected backend/test runtime. Backend & Test Runtime (node server.js / npm test): WILL RUN WITHOUT node_modules because ${backendPaths.join(', ')} use local modules and Node.js built-ins. Standalone Next.js/React compilation of app/orders/page.jsx and components/OrderForm.jsx still requires node_modules.`,
      paths: backendPaths,
    });
  }
  const jsxPaths = ['app/orders/page.jsx', 'components/OrderForm.jsx'];
  const existingJsxPaths = [];
  for (const jsxPath of jsxPaths) {
    if (await readDiskFile(jsxPath) !== null) existingJsxPaths.push(jsxPath);
  }
  if (!hasNodeModules && existingJsxPaths.length) {
    findings.push({
      type: 'WORKSPACE_GAP',
      severity: 'WARN',
      message: `[DETECTED WORKSPACE GAP] Missing node_modules for JSX source files (${existingJsxPaths.join(', ')}): standalone Next.js/React compilation is unavailable without installed React and bundler packages. The backend currently serves its interactive UI through the built-in HTTP handler when its live UI probe passes.`,
      paths: [...existingJsxPaths, 'node_modules'],
    });
  }
  const envExampleExists = await readDiskFile('.env.example') !== null;
  const envFileExists = await readDiskFile('.env') !== null;
  if (envExampleExists && !envFileExists) {
    const configPath = modularPlan.routeContracts?.[0]?.configFile || 'config/db.js';
    const configSource = await readDiskFile(configPath) || '';
    const hasPortFallback = /process\.env\.PORT[^;\n]{0,40}\|\|\s*5000/.test(configSource);
    const modelSource = await readDiskFile(modularPlan.routeContracts?.[0]?.modelFile || '') || '';
    const hasMemoryStore = modelSource.includes('const records = []');
    findings.push({
      type: 'WORKSPACE_GAP',
      severity: 'WARN',
      message: `[DETECTED WORKSPACE GAP] Missing .env file: .env.example is present on disk, but .env has not been created${hasPortFallback && hasMemoryStore ? ' (the inspected server configuration falls back to PORT=5000 and uses a local in-memory store)' : ''}.`,
      paths: ['.env.example', '.env', configPath],
    });
  }

  const route = modularPlan.routeContracts?.[0];
  const actualContents = new Map();
  for (const module of modularPlan.modulesToCreate || []) {
    const actualSource = await readActualFile(module.path);
    if (actualSource !== null) actualContents.set(normalizePath(module.path), actualSource);
  }
  const actualStaticResult = verifyHermeticEngineeringGates(modularPlan, actualContents);
  const actualResolution = moduleResolutionGate(root, modularPlan, actualContents);
  const arrayFields = (modularPlan.routeSchema?.fields || []).filter((field) => field.type === 'array');
  const syncPlan = [];
  const syncTargets = route ? [
    route.integrationFile,
    route.targetFile,
    route.pageFile,
    route.configFile,
  ].filter(Boolean).map(normalizePath) : [];
  const integrationPath = route ? normalizePath(route.integrationFile) : null;
  if (route && arrayFields.length && integrationPath) {
    const integrationModule = (modularPlan.modulesToCreate || []).find((module) => normalizePath(module.path) === integrationPath);
    const actualServer = integrationModule?.diskBaselineContent ?? await readDiskFile(integrationPath);
    const emptyInlineArrayContract = /\bconst\s+itemFields\s*=\s*\{\s*\}/.test(String(actualServer || ''));
    const missingItemFields = arrayFields.flatMap((field) => (field.items || []).map((item) => item.name))
      .filter((fieldName) => emptyInlineArrayContract || !String(actualServer || '').includes(fieldName));
    if (actualServer && /\bpreviewHtml\b/.test(actualServer) && missingItemFields.length) {
      const stalePaths = [integrationPath];
      findings.push({
        type: 'DETECTED_BUG',
        severity: 'WARN',
        message: `[DETECTED BUG] Stale inline UI contract: ${integrationPath} serves an embedded form that does not include inferred nested fields (${missingItemFields.join(', ')}), while the model/controller/form contract contains ${arrayFields.map((field) => `${field.name}[]`).join(', ')}.`,
        paths: stalePaths,
      });
      bugs.push({
        path: integrationPath,
        line: null,
        description: `Embedded previewHtml is missing nested fields: ${missingItemFields.join(', ')}.`,
      });
      syncPlan.push(...syncTargets.map((filePath) => ({
        path: filePath,
        action: filePath === integrationPath ? 'REPAIR' : 'REVIEW_SYNC',
        reason: filePath === integrationPath
          ? 'Regenerate the embedded HTTP UI against the inferred nested schema.'
          : 'Review against the regenerated workspace contract before approval.',
      })));
    }
  }

  for (const failure of actualStaticResult.syntaxFailures || []) {
    bugs.push({
      path: failure.path,
      line: failure.line || null,
      description: failure.error || failure.message || 'Source syntax could not be verified.',
    });
  }
  for (const failure of actualResolution.failures || []) {
    bugs.push({
      path: failure.path,
      line: null,
      description: `Unresolved import "${failure.specifier}": ${failure.reason}`,
    });
  }
  for (const gate of actualStaticResult.gates || []) {
    if (gate.passed || !['SCHEMA_CONTRACT', 'VALIDATION_AND_STATUS', 'FULL_STACK_WIRING', 'CROSS_LAYER_DATA_FLOW'].includes(gate.id)) continue;
    bugs.push({
      path: route?.integrationFile || 'workspace',
      line: null,
      description: `${gate.id}: ${typeof gate.evidence === 'string' ? gate.evidence : JSON.stringify(gate.evidence)}`,
    });
  }
  const dedupedBugs = [...new Map(bugs.map((bug) => [
    `${bug.path}:${bug.line || ''}:${bug.description}`,
    bug,
  ])).values()];
  if (dedupedBugs.length) {
    findings.push({
      type: 'DETECTED_BUGS',
      severity: 'WARN',
      message: `Detected ${dedupedBugs.length} source or integration bug(s); see the exact file and module diagnostics.`,
      paths: [...new Set(dedupedBugs.map((bug) => bug.path))],
    });
  }
  const inspectedFiles = [...diskInspections.values()].sort((left, right) => left.path.localeCompare(right.path));
  const directoryPaths = new Set(['.']);
  for (const file of inspectedFiles) {
    const parent = path.posix.dirname(file.path);
    if (parent && parent !== '.') directoryPaths.add(parent);
  }
  const exploredDirectories = [];
  for (const relativeDirectory of [...directoryPaths].sort((left, right) => left.localeCompare(right))) {
    try {
      const directoryPath = relativeDirectory === '.'
        ? root
        : path.join(root, ...validateSafePath(root, relativeDirectory).split('/'));
      const stat = await fs.lstat(directoryPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const entries = await fs.readdir(directoryPath);
      exploredDirectories.push({ path: relativeDirectory, entryCount: entries.length });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
  }
  const routeEvidence = route
    ? `Audited ${route.method} ${route.path} with integration ${route.integrationFile}, model ${route.modelFile}, controller ${route.controllerFile}, route module ${route.targetFile}, UI ${route.frontendFile || route.pageFile || 'not present'}, and test suite ${route.testFile}.`
    : 'No route contract was available for cross-file inspection.';
  const engineeringSummary = [
    {
      phase: 'Workspace topology',
      summary: `Read ${inspectedFiles.length} on-disk file(s) and enumerated ${exploredDirectories.length} directory(ies): ${inspectedFiles.map((file) => `${file.path} (${file.lineCount} lines)`).join(', ') || 'no existing files were read'}.`,
    },
    {
      phase: 'Cross-file contract',
      summary: routeEvidence,
    },
    {
      phase: 'Environment and drift',
      summary: findings.length
        ? findings.map((finding) => finding.message).join(' ')
        : 'No workspace environment or cross-file drift findings were reported.',
    },
    {
      phase: 'Verification plan',
      summary: `Static hermetic gates reported ${staticResult.passed}/${staticResult.total}; when they pass, the runtime verifier executes the in-process HTTP loopback probes.`,
    },
  ];
  return {
    status: dedupedBugs.length || findings.some((finding) => finding.severity === 'WARN')
      ? 'ISSUES_FOUND'
      : 'NO_BLOCKING_ISSUES',
    findings,
    bugs: dedupedBugs,
    syncPlan,
    dependencies: {
      declared: dependencyNames,
      nodeModulesPresent: hasNodeModules,
    },
    environment: {
      envExamplePresent: envExampleExists,
      envFilePresent: envFileExists,
      jsxFiles: existingJsxPaths,
    },
    inspectedPaths: [...inspectedPaths, 'package.json', 'node_modules', '.env', '.env.example'],
    inspectedFiles,
    exploredDirectories,
    engineeringSummary,
    engineeringAnalysis: engineeringSummary,
  };
}

async function verifyHermeticEngineeringGatesWithRuntime(modularPlan, fileContents = moduleContentByPath(modularPlan), options = {}) {
  const staticResult = verifyHermeticEngineeringGates(modularPlan, fileContents, options);
  const workspaceAudit = options.root
    ? await auditProjectWorkspace(options.root, modularPlan, fileContents, staticResult)
    : null;
  const runtimeGate = staticResult.passed === staticResult.total
    ? await verifyCandidateRuntimeGate(modularPlan, fileContents)
    : {
      id: 'CANDIDATE_RUNTIME_BEHAVIOR',
      passed: false,
      evidence: 'Runtime probes were not executed because one or more static hermetic gates failed.',
      probes: [],
      diagnostics: [{ path: 'candidate', reason: 'Static hermetic checks must pass before runtime probes.' }],
    };
  const gates = [...staticResult.gates, runtimeGate];
  const passed = gates.filter((gate) => gate.passed).length;
  return {
    ...staticResult,
    status: passed === gates.length ? 'HERMETIC_CONTRACT_SYNTAX_AND_RUNTIME_VERIFIED' : 'HERMETIC_VERIFICATION_FAILED',
    passed,
    total: gates.length,
    gates,
    runtimeVerification: runtimeGate,
    workspaceAudit,
  };
}

async function runHermeticRegressionLoopWithRuntime(modularPlan, { root, onProgress = () => {}, maxPasses = 3 } = {}) {
  const repairs = [];
  let result;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    runHermeticRegressionLoop(modularPlan, { root, onProgress, maxPasses });
    result = await verifyHermeticEngineeringGatesWithRuntime(
      modularPlan,
      moduleContentByPath(modularPlan),
      { root },
    );
    if (result.passed === result.total) {
      result.regressionLoop = { passes: pass, repairs };
      return result;
    }
    const runtimeGate = result.gates.find((gate) => gate.id === 'CANDIDATE_RUNTIME_BEHAVIOR');
    for (const failure of runtimeGate?.diagnostics || []) {
      onProgress({
        phase: 'THINK_REGRESSION_DIAGNOSTIC',
        message: `[THINK / REGRESSION LOOP] PASS ${pass} ${runtimeGate.id} @ ${failure.path}: ${failure.reason}`,
      });
    }
    if (pass === maxPasses || !runtimeGate || runtimeGate.passed) break;
    const before = new Map((modularPlan.modulesToCreate || []).map((module) => [module.path, module.content]));
    const failedPaths = new Set((runtimeGate.diagnostics || []).map((failure) => normalizePath(failure.path)));
    for (const module of modularPlan.modulesToCreate || []) {
      if (!failedPaths.has(normalizePath(module.path))
        || (module.operation === 'reuse' && !modularPlan.isProjectRuntimeTest)
        || typeof module.hermeticBaselineContent !== 'string') continue;
      restoreHermeticBaseline(module, modularPlan);
    }
    repairHermeticCandidate(modularPlan);
    syncProjectRuntimeTestOperations(modularPlan);
    const changed = (modularPlan.modulesToCreate || []).filter((module) => before.get(module.path) !== module.content);
    if (!changed.length) {
      onProgress({
        phase: 'THINK_REGRESSION',
        message: `[THINK / REGRESSION LOOP] PASS ${pass} has no safe runtime repair; verification remains fail-closed.`,
      });
      break;
    }
    for (const module of changed) {
      const message = `Repaired ${module.path} after candidate runtime probe failure.`;
      repairs.push(message);
      onProgress({
        phase: 'THINK_REGRESSION_REPAIR',
        message: `[DEEP-THINK REPAIR PASS ${pass}] [SELF-REPAIR] Upgraded ${module.path} after runtime verification.`,
      });
    }
  }
  if (result) result.regressionLoop = { passes: Math.min(maxPasses, repairs.length + 1), repairs };
  return result;
}

function repairHermeticCandidate(modularPlan) {
  const packageModule = modularPlan.modulesToCreate.find((module) => normalizePath(module.path) === 'package.json');
  const route = (modularPlan.routeContracts || [])[0];
  let packageMetadata = {};
  if (packageModule && route) {
    try {
      packageMetadata = JSON.parse(packageModule.content);
    } catch {
      packageMetadata = {};
    }
    packageMetadata.scripts = {
      ...(packageMetadata.scripts || {}),
      start: `node ${route.integrationFile}`,
      dev: `node ${route.integrationFile}`,
      test: packageMetadata.scripts?.test || `node --check ${route.integrationFile}`,
    };
    packageMetadata.dependencies = {
      ...(packageMetadata.dependencies || {}),
      react: packageMetadata.dependencies?.react || '^18.3.1',
      'react-dom': packageMetadata.dependencies?.['react-dom'] || '^18.3.1',
    };
    packageMetadata.type = packageMetadata.type || 'commonjs';
    packageModule.content = `${JSON.stringify(packageMetadata, null, 2)}\n`;
  }

  const fields = modularPlan.routeSchema?.fields || [];
  const model = moduleForResponsibility(modularPlan, 'DATA_MODEL');
  if (model && fields.length) {
    const serializedFields = JSON.stringify(fields, null, 2);
    const fieldsStart = model.content.indexOf('const fields = ');
    const fieldsEnd = fieldsStart >= 0
      ? Math.min(
        ...[
          model.content.indexOf('\nconst records =', fieldsStart),
          model.content.indexOf('\n\nfunction validate', fieldsStart),
        ].filter((index) => index >= 0),
      )
      : -1;
    if (fieldsStart >= 0 && Number.isFinite(fieldsEnd)) {
      model.content = `${model.content.slice(0, fieldsStart)}const fields = ${serializedFields};${model.content.slice(fieldsEnd)}`;
    }
    const computedTotal = fields.find((field) => (
      field.type === 'number' && /(?:total|amount|subtotal|sum)/i.test(field.name)
    ));
    const lineItems = fields.find((field) => (
      field.type === 'array'
        && field.items?.some((item) => /(?:price|cost|amount)/i.test(item.name))
        && field.items?.some((item) => /(?:quantity|count|units)/i.test(item.name))
    ));
    if (computedTotal && lineItems && !model.content.includes('.reduce(')) {
      const priceField = lineItems.items.find((item) => /(?:price|cost|amount)/i.test(item.name)).name;
      const quantityField = lineItems.items.find((item) => /(?:quantity|count|units)/i.test(item.name)).name;
      const applyDefaultsHeader = /function applyDefaults\(payload\)\s*\{\s*const value = \{ \.\.\.payload \};/;
      const calculation = `function applyDefaults(payload) {\n  const value = { ...payload };\n  if (Array.isArray(value[${JSON.stringify(lineItems.name)}])) {\n    value[${JSON.stringify(computedTotal.name)}] = value[${JSON.stringify(lineItems.name)}].reduce((sum, item) => sum + Number(item[${JSON.stringify(priceField)}] || 0) * Number(item[${JSON.stringify(quantityField)}] || 0), 0);\n  }`;
      model.content = model.content.replace(applyDefaultsHeader, calculation);
    }
  }
  const controller = moduleForResponsibility(modularPlan, 'CORE_BUSINESS_LOGIC');
  if (controller && fields.length && route) {
    const useEsm = packageMetadata.type === 'module';
    const schemaBinding = controller.content.match(/(?:const schema = require\([^\n]+\);|import \* as schema from [^\n;]+;)/)?.[0]
      || (useEsm ? "import * as schema from './model.js';" : "const schema = require('./model');");
    const handlerName = controller.content.match(/async function ([A-Za-z_$][\w$]*)\s*\(/)?.[1]
      || 'handleRequest';
    const responseStatus = route.method === 'POST' ? 201 : 200;
    const listHandlerName = `list${route.entity || route.controllerHandler?.replace(/^handle/, '') || 'Records'}`;
    controller.content = `${useEsm ? '' : "'use strict';\n\n"}${schemaBinding}\nconst requestedFieldContract = ${JSON.stringify(fields.map((field) => field.name), null, 2)};\n\nasync function ${handlerName}(request) {\n  try {\n    const validation = schema.validate(request.body, requestedFieldContract);\n    if (!validation.valid) return { status: 400, body: { errors: validation.errors } };\n    return { status: ${responseStatus}, body: { data: schema.create(request.body) } };\n  } catch (error) {\n    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };\n  }\n}\n\nasync function ${listHandlerName}() {\n  try {\n    return { status: 200, body: { data: schema.list() } };\n  } catch (error) {\n    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };\n  }\n}\n\n${useEsm ? `export { ${handlerName}, ${listHandlerName} };` : `module.exports = { ${handlerName}, ${listHandlerName} };`}\n`;
  }
  const form = route
    ? modularPlan.modulesToCreate.find((module) => normalizePath(module.path) === normalizePath(route.frontendFile))
    : null;
  if (form && fields.length) {
    const initialState = JSON.stringify(Object.fromEntries(fields.map((field) => [
      field.name,
      field.type === 'array' ? [] : field.hasDefault ? field.defaultValue : '',
    ])), null, 2);
    form.content = form.content.replace(
      /const initialForm = [\s\S]*?;\s*(?=export default function)/,
      `const initialForm = ${initialState};\n\n`,
    );
    form.content = form.content.replace(
      /(<form\b[^>]*>\s*)[\s\S]*?(\s*<button type="submit")/,
      `$1\n${buildRequestedFormFields(fields)}\n${buildComputedTotalPreview(fields)}$2`,
    );
    const arrays = fields.filter((field) => field.type === 'array');
    if (arrays.length && !form.content.includes('function updateArrayField(')) {
      const arrayHelpers = `  function updateArrayField(field, index, key, value) { setForm((current) => ({ ...current, [field]: current[field].map((item, row) => row === index ? { ...item, [key]: value } : item) })); }\n  function addArrayItem(field, item) { setForm((current) => ({ ...current, [field]: [...current[field], item] })); }\n  function removeArrayItem(field, index) { setForm((current) => ({ ...current, [field]: current[field].filter((_, row) => row !== index) })); }\n`;
      form.content = form.content.replace('  async function submit(', `${arrayHelpers}  async function submit(`);
    }
  }
  return modularPlan;
}

function removeUnusedMissingExternalImports(modularPlan, failures) {
  let repaired = 0;
  for (const failure of failures || []) {
    const module = modularPlan.modulesToCreate.find((candidate) => normalizePath(candidate.path) === normalizePath(failure.path));
    if (!module) continue;
    const escaped = failure.specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const importStatement = new RegExp(`^[\\t ]*import\\s+([^\\n;]+?)\\s+from\\s+(['"])${escaped}\\2\\s*;?[\\t ]*(?:\\r?\\n|$)`, 'm');
    const requireStatement = new RegExp(`^[\\t ]*(?:(?:const|let|var)\\s+([^=\\n]+?)\\s*=\\s*)?require\\s*\\(\\s*(['"])${escaped}\\2\\s*\\)\\s*;?[\\t ]*(?:\\r?\\n|$)`, 'm');
    let match = module.content.match(importStatement);
    let pattern = importStatement;
    if (!match) {
      match = module.content.match(requireStatement);
      pattern = requireStatement;
    }
    if (!match) continue;
    const bindings = (match[1] || '').match(/[A-Za-z_$][\w$]*/g) || [];
    const remainingSource = module.content.replace(pattern, '');
    if (bindings.some((binding) => new RegExp(`\\b${binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(remainingSource))) {
      continue;
    }
    module.content = remainingSource;
    repaired += 1;
  }
  return repaired;
}

function gateFailureDiagnostics(result, modularPlan) {
  const diagnostics = [];
  const modulePath = (responsibility) => (
    modularPlan.modulesToCreate.find((module) => module.responsibility === responsibility)?.path || 'unknown'
  );
  for (const gate of result.gates || []) {
    if (gate.passed) continue;
    if (gate.id === 'SYNTAX_AND_AST') {
      for (const failure of result.syntaxFailures || []) {
        diagnostics.push({ gate: gate.id, path: failure.path, reason: failure.error || failure.message || 'JavaScript parsing failed.' });
      }
    } else if (gate.id === 'MODULE_AND_RUNTIME_RESOLUTION') {
      for (const failure of result.moduleResolution?.failures || []) {
        diagnostics.push({ gate: gate.id, path: failure.path, reason: `${failure.specifier}: ${failure.reason}` });
      }
    } else if (gate.id === 'SCHEMA_CONTRACT') {
      const missingFields = gate.evidence?.missingFields || [];
      if (missingFields.length) {
        for (const role of ['DATA_MODEL', 'CORE_BUSINESS_LOGIC', 'UI_PRESENTATION']) {
          diagnostics.push({ gate: gate.id, path: modulePath(role), reason: `Required field contract is missing: ${missingFields.join(', ')}.` });
        }
      }
      if (gate.evidence?.totalCalculationPassed === false) {
        diagnostics.push({ gate: gate.id, path: modulePath('DATA_MODEL'), reason: 'Computed total is not derived from the line-item fields.' });
      }
    } else if (gate.id === 'VALIDATION_AND_STATUS') {
      diagnostics.push({ gate: gate.id, path: modulePath('CORE_BUSINESS_LOGIC'), reason: JSON.stringify(gate.evidence) });
    } else if (gate.id === 'FULL_STACK_WIRING') {
      for (const module of modularPlan.modulesToCreate.filter((candidate) => [
        'ROUTING', 'APPLICATION_ENTRYPOINT', 'UI_PRESENTATION',
      ].includes(candidate.responsibility))) {
        diagnostics.push({ gate: gate.id, path: module.path, reason: String(gate.evidence) });
      }
    } else if (gate.id === 'RUN_READINESS') {
      for (const target of ['package.json', '.env.example', 'README.md', (modularPlan.routeContracts || [])[0]?.testFile]) {
        if (!target) continue;
        diagnostics.push({ gate: gate.id, path: target, reason: String(gate.evidence) });
      }
    } else if (gate.id === 'CROSS_LAYER_DATA_FLOW') {
      for (const issue of result.dataFlow?.issues || []) {
        diagnostics.push({ gate: gate.id, path: issue.path, reason: issue.reason });
      }
    } else if (gate.id === 'ADVERSARIAL_BEHAVIOR_MATRIX') {
      for (const vector of result.behavioralMatrix?.vectors || []) {
        if (vector.passed) continue;
        const paths = vector.id === 'structured-client-and-server-error-responses'
          ? [modulePath('CORE_BUSINESS_LOGIC'), modulePath('UI_PRESENTATION')]
          : vector.id === 'required-scalar-whitespace-rejected'
            || vector.id === 'empty-or-non-array-nested-collection-rejected'
            || vector.id === 'invalid-nested-item-values-rejected'
            ? [modulePath('DATA_MODEL'), modulePath('UI_PRESENTATION')]
            : [modulePath('DATA_MODEL'), modulePath('CORE_BUSINESS_LOGIC'), modulePath('UI_PRESENTATION')];
        for (const targetPath of paths) {
          diagnostics.push({ gate: gate.id, path: targetPath, reason: `${vector.id}: ${vector.reason}` });
        }
      }
    }
  }
  return diagnostics;
}

function restoreHermeticBaseline(module, modularPlan) {
  if (!module || typeof module.hermeticBaselineContent !== 'string'
    || module.content === module.hermeticBaselineContent) return false;
  module.content = module.hermeticBaselineContent;
  if (modularPlan.isProjectRuntimeTest && typeof module.diskBaselineContent === 'string') {
    module.operation = module.hermeticBaselineContent === module.diskBaselineContent ? 'reuse' : 'modify';
  }
  return true;
}

function syncProjectRuntimeTestOperations(modularPlan) {
  if (modularPlan.isProjectRuntimeTest !== true) return;
  for (const module of modularPlan.modulesToCreate || []) {
    if (typeof module.diskBaselineContent !== 'string') continue;
    module.operation = normalizeRuntimeSource(module.content) === normalizeRuntimeSource(module.diskBaselineContent)
      ? 'reuse'
      : 'modify';
  }
}

function runHermeticRegressionLoop(modularPlan, { root, onProgress = () => {}, maxPasses = 3 } = {}) {
  const repairs = [];
  let result;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    result = verifyHermeticEngineeringGates(modularPlan, moduleContentByPath(modularPlan), { root });
    if (result.passed === result.total) {
      result.regressionLoop = { passes: pass, repairs };
      return result;
    }
    const diagnostics = gateFailureDiagnostics(result, modularPlan);
    const failedGates = result.gates.filter((gate) => !gate.passed).map((gate) => gate.id);
    onProgress({
      phase: 'THINK_REGRESSION',
      message: `[DEEP-THINK PASS ${pass}/${maxPasses}] Failed gates: ${failedGates.join(', ')}. Inspecting generated modules and applying only safe, semantics-preserving repairs.`,
    });
    for (const failure of diagnostics) {
      onProgress({
        phase: 'THINK_REGRESSION_DIAGNOSTIC',
        message: `[THINK / REGRESSION LOOP] PASS ${pass} ${failure.gate} @ ${failure.path}: ${failure.reason}`,
      });
    }
    if (pass === maxPasses) break;
    const before = new Map((modularPlan.modulesToCreate || []).map((module) => [module.path, module.content]));
    repairHermeticCandidate(modularPlan);
    syncProjectRuntimeTestOperations(modularPlan);
    const dependencyRepairs = removeUnusedMissingExternalImports(modularPlan, result.moduleResolution?.failures);
    const repairedPaths = new Set();
    for (const failure of diagnostics) {
      const module = modularPlan.modulesToCreate.find((candidate) => normalizePath(candidate.path) === normalizePath(failure.path));
      if (!module || (module.operation === 'reuse' && !modularPlan.isProjectRuntimeTest)
        || typeof module.hermeticBaselineContent !== 'string'
        || module.content === module.hermeticBaselineContent) continue;
      const helperChangedCandidate = before.get(module.path) !== module.content;
      const candidateWasAlreadyModified = before.get(module.path) !== module.hermeticBaselineContent;
      const mustRestore = ['SYNTAX_AND_AST', 'MODULE_AND_RUNTIME_RESOLUTION', 'FULL_STACK_WIRING', 'CROSS_LAYER_DATA_FLOW', 'ADVERSARIAL_BEHAVIOR_MATRIX'].includes(failure.gate)
        || (candidateWasAlreadyModified && !helperChangedCandidate);
      if (!mustRestore) continue;
      if (restoreHermeticBaseline(module, modularPlan)) repairedPaths.add(module.path);
    }
    if (repairedPaths.size) repairHermeticCandidate(modularPlan);
    const contentRepairs = (modularPlan.modulesToCreate || []).filter((module) => (
      before.get(module.path) !== module.content || repairedPaths.has(module.path)
    ));
    if (contentRepairs.length) {
      repairs.push(...contentRepairs.map((module) => `Repaired ${module.path} from its approved full-stack baseline.`));
      for (const module of contentRepairs) {
        onProgress({
          phase: 'THINK_REGRESSION_REPAIR',
          message: `[DEEP-THINK REPAIR PASS ${pass}] [SELF-REPAIR] Upgraded ${module.path} to the verified full-stack candidate.`,
        });
      }
    }
    if (dependencyRepairs) {
      repairs.push(`Removed ${dependencyRepairs} unused import(s) of packages missing from the workspace.`);
    }
    if (!contentRepairs.length && !dependencyRepairs) {
      onProgress({
        phase: 'THINK_REGRESSION',
        message: `[THINK / REGRESSION LOOP] PASS ${pass} has no safe automatic repair; verification remains fail-closed.`,
      });
      break;
    }
    onProgress({
      phase: 'THINK_REGRESSION',
      message: `[DEEP-THINK PASS ${pass}] Repaired ${contentRepairs.length + dependencyRepairs} issue(s); rerunning all eight gates.`,
    });
  }
  result.regressionLoop = { passes: Math.min(maxPasses, repairs.length ? repairs.length + 1 : 1), repairs };
  return result;
}

async function verifyHermeticEngineeringGatesOnDisk(root, modularPlan) {
  const diskContents = new Map();
  for (const module of modularPlan.modulesToCreate || []) {
    const safePath = validateSafePath(root, module.path);
    try {
      diskContents.set(normalizePath(safePath), await fs.readFile(path.join(root, ...safePath.split('/')), 'utf8'));
    } catch (error) {
      return {
        status: 'HERMETIC_VERIFICATION_FAILED',
        passed: 0,
        total: 9,
        gates: [{
          id: 'SYNTAX_AND_AST',
          passed: false,
          evidence: `Could not read approved file ${safePath}: ${error.message}`,
        }],
        syntaxFailures: [],
        moduleResolution: {
          passed: false,
          evidence: 'Module resolution was not run because an approved file could not be read.',
          resolved: [],
          failures: [],
        },
      };
    }
  }
  return verifyHermeticEngineeringGatesWithRuntime(modularPlan, diskContents, { root });
}

async function synthesizeMultiFilePatch(root, modularPlan, options = {}) {
  const snapshotFn = typeof options.snapshotTarget === 'function' ? options.snapshotTarget : (r, p) => defaultSnapshotTarget(r, p);
  const splitPatchLines = (content) => {
    if (!content) return [];
    const lines = String(content).split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return lines;
  };
  const normalizePatchContent = (content) => splitPatchLines(content).join('\n');
  const buildFileDiff = (safePath, operation, original, target) => {
    const oldLines = operation === 'create' ? [] : splitPatchLines(original);
    const newLines = splitPatchLines(target);
    const oldStart = oldLines.length === 0 ? 0 : 1;
    const newStart = newLines.length === 0 ? 0 : 1;
    return [
      `diff --git a/${safePath} b/${safePath}`,
      operation === 'create' ? '--- /dev/null' : `--- a/${safePath}`,
      `+++ b/${safePath}`,
      `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
      '',
    ].join('\n');
  };
  const patchParts = [];
  const expectedSnapshots = [];
  const filesList = [];
  const stagedTargets = new Map();
  const claimTarget = (targetPath, content, operation) => {
    const key = process.platform === 'win32' ? normalizePath(targetPath).toLowerCase() : normalizePath(targetPath);
    const previous = stagedTargets.get(key);
    if (!previous) {
      stagedTargets.set(key, { content, operation, path: targetPath });
      return false;
    }
    if (previous.content === content && previous.operation === operation) return true;
    throw new Error(`Conflicting modular operations target the same file: ${targetPath}.`);
  };

  // 1. Process generated modules, using the inspected operation and snapshot.
  for (const mod of modularPlan.modulesToCreate) {
    const safePath = validateSafePath(root, mod.path);
    const operation = mod.operation || 'create';
    if (claimTarget(safePath, mod.content, operation)) continue;
    if (operation === 'rename') {
      const sourcePath = validateSafePath(root, mod.sourcePath);
      if (sourcePath === safePath) throw new Error(`Rename source and target must differ: ${sourcePath}.`);
      if (claimTarget(sourcePath, mod.content, 'rename-source')) {
        throw new Error(`Conflicting modular operations rename the same source: ${sourcePath}.`);
      }
      const sourceSnapshot = await snapshotFn(root, sourcePath);
      const targetSnapshot = await snapshotFn(root, safePath);
      if (!sourceSnapshot.exists) {
        throw new Error(`STALE_PROPOSAL_DRIFT: Expected rename source [${sourcePath}] is missing.`);
      }
      if (targetSnapshot.exists) {
        throw new Error(`STALE_PROPOSAL_DRIFT: Rename target [${safePath}] already exists.`);
      }
      expectedSnapshots.push(sourceSnapshot, targetSnapshot);
      patchParts.push([
        `diff --git a/${sourcePath} b/${safePath}`,
        'similarity index 100%',
        `rename from ${sourcePath}`,
        `rename to ${safePath}`,
        '',
      ].join('\n'));
      filesList.push({
        path: safePath,
        sourcePath,
        operation,
        responsibility: mod.responsibility,
        dependencies: mod.dependencies,
      });
      continue;
    }
    const snap = await snapshotFn(root, safePath);
    if (operation === 'modify' && !snap.exists) {
      throw new Error(`STALE_PROPOSAL_DRIFT: Expected existing target [${safePath}] is missing.`);
    }
    if (operation === 'create' && snap.exists) {
      throw new Error(`STALE_PROPOSAL_DRIFT: New target [${safePath}] already exists.`);
    }
    if (operation === 'reuse') {
      if (!snap.exists) {
        throw new Error(`STALE_PROPOSAL_DRIFT: Expected reusable target [${safePath}] is missing.`);
      }
      continue;
    }
    if (operation === 'modify'
        && normalizePatchContent(snap.content || '') === normalizePatchContent(mod.content || '')) {
      continue;
    }
    expectedSnapshots.push(snap);

    patchParts.push(buildFileDiff(safePath, operation, snap.content || '', mod.content));
    filesList.push({
      path: safePath,
      operation,
      responsibility: mod.responsibility,
      dependencies: mod.dependencies,
    });
  }

  // 2. Process integration points
  for (const point of modularPlan.integrationPoints) {
    const safePath = validateSafePath(root, point.targetFile);
    const snap = await snapshotFn(root, safePath);
    const operation = snap.exists ? 'modify' : 'create';
    if (claimTarget(safePath, point.patchedContent || '', operation)) continue;
    if (snap.exists
        && normalizePatchContent(snap.content || '') === normalizePatchContent(point.patchedContent || '')) {
      continue;
    }
    expectedSnapshots.push(snap);
    const original = snap.exists ? (snap.content || '') : (point.originalContent || '');

    patchParts.push(buildFileDiff(safePath, operation, original, point.patchedContent || ''));
    filesList.push({
      path: safePath,
      operation,
      responsibility: point.responsibility,
    });
  }

  const rawPatch = patchParts.join('\n');

  return {
    rawPatch,
    expectedSnapshots,
    filesList,
    planRecord: modularPlan.planRecord,
  };
}

/**
 * Validates that after application, all created modules exist on disk and integration points
 * are truly functional and reachable, not merely present.
 */
async function verifyIntegrationReachability(root, modularPlan, { probeRoute } = {}) {
  const result = {
    isValid: true,
    verifiedFiles: [],
    unverifiedFiles: [],
    incompleteIntegrations: [],
    rejectionReason: null,
  };

  // 1. Verify existence of all created files
  for (const mod of modularPlan.modulesToCreate) {
    const safePath = validateSafePath(root, mod.path);
    const fullPath = path.join(root, ...safePath.split('/'));
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        result.isValid = false;
        result.unverifiedFiles.push(safePath);
        result.rejectionReason = `Target module [${safePath}] was not created as a file on disk.`;
        return result;
      }
      const content = await fs.readFile(fullPath, 'utf8');
      if (!content.trim()) {
        result.isValid = false;
        result.unverifiedFiles.push(safePath);
        result.rejectionReason = `Target module [${safePath}] was created with empty content.`;
        return result;
      }
      result.verifiedFiles.push(safePath);
    } catch (err) {
      result.isValid = false;
      result.unverifiedFiles.push(safePath);
      result.rejectionReason = `Failed to verify disk state for module [${safePath}]: ${err.message}`;
      return result;
    }
  }
  result.syntaxChecks = [];
  for (const mod of modularPlan.modulesToCreate) {
    const safePath = validateSafePath(root, mod.path);
    if (!/\.(?:c?js|mjs|jsx|tsx?)$/i.test(safePath)) continue;
    try {
      const source = await fs.readFile(path.join(root, ...safePath.split('/')), 'utf8');
      const check = parseJavaScriptSource(source, safePath);
      result.syntaxChecks.push({ path: safePath, ...check });
      if (check.status !== 'SYNTAX_VERIFIED') {
        result.isValid = false;
        result.unverifiedFiles.push(safePath);
        result.rejectionReason = `Syntax verification ${check.status === 'SYNTAX_INVALID' ? 'failed' : 'was unavailable'} for [${safePath}]: ${check.reason}`;
        return result;
      }
    } catch (error) {
      result.isValid = false;
      result.unverifiedFiles.push(safePath);
      result.syntaxChecks.push({
        path: safePath,
        status: 'SYNTAX_READ_FAILED',
        parser: null,
        reason: error.message,
      });
      result.rejectionReason = `Syntax source could not be read for [${safePath}]: ${error.message}`;
      return result;
    }
  }

  // 2. Verify integration points contain the integration reference
  for (const point of modularPlan.integrationPoints) {
    const safePath = validateSafePath(root, point.targetFile);
    const fullPath = path.join(root, ...safePath.split('/'));
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        result.isValid = false;
        result.incompleteIntegrations.push({ path: safePath, reason: 'Integration target file does not exist on disk.' });
        result.rejectionReason = `Integration target file [${safePath}] is missing.`;
        return result;
      }
      const diskContent = await fs.readFile(fullPath, 'utf8');
      const snippet = String(point.integrationSnippet || '').trim();
      if (snippet && !diskContent.includes(snippet)) {
        result.isValid = false;
        result.incompleteIntegrations.push({ path: safePath, reason: `Integration snippet [${snippet}] was not found in ${safePath}.` });
        result.rejectionReason = `Incomplete integration: [${safePath}] does not reference the newly created module.`;
        return result;
      }
      result.verifiedFiles.push(safePath);
    } catch (err) {
      result.isValid = false;
      result.incompleteIntegrations.push({ path: safePath, reason: err.message });
      result.rejectionReason = `Integration point verification failed for [${safePath}]: ${err.message}`;
      return result;
    }
  }

  const integratedPaths = new Set([
    ...(modularPlan.modulesToCreate || []).map((module) => normalizePath(module.path)),
    ...(modularPlan.integrationPoints || []).map((point) => normalizePath(point.targetFile)),
  ]);
  for (const route of modularPlan.routeContracts || []) {
    const targetFile = validateSafePath(root, route.targetFile);
    const routePath = validateRoutePath(route.path);
    if (!integratedPaths.has(normalizePath(targetFile))) {
      result.isValid = false;
      result.incompleteIntegrations.push({
        path: targetFile,
        reason: 'The route contract target is not part of the approved integration plan.',
      });
      result.rejectionReason = `Route target is outside the approved integration plan: ${targetFile}.`;
      return result;
    }
    if (route.staticMountVerification === true) {
      const routeModule = modularPlan.modulesToCreate.find((module) => (
        normalizePath(module.path) === normalizePath(targetFile)
      ));
      const serverPath = validateSafePath(root, route.integrationFile);
      const serverModule = modularPlan.modulesToCreate.find((module) => (
        normalizePath(module.path) === normalizePath(serverPath)
      ));
      const routeSource = routeModule
        ? await fs.readFile(path.join(root, ...targetFile.split('/')), 'utf8')
        : '';
      const serverSource = serverModule
        ? await fs.readFile(path.join(root, ...serverPath.split('/')), 'utf8')
        : '';
      const controllerPath = validateSafePath(root, route.controllerFile);
      const modelPath = validateSafePath(root, route.modelFile);
      const controllerModule = modularPlan.modulesToCreate.find((module) => (
        normalizePath(module.path) === normalizePath(controllerPath)
      ));
      const modelModule = modularPlan.modulesToCreate.find((module) => (
        normalizePath(module.path) === normalizePath(modelPath)
      ));
      const controllerSource = controllerModule
        ? await fs.readFile(path.join(root, ...controllerPath.split('/')), 'utf8')
        : '';
      const modelSource = modelModule
        ? await fs.readFile(path.join(root, ...modelPath.split('/')), 'utf8')
        : '';
      const controllerRequirePath = path.posix.relative(
        path.posix.dirname(targetFile),
        controllerPath,
      ).replace(/^(?!\.)/, './');
      const modelRequirePath = path.posix.relative(
        path.posix.dirname(controllerPath),
        modelPath,
      ).replace(/^(?!\.)/, './');
      const routeDeclaration = containsQuotedValue(routeSource, route.method)
        && containsQuotedValue(routeSource, routePath)
        && /function\s+registerRoutes\s*\(/.test(routeSource)
        && containsRequire(routeSource, controllerRequirePath)
        && (!route.controllerHandler || (
          routeSource.includes(route.controllerHandler)
          && routeSource.includes(`${route.controllerHandler}(`)
        ));
      const controllerImportsModel = containsRequire(controllerSource, modelRequirePath)
        && /\b(?:function\s+validate|validate\s*\()\s*/.test(modelSource)
        && /\b(?:schema|[A-Za-z_$][\w$]*Schema)\.validate\s*\(/.test(controllerSource);
      const routeImportPath = path.posix.relative(
        path.posix.dirname(serverPath),
        targetFile,
      );
      const serverMount = containsRequire(serverSource, routeImportPath.replace(/^(?!\.)/, './'))
        && /registerRoutes\s*\(\s*app\s*\)/.test(serverSource)
        && /register\s*\(\s*method,\s*routePath,\s*handler\s*\)/.test(serverSource)
        && /\b(?:routes|handlers)\.set\s*\(/.test(serverSource);
      const frontendPath = route.frontendFile
        ? validateSafePath(root, route.frontendFile)
        : null;
      const frontendModule = frontendPath
        ? modularPlan.modulesToCreate.find((module) => (
            normalizePath(module.path) === normalizePath(frontendPath)
          ))
        : null;
      const frontendSource = frontendModule
        ? await fs.readFile(path.join(root, ...frontendPath.split('/')), 'utf8')
        : '';
      const frontendCallsRoute = !frontendPath || (
        Boolean(frontendModule)
        && (
          frontendSource.includes(`fetch(${JSON.stringify(routePath)}`)
          || frontendSource.includes(`fetch('${routePath}'`)
          || frontendSource.includes(`fetch("${routePath}"`)
        )
        && frontendSource.includes(`method: ${JSON.stringify(route.method)}`)
      );
      const pagePath = route.pageFile ? validateSafePath(root, route.pageFile) : null;
      const pageModule = pagePath
        ? modularPlan.modulesToCreate.find((module) => (
            normalizePath(module.path) === normalizePath(pagePath)
          ))
        : null;
      const pageSource = pageModule
        ? await fs.readFile(path.join(root, ...pagePath.split('/')), 'utf8')
        : '';
      const frontendImportPath = frontendPath && pagePath
        ? path.posix.relative(path.posix.dirname(pagePath), frontendPath).replace(/^(?!\.)/, './')
        : null;
      const pageMountsFrontend = !pagePath || (
        Boolean(pageModule && frontendPath && route.uiComponent)
        && (pageSource.includes(`import ${route.uiComponent} from '${frontendImportPath}'`)
          || pageSource.includes(`import ${route.uiComponent} from "${frontendImportPath}"`))
        && new RegExp(`<${route.uiComponent}(?:\\s|\\s*\\/?>)`).test(pageSource)
      );
      if (!routeDeclaration || !controllerImportsModel || !serverMount
        || !frontendCallsRoute || !pageMountsFrontend) {
        result.isValid = false;
        result.incompleteIntegrations.push({
          path: targetFile,
          reason: !frontendCallsRoute
            ? `The frontend module does not call ${route.method} ${routePath}.`
            : !pageMountsFrontend
              ? `The page does not mount the frontend module for ${route.method} ${routePath}.`
              : 'The route, controller, model, and server entrypoint are not statically wired.',
        });
        result.rejectionReason = !frontendCallsRoute
          ? `Frontend integration verification failed for ${route.method} ${routePath}.`
          : !pageMountsFrontend
            ? `Page integration verification failed for ${route.method} ${routePath}.`
            : `Static route wiring verification failed for ${route.method} ${routePath}.`;
        return result;
      }
      result.verifiedFiles.push(serverPath);
      const wiredFiles = [...new Set([
        targetFile,
        controllerPath,
        modelPath,
        serverPath,
        frontendPath,
        pagePath,
      ].filter(Boolean))];
      result.routeMounts = [...(result.routeMounts || []), {
        method: route.method,
        path: routePath,
        targetFile,
        integrationFile: serverPath,
        files: wiredFiles,
        verificationType: 'STATIC_WIRING',
        status: 'STATIC_WIRING_VERIFIED',
      }];
      continue;
    }
    if (typeof probeRoute !== 'function') {
      result.isValid = false;
      result.incompleteIntegrations.push({
        path: targetFile,
        reason: `Live route ${route.method} ${routePath} was not probed.`,
      });
      result.rejectionReason = `Live route reachability is unverified: ${route.method} ${routePath}.`;
      return result;
    }
    const observation = await probeRoute({ method: route.method, path: routePath, targetFile });
    if (!observation || observation.executed !== true || !Number.isInteger(observation.status)
      || observation.status < 200 || observation.status >= 500 || observation.status === 404) {
      result.isValid = false;
      result.incompleteIntegrations.push({
        path: targetFile,
        reason: `Live route ${route.method} ${routePath} did not return a host-observed non-404 response.`,
      });
      result.rejectionReason = `Live route reachability failed: ${route.method} ${routePath} returned ${Number.isInteger(observation?.status) ? observation.status : 'no status'}.`;
      return result;
    }
    result.routeMounts = [...(result.routeMounts || []), {
      method: route.method,
      path: routePath,
      targetFile,
      verificationType: 'LIVE_PROBE',
      status: 'LIVE_REACHABILITY_VERIFIED',
    }];
  }

  result.verificationModes = [...new Set((result.routeMounts || []).map((route) => route.verificationType))];
  return result;
}

module.exports = {
  validateSafePath,
  isGreenfieldWorkspace,
  discoverProjectConventions,
  isFullStackBuildRequest,
  isProjectRuntimeTestRequest,
  deriveModularPlan,
  deriveExistingProjectTestPlan,
  moduleResolutionGate,
  runHermeticRegressionLoop,
  runHermeticRegressionLoopWithRuntime,
  verifyHermeticEngineeringGates,
  verifyHermeticEngineeringGatesWithRuntime,
  verifyHermeticEngineeringGatesOnDisk,
  repairHermeticCandidate,
  synthesizeMultiFilePatch,
  verifyIntegrationReachability,
};
