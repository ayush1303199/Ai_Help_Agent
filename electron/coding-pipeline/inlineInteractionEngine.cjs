'use strict';

const ACTIONS = new Set(['create', 'modify', 'delete']);

function normalizeAction(operation) {
  if (operation === 'delete_directory') return 'delete';
  if (operation === 'rename') return 'modify';
  return ACTIONS.has(operation) ? operation : 'modify';
}

function operationLineCount(operation, diffLines) {
  if (Array.isArray(diffLines)) return diffLines.length;
  if (typeof operation.content === 'string') return operation.content.split(/\r?\n/).length;
  return 0;
}

function createInlineProposalEnvelope(proposal, sessionContext = {}) {
  const fileOperations = Array.isArray(proposal?.fileOperations)
    ? proposal.fileOperations
    : Array.isArray(proposal?.files)
      ? proposal.files
      : [];
  const diff = typeof proposal?.diff === 'string' ? proposal.diff : '';
  const diffSections = new Map();
  let activeSection = null;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const filePath = line.slice(4).replace(/^(?:b\/|\/dev\/null$)/, '');
      activeSection = filePath && filePath !== '/dev/null' ? filePath : null;
      if (activeSection && !diffSections.has(activeSection)) diffSections.set(activeSection, []);
    }
    if (activeSection) diffSections.get(activeSection).push(line);
  }

  const fileBadges = fileOperations.map((operation) => ({
    filePath: operation.path,
    action: normalizeAction(operation.operation),
    lineCount: operationLineCount(operation, diffSections.get(operation.path)),
  }));
  const counts = fileBadges.reduce((result, badge) => {
    result[badge.action] = (result[badge.action] || 0) + 1;
    return result;
  }, {});
  const summary = Object.entries(counts)
    .map(([action, count]) => `${count} ${action}${count === 1 ? '' : 's'}`)
    .join(', ');

  return {
    proposalId: proposal?.proposalId || proposal?.taskId || null,
    proposalDigest: proposal?.proposalDigest || proposal?.manifestHash || null,
    projectId: sessionContext.projectId || null,
    summary: summary ? `${summary} across ${fileBadges.length} file operation${fileBadges.length === 1 ? '' : 's'}` : 'No file operations',
    fileBadges,
    diffPreview: fileBadges.map((badge) => ({
      filePath: badge.filePath,
      action: badge.action,
      lines: diffSections.get(badge.filePath) || [],
    })),
    debugTrace: {
      stage: 'PLAN_READY',
      timestamp: new Date().toISOString(),
      sessionId: sessionContext.sessionId || null,
      verificationStatus: 'NOT_STARTED',
    },
  };
}

function diagnosticSnapshot(envelope, stage, verificationStatus = 'NOT_STARTED') {
  return {
    proposalId: envelope.proposalId,
    proposalDigest: envelope.proposalDigest,
    projectId: envelope.projectId,
    stage,
    timestamp: new Date().toISOString(),
    sessionId: envelope.debugTrace.sessionId,
    verificationStatus,
  };
}

async function resolveInlineApproval(envelope, userDecision, brokerOrAgentContext = {}) {
  if (!envelope || typeof envelope !== 'object'
    || typeof envelope.proposalId !== 'string'
    || typeof envelope.proposalDigest !== 'string'
    || !/^[a-f0-9]{64}$/i.test(envelope.proposalDigest)
    || !userDecision || !['approve', 'reject'].includes(userDecision.action)
    || typeof brokerOrAgentContext.resolveDecision !== 'function') {
    throw new TypeError('An inline decision requires a valid proposal envelope and trusted decision adapter.');
  }
  if (typeof brokerOrAgentContext.assertSessionOwnership !== 'function'
    || typeof brokerOrAgentContext.validateProposalDigest !== 'function') {
    throw new TypeError('Inline decisions require session ownership and proposal digest validators.');
  }

  const session = await brokerOrAgentContext.assertSessionOwnership(envelope);
  if (session === false || session?.owned === false
    || (envelope.projectId && session?.projectId !== envelope.projectId)
    || (envelope.debugTrace.sessionId && session?.sessionId !== envelope.debugTrace.sessionId)) {
    throw new Error('Inline proposal approval session ownership validation failed.');
  }
  const digestMatches = await brokerOrAgentContext.validateProposalDigest(envelope);
  if (digestMatches !== true) throw new Error('Inline proposal digest no longer matches the approved proposal.');

  const emit = (stage, verificationStatus) => {
    const snapshot = diagnosticSnapshot(envelope, stage, verificationStatus);
    brokerOrAgentContext.onTransition?.(snapshot);
    return snapshot;
  };
  emit('AWAITING_INLINE_APPROVAL');

  if (userDecision.action === 'reject') {
    const result = await brokerOrAgentContext.resolveDecision(envelope, {
      approved: false,
      deleteConfirmed: false,
    });
    emit('REJECTED');
    return result;
  }

  if (typeof brokerOrAgentContext.validateSnapshots !== 'function'
    || await brokerOrAgentContext.validateSnapshots(envelope) !== true) {
    throw new Error('Inline proposal snapshots changed or could not be validated before apply.');
  }
  emit('APPLYING_FILES');
  return brokerOrAgentContext.resolveDecision(envelope, {
    approved: true,
    deleteConfirmed: userDecision.deleteConfirmed === true,
  });
}

async function executePostApplyVerification(
  workspaceRoot,
  createdOrModifiedFiles,
  { terminalRunner, checks = [], verifyIntegrationReachability, onTransition } = {},
) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot
    || !Array.isArray(createdOrModifiedFiles)
    || typeof verifyIntegrationReachability !== 'function') {
    throw new TypeError('Post-apply verification requires a workspace, file list, and reachability verifier.');
  }
  const trace = (stage, verificationStatus) => {
    const snapshot = {
      stage,
      timestamp: new Date().toISOString(),
      verificationStatus,
      files: [...createdOrModifiedFiles],
    };
    onTransition?.(snapshot);
    return snapshot;
  };

  trace('RUNNING_TERMINAL_VERIFICATION', 'RUNNING');
  const terminalResults = [];
  if (checks.length > 0 && typeof terminalRunner !== 'function') {
    throw new TypeError('Allow-listed checks require the trusted terminal runner.');
  }
  for (const check of checks) {
    terminalResults.push(await terminalRunner(check));
    if (terminalResults.at(-1)?.ok !== true) {
      trace('ROLLED_BACK', 'FAILED');
      return { ok: false, status: 'FAILED', terminalResults, reachability: null };
    }
  }

  const reachability = await verifyIntegrationReachability(workspaceRoot, createdOrModifiedFiles);
  if (!reachability?.isValid) {
    trace('ROLLED_BACK', 'FAILED');
    return { ok: false, status: 'FAILED', terminalResults, reachability };
  }
  trace('COMPLETED', 'PASS');
  return { ok: true, status: 'PASS', terminalResults, reachability };
}

module.exports = {
  createInlineProposalEnvelope,
  diagnosticSnapshot,
  executePostApplyVerification,
  resolveInlineApproval,
};
