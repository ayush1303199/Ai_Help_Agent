import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import developerFiles from '../electron/developerFiles.cjs';

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-sandbox-failure-audit-'));
const projectRoot = path.join(temporaryRoot, 'project');
const auditDirectory = path.join(temporaryRoot, 'audit');
await fs.mkdir(projectRoot);
const rootKey = crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex');
const auditFile = path.join(auditDirectory, `${rootKey}.jsonl`);

try {
  developerFiles.configureAuditDirectory(auditDirectory);
  const cleanupFailure = Object.assign(new Error('Synthetic lifecycle cleanup failure.'), {
    isolationFailure: true,
  });
  let propagatedFailure;
  try {
    await developerFiles.auditAndPropagateWindowsSandboxFailure(
      projectRoot,
      'test',
      cleanupFailure,
    );
  } catch (error) {
    propagatedFailure = error;
  }

  assert.ok(propagatedFailure instanceof Error);
  assert.equal(propagatedFailure.cause, cleanupFailure);
  assert.match(propagatedFailure.message, /Windows Sandbox verification failed closed/);
  const auditLines = (await fs.readFile(auditFile, 'utf8')).trim().split(/\r?\n/);
  assert.equal(auditLines.length, 1);
  assert.match(auditLines[0], /tool=run_command/);
  assert.match(auditLines[0], /target="test"/);
  assert.match(auditLines[0], /result=failure:cleanup/);
  assert.doesNotMatch(auditLines[0], /Synthetic lifecycle cleanup failure/);

  const blockedAuditPath = path.join(temporaryRoot, 'not-a-directory');
  await fs.writeFile(blockedAuditPath, 'fixture');
  developerFiles.configureAuditDirectory(blockedAuditPath);
  const secondCleanupFailure = Object.assign(new Error('Second synthetic cleanup failure.'), {
    isolationFailure: true,
  });
  let combinedFailure;
  try {
    await developerFiles.auditAndPropagateWindowsSandboxFailure(
      projectRoot,
      'test',
      secondCleanupFailure,
    );
  } catch (error) {
    combinedFailure = error;
  }

  assert.ok(combinedFailure instanceof AggregateError);
  assert.equal(combinedFailure.errors[0], secondCleanupFailure);
  assert.ok(combinedFailure.errors[1] instanceof Error);
  assert.match(combinedFailure.message, /Second synthetic cleanup failure/);
  assert.match(combinedFailure.message, /failure audit could not be recorded/);
} finally {
  developerFiles.configureAuditDirectory(null);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Windows Sandbox failure audit propagation checks passed.');
