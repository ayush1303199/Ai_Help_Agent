const crypto = require('node:crypto');
const path = require('node:path');

const ISSUED_EVIDENCE = new WeakMap();
const VERIFIED_RESULTS = new WeakSet();
const MAX_EVIDENCE_AGE_MS = 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(normalized)
    || path.posix.isAbsolute(normalized)
    || normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    return null;
  }
  return normalized.replace(/^\.\//, '');
}

function normalizeVerificationCriteria(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const ids = new Set();
  const criteria = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate.id)
      || ids.has(candidate.id)
      || candidate.type !== 'FILE_SHA256'
      || !normalizeRelativePath(candidate.path)
      || typeof candidate.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(candidate.sha256)) {
      return null;
    }
    ids.add(candidate.id);
    criteria.push({
      id: candidate.id,
      type: candidate.type,
      path: normalizeRelativePath(candidate.path),
      sha256: candidate.sha256.toLowerCase(),
    });
  }
  return criteria;
}

function planBindings(plan) {
  if (!plan || typeof plan !== 'object' || plan.schemaVersion !== 2
    || !Array.isArray(plan.workItems) || plan.workItems.length < 1) return null;
  const workItems = [];
  const positions = new Map();
  for (const item of plan.workItems) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string'
      || !/^WI-\d{3}$/.test(item.id)
      || typeof item.objective !== 'string' || !item.objective.trim()
      || !Array.isArray(item.dependsOn)
      || !item.dependsOn.every((dependencyId) => typeof dependencyId === 'string')
      || !Array.isArray(item.requiredEvidence)
      || !item.requiredEvidence.every((requirement) => typeof requirement === 'string' && requirement.trim())) return null;
    const verificationCriteria = item.verificationCriteria === undefined
      ? null
      : normalizeVerificationCriteria(item.verificationCriteria);
    if (item.verificationCriteria !== undefined && !verificationCriteria) return null;
    workItems.push({
      id: item.id,
      objective: item.objective.trim(),
      status: item.status,
      dependsOn: [...item.dependsOn],
      requiredEvidence: [...item.requiredEvidence],
      verificationCriteria,
    });
    if (positions.has(item.id)) return null;
    positions.set(item.id, workItems.length - 1);
  }
  for (const [index, item] of workItems.entries()) {
    if (item.dependsOn.some((dependencyId) => {
      const dependencyPosition = positions.get(dependencyId);
      return dependencyPosition === undefined || dependencyPosition >= index;
    })) return null;
  }
  return {
    planDigest: digest({
      schemaVersion: 2,
      goal: String(plan.goal || ''),
      workItems: workItems.map(({ id, objective, dependsOn, requiredEvidence, verificationCriteria }) => ({
        id,
        objective,
        dependsOn,
        requiredEvidence,
        verificationCriteria,
      })),
    }),
    workItems,
  };
}

function getWorkItemPlanDigest(plan) {
  return planBindings(plan)?.planDigest || null;
}

function itemDigest(item) {
  return digest({
    id: item.id,
    objective: item.objective.trim(),
    dependsOn: [...item.dependsOn],
    requiredEvidence: [...item.requiredEvidence],
    verificationCriteria: normalizeVerificationCriteria(item.verificationCriteria),
  });
}

function projectDigest(context) {
  const root = path.resolve(context.projectRoot);
  const canonicalRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  return digest({ sessionId: context.sessionId, canonicalRoot });
}

function issueHostFileObservation({ plan, item, context, criterion, observed }) {
  const bindings = planBindings(plan);
  const criteria = normalizeVerificationCriteria(item?.verificationCriteria);
  const selected = criteria?.find((entry) => entry.id === criterion?.id);
  const relativePath = normalizeRelativePath(observed?.path);
  if (!bindings || !selected || selected.type !== 'FILE_SHA256'
    || !context || typeof context.sessionId !== 'string' || !context.sessionId
    || typeof context.projectRoot !== 'string' || !context.projectRoot
    || typeof context.proposalId !== 'string' || !context.proposalId
    || typeof context.scope !== 'string' || !context.scope
    || typeof context.attemptId !== 'string' || !context.attemptId
    || relativePath !== selected.path
    || typeof observed?.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(observed.sha256)) {
    return null;
  }
  const evidence = Object.freeze({
    kind: 'HOST_FILE_STATE',
    criterionId: selected.id,
    observedAt: new Date().toISOString(),
  });
  ISSUED_EVIDENCE.set(evidence, Object.freeze({
    criterionId: selected.id,
    planDigest: bindings.planDigest,
    itemId: item.id,
    itemDigest: itemDigest(item),
    objectiveDigest: digest(item.objective.trim()),
    projectDigest: projectDigest(context),
    proposalId: context.proposalId,
    scope: context.scope,
    attemptId: context.attemptId,
    path: relativePath,
    sha256: observed.sha256.toLowerCase(),
    exists: observed.exists === true,
    observedAt: evidence.observedAt,
  }));
  return evidence;
}

function verifyWorkItemEvidence({
  plan,
  itemId,
  context,
  evidence = [],
  verificationPassed = false,
  rolledBack = false,
} = {}) {
  const result = (status, reason, criteriaChecked = [], criteriaUnverified = []) => {
    const value = {
      status,
      reason,
      itemId: typeof itemId === 'string' ? itemId : null,
      criteriaChecked,
      criteriaUnverified,
    };
    if (status === 'SATISFIED') {
      const bindings = planBindings(plan);
      const item = bindings?.workItems.find((candidate) => candidate.id === itemId);
      value.planDigest = bindings?.planDigest;
      value.itemDigest = item ? itemDigest(item) : null;
      VERIFIED_RESULTS.add(value);
    }
    return Object.freeze(value);
  };

  try {
    const bindings = planBindings(plan);
    const item = bindings?.workItems.find((candidate) => candidate.id === itemId);
    if (!bindings || !item || !context || typeof context !== 'object'
      || typeof context.sessionId !== 'string' || !context.sessionId
      || typeof context.projectRoot !== 'string' || !context.projectRoot
      || typeof context.proposalId !== 'string' || !context.proposalId
      || typeof context.scope !== 'string' || !context.scope
      || typeof context.attemptId !== 'string' || !context.attemptId
      || !Array.isArray(evidence)) {
      return result('INVALID_EVIDENCE', 'Plan, item, context, or evidence structure is invalid.');
    }
    const criteria = item.verificationCriteria || [];
    const unverifiedCriteria = criteria.length ? criteria.map((entry) => entry.id) : [item.objective];
    if (rolledBack) return result('INVALID_EVIDENCE', 'Rollback invalidated observations from this proposal.', [], unverifiedCriteria);
    if (verificationPassed !== true) {
      return result('NOT_SATISFIED', 'The approved proposal did not pass host verification.', [], unverifiedCriteria);
    }
    if (item.dependsOn.some((dependencyId) => (
      bindings.workItems.find((candidate) => candidate.id === dependencyId)?.status !== 'COMPLETED'
    ))) {
      return result('NOT_SATISFIED', 'One or more required work-item dependencies remain unresolved.', [], unverifiedCriteria);
    }

    if (!criteria?.length) {
      return result('INCONCLUSIVE', 'No supported machine-checkable item criteria were supplied.', [], [item.objective]);
    }
    if (item.requiredEvidence.some((requirement) => (
      ['APPROVED_SCOPE_PROPOSAL', 'EXPLICIT_APPROVAL', 'VERIFICATION_PASS', 'PRESERVATION_AUDIT'].includes(requirement)
      && context.completedEvidence?.includes(requirement) !== true
    ))) {
      return result('INCONCLUSIVE', 'Required approval, verification, or preservation evidence is incomplete.', [], criteria.map((entry) => entry.id));
    }

    const evidenceById = new Map();
    for (const candidate of evidence) {
      const payload = candidate && typeof candidate === 'object' ? ISSUED_EVIDENCE.get(candidate) : null;
      if (!payload || evidenceById.has(payload.criterionId)) {
        return result('INVALID_EVIDENCE', 'Evidence is unissued, malformed, or duplicated.');
      }
      if (payload.planDigest !== bindings.planDigest
        || payload.itemId !== item.id
        || payload.itemDigest !== itemDigest(item)
        || payload.objectiveDigest !== digest(item.objective.trim())
        || payload.projectDigest !== projectDigest(context)
        || payload.proposalId !== context.proposalId
        || payload.scope !== context.scope
        || payload.attemptId !== context.attemptId) {
        return result('INVALID_EVIDENCE', 'Evidence is bound to a different plan, item, project, proposal, scope, or attempt.');
      }
      evidenceById.set(payload.criterionId, payload);
    }

    const checked = [];
    const missing = [];
    const expectedProjectDigest = projectDigest(context);
    for (const criterion of criteria) {
      const observation = evidenceById.get(criterion.id);
      if (!observation) {
        missing.push(criterion.id);
        continue;
      }
      if (observation.planDigest !== bindings.planDigest
        || observation.itemId !== item.id
        || observation.itemDigest !== itemDigest(item)
        || observation.objectiveDigest !== digest(item.objective.trim())
        || observation.projectDigest !== expectedProjectDigest
        || observation.proposalId !== context.proposalId
        || observation.scope !== context.scope
        || observation.attemptId !== context.attemptId
        || observation.path !== criterion.path) {
        return result('INVALID_EVIDENCE', `Evidence binding mismatch for criterion ${criterion.id}.`, checked, [criterion.id]);
      }
      const observedAt = Date.parse(observation.observedAt);
      if (!Number.isFinite(observedAt) || observedAt > Date.now()
        || Date.now() - observedAt > MAX_EVIDENCE_AGE_MS) {
        return result('INVALID_EVIDENCE', `Evidence for criterion ${criterion.id} is stale or invalid.`, checked, [criterion.id]);
      }
      if (!observation.exists || observation.sha256 !== criterion.sha256) {
        return result('NOT_SATISFIED', `Host-observed file state did not satisfy criterion ${criterion.id}.`, checked, [criterion.id]);
      }
      checked.push(criterion.id);
    }
    if (missing.length) {
      return result('INCONCLUSIVE', 'One or more item criteria have no host observation.', checked, missing);
    }
    return result('SATISFIED', 'Every supported criterion has fresh, item-bound host evidence.', checked, []);
  } catch {
    return result('INVALID_EVIDENCE', 'Malformed evidence was rejected safely.');
  }
}

function isTrustedWorkItemVerificationResult(value, { plan, item } = {}) {
  if (!value || !VERIFIED_RESULTS.has(value) || value.status !== 'SATISFIED') return false;
  const bindings = planBindings(plan);
  const expectedItem = bindings?.workItems.find((candidate) => candidate.id === item?.id);
  return Boolean(expectedItem
    && value.planDigest === bindings.planDigest
    && value.itemDigest === itemDigest(expectedItem)
    && value.itemId === item.id);
}

module.exports = {
  issueHostFileObservation,
  getWorkItemPlanDigest,
  isTrustedWorkItemVerificationResult,
  normalizeVerificationCriteria,
  verifyWorkItemEvidence,
};
