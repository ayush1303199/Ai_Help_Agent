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
assert.equal(missingProvider.canInspectProject, true);
assert.equal(missingProvider.projectIdentity, 'NOT_VERIFIED');
assert.equal(missingProvider.projectRoot, attachedProject.projectRoot);

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

const inaccessibleProject = buildCodingAcceptancePreflight({
  providerConfigured: readyProvider,
  projectState: { status: 'PROJECT_INACCESSIBLE', projectRoot: 'C:\\restricted-project' },
  isolation: unverifiedWindows,
});
assert.equal(inaccessibleProject.projectAttached, false);
assert.equal(inaccessibleProject.canInspectProject, false);
assert.ok(inaccessibleProject.blockers.some((item) => item.code === 'project_inaccessible'));

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
assert.equal(
  buildCodingAcceptancePreflight({
    providerConfigured: readyProvider,
    projectState: attachedProject,
    isolation: projectProcessIsolationStatus('win32'),
  }).sandbox.capabilityStates.osEnforcedProcessIsolation,
  'BLOCKED',
);
assert.throws(
  () => buildCodingAcceptancePreflight({
    providerConfigured: readyProvider,
    projectState: attachedProject,
    isolation: {
      ...unverifiedWindows,
      capabilityStates: { osEnforcedProcessIsolation: 'VERIFIED' },
    },
  }),
  /Invalid state/,
);
const linuxCapabilityStates = buildCodingAcceptancePreflight({
  providerConfigured: readyProvider,
  projectState: attachedProject,
  isolation: projectProcessIsolationStatus('linux'),
}).sandbox.capabilityStates;
assert.ok(Object.values(linuxCapabilityStates).every((state) => state === 'UNSUPPORTED'));
assert.throws(
  () => requireProjectProcessIsolation('Preflight test command'),
  /was not started.*(?:sandbox|isolation mechanism)/i,
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
const preflightNormalizerStart = codingPage.indexOf('function normalizeCodingAcceptancePreflight(');
const preflightNormalizerEnd = codingPage.indexOf('interface CodingAgentPageProps', preflightNormalizerStart);
const preflightNormalizer = codingPage.slice(preflightNormalizerStart, preflightNormalizerEnd);
assert.ok(preflightNormalizerStart >= 0 && preflightNormalizerEnd > preflightNormalizerStart);
assert.match(preflightNormalizer, /ready: false/);
assert.match(preflightNormalizer, /canRunProjectCommands: false/);
assert.match(preflightNormalizer, /available: false/);
assert.match(preflightNormalizer, /verified: false/);
assert.match(preflightNormalizer, /isIsolationCapabilityState/);
assert.match(preflightNormalizer, /Array\.isArray\(source\.blockers\)/);
assert.match(codingPage, /setAcceptancePreflight\(normalizeCodingAcceptancePreflight\(preflight,\s*workspace\.projectRoot\)\)/);
assert.match(codingPage, /getDeveloperAcceptancePreflight\(\)/);
assert.match(codingPage, /hasProjectContextMismatch/);
assert.match(codingPage, /PROJECT_CONTEXT_MISMATCH/);
assert.match(codingWorkspace, /Project command execution remains blocked by the shared execution gate/);
assert.match(codingWorkspace, /descriptive, not verification/);
assert.doesNotMatch(codingWorkspace, /acceptancePreflight\.ready\s*\?/);
assert.doesNotMatch(codingWorkspace, /acceptancePreflight\.sandbox\.verified\s*\?/);
assert.match(codingPage, /\/api\/coding\/acceptance-preflight/);
assert.doesNotMatch(codingPage, /if \(!window\.electronAPI\?\.getDeveloperAcceptancePreflight[^]*return;/);
assert.match(codingWorkspace, /isBrowserDevelopment/);
assert.match(codingWorkspace, /Select project folder/);
assert.match(codingWorkspace, /Project identity: \{acceptancePreflight\.projectIdentity\}/);
assert.match(codingWorkspace, /Read-only source inspection:/);
assert.match(codingWorkspace, /aria-label="Project folder path"/);
assert.match(codingWorkspace, /onAttachProjectByPath\?\.\(projectPathInput\.trim\(\)\)/);
assert.match(codingController, /input\.setAttribute\('webkitdirectory', ''\)/);
assert.match(codingController, /file\.webkitRelativePath/);
assert.match(codingController, /\/api\/coding\/project-discover/);
assert.match(backendSource, /@app\.get\("\/api\/coding\/acceptance-preflight"\)/);
assert.match(backendSource, /"canRunProjectCommands": False/);
assert.match(backendSource, /"capabilityStates": capability_states/);

console.log('Coding acceptance preflight missing-prerequisite and fail-closed tests passed.');
