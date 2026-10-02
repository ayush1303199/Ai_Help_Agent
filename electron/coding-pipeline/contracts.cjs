const PROJECT_PROFILE_CONTRACT = Object.freeze({
  type: 'string',
  language: 'string',
  manifest: 'string|null',
  confidence: 'manifest|extension-guess|unknown',
  extensions: 'string[]',
  profile: 'object',
  detectedFiles: 'number',
});

const INDEX_SNAPSHOT_CONTRACT = Object.freeze({
  root: 'string',
  files: 'object',
  dependencyGraph: 'object',
  repositoryMap: 'object',
  createdAt: 'string',
});

const ORCHESTRATOR_TASK_CONTRACT = Object.freeze({
  taskId: 'string',
  sessionId: 'string',
  goal: 'string',
  state: 'string',
  risk: 'string',
  approvalState: 'string',
  budget: 'object',
  checkpoints: 'object[]',
});

const ARTIFACT_CONTRACT = Object.freeze({
  artifactId: 'string',
  taskId: 'string',
  type: 'string',
  phase: 'string',
  hash: 'string',
  status: 'string',
});

const DEV_SERVER_CONTRACT = Object.freeze({
  detected: 'boolean',
  framework: 'string',
  port: 'number',
  command: 'string',
});

const BROWSER_VERIFICATION_CONTRACT = Object.freeze({
  ok: 'boolean',
  statusCode: 'number|null',
  classification: 'string',
});

const SKILL_CONTRACT = Object.freeze({
  id: 'string',
  name: 'string',
  category: 'string',
  requiredCapabilities: 'string[]',
  playbookSteps: 'object[]',
});

const MCP_TOOL_CONTRACT = Object.freeze({
  name: 'string',
  category: 'string',
  description: 'string',
  riskLevel: 'string',
  permissionsRequired: 'string[]',
});

const MODE_ROUTING_CONTRACT = Object.freeze({
  mode: 'string',
  complexity: 'string',
  effectiveToolBudget: 'number',
  canPropose: 'boolean',
  canApply: 'boolean',
  canVerify: 'boolean',
});

module.exports = {
  PROJECT_PROFILE_CONTRACT,
  INDEX_SNAPSHOT_CONTRACT,
  ORCHESTRATOR_TASK_CONTRACT,
  ARTIFACT_CONTRACT,
  DEV_SERVER_CONTRACT,
  BROWSER_VERIFICATION_CONTRACT,
  SKILL_CONTRACT,
  MCP_TOOL_CONTRACT,
  MODE_ROUTING_CONTRACT,
};
