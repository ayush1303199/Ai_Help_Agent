import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildCodingAcceptancePreflight,
} = require('../electron/coding-pipeline/acceptancePreflight.cjs');
const {
  projectProcessIsolationStatus,
  requireProjectProcessIsolation,
} = require('../electron/coding-pipeline/projectProcessIsolation.cjs');

const unverifiedWindows = {
  available: false,
  verified: false,
  platformRecognized: true,
  platform: 'win32',
  reason: 'Windows sandbox verification is pending.',
};
const attachedProject = { status: 'PROJECT_ATTACHED', projectRoot: 'C:\\test-project' };
const readyProvider = true;

const missingProvider = buildCodingAcceptancePreflight({
  providerConfigured: false,
  projectState: attachedProject,
  isolation: unverifiedWindows,
});
assert.ok(missingProvider.blockers.some((item) => item.code === 'runtime_provider_missing'));
assert.equal(missingProvider.projectAttached, true);
assert.equal(missingProvider.canRunProjectCommands, false);

const missingProject = buildCodingAcceptancePreflight({
  providerConfigured: readyProvider,
  projectState: { status: 'PROJECT_NOT_ATTACHED', projectRoot: null },
  isolation: unverifiedWindows,
});
assert.ok(missingProject.blockers.some((item) => item.code === 'project_missing'));
assert.ok(missingProject.blockers.some((item) => item.code === 'sandbox_unverified'));

const missingFolder = buildCodingAcceptancePreflight({
  providerConfigured: readyProvider,
  projectState: { status: 'PROJECT_MISSING', projectRoot: null },
  isolation: unverifiedWindows,
});
assert.match(missingFolder.blockers.find((item) => item.code === 'project_missing').message, /missing from disk/i);

const unsupportedPlatform = buildCodingAcceptancePreflight({
  providerConfigured: readyProvider,
  projectState: attachedProject,
  isolation: projectProcessIsolationStatus('aix'),
});
assert.ok(unsupportedPlatform.blockers.some((item) => item.code === 'sandbox_unsupported_platform'));
assert.equal(unsupportedPlatform.canRunProjectCommands, false);

const providerCheckFailed = buildCodingAcceptancePreflight({
  providerConfigured: false,
  providerCheckError: 'backend unavailable',
  projectState: attachedProject,
  isolation: unverifiedWindows,
});
assert.ok(providerCheckFailed.blockers.some((item) => item.code === 'provider_status_unavailable'));
assert.ok(!providerCheckFailed.blockers.some((item) => item.code === 'runtime_provider_missing'));

const actualIsolation = projectProcessIsolationStatus();
assert.equal(actualIsolation.available, false);
assert.equal(actualIsolation.verified, false);
assert.equal(actualIsolation.platform, process.platform);
assert.throws(
  () => requireProjectProcessIsolation('Preflight test command'),
  /was not started.*sandbox/i,
);

const codingPage = await fs.readFile(
  new URL('../src/features/coding/CodingAgentPage.tsx', import.meta.url),
  'utf8',
);
const codingWorkspace = await fs.readFile(
  new URL('../src/features/coding/CodingAgentWorkspace.tsx', import.meta.url),
  'utf8',
);
const codingController = await fs.readFile(
  new URL('../src/features/coding/useCodingAgentController.ts', import.meta.url),
  'utf8',
);
const backendSource = await fs.readFile(
  new URL('../server/src/index.py', import.meta.url),
  'utf8',
);
assert.match(codingPage, /getDeveloperAcceptancePreflight\(\)/);
assert.match(codingPage, /\/api\/coding\/acceptance-preflight/);
assert.doesNotMatch(codingPage, /if \(!window\.electronAPI\?\.getDeveloperAcceptancePreflight[^]*return;/);
assert.match(codingWorkspace, /isBrowserDevelopment/);
assert.match(codingWorkspace, /Select project folder/);
assert.match(codingWorkspace, /aria-label="Project folder path"/);
assert.match(codingWorkspace, /onAttachProjectByPath\?\.\(projectPathInput\.trim\(\)\)/);
assert.match(codingController, /input\.setAttribute\('webkitdirectory', ''\)/);
assert.match(codingController, /file\.webkitRelativePath/);
assert.match(codingController, /\/api\/coding\/project-discover/);
assert.match(backendSource, /@app\.get\("\/api\/coding\/acceptance-preflight"\)/);
assert.match(backendSource, /"canRunProjectCommands": False/);

console.log('Coding acceptance preflight missing-prerequisite and fail-closed tests passed.');
