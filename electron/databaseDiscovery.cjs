const path = require('node:path');
const { readFile, getProjectRoot } = require('./developerFiles.cjs');
const { buildIndex } = require('./developerIndex.cjs');

const REQUIREMENT_CHECKER_NAME = /(?:^|[\\/])requirements\.php$/i;
const REQUIREMENT_CHECKER_CONTENT = /\bYiiRequirementChecker\b|\bphpinfo\s*\(|\bextension_loaded\s*\(\s*['"]pdo(?:_mysql|_pgsql|_sqlite)?['"]\s*\)/i;
const DATABASE_CONFIG_SIGNAL = /yii\\db\\connection|\bdsn\s*['"]?\s*=>|\b(?:DB_HOST|DB_PORT|DB_NAME|DB_DATABASE|DB_UIMS|DB_USERNAME|DB_PASS|DB_PASSWORD)\b|\bdbname\s*=|\b(?:mysql|pgsql|postgresql|sqlite):/i;
const DATABASE_FIELD_SIGNAL = /['"](?:host|port|database|dbname|username|user|password)['"]\s*=>/i;
const SENSITIVE_CONFIG_PATH = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|\.config)(?:[\\/]|$)/i;

function classifyPhpFile(relativePath, content) {
  const source = String(content || '');
  if (REQUIREMENT_CHECKER_NAME.test(relativePath) || REQUIREMENT_CHECKER_CONTENT.test(source)) {
    return { role: 'REQUIREMENT_CHECKER', confidence: 1, databaseConfigEligible: false };
  }
  const positive = DATABASE_CONFIG_SIGNAL.test(source) || DATABASE_FIELD_SIGNAL.test(source);
  return {
    role: positive ? 'DATABASE_CONFIGURATION' : 'APPLICATION_CONFIGURATION',
    confidence: positive ? 0.99 : 0.5,
    databaseConfigEligible: positive,
  };
}

function classifyDatabaseRequestIntent(request, contextMessages = []) {
  const text = typeof request === 'string' ? request.trim() : '';
  if (!text) return [];
  const intents = [];
  const explicitCredentialRequest = /\b(?:show|tell|print|reveal|give|get)\b.{0,32}\b(?:db|database)\s+(?:password|credential|secret)\b|\b(?:db|database)\s+(?:password|credential|secret)\b/i.test(text);
  const genericCredentialRequest = /^\s*(?:show|display|tell\s+me|give\s+me)\s+(?:(?:my|the)\s+)?username\s+(?:and|&)\s+(?:password|passwd|passwod|passwrd)\s*[.!?]*\s*$/i.test(text);
  const credentialRequest = explicitCredentialRequest || genericCredentialRequest;
  if (credentialRequest) intents.push('DATABASE_CREDENTIAL_REQUEST');

  const explicitFile = text.match(/(?:^|[\s"'`])((?:[\w.-]+[\\/])*[\w.-]+\.php)\b/i)?.[1] || null;
  const shortDatabaseRequest = /^\s*(?:show|display|tell\s+me)\s+my\s+(?:db|database)\s*[.!?]*\s*$/i.test(text);
  const configurationRequest = (Boolean(explicitFile)
    && /\b(?:open|read|inspect|show|check|find|which|what)\b/i.test(text)) || shortDatabaseRequest;
  if (configurationRequest) intents.push('DATABASE_CONFIGURATION');

  const currentTargetRequest = /\b(?:which|what|show|check|tell|identify)\b.{0,80}\b(?:current|active|connected|connection)\b.{0,40}\b(?:db|database|connection|target)\b|\b(?:current|active|connected)\s+(?:db|database)\s+(?:connection|target)\b|\bwhich\s+db\s+connection\b/i.test(text);
  if (currentTargetRequest) intents.push('DATABASE_CURRENT_TARGET');

  const listDatabasesRequest = /\b(?:show|list|display)\s+(?:all\s+)?databases\b|\bdatabases\s+(?:list|available)\b/i.test(text);
  if (listDatabasesRequest && !intents.includes('DATABASE_CURRENT_TARGET')) intents.push('DATABASE_LIST_DATABASES');
  return intents;
}

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function fileMatchesRequestedPath(relativePath, requestedPath) {
  const wanted = normalizeRelative(requestedPath).toLowerCase();
  const actual = normalizeRelative(relativePath).toLowerCase();
  return wanted.includes('/') ? actual === wanted : path.posix.basename(actual) === wanted;
}

function resolveLiteral(expression, constants) {
  const source = String(expression || '').trim().replace(/;\s*$/, '');
  const literal = source.match(/^\s*(['"])(.*?)\1\s*$/s);
  if (literal) return literal[2];
  const constant = source.match(/^\s*([A-Z_][A-Z0-9_]*)\s*$/);
  if (constant && Object.hasOwn(constants, constant[1])) return constants[constant[1]];
  return null;
}

function extractPhpAssignments(content) {
  const assignments = {};
  const patterns = {
    dsn: /['"]dsn['"]\s*=>\s*([^,\r\n]+)/i,
    host: /['"](?:host)['"]\s*=>\s*([^,\r\n]+)/i,
    port: /['"]port['"]\s*=>\s*([^,\r\n]+)/i,
    database: /['"](?:database|dbname)['"]\s*=>\s*([^,\r\n]+)/i,
    username: /['"](?:username|user)['"]\s*=>\s*([^,\r\n]+)/i,
    password: /['"]password['"]\s*=>\s*([^,\r\n]+)/i,
  };
  for (const [field, pattern] of Object.entries(patterns)) {
    const match = content.match(pattern);
    if (match) assignments[field] = match[1].trim();
  }
  return assignments;
}

function redactedDatabasePreview(content) {
  return String(content || '').split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(({ text }) => /\b(?:require|include)\b|yii\\db\\connection|\bdsn\b|\b(?:DB_HOST|DB_PORT|DB_NAME|DB_DATABASE|DB_UIMS|DB_USERNAME|DB_PASS|DB_PASSWORD)\b|['"](?:host|port|database|dbname|username|user|password)['"]\s*=>/i.test(text))
    .slice(0, 80)
    .map(({ line, text }) => ({
      line,
      text: text
        .replace(/(\bdefine\s*\(\s*['"](?:DB_PASS|DB_PASSWORD|PASSWORD)['"]\s*,\s*['"])[^'"]*(['"]\s*\))/gi, '$1[PROTECTED]$2')
        .replace(/(\bconst\s+(?:DB_PASS|DB_PASSWORD|PASSWORD)\s*=\s*['"])[^'"]*(['"])/gi, '$1[PROTECTED]$2')
        .replace(/((?:password|secret|token|api[_-]?key|credential|DB_PASS(?:WORD)?)\w*\s*['"]?\s*(?:=>|=|:)\s*)([^,;]+)/gi, '$1"[PROTECTED]"')
        .replace(/(\/\/[^/@:\s]+:)[^/@\s]+@/g, '$1[PROTECTED]@')
        .slice(0, 500),
    }));
}

function parseDsn(dsnExpression, constants) {
  if (!dsnExpression) return { engine: null, host: null, port: null, database: null };
  const expanded = [...String(dsnExpression).matchAll(/(['"])(.*?)\1|([A-Z_][A-Z0-9_]*)/gs)]
    .map((match) => match[2] !== undefined ? match[2] : constants[match[3]] || '')
    .join('');
  const engine = expanded.match(/^\s*(mysql|pgsql|postgresql|sqlite):/i)?.[1]?.toLowerCase() || null;
  const host = expanded.match(/(?:^|[;:])host=([^;]+)/i)?.[1] || null;
  const port = expanded.match(/(?:^|;)port=([^;]+)/i)?.[1] || null;
  const database = expanded.match(/(?:^|;)(?:dbname|database)=([^;]+)/i)?.[1] || null;
  return {
    engine: engine === 'postgresql' ? 'postgres' : engine,
    host,
    port,
    database,
  };
}

async function discoverDatabaseConfig(projectRoot, requestedFile, ownerWebContentsId) {
  const root = path.resolve(projectRoot);
  if (!Number.isInteger(ownerWebContentsId) || path.resolve(getProjectRoot(ownerWebContentsId) || '') !== root) {
    throw new Error('Database discovery requires the renderer-owned attached project.');
  }
  const index = await buildIndex(root);
  const indexedFiles = Object.keys(index.files);
  const phpFiles = indexedFiles.filter((relative) => relative.toLowerCase().endsWith('.php')
    && !/(?:^|\/)(?:vendor|node_modules|\.git|dist|build|coverage)(?:\/|$)/i.test(relative));
  const contents = new Map();
  const readProjectFile = async (relative) => {
    const normalized = normalizeRelative(relative);
    if (SENSITIVE_CONFIG_PATH.test(normalized)) throw new Error('Sensitive configuration files are not read by database discovery.');
    if (!contents.has(normalized)) {
      const result = await readFile(normalized, ownerWebContentsId);
      contents.set(normalized, result.content);
    }
    return contents.get(normalized);
  };

  const classified = [];
  for (const relative of phpFiles) {
    const content = await readProjectFile(relative);
    classified.push({ path: relative, content, ...classifyPhpFile(relative, content) });
  }

  let requested = null;
  if (requestedFile) {
    const matches = classified.filter((file) => fileMatchesRequestedPath(file.path, requestedFile));
    matches.sort((a, b) => {
      const exactPath = normalizeRelative(a.path).toLowerCase() === normalizeRelative(requestedFile).toLowerCase();
      const otherExactPath = normalizeRelative(b.path).toLowerCase() === normalizeRelative(requestedFile).toLowerCase();
      return Number(otherExactPath) - Number(exactPath)
        || Number(b.databaseConfigEligible) - Number(a.databaseConfigEligible)
        || a.path.localeCompare(b.path);
    });
    requested = matches[0] || null;
  }

  const dbCandidates = classified
    .filter((file) => file.databaseConfigEligible)
    .sort((a, b) => {
      const score = (item) => (/(?:^|\/)config(?:\/|$)/i.test(item.path) ? 8 : 0)
        + (/(?:^|\/)(?:db|database)(?:\.[^/]*)?\.php$/i.test(item.path) ? 6 : 0)
        + (/\byii\\db\\connection\b/i.test(item.content) ? 5 : 0)
        + (/'dsn'\s*=>/i.test(item.content) ? 4 : 0);
      return score(b) - score(a) || a.path.localeCompare(b.path);
    });

  const configFile = requested?.databaseConfigEligible
    ? requested
    : requestedFile && !requested
      ? null
      : dbCandidates[0] || null;
  let constants = {};
  const dependencies = [];
  const unresolvedDependencies = [];
  if (configFile) {
    const visited = new Set();
    const resolveFile = async (relative) => {
      const normalized = normalizeRelative(relative);
      if (visited.has(normalized)) return;
      visited.add(normalized);
      let content;
      try {
        content = await readProjectFile(normalized);
      } catch {
        unresolvedDependencies.push(normalized);
        return;
      }
      const definePattern = /\bdefine\s*\(\s*(['"])([A-Z_][A-Z0-9_]*)\1\s*,\s*(['"])(.*?)\3\s*\)/gs;
      const constPattern = /\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*(['"])(.*?)\2\s*;/gs;
      for (const match of content.matchAll(definePattern)) constants[match[2]] = match[4];
      for (const match of content.matchAll(constPattern)) constants[match[1]] = match[3];

      const includePattern = /\b(?:require|include)(?:_once)?\b([^;]*);/gs;
      for (const match of content.matchAll(includePattern)) {
        const pathFragments = [...match[1].matchAll(/(['"])([^'"]+)\1/g)].map((part) => part[2]);
        if (pathFragments.length === 0) continue;
        const includeValue = pathFragments.join('')
          .replace(/__DIR__/g, '.')
          .replace(/dirname\s*\(\s*__FILE__\s*\)/g, '.')
          .replace(/__FILE__/g, path.posix.basename(normalized));
        const includeRelative = normalizeRelative(path.posix.normalize(path.posix.join(path.posix.dirname(normalized), includeValue)));
        if (includeRelative.startsWith('../') || includeRelative === '..' || path.posix.isAbsolute(includeRelative)) continue;
        if (!indexedFiles.includes(includeRelative)) {
          unresolvedDependencies.push(includeRelative);
          continue;
        }
        dependencies.push(includeRelative);
        await resolveFile(includeRelative);
      }
    };
    if (requested && requested.path !== configFile.path) await resolveFile(requested.path);
    await resolveFile(configFile.path);
  }

  const assignments = configFile ? extractPhpAssignments(configFile.content) : {};
  const dsn = parseDsn(assignments.dsn, constants);
  const directValue = (field) => resolveLiteral(assignments[field], constants);
  const passwordExpression = assignments.password || '';
  const protectedSecrets = new Set();
  const literalPassword = resolveLiteral(passwordExpression, constants);
  if (literalPassword) protectedSecrets.add(literalPassword);
  for (const symbol of passwordExpression.match(/[A-Z_][A-Z0-9_]*/g) || []) {
    if (Object.hasOwn(constants, symbol) && constants[symbol]) protectedSecrets.add(constants[symbol]);
  }
  const safeValue = (value) => {
    if (value === null || value === undefined || value === '') return null;
    let safe = String(value).replace(/(\/\/[^/@:\s]+:)[^/@\s]+@/g, '$1[PROTECTED]@');
    for (const secret of protectedSecrets) safe = safe.split(secret).join('[PROTECTED]');
    return safe;
  };
  const unresolvedSymbols = [...new Set(Object.values(assignments).join(' ').match(/[A-Z_][A-Z0-9_]*/g) || [])]
    .filter((symbol) => !Object.hasOwn(constants, symbol) && !['TRUE', 'FALSE', 'NULL'].includes(symbol));
  const engine = dsn.engine
    || (configFile && /\bmysql\s*:/i.test(configFile.content) ? 'mysql' : null)
    || (configFile && /\b(?:pgsql|postgresql)\s*:/i.test(configFile.content) ? 'postgres' : null)
    || (configFile && /\bsqlite\s*:/i.test(configFile.content) ? 'sqlite' : null);
  const hasPassword = Boolean(passwordExpression);
  const database = safeValue(dsn.database || directValue('database'));
  const host = safeValue(dsn.host || directValue('host'));
  const port = safeValue(dsn.port || directValue('port'));
  const username = safeValue(directValue('username'));
  const status = configFile
    ? 'CONFIGURED'
    : requestedFile && !requested
      ? 'REQUESTED_FILE_NOT_FOUND'
      : 'NOT_CONFIGURED';
  const live = {
    status: 'NOT_VERIFIED',
    reason: 'This source-inspection operation does not establish or reuse a runtime database session.',
  };
  const report = [
    '## Database configuration',
    '',
    requestedFile ? `**Requested file:** \`${requested?.path || `${requestedFile} (NOT FOUND)`}\`` : null,
    requested ? `**Requested-file role:** ${requested.role}` : null,
    requested ? `**Opened-file excerpt:**\n\n\`\`\`php\n${redactedDatabasePreview(requested.content).map((item) => `${item.line}: ${item.text}`).join('\n') || '(No database-related lines found.)'}\n\`\`\`` : null,
    `**Configuration file:** ${configFile ? `\`${configFile.path}\`` : 'NOT FOUND'}`,
    configFile && requested?.path !== configFile.path ? `**Database configuration excerpt:**\n\n\`\`\`php\n${redactedDatabasePreview(configFile.content).map((item) => `${item.line}: ${item.text}`).join('\n') || '(No database-related lines found.)'}\n\`\`\`` : null,
    `**Database config eligible:** ${configFile ? 'YES' : 'NO'}`,
    `**Engine:** ${engine || 'NOT_RESOLVED'}`,
    `**Database:** ${database || 'NOT_RESOLVED'}`,
    `**Host:** ${host || 'NOT_RESOLVED'}`,
    `**Port:** ${port || 'NOT_RESOLVED'}`,
    `**Username:** ${username || 'NOT_RESOLVED'}`,
    `**Password:** ${hasPassword ? '[PROTECTED]' : 'NOT_CONFIGURED'}`,
    dependencies.length ? `**Configuration dependencies:** ${dependencies.map((item) => `\`${item}\``).join(', ')}` : '**Configuration dependencies:** None resolved',
    unresolvedDependencies.length ? `**Unresolved dependencies:** ${unresolvedDependencies.map((item) => `\`${item}\``).join(', ')}` : null,
    unresolvedSymbols.length ? `**Unresolved symbols:** ${unresolvedSymbols.join(', ')}` : null,
    '',
    '## Live database',
    '',
    `**Status:** ${live.status}`,
    `**Reason:** ${live.reason}`,
  ].filter((line) => line !== null).join('\n');

  return {
    status,
    requestedFile: requested ? { path: requested.path, role: requested.role, confidence: requested.confidence, preview: redactedDatabasePreview(requested.content) } : requestedFile ? { path: requestedFile, role: 'NOT_FOUND', confidence: 0, preview: [] } : null,
    configFile: configFile ? { path: configFile.path, role: configFile.role, confidence: configFile.confidence, preview: redactedDatabasePreview(configFile.content) } : null,
    dependencies: [...new Set(dependencies)],
    unresolvedDependencies: [...new Set(unresolvedDependencies)],
    unresolvedSymbols,
    configuration: {
      engine: engine || null,
      database,
      host,
      port,
      username,
      password: hasPassword ? '[PROTECTED]' : null,
      source: 'static-config-resolution',
    },
    live,
    excludedCandidates: classified.filter((file) => file.role === 'REQUIREMENT_CHECKER')
      .map(({ path: relative, role, confidence, databaseConfigEligible }) => ({ path: relative, role, confidence, databaseConfigEligible })),
    report,
  };
}

module.exports = {
  classifyPhpFile,
  classifyDatabaseRequestIntent,
  redactedDatabasePreview,
  discoverDatabaseConfig,
};
