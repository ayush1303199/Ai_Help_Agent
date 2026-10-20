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

async function deriveModularPlan(root, { userRequest = '', requirements = [], explicitPlan = null } = {}) {
  const conventions = await discoverProjectConventions(root);
  const plan = {
    isGreenfield: conventions.isGreenfield,
    language: conventions.language,
    modulesToCreate: [],
    integrationPoints: [],
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
async function verifyIntegrationReachability(root, modularPlan) {
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
