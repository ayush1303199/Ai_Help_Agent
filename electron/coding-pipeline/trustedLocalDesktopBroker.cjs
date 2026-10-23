'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {
  createInlineProposalEnvelope,
  diagnosticSnapshot,
  resolveInlineApproval,
} = require('./inlineInteractionEngine.cjs');

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_REQUEST_BYTES = 256 * 1024;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function normalizeRoot(root) {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function hashProjectRoot(root) {
  return crypto.createHash('sha256')
    .update(normalizeRoot(root).replace(/\\/g, '/'), 'utf8')
    .digest('hex');
}

function brokerError(code, message, status = 403) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = status;
  return error;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class TrustedLocalDesktopBroker {
  constructor({
    allowedOrigins,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    executeWorkflow,
    browserApproval = false,
    synchronizeProjects = async () => {},
    onLeaseCreated = async () => {},
    onLeaseReleased = async () => {},
    requestApproval,
    getTask,
    validateSnapshots,
    authorizeMutation = async () => ({ allowed: true }),
  }) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0
      || !allowedOrigins.every((origin) => typeof origin === 'string' && /^https?:\/\//.test(origin))) {
      throw new TypeError('Trusted broker requires configured renderer origins.');
    }
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000) {
      throw new TypeError('Trusted broker session TTL must be a positive safe integer.');
    }
    if (typeof executeWorkflow !== 'function' || typeof requestApproval !== 'function'
      || typeof getTask !== 'function' || typeof validateSnapshots !== 'function') {
      throw new TypeError('Trusted broker requires workflow, approval, and proposal-validation delegates.');
    }
    this.allowedOrigins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
    this.sessionTtlMs = sessionTtlMs;
    this.executeWorkflowDelegate = executeWorkflow;
    this.browserApproval = browserApproval === true;
    this.synchronizeProjectsDelegate = synchronizeProjects;
    this.onLeaseCreated = onLeaseCreated;
    this.onLeaseReleased = onLeaseReleased;
    this.requestApprovalDelegate = requestApproval;
    this.getTaskDelegate = getTask;
    this.validateSnapshotsDelegate = validateSnapshots;
    this.authorizeMutationDelegate = authorizeMutation;
    this.projects = new Map();
    this.projectsByOwner = new Map();
    this.leases = new Map();
    this.grants = new Map();
    this.server = null;
    this.endpoint = null;
  }

  async start() {
    if (this.server) return this.endpoint;
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }).catch((error) => {
      this.server = null;
      throw error;
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Broker did not bind a loopback TCP endpoint.');
    this.endpoint = `http://127.0.0.1:${address.port}`;
    return this.endpoint;
  }

  async stop() {
    for (const lease of this.leases.values()) {
      lease.cancelled = true;
      await this.releaseLease(lease);
    }
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  async registerProject({ root, registrationOwnerId }) {
    if (!Number.isInteger(registrationOwnerId) || typeof root !== 'string' || !path.isAbsolute(root)) {
      throw brokerError('BROKER_PROJECT_UNAUTHORIZED', 'Project registration requires a trusted desktop owner.', 403);
    }
    const canonicalRoot = await fs.realpath(root);
    const stat = await fs.stat(canonicalRoot);
    if (!stat.isDirectory()) {
      throw brokerError('BROKER_PROJECT_UNAUTHORIZED', 'Registered project root must be a directory.', 403);
    }
    const existing = this.projectsByOwner.get(registrationOwnerId);
    const rootHash = hashProjectRoot(canonicalRoot);
    if (existing && existing.rootHash === rootHash) {
      return { projectId: existing.projectId, rootHash: existing.rootHash };
    }
    if (existing) this.projects.delete(existing.projectId);
    const project = {
      projectId: crypto.randomUUID(),
      registrationOwnerId,
      root: canonicalRoot,
      rootHash,
    };
    this.projects.set(project.projectId, project);
    this.projectsByOwner.set(registrationOwnerId, project);
    return { projectId: project.projectId, rootHash: project.rootHash };
  }

  async unregisterProject(registrationOwnerId) {
    const project = this.projectsByOwner.get(registrationOwnerId);
    if (!project) return false;
    this.projectsByOwner.delete(registrationOwnerId);
    this.projects.delete(project.projectId);
    const activeLeases = [...this.leases.values()].filter((lease) => lease.projectId === project.projectId);
    for (const lease of activeLeases) {
      lease.cancelled = true;
      await this.releaseLease(lease);
    }
    return true;
  }

  registeredProjects() {
    return [...this.projects.values()].map(({ projectId, rootHash }) => ({ projectId, rootHash }));
  }

  async issueLease({ projectId, origin }) {
    this.assertOrigin(origin);
    const project = this.projects.get(projectId);
    if (!project) {
      throw brokerError('BROKER_PROJECT_UNAUTHORIZED', 'The requested project is not registered with the trusted desktop broker.');
    }
    const brokerSessionId = crypto.randomUUID();
    const leaseToken = crypto.randomBytes(32).toString('base64url');
    const ownerWebContentsId = crypto.randomInt(1, 0xFFFFFFFFFFFF);
    const lease = {
      brokerSessionId,
      leaseToken,
      projectId,
      rootHash: project.rootHash,
      root: project.root,
      registrationOwnerId: project.registrationOwnerId,
      ownerWebContentsId,
      origin: new URL(origin).origin,
      expiresAt: Date.now() + this.sessionTtlMs,
      active: true,
      cancelled: false,
      workflowState: 'idle',
      executionMode: 'inline_review',
      approvedProposal: null,
      pendingApproval: null,
      workflowPromise: null,
      approvalReadyPromise: null,
      resolveApprovalReady: null,
      workflowRequestId: null,
      taskId: null,
      expirationTimer: null,
    };
    this.leases.set(brokerSessionId, lease);
    lease.expirationTimer = setTimeout(() => {
      lease.cancelled = true;
      void this.releaseLease(lease);
    }, this.sessionTtlMs);
    lease.expirationTimer.unref?.();
    try {
      await this.onLeaseCreated({
        root: lease.root,
        ownerWebContentsId,
        sessionId: brokerSessionId,
      });
    } catch (error) {
      this.leases.delete(brokerSessionId);
      lease.active = false;
      clearTimeout(lease.expirationTimer);
      throw error;
    }
    return {
      brokerSessionId,
      sessionLeaseToken: leaseToken,
      expiresAt: new Date(lease.expiresAt).toISOString(),
    };
  }

  async executeWorkflow({
    brokerSessionId,
    sessionLeaseToken,
    origin,
    userRequest,
    scope = '.',
    executionMode = 'inline_review',
  }) {
    const lease = this.assertLease(brokerSessionId, sessionLeaseToken, origin);
    if (lease.workflowState !== 'idle') {
      throw brokerError('BROKER_WORKFLOW_UNAVAILABLE', 'This short-lived broker lease has already been used for a workflow.', 409);
    }
    if (typeof userRequest !== 'string' || !userRequest.trim() || userRequest.length > 20000) {
      throw brokerError('BROKER_INVALID_REQUEST', 'A bounded actionable request is required.', 400);
    }
    const normalizedScope = this.validateScope(scope);
    if (!['inline_review', 'autonomous_auto_apply'].includes(executionMode)) {
      throw brokerError('BROKER_INVALID_REQUEST', 'The requested execution mode is not supported.', 400);
    }
    lease.executionMode = executionMode;
    const requestId = crypto.randomUUID();
    lease.workflowRequestId = requestId;
    lease.workflowState = 'running';
    lease.scope = normalizedScope;
    lease.approvedProposal = null;
    if (this.browserApproval) {
      lease.approvalReadyPromise = new Promise((resolve) => {
        lease.resolveApprovalReady = resolve;
      });
    }
    const runWorkflow = async () => {
      try {
        const result = await this.executeWorkflowDelegate({
          root: lease.root,
          scope: normalizedScope,
          userRequest: userRequest.trim(),
          sessionId: lease.brokerSessionId,
          ownerWebContentsId: lease.ownerWebContentsId,
          workflowRequestId: requestId,
          executionMode,
          isCancelled: () => lease.cancelled || !this.isLeaseCurrent(lease),
          requestApproval: (approval) => this.requestBoundApproval(lease, approval),
          authorizeMutation: (request) => this.authorizeMutation(lease, request),
        });
        if (lease.cancelled && result?.outcome === 'APPROVAL_REJECTED') {
          return {
            ...result,
            outcome: 'CANCELLED',
            filesModified: [],
            codeApplied: false,
            codeVerified: false,
            message: 'The browser broker workflow was cancelled before file application.',
          };
        }
        return result;
      } finally {
        lease.workflowRequestId = null;
        lease.taskId = null;
        lease.workflowState = lease.cancelled ? 'cancelled' : 'finished';
        lease.workflowPromise = null;
        lease.approvalReadyPromise = null;
        lease.resolveApprovalReady = null;
      }
    };
    lease.workflowPromise = runWorkflow();
    if (!this.browserApproval) return lease.workflowPromise;

    const firstResult = await Promise.race([
      lease.approvalReadyPromise.then((approval) => ({ kind: 'approval', approval })),
      lease.workflowPromise.then(
        (result) => ({ kind: 'result', result }),
        (error) => ({ kind: 'error', error }),
      ),
    ]);
    if (firstResult.kind === 'error') throw firstResult.error;
    if (firstResult.kind === 'result') return firstResult.result;
    lease.workflowState = 'awaiting_approval';
    return {
      outcome: 'AWAITING_APPROVAL',
      phase: 'APPROVE',
      filesModified: [],
      codeApplied: false,
      codeVerified: false,
      approval: firstResult.approval,
      message: 'The proposal is staged for inline review; no files have been written.',
    };
  }

  async releaseSession({ brokerSessionId, sessionLeaseToken, origin }) {
    this.assertOrigin(origin);
    const lease = this.leases.get(brokerSessionId);
    const suppliedToken = Buffer.from(String(sessionLeaseToken || ''));
    const expectedToken = lease ? Buffer.from(lease.leaseToken) : Buffer.alloc(suppliedToken.length);
    if (!lease || !lease.active || expectedToken.length !== suppliedToken.length
      || !crypto.timingSafeEqual(expectedToken, suppliedToken)
      || lease.origin !== new URL(origin).origin
      || lease.workflowRequestId) {
      throw brokerError('BROKER_SESSION_UNAUTHORIZED', 'The broker session lease cannot be released.');
    }
    await this.releaseLease(lease);
    return { released: true };
  }

  async requestBoundApproval(lease, { taskId, proposal: proposalSummary, proposalContract, diff }) {
    this.assertActiveLease(lease);
    const invalidFields = [];
    if (!taskId || proposalSummary?.taskId !== taskId) invalidFields.push('task identity');
    if (!Array.isArray(proposalSummary?.files) || proposalSummary.files.length === 0) invalidFields.push('file operations');
    if (typeof proposalSummary?.manifestHash !== 'string' || !/^[a-f0-9]{64}$/i.test(proposalSummary.manifestHash)) {
      invalidFields.push('proposal manifest');
    }
    if (typeof diff !== 'string' || !diff.trim()) invalidFields.push('proposal diff');
    if (invalidFields.length) {
      throw brokerError(
        'BROKER_PROPOSAL_INVALID',
        `The proposal failed broker validation: ${invalidFields.join(', ')}.`,
        422,
      );
    }
    const proposal = this.getTaskDelegate(taskId, {
      sessionId: lease.brokerSessionId,
      ownerWebContentsId: lease.ownerWebContentsId,
    });
    if (!proposal || proposal.taskId !== taskId
      || proposal.proposalId !== proposalSummary.proposalId
      || proposal.manifestHash !== proposalSummary.manifestHash
      || !Array.isArray(proposal.files) || proposal.files.length !== proposalSummary.files.length
      || !Array.isArray(proposal.before)) {
      throw brokerError('BROKER_PROPOSAL_INVALID', 'The broker could not hydrate the authoritative proposal snapshot.', 422);
    }
    const summaryMatches = proposal.files.every((file, index) => {
      const summary = proposalSummary.files[index];
      return summary?.path === file.path
        && summary?.sourcePath === (file.sourcePath || null)
        && summary?.operation === file.operation
        && summary?.hash === file.hash;
    });
    if (!summaryMatches) {
      throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'The proposal summary differs from the authoritative file operations.');
    }
    const project = this.projects.get(lease.projectId);
    if (!project || project.rootHash !== lease.rootHash || !isInside(project.root, path.resolve(lease.root))) {
      throw brokerError('BROKER_PROJECT_UNAUTHORIZED', 'The registered project is no longer authorized.');
    }
    const { validateSafePath } = require('./modularArchitectureEngine.cjs');
    for (const file of proposal.files) {
      if (!file || typeof file.path !== 'string') {
        throw brokerError('BROKER_PROPOSAL_INVALID', 'The proposal contains a path that is not normalized within the registered project.', 422);
      }
      try {
        if (validateSafePath(project.root, file.path) !== file.path
          || (file.sourcePath && validateSafePath(project.root, file.sourcePath) !== file.sourcePath)) {
          throw new Error('The proposal contains a non-normalized path.');
        }
      } catch {
        throw brokerError('BROKER_PROPOSAL_INVALID', 'The proposal contains a path that is not normalized within the registered project.', 422);
      }
    }
    const proposalId = String(proposal.proposalId || taskId);
    const proposalDigest = this.proposalDigest(lease, proposal);
    const envelope = createInlineProposalEnvelope({
      proposalId,
      proposalDigest,
      fileOperations: proposal.files,
      diff,
    }, { projectId: lease.projectId, sessionId: lease.brokerSessionId });
    const grant = {
      approvalGrant: crypto.randomBytes(32).toString('base64url'),
      approvalNonce: crypto.randomBytes(24).toString('base64url'),
      brokerSessionId: lease.brokerSessionId,
      projectId: lease.projectId,
      proposalId,
      proposalDigest,
      expiresAt: Math.min(lease.expiresAt, Date.now() + this.sessionTtlMs),
      used: false,
    };
    this.grants.set(grant.approvalGrant, grant);
    lease.taskId = taskId;
    const approval = {
      projectId: lease.projectId,
      proposalId,
      proposalDigest,
      fileOperations: proposal.files.map((file) => ({
        path: file.path,
        sourcePath: file.sourcePath || null,
        operation: file.operation,
        hash: file.hash,
        content: file.content ?? null,
      })),
      diff,
      proposalContract,
      proposal,
      root: lease.root,
      scope: lease.scope || '.',
      workflowRequestId: lease.workflowRequestId,
      taskId,
      sessionId: lease.brokerSessionId,
      approvalNonce: grant.approvalNonce,
      envelope,
    };
    envelope.approvalNonce = grant.approvalNonce;
    const decision = lease.executionMode === 'autonomous_auto_apply'
      ? await this.autoApproveBrowserProposal(lease, grant, approval)
      : this.browserApproval
        ? await this.waitForBrowserApproval(lease, grant, approval)
      : await this.requestApprovalDelegate(approval);
    if (lease.cancelled || !this.isLeaseCurrent(lease)) {
      this.grants.delete(grant.approvalGrant);
      return false;
    }
    if (decision !== true && decision?.approved !== true) {
      this.grants.delete(grant.approvalGrant);
      return false;
    }
    const currentDigest = this.proposalDigest(lease, proposal);
    this.consumeApprovalGrant(grant.approvalGrant, {
      brokerSessionId: lease.brokerSessionId,
      projectId: lease.projectId,
      proposalId,
      proposalDigest: currentDigest,
    });
    lease.approvedProposal = {
      proposalId,
      taskId,
      proposalDigest,
      manifestHash: proposal.manifestHash,
      scope: proposal.scope || '.',
      paths: [...new Set(proposal.files.flatMap((file) => (
        file.sourcePath ? [file.sourcePath, file.path] : [file.path]
      )))],
      grantId: grant.approvalGrant,
      deleteConfirmed: decision === true || decision?.deleteConfirmed === true,
    };
    return true;
  }

  async autoApproveBrowserProposal(lease, grant, approval) {
    let decision;
    await resolveInlineApproval(approval.envelope, {
      action: 'approve',
      deleteConfirmed: false,
    }, {
      assertSessionOwnership: (envelope) => ({
        owned: this.isLeaseCurrent(lease)
          && envelope.projectId === lease.projectId
          && envelope.debugTrace.sessionId === lease.brokerSessionId,
        projectId: lease.projectId,
        sessionId: lease.brokerSessionId,
      }),
      validateProposalDigest: (envelope) => {
        const currentProposal = this.getTaskDelegate(approval.taskId, {
          sessionId: lease.brokerSessionId,
          ownerWebContentsId: lease.ownerWebContentsId,
        });
        return Boolean(currentProposal
          && this.proposalDigest(lease, currentProposal) === envelope.proposalDigest);
      },
      validateSnapshots: async () => {
        await this.validateSnapshotsDelegate(approval.taskId, {
          sessionId: lease.brokerSessionId,
          ownerWebContentsId: lease.ownerWebContentsId,
        });
        return true;
      },
      resolveDecision: (_envelope, userDecision) => {
        decision = userDecision;
        return userDecision;
      },
    });
    return decision;
  }

  waitForBrowserApproval(lease, grant, approval) {
    if (lease.pendingApproval) {
      throw brokerError('BROKER_APPROVAL_UNAVAILABLE', 'A proposal is already awaiting a decision for this lease.', 409);
    }
    const pending = {
      proposalId: approval.proposalId,
      proposalDigest: approval.proposalDigest,
      workflowRequestId: lease.workflowRequestId,
      envelope: approval.envelope,
      approvalNonce: approval.approvalNonce,
      taskId: approval.taskId,
      deleteConfirmationRequired: approval.fileOperations.some((item) => (
        item.operation === 'delete' || item.operation === 'delete_directory'
      )),
      fileOperations: approval.fileOperations.map(({ path: filePath, sourcePath, operation, hash, content }) => ({
        path: filePath,
        sourcePath,
        operation,
        hash,
        content,
      })),
      diff: approval.diff,
      transitions: [
        approval.envelope.debugTrace,
        diagnosticSnapshot(approval.envelope, 'AWAITING_INLINE_APPROVAL'),
      ],
      grantId: grant.approvalGrant,
    };
    const promise = new Promise((resolve) => {
      pending.resolve = resolve;
    });
    lease.pendingApproval = pending;
    const publicApproval = this.serializePendingApproval(pending);
    lease.resolveApprovalReady?.(publicApproval);
    return promise;
  }

  serializePendingApproval(pending) {
    return {
      taskId: pending.taskId,
      proposalId: pending.proposalId,
      proposalDigest: pending.proposalDigest,
      workflowRequestId: pending.workflowRequestId,
      approvalNonce: pending.approvalNonce,
      deleteConfirmationRequired: pending.deleteConfirmationRequired,
      fileOperations: pending.fileOperations,
      diff: pending.diff,
      envelope: pending.envelope,
      transitions: pending.transitions,
    };
  }

  getPendingApproval({ brokerSessionId, sessionLeaseToken, origin }) {
    const lease = this.assertLease(brokerSessionId, sessionLeaseToken, origin);
    const pending = lease.pendingApproval;
    if (!pending) return { pending: null };
    return { pending: this.serializePendingApproval(pending) };
  }

  heartbeat({ brokerSessionId, sessionLeaseToken, origin }) {
    const lease = this.assertLease(brokerSessionId, sessionLeaseToken, origin);
    return { expiresAt: new Date(lease.expiresAt).toISOString() };
  }

  async decideBrowserApproval({
    brokerSessionId,
    sessionLeaseToken,
    origin,
    proposalId,
    proposalDigest,
    approvalNonce,
    approved,
    deleteConfirmed = false,
  }) {
    const lease = this.assertLease(brokerSessionId, sessionLeaseToken, origin);
    const workflowPromise = lease.workflowPromise;
    const pending = lease.pendingApproval;
    const activeGrant = pending && this.grants.get(pending.grantId);
    if (!pending || !activeGrant
      || pending.proposalId !== proposalId
      || pending.proposalDigest !== proposalDigest
      || pending.approvalNonce !== approvalNonce
      || activeGrant.approvalNonce !== approvalNonce
      || activeGrant.brokerSessionId !== brokerSessionId
      || activeGrant.projectId !== lease.projectId
      || activeGrant.proposalId !== proposalId
      || activeGrant.proposalDigest !== proposalDigest
      || activeGrant.expiresAt <= Date.now()
      || activeGrant.used
      || typeof approved !== 'boolean'
      || typeof deleteConfirmed !== 'boolean'
      || (approved && pending.deleteConfirmationRequired && !deleteConfirmed)) {
      throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'The browser decision does not match the active broker proposal.');
    }
    let decisionResult;
    try {
      decisionResult = await resolveInlineApproval(pending?.envelope, {
        action: approved ? 'approve' : 'reject',
        deleteConfirmed,
      }, {
        assertSessionOwnership: (envelope) => ({
          owned: Boolean(pending
            && pending.proposalId === proposalId
            && pending.proposalDigest === proposalDigest
            && pending.approvalNonce === approvalNonce
            && envelope.projectId === lease.projectId
            && envelope.debugTrace.sessionId === brokerSessionId),
          projectId: lease.projectId,
          sessionId: brokerSessionId,
        }),
        validateProposalDigest: (envelope) => {
          const currentProposal = this.getTaskDelegate(pending.taskId, {
            sessionId: brokerSessionId,
            ownerWebContentsId: lease.ownerWebContentsId,
          });
          return Boolean(currentProposal
            && this.proposalDigest(lease, currentProposal) === envelope.proposalDigest);
        },
        validateSnapshots: async () => {
          await this.validateSnapshotsDelegate(pending.taskId, {
            sessionId: brokerSessionId,
            ownerWebContentsId: lease.ownerWebContentsId,
          });
          return true;
        },
        resolveDecision: (_envelope, decision) => {
          const grant = this.grants.get(pending.grantId);
          if (lease.pendingApproval !== pending
            || !this.isLeaseCurrent(lease)
            || !grant
            || grant.approvalNonce !== approvalNonce
            || grant.brokerSessionId !== brokerSessionId
            || grant.projectId !== lease.projectId
            || grant.proposalId !== proposalId
            || grant.proposalDigest !== proposalDigest
            || grant.expiresAt <= Date.now()
            || grant.used
            || (decision.approved && pending.deleteConfirmationRequired && !decision.deleteConfirmed)) {
            throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'The browser decision does not match the active broker proposal.');
          }
          lease.pendingApproval = null;
          pending.resolve(decision);
          return { decisionAccepted: true, approved: decision.approved };
        },
        onTransition: (snapshot) => {
          pending.transitions.push(snapshot);
        },
      });
    } catch (error) {
      if (error?.message?.includes('session ownership')) {
        throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'The browser decision does not match the active broker proposal.');
      }
      if (error?.message?.includes('proposal digest')) {
        throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'The browser decision does not match the active broker proposal.');
      }
      if (error?.code === 'STALE_PROPOSAL_DRIFT'
        || /snapshot.*changed|project files changed/i.test(error?.message || '')) {
        if (lease.pendingApproval === pending) {
          lease.pendingApproval = null;
          this.grants.delete(pending.grantId);
          pending.resolve({
            approved: false,
            deleteConfirmed: false,
            rejectionReason: error.message,
          });
        }
        throw brokerError('BROKER_PROPOSAL_STALE', 'The proposal files changed before approval; request a fresh proposal.', 409);
      }
      throw error;
    }
    const result = workflowPromise ? await workflowPromise : null;
    return { ...decisionResult, decisionAccepted: true, approved, result };
  }

  proposalDigest(lease, proposal) {
    const project = this.projects.get(lease.projectId);
    if (!project || project.rootHash !== lease.rootHash) {
      throw brokerError('BROKER_PROJECT_UNAUTHORIZED', 'The project registration changed during proposal creation.');
    }
    const fileOperations = proposal.files.map((file) => ({
      path: file.path,
      sourcePath: file.sourcePath || null,
      operation: file.operation,
      hash: file.hash,
      content: file.content ?? null,
    }));
    const snapshots = proposal.before.map((snapshot) => ({
      path: snapshot.path,
      exists: snapshot.exists,
      type: snapshot.type,
      hash: snapshot.hash,
    }));
    return digest({
      projectId: lease.projectId,
      rootHash: lease.rootHash,
      proposalId: String(proposal.proposalId || proposal.taskId),
      fileOperations,
      snapshots,
    });
  }

  consumeApprovalGrant(approvalGrant, binding) {
    const grant = this.grants.get(approvalGrant);
    if (!grant || grant.used || grant.expiresAt <= Date.now()
      || grant.brokerSessionId !== binding.brokerSessionId
      || grant.projectId !== binding.projectId
      || grant.proposalId !== binding.proposalId
      || grant.proposalDigest !== binding.proposalDigest) {
      throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'The exact proposal approval grant is invalid, stale, or already used.');
    }
    grant.used = true;
    this.grants.delete(approvalGrant);
    return true;
  }

  async authorizeMutation(lease, request) {
    this.assertActiveLease(lease);
    const approved = lease.approvedProposal;
    if (!approved || approved.taskId !== request?.taskId
      || request?.proposalApproved !== true
      || (request?.deleteConfirmationRequired === true && approved.deleteConfirmed !== true)
      || normalizeRoot(request?.requestBinding?.root || '') !== normalizeRoot(lease.root)
      || approved.scope !== (request?.requestBinding?.scope || '.')) {
      throw brokerError('BROKER_APPROVAL_REQUIRED', 'File mutation requires a verified broker approval grant.');
    }
    const currentTask = this.getTaskDelegate(request.taskId, {
      sessionId: lease.brokerSessionId,
      ownerWebContentsId: lease.ownerWebContentsId,
    });
    const taskApproval = currentTask?.approval;
    if (!currentTask
      || currentTask.taskId !== approved.taskId
      || currentTask.proposalId !== approved.proposalId
      || !taskApproval
      || taskApproval.proposalId !== approved.proposalId
      || taskApproval.manifestHash !== currentTask.manifestHash
      || !Number.isFinite(Date.parse(taskApproval.expiresAt))
      || Date.parse(taskApproval.expiresAt) <= Date.now()
      || currentTask.state !== 'applying'
      || !Number.isFinite(Date.parse(taskApproval.consumedAt))
      || this.proposalDigest(lease, currentTask) !== approved.proposalDigest) {
      throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'The approved proposal changed before file application.');
    }
    if (!approved.snapshotsRevalidated) {
      try {
        await this.validateSnapshotsDelegate(request.taskId, {
          sessionId: lease.brokerSessionId,
          ownerWebContentsId: lease.ownerWebContentsId,
        });
      } catch (error) {
        if (error?.code === 'STALE_PROPOSAL_DRIFT') {
          throw brokerError('STALE_PROPOSAL_DRIFT', 'Project files changed after the proposal was approved.', 409);
        }
        throw error;
      }
      approved.snapshotsRevalidated = true;
    }
    const targets = Array.isArray(request?.paths) ? request.paths : [];
    if (targets.length === 0) {
      throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'Mutation request has no approved target paths.');
    }
    const { validateSafePath } = require('./modularArchitectureEngine.cjs');
    for (const target of targets) {
      let safeTarget;
      try {
        safeTarget = validateSafePath(lease.root, target);
      } catch {
        throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'Mutation target escapes the approved project scope.');
      }
      if (!approved.paths.includes(safeTarget)) {
        throw brokerError('BROKER_APPROVAL_DIGEST_MISMATCH', 'Mutation target differs from the approved proposal.');
      }
    }
    const policyDecision = await this.authorizeMutationDelegate({
      request,
      approvedProposal: approved,
      projectRoot: lease.root,
      sessionId: lease.brokerSessionId,
      ownerWebContentsId: lease.ownerWebContentsId,
    });
    if (policyDecision?.allowed !== true) {
      throw brokerError(
        'BROKER_MUTATION_DENIED',
        typeof policyDecision?.reason === 'string' ? policyDecision.reason : 'The project mutation policy denied this apply.',
        403,
      );
    }
    return { allowed: true };
  }

  async cancelWorkflow({ brokerSessionId, sessionLeaseToken, origin }) {
    const lease = this.assertLease(brokerSessionId, sessionLeaseToken, origin);
    if (lease.workflowState === 'finished') return { cancellationAccepted: false, workflowActive: false };
    lease.cancelled = true;
    lease.workflowState = 'cancelled';
    if (lease.pendingApproval) {
      const pending = lease.pendingApproval;
      lease.pendingApproval = null;
      pending.resolve(false);
      this.grants.delete(pending.grantId);
    }
    return { cancellationAccepted: true, workflowActive: Boolean(lease.workflowRequestId) };
  }

  validateScope(scope) {
    if (typeof scope !== 'string' || !scope.trim()) {
      throw brokerError('BROKER_INVALID_SCOPE', 'Proposal scope must be a relative workspace path.', 400);
    }
    const normalized = scope.replace(/\\/g, '/').trim();
    if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw brokerError('BROKER_INVALID_SCOPE', 'Proposal scope must remain inside the registered workspace.', 400);
    }
    return normalized || '.';
  }

  assertOrigin(origin) {
    let normalized;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw brokerError('BROKER_ORIGIN_UNAUTHORIZED', 'A configured browser renderer origin is required.', 403);
    }
    if (!this.allowedOrigins.has(normalized)) {
      throw brokerError('BROKER_ORIGIN_UNAUTHORIZED', 'Browser origin is not authorized for the trusted desktop broker.', 403);
    }
    return normalized;
  }

  assertLease(brokerSessionId, sessionLeaseToken, origin) {
    this.assertOrigin(origin);
    const lease = this.leases.get(brokerSessionId);
    const suppliedToken = Buffer.from(String(sessionLeaseToken || ''));
    const expectedToken = lease ? Buffer.from(lease.leaseToken) : Buffer.alloc(suppliedToken.length);
    if (!lease || !lease.active || lease.expiresAt <= Date.now()
      || expectedToken.length !== suppliedToken.length
      || !crypto.timingSafeEqual(expectedToken, suppliedToken)
      || lease.origin !== new URL(origin).origin) {
      throw brokerError('BROKER_SESSION_UNAUTHORIZED', 'The broker session lease is invalid or expired.');
    }
    this.assertActiveLease(lease);
    return lease;
  }

  renewLease(lease) {
    lease.expiresAt = Date.now() + this.sessionTtlMs;
    if (lease.expirationTimer) clearTimeout(lease.expirationTimer);
    lease.expirationTimer = setTimeout(() => {
      lease.cancelled = true;
      void this.releaseLease(lease);
    }, this.sessionTtlMs);
    lease.expirationTimer.unref?.();
    for (const grant of this.grants.values()) {
      if (grant.brokerSessionId === lease.brokerSessionId && !grant.used) {
        grant.expiresAt = lease.expiresAt;
      }
    }
  }

  assertActiveLease(lease) {
    if (!this.isLeaseCurrent(lease)) {
      throw brokerError('BROKER_SESSION_UNAUTHORIZED', 'The broker session lease or project registration is no longer valid.');
    }
    this.renewLease(lease);
  }

  isLeaseCurrent(lease) {
    const project = this.projects.get(lease.projectId);
    return lease.active
      && !lease.cancelled
      && lease.expiresAt > Date.now()
      && project?.rootHash === lease.rootHash
      && normalizeRoot(project.root) === normalizeRoot(lease.root);
  }

  async releaseLease(lease) {
    if (!lease.active) return;
    lease.active = false;
    if (lease.expirationTimer) clearTimeout(lease.expirationTimer);
    this.leases.delete(lease.brokerSessionId);
    if (lease.pendingApproval) {
      const pending = lease.pendingApproval;
      lease.pendingApproval = null;
      pending.resolve(false);
    }
    for (const [grantId, grant] of this.grants) {
      if (grant.brokerSessionId === lease.brokerSessionId) this.grants.delete(grantId);
    }
    await this.onLeaseReleased({
      root: lease.root,
      ownerWebContentsId: lease.ownerWebContentsId,
      sessionId: lease.brokerSessionId,
    });
  }

  async handleRequest(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    try {
      if (request.method === 'OPTIONS') {
        this.assertOrigin(origin);
        response.setHeader('Access-Control-Allow-Origin', new URL(origin).origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.writeHead(204).end();
        return;
      }
      this.assertOrigin(origin);
      response.setHeader('Access-Control-Allow-Origin', new URL(origin).origin);
      response.setHeader('Vary', 'Origin');
      const url = new URL(request.url, this.endpoint);
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        this.sendJson(response, 200, { ready: Boolean(this.server?.listening) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/synchronize') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, []);
        await this.synchronizeProjectsDelegate();
        this.sendJson(response, 200, { synchronized: true, projects: this.registeredProjects() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/sessions') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, ['projectId']);
        const lease = await this.issueLease({ projectId: body.projectId, origin });
        this.sendJson(response, 201, lease);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/sessions/heartbeat') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, ['brokerSessionId', 'sessionLeaseToken']);
        this.sendJson(response, 200, this.heartbeat({ ...body, origin }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workflows') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, [
          'brokerSessionId',
          'sessionLeaseToken',
          'userRequest',
          'scope',
          'executionMode',
        ]);
        const result = await this.executeWorkflow({ ...body, origin });
        this.sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workflows/cancel') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, ['brokerSessionId', 'sessionLeaseToken']);
        this.sendJson(response, 200, await this.cancelWorkflow({ ...body, origin }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workflows/approval') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, ['brokerSessionId', 'sessionLeaseToken']);
        this.sendJson(response, 200, this.getPendingApproval({ ...body, origin }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/workflows/approval/decision') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, [
          'brokerSessionId',
          'sessionLeaseToken',
          'proposalId',
          'proposalDigest',
          'approvalNonce',
          'approved',
          'deleteConfirmed',
        ]);
        this.sendJson(response, 200, await this.decideBrowserApproval({ ...body, origin }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/sessions/release') {
        const body = await this.readJson(request);
        this.assertAllowedKeys(body, ['brokerSessionId', 'sessionLeaseToken']);
        this.sendJson(response, 200, await this.releaseSession({ ...body, origin }));
        return;
      }
      this.sendJson(response, 404, {
        error: {
          code: 'BROKER_ROUTE_NOT_FOUND',
          message: `No trusted broker handler is registered for ${request.method} ${url.pathname}.`,
          stage: url.pathname,
        },
      });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      const stage = typeof request.url === 'string' ? request.url.split('?')[0].slice(0, 120) : 'unknown';
      const diagnosticId = crypto.randomUUID();
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = rawMessage
        .replace(/(authorization|token|secret|credential)(\s*[:=]\s*)\S+/ig, '$1$2[redacted]')
        .slice(0, 1000);
      if (status >= 500) {
        console.error('[CODING][BROKER] Request failed', {
          diagnosticId,
          stage,
          code: error?.code || 'BROKER_INTERNAL_ERROR',
          message,
          stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined,
        });
      }
      this.sendJson(response, status, {
        error: {
          code: error?.code || 'BROKER_INTERNAL_ERROR',
          message,
          stage,
          diagnosticId,
        },
      });
    }
  }

  assertAllowedKeys(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !allowed.includes(key))) {
      throw brokerError('BROKER_INVALID_REQUEST', 'Request includes unsupported or client-controlled authority fields.', 400);
    }
  }

  async readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        throw brokerError('BROKER_REQUEST_TOO_LARGE', 'Broker request exceeds the configured size limit.', 413);
      }
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object.');
      return value;
    } catch {
      throw brokerError('BROKER_INVALID_REQUEST', 'Broker request must be a JSON object.', 400);
    }
  }

  sendJson(response, status, value) {
    if (response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
}

module.exports = {
  TrustedLocalDesktopBroker,
  hashProjectRoot,
  canonicalJson,
  digest,
  DEFAULT_SESSION_TTL_MS,
};
