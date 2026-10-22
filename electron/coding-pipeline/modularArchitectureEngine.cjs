'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

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
    || source.match(/(\/(?:api\/)?[A-Za-z0-9_:-]+(?:\/[A-Za-z0-9_:-]+)*)\s*(?:\((GET|POST|PUT|PATCH|DELETE)\)|[-,;:]?\s*(?:using|via|with\s+method)\s+(GET|POST|PUT|PATCH|DELETE)\b)/i);
  if (!match) return null;
  const routeFirst = match[1].startsWith('/');
  const method = (routeFirst ? match[2] || match[3] : match[1]).toUpperCase();
  const routeValue = routeFirst ? match[1] : match[2];
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
    const defaultMatch = metadata.match(/\bdefault\s*[:=]\s*("[^"]*"|'[^']*'|true|false|null|-?\d+(?:\.\d+)?)/i);
    let defaultValue = null;
    if (defaultMatch) {
      const literal = defaultMatch[1];
      try {
        defaultValue = literal.startsWith("'")
          ? literal.slice(1, -1)
          : JSON.parse(literal);
      } catch {
        defaultValue = null;
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
      lines.push(`  if (payload[${fieldKey}] === undefined || payload[${fieldKey}] === null || payload[${fieldKey}] === '') errors.push(${JSON.stringify(`${field.name} is required.`)});`);
    }
    if (field.type === 'array') {
      lines.push(`  if (payload[${fieldKey}] !== undefined && !Array.isArray(payload[${fieldKey}])) errors.push(${JSON.stringify(`${field.name} must be an array.`)});`);
      if (field.items?.length) {
        lines.push(`  if (Array.isArray(payload[${fieldKey}])) payload[${fieldKey}].forEach((item, index) => {`);
        lines.push(`    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(${JSON.stringify(`${field.name}[item] must be an object.`)}); return; }`);
        for (const itemField of field.items) {
          const itemKey = JSON.stringify(itemField.name);
          if (itemField.required) {
            lines.push(`    if (item[${itemKey}] === undefined || item[${itemKey}] === null || item[${itemKey}] === '') errors.push(${JSON.stringify(`${field.name}[${itemField.name}] is required at index `)} + index + '.');`);
          }
          if (itemField.type === 'number') {
            lines.push(`    if (item[${itemKey}] !== undefined && !Number.isFinite(Number(item[${itemKey}]))) errors.push(${JSON.stringify(`${field.name}[${itemField.name}] must be a number at index `)} + index + '.');`);
          }
        }
        lines.push('  });');
      }
    } else if (field.type === 'number') {
      lines.push(`  if (payload[${fieldKey}] !== undefined && payload[${fieldKey}] !== null && !Number.isFinite(Number(payload[${fieldKey}]))) errors.push(${JSON.stringify(`${field.name} must be a number.`)});`);
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

async function deriveRequestedFullStackPlan(root, conventions, userRequest, requirements) {
  const text = [userRequest, ...(Array.isArray(requirements) ? requirements : [])].join('\n');
  const fullStackIntent = isFullStackBuildRequest(text);
  const resolution = text.match(/\bworkspace resolution\s*:\s*(UPDATE_AND_INTEGRATE|REPLACE_TARGETS|KEEP_AND_SCAFFOLD)\b/i)?.[1]?.toUpperCase() || null;
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
  const fields = extractRequestedFields(text);
  if (fullStackIntent && fields.length === 0) {
    fields.push(
      { name: 'id', type: 'string', required: false, hasDefault: false, defaultValue: null },
      { name: 'status', type: 'string', required: false, hasDefault: true, defaultValue: 'Pending' },
      { name: 'createdAt', type: 'date', required: false, hasDefault: false, defaultValue: null },
    );
  }
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
  let pagePath = matchingWorkspaceFile(inspection.files, (file) => (
    /\.(?:[jt]sx?)$/i.test(file)
      && (/(^|\/)(?:app|pages)\//.test(file) || /\bpage\.[jt]sx?$/.test(file))
      && file.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '').includes(entityToken)
  )) || (isNextAppRouter ? `app/${routeResource}/page.jsx` : `pages/${entityPascal}Page.jsx`);
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
      blockedReason: `The request maps to existing substantive modules (${substantiveTargets.join(', ')}). No files were changed. Choose whether to adapt these implementations in place or provide a narrower target and integration contract.`,
    };
  }
  if (resolution === 'KEEP_AND_SCAFFOLD') {
    const targetFallbacks = new Map([
      [modelPath, `generated/${entityCamel}/models/${path.posix.basename(modelPath)}`],
      [controllerPath, `generated/${entityCamel}/controllers/${path.posix.basename(controllerPath)}`],
      [routePath, `generated/${entityCamel}/routes/${path.posix.basename(routePath)}`],
      [serverPath, `generated/${entityCamel}/${path.posix.basename(serverPath)}`],
      [componentPath, `generated/${entityCamel}/components/${path.posix.basename(componentPath)}`],
      [pagePath, `generated/${entityCamel}/pages/${path.posix.basename(pagePath)}`],
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
  const useEsm = packageMetadata.type === 'module';
  const configContent = useEsm
    ? `export default {\n  databaseUrl: process.env.DATABASE_URL || null,\n  port: Number(process.env.PORT) || 0,\n};\n`
    : `'use strict';\n\nmodule.exports = {\n  databaseUrl: process.env.DATABASE_URL || null,\n  port: Number(process.env.PORT) || 0,\n};\n`;
  const modelContent = `'use strict';\n\nconst fields = ${JSON.stringify(fields, null, 2)};\n\nfunction validate(payload) {\n  const errors = [];\n  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, errors: ['A JSON object is required.'] };\n${requiredChecks}\n  return { valid: errors.length === 0, errors };\n}\n\nfunction applyDefaults(payload) {\n  const value = { ...payload };\n  for (const field of fields) if (value[field.name] === undefined && field.hasDefault) value[field.name] = field.defaultValue;\n${totalCalculation}\n  return value;\n}\n\n${useEsm ? 'export { fields, validate, applyDefaults };' : 'module.exports = { fields, validate, applyDefaults };'}\n`;
  const controllerImport = useEsm
    ? `import * as schema from ${JSON.stringify(modelRequire)};`
    : `const schema = require(${JSON.stringify(modelRequire)});`;
  const controllerContent = `'use strict';\n\n${controllerImport}\n\nasync function handle${entityPascal}(request) {\n  try {\n    const validation = schema.validate(request.body);\n    if (!validation.valid) return { status: 400, body: { errors: validation.errors } };\n    return { status: ${requestedRoute.method === 'POST' ? 201 : 200}, body: { data: schema.applyDefaults(request.body) } };\n  } catch (error) {\n    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };\n  }\n}\n\n${useEsm ? `export { handle${entityPascal} };` : `module.exports = { handle${entityPascal} };`}\n`;
  const routeImport = useEsm
    ? `import { handle${entityPascal} } from ${JSON.stringify(controllerRequire)};`
    : `const { handle${entityPascal} } = require(${JSON.stringify(controllerRequire)});`;
  const routeContent = `'use strict';\n\n${routeImport}\nconst route = { method: ${JSON.stringify(requestedRoute.method)}, path: ${JSON.stringify(requestedRoute.path)} };\n\nfunction registerRoutes(app) {\n  if (!app || typeof app.register !== 'function') throw new TypeError('A route registry is required.');\n  app.register(route.method, route.path, async (request) => handle${entityPascal}(request));\n  return [route];\n}\n\n${useEsm ? 'export { registerRoutes, route };' : 'module.exports = { registerRoutes, route };'}\n`;
  const serverImports = useEsm
    ? `import http from 'node:http';\nimport { pathToFileURL } from 'node:url';\nimport config from ${JSON.stringify(`./${configPath}`)};\nimport { registerRoutes } from ${JSON.stringify(routeRequire)};`
    : `const http = require('node:http');\nconst config = require(${JSON.stringify(`./${configPath}`)});\nconst { registerRoutes } = require(${JSON.stringify(routeRequire)});`;
  const serverStartGuard = useEsm
    ? `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const server = createApplication(); server.listen(config.port, () => console.info(JSON.stringify({ status: 'listening', port: server.address().port }))); }`
    : `if (require.main === module) { const server = createApplication(); server.listen(config.port, () => console.info(JSON.stringify({ status: 'listening', port: server.address().port }))); }`;
  const serverContent = `${useEsm ? '' : "'use strict';\n\n"}${serverImports}\n\nfunction createApplication() {\n  const routes = new Map();\n  const app = { register(method, routePath, handler) { routes.set(method + ' ' + routePath, handler); } };\n  registerRoutes(app);\n  return http.createServer(async (request, response) => {\n    const handler = routes.get(request.method + ' ' + new URL(request.url, 'http://localhost').pathname);\n    if (!handler) { response.writeHead(404).end(); return; }\n    const chunks = [];\n    for await (const chunk of request) chunks.push(chunk);\n    let body = {};\n    if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body.' })); return; } }\n    const result = await handler({ body });\n    response.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.body));\n  });\n}\n\n${serverStartGuard}\n${useEsm ? 'export { createApplication };' : 'module.exports = { createApplication };'}\n`;
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
    routeSchema: { entity: entityPascal, fields },
  };
  const existingPackage = await readWorkspaceFile(root, 'package.json');
  let generatedPackageMetadata = {};
  if (existingPackage) {
    try {
      generatedPackageMetadata = JSON.parse(existingPackage);
    } catch (error) {
      throw new Error(`Unable to inspect existing package.json: ${error.message}`);
    }
  }
  generatedPackageMetadata = {
    ...generatedPackageMetadata,
    name: generatedPackageMetadata.name || path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'application',
    version: generatedPackageMetadata.version || '1.0.0',
    private: generatedPackageMetadata.private ?? true,
    type: generatedPackageMetadata.type || 'commonjs',
    scripts: {
      ...(generatedPackageMetadata.scripts || {}),
      start: `node ${serverPath}`,
      dev: `node ${serverPath}`,
      test: generatedPackageMetadata.scripts?.test || `node --check ${serverPath}`,
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
    content: '# Local development configuration\nPORT=3000\nDATABASE_URL=mongodb://127.0.0.1:27017/app_dev\nAPI_URL=http://127.0.0.1:3000\n',
  }, {
    path: 'README.md',
    responsibility: 'DOCUMENTATION',
    dependencies: [],
    content: `# ${entityPascal} application\n\n## Run locally\n\nUse Node.js 18 or newer:\n\n\`\`\`sh\nnode ${serverPath}\n\`\`\`\n\nThe HTTP server binds to loopback and uses the configured \`PORT\` value (or an ephemeral port when unset). \`.env.example\` documents optional settings; the generated server does not load \`.env\` files automatically, so set environment variables in your shell when you need to override defaults. The generated HTTP service uses Node.js built-ins and does not require a dependency installation to start.\n\nThe React form source is included for integration into a React-capable frontend; it is not served or compiled by this Node.js API server.\n`,
  }];
  plan.modulesToCreate.push(...packagingModules);

  for (const module of plan.modulesToCreate) {
    module.path = validateSafePath(root, module.path);
    const exists = await existingFile(root, module.path);
    module.operation = exists ? 'modify' : 'create';
    if (module.path === '.env.example' && exists) {
      const previous = await readWorkspaceFile(root, module.path);
      const requiredLines = module.content.split('\n').filter((line) => line && !line.startsWith('#'));
      const additions = requiredLines.filter((line) => !String(previous).split(/\r?\n/).some((existing) => existing.startsWith(`${line.split('=')[0]}=`)));
      module.content = `${String(previous || '').replace(/\s*$/, '')}\n${additions.join('\n')}\n`;
    }
    if (module.path === 'README.md' && exists) {
      const previous = await readWorkspaceFile(root, module.path);
      if (String(previous || '').trim()) module.content = previous;
    }
    plan.planRecord.push({
      path: module.path,
      action: module.operation,
      responsibility: module.responsibility,
      status: 'planned',
    });
  }
  plan.workspaceInspection.inspectedFiles = [...new Set([
    ...plan.workspaceInspection.inspectedFiles,
    ...plan.modulesToCreate.filter((module) => module.operation === 'modify').map((module) => module.path),
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

function verifyHermeticEngineeringGates(modularPlan, fileContents = moduleContentByPath(modularPlan)) {
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
  const syntaxPassed = syntaxFailures.length === 0;
  const schemaPassed = Boolean(model && controller && form && page && fieldNames.length > 0 && missingFields.length === 0);
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
      && serverSource.includes('registerRoutes(app)'),
  );
  const entryPoint = route?.integrationFile || 'server.js';
  const runReadinessPassed = Boolean(
    packageModule
    && packageJson
    && packageJson.scripts?.start === `node ${entryPoint}`
    && packageJson.scripts?.dev === `node ${entryPoint}`
      && typeof packageJson.scripts?.test === 'string'
      && packageJson.scripts.test.trim()
      && envModule
      && String(fileContents.get('.env.example') || '').trim()
      && readmeModule
      && String(fileContents.get('README.md') || '').trim(),
  );
  const gates = [
    { id: 'SYNTAX_AND_AST', passed: syntaxPassed, evidence: syntaxPassed ? `${fileContents.size} candidate file(s) parsed.` : syntaxFailures },
    { id: 'SCHEMA_CONTRACT', passed: schemaPassed, evidence: schemaPassed ? `${fieldNames.length} scalar/nested field(s) present in model, controller, and form.` : { missingFields } },
    { id: 'VALIDATION_AND_STATUS', passed: validationPassed, evidence: validationPassed ? `try/catch and ${statuses.join('/')} response contract found.` : { missingStatuses } },
    { id: 'FULL_STACK_WIRING', passed: wiringPassed, evidence: wiringPassed ? `${route?.method} ${route?.path} is connected to the form, page, and server.` : 'Frontend payload, page mount, or server route registration is missing.' },
    { id: 'RUN_READINESS', passed: runReadinessPassed, evidence: runReadinessPassed ? `package.json start script targets ${entryPoint}.` : packageFailure || 'package.json start/dev/test scripts do not match the server entrypoint.' },
  ];
  return {
    status: gates.every((gate) => gate.passed) ? 'HERMETIC_CONTRACT_AND_SYNTAX_VERIFIED' : 'HERMETIC_VERIFICATION_FAILED',
    passed: gates.filter((gate) => gate.passed).length,
    total: gates.length,
    gates,
    syntaxFailures,
  };
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
    if (/const fields = [\s\S]*?;\s*function validate/.test(model.content)) {
      model.content = model.content.replace(
        /const fields = [\s\S]*?;\s*(?=function validate)/,
        `const fields = ${serializedFields};\n\n`,
      );
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
    controller.content = `${useEsm ? '' : "'use strict';\n\n"}${schemaBinding}\nconst requestedFieldContract = ${JSON.stringify(fields.map((field) => field.name), null, 2)};\n\nasync function ${handlerName}(request) {\n  try {\n    const validation = schema.validate(request.body, requestedFieldContract);\n    if (!validation.valid) return { status: 400, body: { errors: validation.errors } };\n    return { status: ${responseStatus}, body: { data: schema.applyDefaults(request.body) } };\n  } catch (error) {\n    return { status: 500, body: { error: error instanceof Error ? error.message : 'Request failed.' } };\n  }\n}\n\n${useEsm ? `export { ${handlerName} };` : `module.exports = { ${handlerName} };`}\n`;
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
      `$1\n${buildRequestedFormFields(fields)}\n$2`,
    );
    const arrays = fields.filter((field) => field.type === 'array');
    if (arrays.length && !form.content.includes('function updateArrayField(')) {
      const arrayHelpers = `  function updateArrayField(field, index, key, value) { setForm((current) => ({ ...current, [field]: current[field].map((item, row) => row === index ? { ...item, [key]: value } : item) })); }\n  function addArrayItem(field, item) { setForm((current) => ({ ...current, [field]: [...current[field], item] })); }\n  function removeArrayItem(field, index) { setForm((current) => ({ ...current, [field]: current[field].filter((_, row) => row !== index) })); }\n`;
      form.content = form.content.replace('  async function submit(', `${arrayHelpers}  async function submit(`);
    }
  }
  return modularPlan;
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
        total: 5,
        gates: [{
          id: 'SYNTAX_AND_AST',
          passed: false,
          evidence: `Could not read approved file ${safePath}: ${error.message}`,
        }],
        syntaxFailures: [],
      };
    }
  }
  return verifyHermeticEngineeringGates(modularPlan, diskContents);
}

async function synthesizeMultiFilePatch(root, modularPlan, options = {}) {
  const snapshotFn = typeof options.snapshotTarget === 'function' ? options.snapshotTarget : (r, p) => defaultSnapshotTarget(r, p);
  const splitPatchLines = (content) => {
    if (!content) return [];
    const lines = String(content).split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return lines;
  };
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
    const snap = await snapshotFn(root, safePath);
    if (operation === 'modify' && !snap.exists) {
      throw new Error(`STALE_PROPOSAL_DRIFT: Expected existing target [${safePath}] is missing.`);
    }
    if (operation === 'create' && snap.exists) {
      throw new Error(`STALE_PROPOSAL_DRIFT: New target [${safePath}] already exists.`);
    }
    if (operation === 'modify'
        && String(snap.content || '').replace(/\r\n/g, '\n') === String(mod.content || '').replace(/\r\n/g, '\n')) {
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
        && String(snap.content || '').replace(/\r\n/g, '\n') === String(point.patchedContent || '').replace(/\r\n/g, '\n')) {
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
  deriveModularPlan,
  verifyHermeticEngineeringGates,
  verifyHermeticEngineeringGatesOnDisk,
  repairHermeticCandidate,
  synthesizeMultiFilePatch,
  verifyIntegrationReachability,
};
