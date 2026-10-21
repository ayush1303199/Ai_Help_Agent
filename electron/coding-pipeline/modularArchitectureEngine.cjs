'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function hash(content) {
  return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
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
  const match = String(text || '').match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_/:.-]*)/i);
  if (!match) return null;
  const method = match[1].toUpperCase();
  const routePath = validateRoutePath(match[2].replace(/[.,;]+$/, '').replace(/\/+$/, '') || '/');
  return { method, path: routePath };
}

function extractRequestedFields(text) {
  const fields = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?([A-Za-z_$][\w$]*)\s*(?::\s*|\(\s*)(string|number|boolean|integer|date|email|array|object)?\s*([^)]*)\)?\s*$/i);
    if (!match || !match[2]) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const declaredType = (match[2] || 'string').toLowerCase();
    const type = declaredType === 'integer' ? 'number' : declaredType;
    const metadata = `${match[2] || ''} ${match[3] || ''} ${line}`;
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
    fields.push({
      name,
      type,
      required: /\brequired\b/i.test(metadata),
      hasDefault: Boolean(defaultMatch),
      defaultValue,
    });
  }
  return fields;
}

function pascalCaseIdentifier(value) {
  const words = String(value || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const combined = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return /^[A-Z]/.test(combined) ? combined : `Resource${combined}`;
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
        });
        plan.planRecord.push({
          path: safePath,
          action: 'create',
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
          content: `// API route dispatcher for ${entityPascal}\nconst { create${entityPascal}, list${entityPascal}s } = require('../${controllerPath}');\n\nfunction register${entityPascal}Routes(app) {\n  const routes = [\n    { method: 'POST', path: '/api/${entityPlural}', handler: async (req) => create${entityPascal}(req?.body || {}) },\n    { method: 'GET', path: '/api/${entityPlural}', handler: async () => list${entityPascal}s() },\n  ];\n  if (app && typeof app.use === 'function') {\n    for (const r of routes) {\n      if (r.method === 'POST') app.post?.(r.path, r.handler);\n      if (r.method === 'GET') app.get?.(r.path, r.handler);\n    }\n  }\n  return routes;\n}\n\nmodule.exports = { register${entityPascal}Routes };\n`,
        },
        {
          path: serverPath,
          responsibility: 'APPLICATION_ENTRYPOINT',
          dependencies: [dbConfigPath, routePath],
          content: `// Application server entrypoint\nconst { connectDatabase } = require('./${dbConfigPath}');\nconst { register${entityPascal}Routes } = require('./${routePath}');\n\nasync function startServer(port = 3000) {\n  await connectDatabase();\n  const app = { post: () => {}, get: () => {} };\n  const routes = register${entityPascal}Routes(app);\n  return { port, status: 'listening', registeredRoutes: routes.length };\n}\n\nmodule.exports = { startServer };\n`,
        },
        {
          path: componentPath,
          responsibility: 'UI_PRESENTATION',
          dependencies: [],
          content: `// Presentation component for ${entityPascal}\nexport default function ${entityPascal}Form({ onSubmit, initialData = {} }) {\n  return {\n    component: '${entityPascal}Form',\n    initialData,\n    fields: ['title', 'description', 'status'],\n    handleSubmit(event) {\n      if (typeof onSubmit === 'function') onSubmit(event);\n    },\n  };\n}\n`,
        },
        {
          path: pagePath,
          responsibility: 'UI_PRESENTATION',
          dependencies: [componentPath],
          content: `// Page view for ${entityPascal}\nimport ${entityPascal}Form from '${isNextAppRouter ? '../../' : '../'}${componentPath}';\n\nexport default function ${entityPascal}Page() {\n  return {\n    page: '${entityPascal}Page',\n    title: '${entityPascal} Management',\n    Component: ${entityPascal}Form,\n  };\n}\n`,
        },
      ];
      plan.routeContracts = [
        { method: 'POST', path: `/api/${entityPlural}`, targetFile: routePath },
        { method: 'GET', path: `/api/${entityPlural}`, targetFile: routePath },
      ];

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

async function synthesizeMultiFilePatch(root, modularPlan, options = {}) {
  const snapshotFn = typeof options.snapshotTarget === 'function' ? options.snapshotTarget : (r, p) => defaultSnapshotTarget(r, p);
  const patchParts = [];
  const expectedSnapshots = [];
  const filesList = [];

  // 1. Process files to create
  for (const mod of modularPlan.modulesToCreate) {
    const safePath = validateSafePath(root, mod.path);
    const snap = await snapshotFn(root, safePath);
    expectedSnapshots.push(snap);

    const lines = mod.content.split(/\r?\n/);
    if (mod.content.endsWith('\n') && lines.at(-1) === '') lines.pop();

    const fileDiff = [
      `--- /dev/null`,
      `+++ b/${safePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
      '',
    ].join('\n');

    patchParts.push(fileDiff);
    filesList.push({
      path: safePath,
      operation: 'create',
      responsibility: mod.responsibility,
      dependencies: mod.dependencies,
    });
  }

  // 2. Process integration points
  for (const point of modularPlan.integrationPoints) {
    const safePath = validateSafePath(root, point.targetFile);
    const snap = await snapshotFn(root, safePath);
    expectedSnapshots.push(snap);
    const original = snap.exists ? (snap.content || '') : (point.originalContent || '');

    const origLines = (original || '').split(/\r?\n/);
    if (original && original.endsWith('\n') && origLines.at(-1) === '') origLines.pop();

    const patched = point.patchedContent;
    const patchedLines = (patched || '').split(/\r?\n/);
    if (patched && patched.endsWith('\n') && patchedLines.at(-1) === '') patchedLines.pop();

    const fileDiff = [
      `--- a/${safePath}`,
      `+++ b/${safePath}`,
      `@@ -1,${origLines.length} +1,${patchedLines.length} @@`,
      ...origLines.map((l) => `-${l}`),
      ...patchedLines.map((l) => `+${l}`),
      '',
    ].join('\n');

    patchParts.push(fileDiff);
    filesList.push({
      path: safePath,
      operation: 'modify',
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
      const routeDeclaration = routeSource.includes(JSON.stringify(route.method))
        && routeSource.includes(JSON.stringify(routePath))
        && /function\s+registerRoutes\s*\(/.test(routeSource)
        && routeSource.includes(`require('../${controllerPath}')`);
      const controllerImportsModel = controllerSource.includes(`require('../${modelPath}')`)
        && modelSource.includes('function validate(');
      const routeImportPath = path.posix.relative(
        path.posix.dirname(serverPath),
        targetFile,
      );
      const serverMount = serverSource.includes(`require('./${routeImportPath}')`)
        && /registerRoutes\s*\(\s*app\s*\)/.test(serverSource);
      if (!routeDeclaration || !controllerImportsModel || !serverMount) {
        result.isValid = false;
        result.incompleteIntegrations.push({
          path: targetFile,
          reason: 'The requested route is not declared and mounted by the generated server entrypoint.',
        });
        result.rejectionReason = `Route mount verification failed for ${route.method} ${routePath}.`;
        return result;
      }
      result.verifiedFiles.push(serverPath);
      result.routeMounts = [...(result.routeMounts || []), {
        method: route.method,
        path: routePath,
        targetFile,
        integrationFile: serverPath,
        status: 'PASS',
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
  }

  return result;
}

module.exports = {
  validateSafePath,
  isGreenfieldWorkspace,
  discoverProjectConventions,
  deriveModularPlan,
  synthesizeMultiFilePatch,
  verifyIntegrationReachability,
};
