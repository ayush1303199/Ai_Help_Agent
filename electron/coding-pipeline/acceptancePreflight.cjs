const { projectProcessIsolationStatus } = require('./projectProcessIsolation.cjs');
const { createCapabilityStateMap } = require('./providerAdapterContract.cjs');

function buildCodingAcceptancePreflight({
  providerConfigured,
  providerCheckError = null,
  projectState,
  isolation = projectProcessIsolationStatus(),
}) {
  const blockers = [];
  if (providerCheckError) {
    blockers.push({
      code: 'provider_status_unavailable',
      message: `Runtime provider status could not be checked: ${providerCheckError}`,
    });
  } else if (providerConfigured !== true) {
    blockers.push({
      code: 'runtime_provider_missing',
      message: 'No enabled active runtime provider with a configured key and Coding Agent capabilities is available. Configure one under Configuration > AI Providers.',
    });
  }

  const projectAttached = projectState?.status === 'PROJECT_ATTACHED' && Boolean(projectState.projectRoot);
  if (!projectAttached) {
    const projectStatus = projectState?.status || 'PROJECT_STATUS_UNAVAILABLE';
    blockers.push({
      code: projectStatus === 'PROJECT_INACCESSIBLE' ? 'project_inaccessible' : 'project_missing',
      message: projectStatus === 'PROJECT_MISSING'
        ? 'The selected project folder is missing from disk. Attach an existing project under Developer > Advanced.'
        : projectStatus === 'PROJECT_INACCESSIBLE'
          ? 'The selected project folder cannot be accessed. Check folder permissions, then select it again under Developer > Advanced.'
          : projectStatus === 'PROJECT_DETACHED'
            ? 'The project was detached. Attach an existing project under Developer > Advanced.'
            : 'No project is attached. Attach an existing project under Developer > Advanced.',
    });
  }

  if (isolation?.platformRecognized === false) {
    blockers.push({
      code: 'sandbox_unsupported_platform',
      message: isolation.reason || `OS sandbox verification is unsupported on platform "${isolation.platform}".`,
    });
  } else if (isolation?.available !== true || isolation?.verified !== true) {
    blockers.push({
      code: 'sandbox_unverified',
      message: isolation?.reason || 'Project command execution is disabled because the OS sandbox is not verified.',
    });
  }

  return {
    ready: blockers.length === 0,
    canRunProjectCommands: isolation?.available === true && isolation?.verified === true,
    providerConfigured: providerConfigured === true && !providerCheckError,
    projectAttached,
    projectStatus: projectState?.status || 'PROJECT_STATUS_UNAVAILABLE',
    projectRoot: projectAttached ? projectState.projectRoot : projectState?.projectRoot || null,
    projectIdentity: 'NOT_VERIFIED',
    canInspectProject: projectAttached,
    sandbox: {
      available: isolation?.available === true,
      verified: isolation?.verified === true,
      platformRecognized: isolation?.platformRecognized === true,
      platform: isolation?.platform || process.platform,
      reason: isolation?.reason || null,
      capabilityStates: createCapabilityStateMap(isolation?.capabilityStates || {}),
    },
    blockers,
  };
}

module.exports = { buildCodingAcceptancePreflight };
