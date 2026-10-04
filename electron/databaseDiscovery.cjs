// Database Configuration Discovery Module
// Provides utilities to discover DB configuration in the attached project
// Uses existing developerIndex and developerFiles modules for targeted search

const path = require('node:path');
const fs = require('node:fs/promises');
const { readFile } = require('./developerFiles.cjs'); // helper to read file safely
const { buildRepositoryMap, buildIndex } = require('./developerIndex.cjs');

/**
 * Recursively resolve PHP constants and includes to extract DB connection parameters.
 * Supports simple `require_once` or `include` statements and constant definitions.
 * Returns an object with resolved values or NOT_RESOLVED flags.
 */
async function resolvePhpConstants(filePath, visited = new Set()) {
  const absolute = path.resolve(filePath);
  if (visited.has(absolute)) return {};
  visited.add(absolute);
  let content;
  try {
    content = await readFile(absolute, { encoding: 'utf8' });
  } catch (_) {
    return {};
  }
  const result = {};
  // Capture constant definitions like const DB_HOST = 'value'; or define('DB_HOST', 'value');
  const constRegex = /(?:const|define)\s+\(?\s*['"]?([A-Z_][A-Z0-9_]+)['"]?\s*,\s*['"]([^'\"]+)['"]\s*\)?/g;
  let match;
  while ((match = constRegex.exec(content))) {
    const [, name, value] = match;
    result[name] = value;
  }
  // Follow require/include statements to other files
  const includeRegex = /require(?:_once)?\s*\(?\s*['"]([^'\"]+)['"]\s*\)?\s*;/g;
  while ((match = includeRegex.exec(content))) {
    const [, rel] = match;
    const includePath = path.resolve(path.dirname(absolute), rel);
    const nested = await resolvePhpConstants(includePath, visited);
    Object.assign(result, nested);
  }
  return result;
}

/**
 * Discover DB configuration for a given project root.
 * Returns an object with fields: engine, database, username, host, port, status.
 */
async function discoverDatabaseConfig(projectRoot) {
  // Build repository map (metadata) to get important files list
  const repoMap = await buildRepositoryMap(projectRoot);
  const candidateFiles = repoMap.importantFiles.filter((f) => f.endsWith('.php') || f.endsWith('.js'));
  // Find files that contain typical DB patterns
  const dbPattern = /(?:dsn|DB_HOST|DB_UIMS|DB_USERNAME|DB_PASS|DATABASE_URL|mysql|pgsql)/i;
  const matches = [];
  for (const rel of candidateFiles) {
    const abs = path.join(projectRoot, rel);
    const content = await readFile(abs, { encoding: 'utf8' }).catch(() => null);
    if (content && dbPattern.test(content)) {
      matches.push({ path: abs, content });
    }
  }
  // Prioritize config files
  matches.sort((a, b) => {
    const aScore = /config|db|_name/.test(a.path) ? 1 : 0;
    const bScore = /config|db|_name/.test(b.path) ? 1 : 0;
    return bScore - aScore;
  });

  for (const file of matches) {
    const constants = await resolvePhpConstants(file.path);
    const engine = /mysql/i.test(file.content) ? 'MySQL' : /pgsql|postgres/i.test(file.content) ? 'PostgreSQL' : 'UNKNOWN';
    const database = constants.DB_UIMS || constants.DB_NAME || constants.DATABASE || 'CONFIGURATION_DB: NOT_RESOLVED';
    const username = constants.DB_USERNAME || constants.USERNAME || 'CONFIGURATION_USERNAME: NOT_RESOLVED';
    const host = constants.DB_HOST || constants.HOST || 'CONFIGURATION_HOST: NOT_RESOLVED';
    const port = constants.DB_PORT || (engine === 'MySQL' ? '3306' : 'UNKNOWN');
    return {
      engine,
      database,
      username,
      host,
      port,
      sourceFile: file.path,
      status: 'CONFIGURED_ONLY',
    };
  }
  return {
    engine: 'UNKNOWN',
    database: 'CONFIGURATION_DB: NOT_RESOLVED',
    username: 'CONFIGURATION_USERNAME: NOT_RESOLVED',
    host: 'CONFIGURATION_HOST: NOT_RESOLVED',
    port: 'UNKNOWN',
    sourceFile: null,
    status: 'UNRESOLVED',
  };
}

module.exports = { discoverDatabaseConfig };
