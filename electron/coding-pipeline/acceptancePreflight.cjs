const { projectProcessIsolationStatus } = require('./projectProcessIsolation.cjs');

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

  if (projectState?.status !== 'PROJECT_ATTACHED' || !projectState.projectRoot) {
    blockers.push({
      code: 'project_missing',
      message: projectState?.status === 'PROJECT_MISSING'
        ? 'The selected project folder is missing from disk. Attach an existing project under Developer > Advanced.'
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
    projectAttached: projectState?.status === 'PROJECT_ATTACHED' && Boolean(projectState.projectRoot),
    projectStatus: projectState?.status || 'PROJECT_STATUS_UNAVAILABLE',
    sandbox: {
      available: isolation?.available === true,
      verified: isolation?.verified === true,
      platformRecognized: isolation?.platformRecognized === true,
      platform: isolation?.platform || process.platform,
      reason: isolation?.reason || null,
    },
    blockers,
  };
}

module.exports = { buildCodingAcceptancePreflight };
