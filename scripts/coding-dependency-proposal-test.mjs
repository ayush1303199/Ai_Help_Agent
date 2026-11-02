import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  classifyTaskIntent,
  INTENT_CATEGORIES,
} = require('../electron/coding-pipeline/genericIntentClassifier.cjs');
const {
  discoverDependencies,
  createDependencyPlan,
  executeDependencyPlan,
  verifyInstalledDependencies,
  createDependencyProposalContract,
  validateDependencyProposal,
  PACKAGE_MANAGERS,
} = require('../electron/coding-pipeline/dependencyManager.cjs');
const {
  validateProposalContract,
} = require('../electron/coding-pipeline/investigationWorkflowContract.cjs');
const developerAgent = require('../electron/developerAgent.cjs');
const {
  INSTALL_INTENTS,
  classifyInstallIntent,
  checkLanguageConflict,
} = require('../electron/coding-pipeline/genericIntentClassifier.cjs');
const {
  PROPOSAL_MISMATCH_TYPES,
  classifyProposalMismatch,
} = require('../electron/developerAgent.cjs');
const developerFiles = require('../electron/developerFiles.cjs');

test('CODING AGENT V12 — Intent Classification for Dependency Requests', () => {
  const testPhrases = [
    'install node_modules',
    'install dependencies',
    'npm install',
    'pnpm install',
    'yarn install',
    'install the packages',
    'install missing dependencies',
  ];

  for (const phrase of testPhrases) {
    const intent = classifyTaskIntent({ request: phrase });
    assert.equal(
      intent.primaryIntent,
      INTENT_CATEGORIES.UPGRADE_OR_MIGRATE,
      `Request "${phrase}" must be classified as UPGRADE_OR_MIGRATE (got ${intent.primaryIntent})`
    );
  }
});

test('CODING AGENT V12 — Proposal Contract Generation and Validation', async () => {
  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.v12-dep-prop-'));
  try {
    const pkgJson = {
      name: 'v12-test-project',
      version: '1.0.0',
      dependencies: {
        express: '^4.19.2',
        dotenv: '^16.4.5',
      },
    };
    await fs.writeFile(path.join(testRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));

    const report = await discoverDependencies(testRoot);
    assert.equal(report.needsInstallation, true);
    assert.equal(report.missingCount, 2);

    const plan = createDependencyPlan({ projectRoot: testRoot, dependencyReport: report });
    assert.ok(plan.planId);
    assert.ok(plan.planDigest);
    assert.equal(plan.packageManager, 'npm');
    assert.equal(plan.fullCommandString, 'npm install');
    assert.ok(plan.proposalContract);

    // Validate using validateProposalContract
    const validation = validateProposalContract(plan.proposalContract);
    assert.equal(validation.isValid, true, `Proposal must be valid: ${validation.rejectionReason}`);

    // Validate using validateDependencyProposal
    const depValidation = validateDependencyProposal(plan);
    assert.equal(depValidation.isValid, true, `Plan proposal must be valid: ${depValidation.rejectionReason}`);

    // Test rejection of corrupted proposal (missing planDigest)
    const corruptedDigest = { ...plan.proposalContract, planDigest: 'invalid' };
    const rej1 = validateProposalContract(corruptedDigest);
    assert.equal(rej1.isValid, false, 'Proposal with invalid planDigest must be rejected');

    // Test rejection of corrupted proposal (missing packageManager)
    const corruptedPm = { ...plan.proposalContract, packageManager: null };
    const rej2 = validateProposalContract(corruptedPm);
    assert.equal(rej2.isValid, false, 'Proposal without packageManager must be rejected');

    // Test rejection of corrupted proposal (missing command)
    const corruptedCmd = { ...plan.proposalContract, command: '' };
    const rej3 = validateProposalContract(corruptedCmd);
    assert.equal(rej3.isValid, false, 'Proposal without command must be rejected');
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('CODING AGENT V12 — Missing Manifest Handled Cleanly', async () => {
  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.v12-nomani-root-'));
  const tmpDir = path.join(testRoot, 'no-manifest-app');
  await fs.mkdir(tmpDir, { recursive: true });

  const ownerWebContentsId = 12001;
  const sessionId = developerAgent.createSession(ownerWebContentsId);

  const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  try {
    await developerFiles.discoverProjectByName('no-manifest-app', ownerWebContentsId);

    const result = await developerAgent.executeAutonomousCodingWorkflow({
      root: tmpDir,
      userRequest: 'npm install',
      sessionId,
      ownerWebContentsId,
    });

    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(result.phase, 'DEPENDENCY_CHECK');
    assert.equal(result.executionBlocked, true);
    assert.match(result.reason, /No package manifest/i);
  } finally {
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('CODING AGENT V12 — Already Installed Dependencies Do Not Trigger Installation', async () => {
  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.v12-inst-root-'));
  const tmpDir = path.join(testRoot, 'installed-app');
  await fs.mkdir(tmpDir, { recursive: true });

  const ownerWebContentsId = 12002;
  const sessionId = developerAgent.createSession(ownerWebContentsId);

  const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  try {
    const pkgJson = {
      name: 'v12-installed-project',
      version: '1.0.0',
      dependencies: {
        lodash: '^4.17.21',
      },
    };
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    // Simulate installed node_modules/lodash
    const lodashDir = path.join(tmpDir, 'node_modules', 'lodash');
    await fs.mkdir(lodashDir, { recursive: true });
    await fs.writeFile(
      path.join(lodashDir, 'package.json'),
      JSON.stringify({ name: 'lodash', version: '4.17.21' })
    );

    await developerFiles.discoverProjectByName('installed-app', ownerWebContentsId);

    for (const phrase of ['install node_modules', 'install dependencies', 'npm install']) {
      const result = await developerAgent.executeAutonomousCodingWorkflow({
        root: tmpDir,
        userRequest: phrase,
        sessionId,
        ownerWebContentsId,
      });

      assert.equal(result.outcome, 'COMPLETED');
      assert.equal(result.phase, 'DEPENDENCY_CHECK');
      assert.equal(result.status, 'ALREADY_INSTALLED');
      assert.equal(result.codeApplied, false);
      assert.match(result.message, /already installed/i);
    }
  } finally {
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('CODING AGENT V12 — Missing Dependencies Require Approval Workflow', async () => {
  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.v12-appr-root-'));
  const tmpDir = path.join(testRoot, 'missing-app');
  await fs.mkdir(tmpDir, { recursive: true });

  const ownerWebContentsId = 12003;
  const sessionId = developerAgent.createSession(ownerWebContentsId);

  const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  try {
    const pkgJson = {
      name: 'v12-missing-dep-project',
      version: '1.0.0',
      dependencies: {
        chalk: '^5.0.0',
      },
    };
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    await developerFiles.discoverProjectByName('missing-app', ownerWebContentsId);

    // 1. Without approval callback or userApproved: should pause at APPROVAL_REQUIRED
    const pausedResult = await developerAgent.executeAutonomousCodingWorkflow({
      root: tmpDir,
      userRequest: 'install node_modules',
      sessionId,
      ownerWebContentsId,
    });

    assert.equal(pausedResult.outcome, 'APPROVAL_REQUIRED');
    assert.equal(pausedResult.phase, 'APPROVE');
    assert.ok(pausedResult.continuationToken);
    assert.equal(pausedResult.continuation.status, 'AWAITING_APPROVAL');
    assert.ok(pausedResult.dependencyPlan);
    assert.ok(pausedResult.proposalContract);

    // 2. Reject approval: should return APPROVAL_REJECTED
    const rejectedResult = await developerAgent.executeAutonomousCodingWorkflow({
      root: tmpDir,
      userRequest: 'install node_modules',
      sessionId,
      ownerWebContentsId,
      continuationToken: pausedResult.continuationToken,
      userApproved: false,
    });

    assert.equal(rejectedResult.outcome, 'APPROVAL_REJECTED');
    assert.equal(rejectedResult.phase, 'APPROVE');
  } finally {
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('CODING AGENT V12 — Fail-Closed Execution Gate When Container Isolation Unverified', async () => {
  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.v12-gate-root-'));
  const tmpDir = path.join(testRoot, 'gate-app');
  await fs.mkdir(tmpDir, { recursive: true });

  const ownerWebContentsId = 12004;
  const sessionId = developerAgent.createSession(ownerWebContentsId);

  const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  try {
    const pkgJson = {
      name: 'v12-gate-project',
      version: '1.0.0',
      dependencies: {
        debug: '^4.3.4',
      },
    };
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    await developerFiles.discoverProjectByName('gate-app', ownerWebContentsId);

    // Approval granted, but container runner unverified / missing -> fails closed
    const result = await developerAgent.executeAutonomousCodingWorkflow({
      root: tmpDir,
      userRequest: 'install dependencies',
      sessionId,
      ownerWebContentsId,
      userApproved: true,
      tools: {
        containerRunner: {
          execute: async () => ({
            ok: false,
            executionBlocked: true,
            status: 'BLOCKED',
            reason: 'verified Windows process isolation is required before executing package manager commands or lifecycle scripts (unverified container isolation).',
          }),
        },
      },
    });

    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(result.phase, 'DEPENDENCY_INSTALL_GATE');
    assert.equal(result.executionBlocked, true);
    assert.match(result.reason, /verified Windows process isolation is required/i);
    assert.ok(result.dependencyPlan);
    assert.ok(result.proposalContract);
  } finally {
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('CODING AGENT V12 — Post-Install Verification & Outcome Reporting', async () => {
  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.v12-post-root-'));
  const tmpDir = path.join(testRoot, 'post-install-app');
  await fs.mkdir(tmpDir, { recursive: true });

  const ownerWebContentsId = 12005;
  const sessionId = developerAgent.createSession(ownerWebContentsId);

  const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  try {
    const pkgJson = {
      name: 'v12-post-install-project',
      version: '1.0.0',
      dependencies: {
        ms: '^2.1.3',
      },
    };
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    await developerFiles.discoverProjectByName('post-install-app', ownerWebContentsId);

    // Mock container runner that installs the package on disk inside workspace
    const mockContainerRunner = {
      execute: async ({ plan }) => {
        // Simulate container installing ms into workspace node_modules
        const msDir = path.join(tmpDir, 'node_modules', 'ms');
        await fs.mkdir(msDir, { recursive: true });
        await fs.writeFile(
          path.join(msDir, 'package.json'),
          JSON.stringify({ name: 'ms', version: '2.1.3' })
        );
        return {
          ok: true,
          status: 'COMPLETED',
          exitCode: 0,
          stdout: 'added 1 package',
          stderr: '',
        };
      },
    };

    const result = await developerAgent.executeAutonomousCodingWorkflow({
      root: tmpDir,
      userRequest: 'npm install',
      sessionId,
      ownerWebContentsId,
      userApproved: true,
      tools: {
        containerRunner: mockContainerRunner,
      },
    });

    assert.equal(result.outcome, 'COMPLETED');
    assert.equal(result.phase, 'DEPENDENCY_INSTALL_COMPLETE');
    assert.equal(result.status, 'INSTALLED');
    assert.equal(result.codeApplied, true);
    assert.equal(result.codeVerified, true);
    assert.ok(result.dependencyVerification);
    assert.equal(result.dependencyVerification.isFullyInstalled, true);
  } finally {
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('CODING AGENT V44.36 — Ambiguous Add Dependency Requests Clarification (No Silent npm install)', async () => {
  const testRoot = await fs.mkdtemp(path.join(process.cwd(), '.v44-ambig-dep-'));
  const tmpDir = path.join(testRoot, 'ambig-app');
  await fs.mkdir(tmpDir, { recursive: true });

  const ownerWebContentsId = 12005;
  const sessionId = developerAgent.createSession(ownerWebContentsId);
  const prevRoots = process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS;
  process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = testRoot;

  try {
    const pkgJson = {
      name: 'ambig-project',
      version: '1.0.0',
      dependencies: {
        express: '^4.19.2',
      },
    };
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
    await developerFiles.discoverProjectByName('ambig-app', ownerWebContentsId);

    // 1. "install a package" must NOT silently trigger npm install
    const result = await developerAgent.executeAutonomousCodingWorkflow({
      root: tmpDir,
      userRequest: 'install a package',
      sessionId,
      ownerWebContentsId,
    });

    assert.equal(result.outcome, 'CLARIFICATION_REQUIRED');
    assert.equal(result.phase, 'UNDERSTAND');
    assert.match(result.clarificationPrompt, /Which package or dependency would you like to install/i);
    assert.equal(result.filesModified.length, 0);

    // 2. Intent classifier verification
    const installIntent = classifyInstallIntent('install a package', { manifestPresent: true });
    assert.equal(installIntent.intent, INSTALL_INTENTS.ADD_DEPENDENCY);
    assert.equal(installIntent.requiresClarification, true);

    // 3. Follow-up answering the clarification unloops
    const unlooped = classifyInstallIntent('install a package', {
      manifestPresent: true,
      contextMessages: [{ role: 'user', content: 'install axios' }],
    });
    assert.equal(unlooped.requiresClarification, false);
  } finally {
    developerAgent.releaseSession(ownerWebContentsId);
    developerFiles.releaseProject(ownerWebContentsId);
    process.env.AI_HELP_AGENT_CODING_PROJECT_ROOTS = prevRoots;
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('CODING AGENT V44.36 — Proposal Validation Failure Classification Contract', () => {
  assert.ok(PROPOSAL_MISMATCH_TYPES);
  assert.equal(PROPOSAL_MISMATCH_TYPES.STALE_SOURCE_EVIDENCE, 'STALE_SOURCE_EVIDENCE');
  assert.equal(PROPOSAL_MISMATCH_TYPES.CHANGED_FILE_CONTENTS, 'CHANGED_FILE_CONTENTS');
  assert.equal(PROPOSAL_MISMATCH_TYPES.INCORRECT_FILE_PATH, 'INCORRECT_FILE_PATH');
  assert.equal(PROPOSAL_MISMATCH_TYPES.INVALID_PATCH_CONTEXT, 'INVALID_PATCH_CONTEXT');
  assert.equal(PROPOSAL_MISMATCH_TYPES.MALFORMED_DIFF, 'MALFORMED_DIFF');

  // Test classifyProposalMismatch classifications
  assert.equal(
    classifyProposalMismatch({ error: new Error('Snapshot is stale for src/app.js') }),
    PROPOSAL_MISMATCH_TYPES.STALE_SOURCE_EVIDENCE
  );
  assert.equal(
    classifyProposalMismatch({ error: new Error('File contents changed on disk') }),
    PROPOSAL_MISMATCH_TYPES.CHANGED_FILE_CONTENTS
  );
  assert.equal(
    classifyProposalMismatch({ error: new Error('Proposal target is outside the approved scope: ../other.js') }),
    PROPOSAL_MISMATCH_TYPES.INCORRECT_FILE_PATH
  );
  assert.equal(
    classifyProposalMismatch({ error: new Error('Patch context does not match') }),
    PROPOSAL_MISMATCH_TYPES.INVALID_PATCH_CONTEXT
  );
  assert.equal(
    classifyProposalMismatch({ error: new Error('Invalid patch format: malformed hunk header') }),
    PROPOSAL_MISMATCH_TYPES.MALFORMED_DIFF
  );
});
