import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../electron/developerAgent.cjs';
import developerFiles from '../electron/developerFiles.cjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyDatabaseRequestIntent, classifyPhpFile } = require('../electron/databaseDiscovery.cjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'developer-database-discovery-'));
const ownerWebContentsId = 987654;
try {
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config.php'), `<?php
require_once __DIR__ . '/config/db.php';
return ['components' => ['db' => require __DIR__ . '/config/db.php']];
`, 'utf8');
  await fs.writeFile(path.join(root, 'config', 'db.php'), `<?php
require_once __DIR__ . '/_name.php';
return [
    'class' => 'yii\\\\db\\\\Connection',
    'dsn' => 'mysql:host='.DB_HOST.';port='.DB_PORT.';dbname='.DB_UIMS,
    'username' => DB_USERNAME,
    'password' => DB_PASS,
];
`, 'utf8');
  await fs.writeFile(path.join(root, 'config', '_name.php'), `<?php
define('DB_HOST', 'db.internal');
define('DB_PORT', '3307');
define('DB_UIMS', 'admissions');
define('DB_USERNAME', 'app_user');
define('DB_PASS', 'test-secret-must-not-leak');
`, 'utf8');
  await fs.writeFile(path.join(root, 'requirements.php'), `<?php
// Database requirements only; this file configures no connection.
extension_loaded('pdo_mysql');
new YiiRequirementChecker();
`, 'utf8');

  assert.deepEqual(classifyDatabaseRequestIntent('open my project config.php'), ['DATABASE_CONFIGURATION']);
  assert.deepEqual(classifyDatabaseRequestIntent('which db connection current now'), ['DATABASE_CURRENT_TARGET']);
  assert.deepEqual(
    classifyDatabaseRequestIntent('open my project config.php and which db connection current now'),
    ['DATABASE_CONFIGURATION', 'DATABASE_CURRENT_TARGET'],
  );
  assert.deepEqual(classifyDatabaseRequestIntent('show databases'), ['DATABASE_LIST_DATABASES']);
  assert.deepEqual(classifyDatabaseRequestIntent('show db password'), ['DATABASE_CREDENTIAL_REQUEST']);
  assert.deepEqual(classifyDatabaseRequestIntent('show my db'), ['DATABASE_CONFIGURATION']);
  assert.deepEqual(classifyDatabaseRequestIntent('show my username and passwd'), ['DATABASE_CREDENTIAL_REQUEST']);
  assert.deepEqual(classifyDatabaseRequestIntent('show my username and passwd', [
    { role: 'user', content: 'SELECT COUNT(*) FROM admissions' },
  ]), ['DATABASE_CREDENTIAL_REQUEST']);
  assert.deepEqual(classifyPhpFile('requirements.php', "extension_loaded('pdo_mysql'); new YiiRequirementChecker();"), {
    role: 'REQUIREMENT_CHECKER',
    confidence: 1,
    databaseConfigEligible: false,
  });

  const attached = await developerFiles.attachProject(root, ownerWebContentsId);
  assert.equal(attached.status, 'PROJECT_ATTACHED');
  const sessionId = agent.getSession(ownerWebContentsId);
  const inspection = await agent.inspectDatabaseRequest({
    root,
    request: 'open my project config.php',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.handled, true);
  assert.deepEqual(inspection.intents, ['DATABASE_CONFIGURATION']);
  assert.equal(inspection.data.requestedFile.path, 'config.php');
  assert.equal(inspection.data.requestedFile.role, 'APPLICATION_CONFIGURATION');
  assert.equal(inspection.data.configFile.path, 'config/db.php');
  assert.equal(inspection.data.configuration.engine, 'mysql');
  assert.equal(inspection.data.configuration.database, 'admissions', JSON.stringify(inspection.data));
  assert.equal(inspection.data.configuration.host, 'db.internal');
  assert.equal(inspection.data.configuration.port, '3307');
  assert.equal(inspection.data.configuration.username, 'app_user');
  assert.equal(inspection.data.configuration.password, '[PROTECTED]');
  assert.equal(inspection.data.live.status, 'NOT_VERIFIED');
  assert.match(inspection.data.requestedFile.preview.map((item) => item.text).join('\n'), /config\/db\.php/);
  assert.match(inspection.data.configFile.preview.map((item) => item.text).join('\n'), /\[PROTECTED\]/);
  assert.equal(agent.getConversationTurn(inspection.turnId, { sessionId, ownerWebContentsId }).state, 'completed');
  assert.ok(inspection.data.dependencies.includes('config/db.php'));
  assert.ok(inspection.data.dependencies.includes('config/_name.php'));
  assert.deepEqual(inspection.data.excludedCandidates, [{
    path: 'requirements.php',
    role: 'REQUIREMENT_CHECKER',
    confidence: 1,
    databaseConfigEligible: false,
  }]);
  assert.doesNotMatch(JSON.stringify(inspection), /test-secret-must-not-leak/);

  const compound = await agent.inspectDatabaseRequest({
    root,
    request: 'open my project config.php and which db connection current now',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(compound.handled, false, 'Compound current-target requests must reach the runtime session handler.');
  assert.deepEqual(compound.intents, ['DATABASE_CONFIGURATION', 'DATABASE_CURRENT_TARGET']);

  const missingConfig = await agent.inspectDatabaseRequest({
    root,
    request: 'open my project missing.php',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(missingConfig.ok, true);
  assert.equal(missingConfig.data.status, 'REQUESTED_FILE_NOT_FOUND');
  assert.equal(missingConfig.data.configFile, null, 'An explicitly requested missing file must not fall back to another PHP file.');

  const currentTarget = await agent.inspectDatabaseRequest({
    root,
    request: 'which db connection current now',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(currentTarget.handled, false);
  assert.deepEqual(currentTarget.intents, ['DATABASE_CURRENT_TARGET']);

  const shortDatabase = await agent.inspectDatabaseRequest({
    root,
    request: 'show my db',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(shortDatabase.ok, true);
  assert.equal(shortDatabase.handled, true);
  assert.deepEqual(shortDatabase.intents, ['DATABASE_CONFIGURATION']);
  assert.equal(shortDatabase.data.configuration.database, 'admissions');
  assert.equal(shortDatabase.data.live.status, 'NOT_VERIFIED');
  assert.match(shortDatabase.data.report, /Live database[\s\S]*NOT_VERIFIED/);

  const listDatabases = await agent.inspectDatabaseRequest({
    root,
    request: 'show databases',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(listDatabases.handled, false);
  assert.deepEqual(listDatabases.intents, ['DATABASE_LIST_DATABASES']);

  const credentialRequest = await agent.inspectDatabaseRequest({
    root,
    request: 'show db password',
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(credentialRequest.handled, true);
  assert.match(credentialRequest.data.report, /\*\*Password:\*\* \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(credentialRequest), /test-secret-must-not-leak/);
  assert.deepEqual(credentialRequest.intents, ['DATABASE_CREDENTIAL_REQUEST']);

  const contextualCredentialRequest = await agent.inspectDatabaseRequest({
    root,
    request: 'show my username and passwd',
    contextMessages: [
      { role: 'user', content: 'SELECT COUNT(*) FROM admissions' },
      { role: 'assistant', content: 'Total records: 11' },
    ],
    sessionId,
    ownerWebContentsId,
  });
  assert.equal(contextualCredentialRequest.handled, true);
  assert.match(contextualCredentialRequest.data.report, /\*\*Username:\*\* app_user/);
  assert.match(contextualCredentialRequest.data.report, /\*\*Password:\*\* \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(contextualCredentialRequest), /test-secret-must-not-leak/);

  console.log('Database discovery, routing, include resolution, and secret-protection tests passed.');
} finally {
  developerFiles.releaseProject(ownerWebContentsId);
  agent.resetForTest();
  await fs.rm(root, { recursive: true, force: true });
}
