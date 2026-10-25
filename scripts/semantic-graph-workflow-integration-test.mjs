import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  createSemanticProjectGraph,
} from '../electron/coding-pipeline/projectGraphModel.cjs';
import {
  VerificationOrchestrator,
} from '../electron/coding-pipeline/verificationOrchestrator.cjs';
import {
  createRepairPlan,
  executeRepairCycle,
  REPAIR_PLAN_STATUSES,
} from '../electron/coding-pipeline/repairPlanner.cjs';
import {
  createWorkflowCoordinator,
  WORKFLOW_STATES,
} from '../electron/coding-pipeline/workflowStateCoordinator.cjs';
import {
  auditWorkflowCompletion,
  AUDITOR_OUTCOMES,
} from '../electron/coding-pipeline/completionAuditor.cjs';
import developerFiles from '../electron/developerFiles.cjs';

console.log('Starting Semantic Graph Workflow Integration & Evidence Verification tests (V12)...');

const orchestrator = new VerificationOrchestrator();

// 1. A change to a leaf module identifies its direct importers
console.log('Testing leaf module change identifies direct importers...');
{
  const projectRoot = 'C:/mock/project1';
  const fileContents = new Map([
    ['src/leaf.ts', 'export const leafValue = 42;'],
    ['src/consumer.ts', "import { leafValue } from './leaf';\nexport function useLeaf() { return leafValue; }"],
    ['src/unrelated.ts', 'export const unrelated = true;'],
  ]);

  const graph = createSemanticProjectGraph(projectRoot);
  graph.buildFromWorkspace(fileContents);

  const impact = graph.detectAffectedFilesDetailed(['src/leaf.ts']);
  assert.strictEqual(impact.status, 'VERIFIED');
  assert.strictEqual(impact.totalTargets, 2);

  const leafTarget = impact.targets.find((t) => t.file === 'src/leaf.ts');
  assert.strictEqual(leafTarget.relationshipType, 'DIRECTLY_MODIFIED');
  assert.strictEqual(leafTarget.severity, 'HIGH');

  const consumerTarget = impact.targets.find((t) => t.file === 'src/consumer.ts');
  assert.strictEqual(consumerTarget.relationshipType, 'DIRECT_IMPORTER');
  assert.strictEqual(consumerTarget.reason, 'DIRECT_IMPORTER_OF: src/leaf.ts');
  assert.strictEqual(consumerTarget.severity, 'HIGH');
  assert.ok(consumerTarget.edgeProvenance.length > 0);
  assert.strictEqual(consumerTarget.edgeProvenance[0].specifier, './leaf');

  assert.ok(!impact.targets.some((t) => t.file === 'src/unrelated.ts'));
}

// 2. A transitive dependent is identified without being mislabeled as a direct importer
console.log('Testing transitive dependent distinction from direct importer...');
{
  const projectRoot = 'C:/mock/project2';
  const fileContents = new Map([
    ['src/core.ts', 'export class Model {}'],
    ['src/service.ts', "import { Model } from './core';\nexport class Service { model = new Model(); }"],
    ['src/controller.ts', "import { Service } from './service';\nexport class Controller { svc = new Service(); }"],
  ]);

  const graph = createSemanticProjectGraph(projectRoot);
  graph.buildFromWorkspace(fileContents);

  const impact = graph.detectAffectedFilesDetailed(['src/core.ts']);
  assert.strictEqual(impact.totalTargets, 3);

  const direct = impact.targets.find((t) => t.file === 'src/service.ts');
  assert.strictEqual(direct.relationshipType, 'DIRECT_IMPORTER');
  assert.strictEqual(direct.severity, 'HIGH');

  const transitive = impact.targets.find((t) => t.file === 'src/controller.ts');
  assert.strictEqual(transitive.relationshipType, 'TRANSITIVE_DEPENDENT');
  assert.strictEqual(transitive.reason, 'TRANSITIVE_DEPENDENT_OF: src/core.ts');
  assert.strictEqual(transitive.severity, 'MEDIUM');
  assert.deepStrictEqual(transitive.edgeProvenance, []);

  // Detailed relationship explanation
  const explanation = graph.explainRelationship('src/controller.ts', 'src/core.ts');
  assert.strictEqual(explanation.relationship, 'TRANSITIVE_DEPENDENT');
  assert.strictEqual(explanation.isDirect, false);
  assert.deepStrictEqual(explanation.path, ['src/controller.ts', 'src/service.ts', 'src/core.ts']);
}

// 3. A missing or unresolved import remains unresolved throughout investigation
console.log('Testing missing or unresolved import preservation...');
{
  const projectRoot = 'C:/mock/project3';
  const fileContents = new Map([
    ['src/broken.ts', "import { missing } from './nonexistent';\nexport const x = missing;"],
  ]);

  const graph = createSemanticProjectGraph(projectRoot);
  graph.buildFromWorkspace(fileContents);

  const impact = graph.detectAffectedFilesDetailed(['src/broken.ts']);
  assert.strictEqual(impact.status, 'DEGRADED_UNRESOLVED');
  assert.strictEqual(impact.unresolvedDependencies.length, 1);
  assert.strictEqual(impact.unresolvedDependencies[0].from, 'src/broken.ts');
  assert.strictEqual(impact.unresolvedDependencies[0].specifier, './nonexistent');
  assert.strictEqual(impact.unresolvedDependencies[0].status, 'UNRESOLVED_NOT_FOUND');
  assert.strictEqual(graph.edges.length, 0); // Must NOT convert to fabricated edge
}

// 4. File deletion and modification do not leave stale regression targets
console.log('Testing file deletion and modification graph synchronization...');
{
  const projectRoot = 'C:/mock/project4';
  const fileContents = new Map([
    ['src/dep.ts', 'export const a = 1;'],
    ['src/app.ts', "import { a } from './dep';"],
  ]);

  const graph = createSemanticProjectGraph(projectRoot);
  graph.buildFromWorkspace(fileContents);

  let initialRegression = orchestrator.detectRegressionTargetsDetailed({
    modifiedFiles: ['src/dep.ts'],
    dependencyGraph: { semanticGraph: graph },
  });
  assert.strictEqual(initialRegression.totalTargets, 2);

  // Modify src/app.ts to remove import of dep
  fileContents.set('src/app.ts', 'export const standalone = 2;');
  graph.invalidateFiles({
    modified: ['src/app.ts'],
    fileContents,
  });

  const updatedRegression = orchestrator.detectRegressionTargetsDetailed({
    modifiedFiles: ['src/dep.ts'],
    dependencyGraph: { semanticGraph: graph },
  });
  assert.strictEqual(updatedRegression.totalTargets, 1);
  assert.strictEqual(updatedRegression.targets[0].file, 'src/dep.ts');
  assert.ok(!updatedRegression.targets.some((t) => t.file === 'src/app.ts'));
}

// 5. A repair proposal changing multiple files triggers impact analysis for all changed files
console.log('Testing multi-file repair proposal impact analysis...');
{
  const projectRoot = 'C:/mock/project5';
  const fileContents = new Map([
    ['src/schema.ts', 'export const Schema = {};'],
    ['src/model.ts', 'export const Model = {};'],
    ['src/schemaConsumer.ts', "import { Schema } from './schema';"],
    ['src/modelConsumer.ts', "import { Model } from './model';"],
  ]);

  const graph = createSemanticProjectGraph(projectRoot);
  graph.buildFromWorkspace(fileContents);

  const multiTargets = orchestrator.detectRegressionTargetsDetailed({
    modifiedFiles: ['src/schema.ts', 'src/model.ts'],
    dependencyGraph: { semanticGraph: graph },
  });

  assert.strictEqual(multiTargets.totalTargets, 4);
  const targetFiles = multiTargets.targets.map((t) => t.file);
  assert.ok(targetFiles.includes('src/schema.ts'));
  assert.ok(targetFiles.includes('src/model.ts'));
  assert.ok(targetFiles.includes('src/schemaConsumer.ts'));
  assert.ok(targetFiles.includes('src/modelConsumer.ts'));
}

// 6. An incomplete or unavailable graph produces an honest degraded or blocked result
console.log('Testing incomplete or unavailable graph reporting...');
{
  // Null or missing graph
  const unavailResult = orchestrator.detectRegressionTargetsDetailed({
    modifiedFiles: ['src/unknown.ts'],
    dependencyGraph: null,
  });
  assert.strictEqual(unavailResult.status, 'GRAPH_UNAVAILABLE');
  assert.strictEqual(unavailResult.totalTargets, 0);

  // Graph with unresolved dependencies
  const brokenGraph = createSemanticProjectGraph('C:/mock/project6');
  brokenGraph.buildFromWorkspace(new Map([
    ['src/faulty.ts', "import { foo } from './missingModule';"],
  ]));

  const degradedResult = orchestrator.detectRegressionTargetsDetailed({
    modifiedFiles: ['src/faulty.ts'],
    dependencyGraph: { semanticGraph: brokenGraph },
  });
  assert.strictEqual(degradedResult.status, 'DEGRADED_UNRESOLVED');
  assert.strictEqual(degradedResult.unresolvedDependencies.length, 1);
}

// 7. An unrelated file is not selected without supporting evidence
console.log('Testing unrelated files are rejected from impact selection...');
{
  const projectRoot = 'C:/mock/project7';
  const fileContents = new Map([
    ['src/featureA.ts', 'export const a = 10;'],
    ['src/featureB.ts', 'export const b = 20;'],
    ['src/featureC.ts', 'export const c = 30;'],
  ]);

  const graph = createSemanticProjectGraph(projectRoot);
  graph.buildFromWorkspace(fileContents);

  const impactA = graph.detectAffectedFiles(['src/featureA.ts']);
  assert.strictEqual(impactA.length, 1);
  assert.strictEqual(impactA[0].file, 'src/featureA.ts');
  assert.ok(!impactA.some((t) => t.file === 'src/featureB.ts'));
  assert.ok(!impactA.some((t) => t.file === 'src/featureC.ts'));
}

// 8. Graph results retain provenance through regression-target selection and audit
console.log('Testing provenance retention through workflow coordinator & auditor...');
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v12-audit-test-'));
  developerFiles.attachProject(tmpDir, 1);
  try {
    const fileContents = new Map([
      ['src/shared.ts', 'export const v = 1;'],
      ['src/main.ts', "import { v } from './shared';\nconsole.log(v);"],
    ]);

    const graph = createSemanticProjectGraph(tmpDir);
    graph.buildFromWorkspace(fileContents);

    const detailedTargets = orchestrator.detectRegressionTargetsDetailed({
      modifiedFiles: ['src/shared.ts'],
      dependencyGraph: { semanticGraph: graph },
    });

    assert.ok(detailedTargets.provenance);
    assert.strictEqual(detailedTargets.provenance.source, 'SEMANTIC_PROJECT_GRAPH');

    // Create workflow coordinator
    const coordinator = createWorkflowCoordinator({
      workflowId: 'task-v12-prov',
      originalRequest: 'Fix shared module value',
      projectIdentity: { projectRoot: tmpDir },
    });

    coordinator.transitionTo(WORKFLOW_STATES.INTENT_CLASSIFIED);
    coordinator.transitionTo(WORKFLOW_STATES.PROJECT_AUTHORIZED);
    coordinator.transitionTo(WORKFLOW_STATES.DISCOVERY_COMPLETED);
    coordinator.transitionTo(WORKFLOW_STATES.PLAN_CREATED);

    coordinator.recordAppliedPatch({
      targetFile: 'src/shared.ts',
      files: ['src/shared.ts'],
      regressionTargets: detailedTargets.targets,
    });

    coordinator.transitionTo(WORKFLOW_STATES.APPROVAL_PENDING);
    coordinator.transitionTo(WORKFLOW_STATES.APPROVED, { approvedBy: 'user', grantId: 'grant-v12' });
    coordinator.transitionTo(WORKFLOW_STATES.APPLYING);
    coordinator.transitionTo(WORKFLOW_STATES.VERIFYING);
    coordinator.transitionTo(WORKFLOW_STATES.COMPLETED);

    const audit = auditWorkflowCompletion({
      coordinator,
      originalRequest: 'Fix shared module value',
    });

    assert.ok(audit);
    assert.strictEqual(audit.whatChanged.includes('src/shared.ts'), true);
    assert.strictEqual(audit.auditFlags.length, 0); // No synthetic/simulated flags
  } finally {
    developerFiles.releaseProject(1);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 9. Cancellation or failure does not report a successful completed workflow
console.log('Testing cancellation and failure states truthfully audited...');
{
  const coordinator = createWorkflowCoordinator({
    workflowId: 'task-v12-cancel',
    originalRequest: 'Refactor core modules',
    projectIdentity: { projectRoot: 'C:/mock/project-cancel' },
  });

  coordinator.transitionTo(WORKFLOW_STATES.CANCELLED, { reason: 'User cancelled operation' });

  const auditReport = auditWorkflowCompletion({
    coordinator,
    originalRequest: 'Refactor core modules',
  });

  assert.strictEqual(auditReport.outcome, AUDITOR_OUTCOMES.BLOCKED);
  assert.ok((auditReport.summary || '').includes('cancelled by user'));
}

// 10. Approval and isolation gates cannot be bypassed through graph output or test fixtures
console.log('Testing approval and isolation boundaries cannot be bypassed...');
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v12-gate-test-'));
  const targetFile = path.join(tmpDir, 'target.ts');
  await fs.writeFile(targetFile, 'const x = 1;', 'utf8');

  developerFiles.attachProject(tmpDir, 1);
  try {
    const fileContents = new Map([['target.ts', 'const x = 1;']]);
    const graph = createSemanticProjectGraph(tmpDir);
    graph.buildFromWorkspace(fileContents);

    const diagnosis = {
      diagnosisId: 'diag-v12-gate',
      status: 'CONFIRMED',
      failureCategory: 'SYNTAX_ERROR',
      affectedFiles: ['target.ts'],
      primaryLocation: { file: 'target.ts', line: 1 },
      evidence: { summary: 'Syntax error' },
    };

    const repairPlan = await createRepairPlan({
      projectRoot: tmpDir,
      diagnosis,
      sourceReader: async (f) => fs.readFile(path.resolve(tmpDir, f), 'utf8'),
      projectGraph: graph,
      customPatchGenerator: () => ({ replacementContent: 'const x = 2;' }),
    });

    assert.strictEqual(repairPlan.status, REPAIR_PLAN_STATUSES.READY);
    assert.ok(repairPlan.impactAnalysis);
    assert.strictEqual(repairPlan.impactAnalysis.status, 'VERIFIED');

    // Attempt executeRepairCycle with unapproved digest -> MUST be rejected
    const unapprovedRes = await executeRepairCycle({
      projectRoot: tmpDir,
      ownerWebContentsId: 1,
      repairPlan,
      approve: () => ({ approved: true, approvedPlanDigest: 'unapproved-tampered-digest' }),
    });

    assert.strictEqual(unapprovedRes.ok, false);
    assert.strictEqual(unapprovedRes.outcome, 'APPROVAL_DIGEST_MISMATCH');
    assert.strictEqual(unapprovedRes.codeApplied, false);

    // Attempt executeRepairCycle with approved digest -> Must halt fail-closed at process-isolation gate on Windows
    const approvedRes = await executeRepairCycle({
      projectRoot: tmpDir,
      ownerWebContentsId: 1,
      repairPlan,
      approve: () => ({ approved: true, approvedPlanDigest: repairPlan.planDigest }),
      projectGraph: graph,
    });

    if (process.platform === 'win32') {
      assert.strictEqual(approvedRes.ok, false);
      assert.strictEqual(approvedRes.outcome, 'BLOCKED');
      assert.strictEqual(approvedRes.gate, 'PROCESS_ISOLATION_GATE');
      assert.ok(approvedRes.reason.includes('process isolation is required'));
    }
  } finally {
    developerFiles.releaseProject(1);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 11. Rejected approval stops mutation completely
console.log('Testing rejected approval path...');
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v12-reject-test-'));
  const targetFile = path.join(tmpDir, 'target.ts');
  await fs.writeFile(targetFile, 'const original = true;', 'utf8');
  developerFiles.attachProject(tmpDir, 1);
  try {
    const diagnosis = {
      diagnosisId: 'diag-reject',
      status: 'CONFIRMED',
      failureCategory: 'SYNTAX_ERROR',
      affectedFiles: ['target.ts'],
      primaryLocation: { file: 'target.ts', line: 1 },
      evidence: { summary: 'Syntax error' },
    };

    const repairPlan = await createRepairPlan({
      projectRoot: tmpDir,
      diagnosis,
      sourceReader: async (f) => fs.readFile(path.resolve(tmpDir, f), 'utf8'),
      customPatchGenerator: () => ({ replacementContent: 'const modified = true;' }),
    });

    const rejectRes = await executeRepairCycle({
      projectRoot: tmpDir,
      ownerWebContentsId: 1,
      repairPlan,
      approve: () => ({ approved: false }),
    });

    assert.strictEqual(rejectRes.ok, false);
    assert.strictEqual(rejectRes.outcome, 'APPROVAL_REQUIRED');
    assert.strictEqual(rejectRes.codeApplied, false);
    const contentOnDisk = await fs.readFile(targetFile, 'utf8');
    assert.strictEqual(contentOnDisk, 'const original = true;');
  } finally {
    developerFiles.releaseProject(1);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 12. Stale proposal or source changes after approval (drift detected)
console.log('Testing drift detection when file changes between proposal and apply...');
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v12-drift-test-'));
  const targetFile = path.join(tmpDir, 'drift.ts');
  await fs.writeFile(targetFile, 'initial content', 'utf8');
  developerFiles.attachProject(tmpDir, 1);
  try {
    const diagnosis = {
      diagnosisId: 'diag-drift',
      status: 'CONFIRMED',
      failureCategory: 'SYNTAX_ERROR',
      affectedFiles: ['drift.ts'],
      primaryLocation: { file: 'drift.ts', line: 1 },
      evidence: { summary: 'Syntax error' },
    };

    const repairPlan = await createRepairPlan({
      projectRoot: tmpDir,
      diagnosis,
      sourceReader: async (f) => fs.readFile(path.resolve(tmpDir, f), 'utf8'),
      customPatchGenerator: () => ({ replacementContent: 'repaired content' }),
    });

    // Modify file on disk to simulate external edit/drift
    await fs.writeFile(targetFile, 'externally modified content', 'utf8');

    const driftRes = await executeRepairCycle({
      projectRoot: tmpDir,
      ownerWebContentsId: 1,
      repairPlan,
      approve: () => ({ approved: true, approvedPlanDigest: repairPlan.planDigest }),
    });

    assert.strictEqual(driftRes.ok, false);
    assert.strictEqual(driftRes.outcome, 'DRIFT_DETECTED');
    assert.strictEqual(driftRes.codeApplied, false);
  } finally {
    developerFiles.releaseProject(1);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 13. Partial apply failure and snapshot rollback
console.log('Testing atomic rollback on apply failure...');
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v12-rollback-test-'));
  const fileA = path.join(tmpDir, 'fileA.ts');
  const fileB = path.join(tmpDir, 'fileB.ts');
  await fs.writeFile(fileA, 'const a = "original";', 'utf8');
  await fs.writeFile(fileB, 'const b = "original";', 'utf8');
  developerFiles.attachProject(tmpDir, 1);
  try {
    const graph = createSemanticProjectGraph(tmpDir);
    graph.buildFromWorkspace(new Map([['fileA.ts', 'const a = "original";'], ['fileB.ts', 'const b = "original";']]));

    const diagnosis = {
      diagnosisId: 'diag-rollback',
      status: 'CONFIRMED',
      failureCategory: 'SYNTAX_ERROR',
      affectedFiles: ['fileA.ts'],
      primaryLocation: { file: 'fileA.ts', line: 1 },
      evidence: { summary: 'Syntax error' },
    };

    const repairPlan = await createRepairPlan({
      projectRoot: tmpDir,
      diagnosis,
      projectGraph: graph,
      customPatchGenerator: () => ({ replacementContent: 'const a = "mutated";' }),
    });

    // Apply fails because read-back fails or applyPatch throws
    let callCount = 0;
    const rollbackRes = await executeRepairCycle({
      projectRoot: tmpDir,
      ownerWebContentsId: 1,
      repairPlan,
      projectGraph: graph,
      approve: () => ({ approved: true, approvedPlanDigest: repairPlan.planDigest }),
      applyPatch: async () => {
        callCount++;
        throw new Error('Simulated disk write failure during patch apply');
      },
    });

    assert.strictEqual(rollbackRes.ok, false);
    assert.strictEqual(rollbackRes.outcome, 'APPLY_FAILED');
    assert.strictEqual(rollbackRes.codeApplied, false);
    assert.strictEqual(rollbackRes.rolledBack, true);
    // Ensure file on disk is preserved at original content
    const diskA = await fs.readFile(fileA, 'utf8');
    assert.strictEqual(diskA, 'const a = "original";');
  } finally {
    developerFiles.releaseProject(1);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 14. Missing or degraded graph propagation into completion audit
console.log('Testing missing and degraded graph impact propagation in auditor...');
{
  const coordinator = createWorkflowCoordinator({
    workflowId: 'task-audit-degraded',
    originalRequest: 'Fix bug with degraded graph',
    projectIdentity: { projectRoot: 'C:/mock/project-audit' },
  });

  coordinator.transitionTo(WORKFLOW_STATES.INTENT_CLASSIFIED);
  coordinator.transitionTo(WORKFLOW_STATES.PROJECT_AUTHORIZED);
  coordinator.transitionTo(WORKFLOW_STATES.DISCOVERY_COMPLETED);
  coordinator.transitionTo(WORKFLOW_STATES.PLAN_CREATED);
  coordinator.transitionTo(WORKFLOW_STATES.APPROVAL_PENDING);
  coordinator.transitionTo(WORKFLOW_STATES.APPROVED, { approvedBy: 'user', grantId: 'grant-audit' });
  coordinator.transitionTo(WORKFLOW_STATES.APPLYING);
  coordinator.transitionTo(WORKFLOW_STATES.VERIFYING);
  coordinator.transitionTo(WORKFLOW_STATES.COMPLETED);

  const degradedAudit = auditWorkflowCompletion({
    coordinator,
    originalRequest: 'Fix bug with degraded graph',
    finalResult: {
      repairPlan: {
        impactAnalysis: { status: 'DEGRADED_UNRESOLVED', targets: [] },
      },
      regressionTargets: ['src/dep.ts'],
    },
  });

  assert.strictEqual(degradedAudit.regressionTargets.includes('src/dep.ts'), true);
  assert.ok(degradedAudit.auditFlags.some((f) => f.includes('degraded graph')));
}

// 15. Incomplete test execution / blocked isolation prevents full success
console.log('Testing blocked isolation cannot report full verification success...');
{
  const coordinator = createWorkflowCoordinator({
    workflowId: 'task-audit-blocked-isolation',
    originalRequest: 'Run test suite',
    projectIdentity: { projectRoot: 'C:/mock/project-blocked' },
  });

  coordinator.transitionTo(WORKFLOW_STATES.INTENT_CLASSIFIED);
  coordinator.transitionTo(WORKFLOW_STATES.PROJECT_AUTHORIZED);
  coordinator.transitionTo(WORKFLOW_STATES.DISCOVERY_COMPLETED);
  coordinator.transitionTo(WORKFLOW_STATES.BLOCKED, {
    reason: 'Windows project-context process execution is disabled pending an independently reviewed isolation mechanism.',
    evidence: {
      status: 'BLOCKED',
      gate: 'PROCESS_ISOLATION_GATE',
      reason: 'Windows project-context process execution is disabled pending an independently reviewed isolation mechanism.',
    },
  });

  const blockedAudit = auditWorkflowCompletion({
    coordinator,
    originalRequest: 'Run test suite',
  });

  assert.strictEqual(blockedAudit.outcome, AUDITOR_OUTCOMES.BLOCKED);
  assert.ok(blockedAudit.checksBlocked.length > 0);
  assert.strictEqual(blockedAudit.checksBlocked[0].gate, 'PROCESS_ISOLATION_GATE');
  assert.notStrictEqual(blockedAudit.outcome, AUDITOR_OUTCOMES.FULL_VERIFIED_SUCCESS);
}

console.log('All Semantic Graph Workflow Integration & Evidence Verification regression tests passed successfully!');
