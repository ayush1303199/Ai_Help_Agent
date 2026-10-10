const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog, globalShortcut, screen, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const fs = require('node:fs/promises');
const developerFiles = require('./developerFiles.cjs');
const developerAgent = require('./developerAgent.cjs');
const developerIndex = require('./developerIndex.cjs');
const developerContext = require('./developerContext.cjs');
const developerBenchmark = require('./developerBenchmark.cjs');
const generalAgent = require('./generalAgent.cjs');
const { ProviderSecretVault } = require('./providerSecretVault.cjs');
const { authorizeAppOwnedMutation } = require('./appOwnedPersistence.cjs');
const { projectProcessIsolationStatus } = require('./coding-pipeline/projectProcessIsolation.cjs');
const { buildCodingAcceptancePreflight } = require('./coding-pipeline/acceptancePreflight.cjs');
const runtimeSettings = require('../src/config/runtimeSettings.json');
const { services, electron: electronSettings } = runtimeSettings;
const devServerUrl = `http://${services.devServer.host}:${services.devServer.port}`;

function ignoreBrokenOutputPipe(stream) {
  stream.on('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
  });
}

ignoreBrokenOutputPipe(process.stdout);
ignoreBrokenOutputPipe(process.stderr);

const isDev = !app.isPackaged;
const codingAuthToken = process.env.AI_CODING_AUTH_TOKEN || crypto.randomBytes(32).toString('base64url');
const codingMutationHandshakeSecret = process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET || crypto.randomBytes(32).toString('base64url');
function canonicalMutationJson(value) {
  if (Array.isArray(value)) return value.map(canonicalMutationJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalMutationJson(value[key])]));
  }
  return value;
}
function codingMutationProof(payload) {
  return crypto.createHmac('sha256', codingMutationHandshakeSecret)
    .update(JSON.stringify(canonicalMutationJson(payload)))
    .digest('hex');
}
const providerSecretVault = new ProviderSecretVault({
  storageDirectory: app.getPath('userData'),
  safeStorage,
});
process.env.AI_CODING_AUTH_TOKEN = codingAuthToken;
process.env.AI_CODING_MUTATION_HANDSHAKE_SECRET = codingMutationHandshakeSecret;
developerFiles.configureAuditDirectory(path.join(app.getPath('userData'), 'developer-audit'));
developerIndex.configureSemanticSearch({
  cacheDirectory: path.join(app.getPath('userData'), 'developer-semantic-index'),
  modelCacheDirectory: path.join(app.getPath('userData'), 'developer-semantic-index', 'models'),
});
let backendProcess = null;
let isQuitting = false;
let mainWindow = null;
let overlayWindow = null;
const developerIndexCaches = new Map();
const generalSessionRenderers = new Set();
let developerMutationIpcReady = false;
const verificationRepairChainsByRoot = new Map();
const verificationRepairChainsByToken = new Map();
const verificationRepairChainsByTask = new Map();
const VERIFICATION_REPAIR_CHAIN_TTL_MS = 30 * 60 * 1000;
const MAX_REPAIR_DIAGNOSTIC_CHARS = 4000;

if (!Number.isSafeInteger(runtimeSettings.developer.maxVerificationAttempts)
  || runtimeSettings.developer.maxVerificationAttempts < 1) {
  throw new Error('Developer maxVerificationAttempts must be a positive safe integer.');
}
if (!Number.isSafeInteger(runtimeSettings.developer.maxAutoRepairAttempts)
  || runtimeSettings.developer.maxAutoRepairAttempts < 1
  || runtimeSettings.developer.maxAutoRepairAttempts > 3) {
  throw new Error('Developer maxAutoRepairAttempts must be an integer from 1 to 3.');
}

function projectChainKey(root) {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function clearVerificationRepairChain(chain) {
  if (!chain) return;
  if (verificationRepairChainsByRoot.get(chain.rootKey) === chain) {
    verificationRepairChainsByRoot.delete(chain.rootKey);
  }
  if (chain.repairToken) verificationRepairChainsByToken.delete(chain.repairToken);
  for (const taskId of chain.taskIds) verificationRepairChainsByTask.delete(taskId);
  chain.status = 'closed';
}

function activeVerificationRepairChain(root) {
  const chain = verificationRepairChainsByRoot.get(projectChainKey(root));
  if (!chain) return null;
  if (chain.expiresAt <= Date.now()) {
    clearVerificationRepairChain(chain);
    return null;
  }
  return chain;
}

function createVerificationRepairChain(root, owner, firstTaskId) {
  const rootKey = projectChainKey(root);
  const prior = verificationRepairChainsByRoot.get(rootKey);
  if (prior) clearVerificationRepairChain(prior);
  const chain = {
    id: crypto.randomUUID(),
    rootKey,
    root,
    ownerWebContentsId: owner.ownerWebContentsId,
    sessionId: owner.sessionId,
    attemptCount: 0,
    maxAttempts: runtimeSettings.developer.maxVerificationAttempts,
    expiresAt: Date.now() + VERIFICATION_REPAIR_CHAIN_TTL_MS,
    status: 'ready',
    taskIds: [firstTaskId],
    repairToken: null,
    verificationScripts: null,
    autoRepairEnabled: false,
    autoRepairPaths: null,
    autoRepairAuthorizedFeatures: null,
    autoRepairBlockedReason: null,
  };
  verificationRepairChainsByRoot.set(rootKey, chain);
  verificationRepairChainsByTask.set(firstTaskId, chain);
  return chain;
}

function bindRepairProposalToChain(task, owner, root, repairToken) {
  if (typeof repairToken !== 'string' || !repairToken) {
    return createVerificationRepairChain(root, owner, task.taskId);
  }
  const chain = verificationRepairChainsByToken.get(repairToken);
  if (!chain
    || chain !== activeVerificationRepairChain(root)
    || chain.repairToken !== repairToken
    || chain.ownerWebContentsId !== owner.ownerWebContentsId
    || chain.sessionId !== owner.sessionId
    || chain.status !== 'awaiting_repair'
    || chain.attemptCount >= chain.maxAttempts) {
    throw new Error('Verification repair authorization is invalid or expired.');
  }
  const parent = developerAgent.getTaskForTest(chain.taskIds[chain.taskIds.length - 1]);
  if (!parent || parent.state !== 'failed' || parent.verification?.status !== 'CODE_FAILURE') {
    throw new Error('The failed verification no longer authorizes a repair proposal.');
  }
  if (chain.verificationScripts
    && task.verificationScripts?.some((script) => !chain.verificationScripts.includes(script))) {
    throw new Error('A repair proposal cannot change the approved verification command set.');
  }
  verificationRepairChainsByToken.delete(repairToken);
  chain.repairToken = null;
  chain.status = 'ready';
  chain.taskIds.push(task.taskId);
  verificationRepairChainsByTask.set(task.taskId, chain);
  return chain;
}

function verificationRepairPresentation(task, chain) {
  const attemptNumber = chain ? Math.min(chain.maxAttempts, chain.attemptCount + 1) : 1;
  const sensitivePath = /(?:^|[/\\])(?:__tests__|tests?|specs?)(?:[/\\.]|$)|(?:^|[/\\])[^/\\]+\.(?:test|spec)\.[^/\\]+$/i;
  const verificationConfig = /(?:^|[/\\])(?:package\.json|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|Makefile|vite\.config\.[^/\\]+|webpack\.config\.[^/\\]+|rollup\.config\.[^/\\]+|jest\.config\.[^/\\]+|vitest\.config\.[^/\\]+|tsconfig(?:\.[^/\\]+)?\.json|\.github[/\\]workflows[/\\][^/\\]+)$/i;
  const reviewFlags = [...new Set((task.files || []).flatMap((file) => {
    const filePath = `${file.path || ''} ${file.sourcePath || ''}`;
    const flags = [];
    if (sensitivePath.test(filePath)) flags.push('test-file');
    if (/package\.json|composer\.json/i.test(filePath)) flags.push('package-script-or-dependency-manifest');
    if (verificationConfig.test(filePath) || /(?:^|[/\\])scripts?[/\\]/i.test(filePath)) {
      flags.push('verification-or-build-configuration');
    }
    return flags;
  }))];
  return {
    attemptNumber,
    maxAttempts: chain?.maxAttempts || runtimeSettings.developer.maxVerificationAttempts,
    attemptLabel: `attempt ${attemptNumber} of ${chain?.maxAttempts || runtimeSettings.developer.maxVerificationAttempts}`,
    repairAvailable: Boolean(chain && chain.status !== 'exhausted' && chain.attemptCount < chain.maxAttempts),
    reviewFlags,
    chainExpiresAt: chain ? new Date(chain.expiresAt).toISOString() : null,
    autoRepairEnabled: chain?.autoRepairEnabled === true,
    autoRepairBlockedReason: chain?.autoRepairBlockedReason || null,
  };
}

function autoRepairEligibility(task) {
  const files = Array.isArray(task.files) ? task.files : [];
  if (!files.length || files.some((file) => !['create', 'modify'].includes(file.operation))) {
    return { allowed: false, reason: 'Auto mode supports only create/modify operations; other operations need fresh approval.' };
  }
  const reviewFlags = verificationRepairPresentation(task, null).reviewFlags;
  if (reviewFlags.length) {
    return { allowed: false, reason: 'Auto mode is unavailable for test, dependency, or verification configuration changes.' };
  }
  return { allowed: true };
}

function autoRepairProposalScope(task, chain) {
  if (!chain.autoRepairEnabled
    || !Array.isArray(chain.autoRepairPaths)
    || !Array.isArray(chain.autoRepairAuthorizedFeatures)) {
    return { allowed: false, reason: 'Auto-repair authorization is unavailable; this repair needs approval.' };
  }
  const approved = new Map(chain.autoRepairPaths.map((entry) => [entry.path, entry.operation]));
  const repairFiles = Array.isArray(task.files) ? task.files : [];
  if (!repairFiles.length || repairFiles.some((file) => {
    const allowedOperation = approved.get(file.path);
    return !allowedOperation
      || allowedOperation !== file.operation
      || file.sourcePath
      || !['create', 'modify'].includes(file.operation);
  })) {
    return { allowed: false, reason: 'This repair changes files or operations outside the initial approval; fresh approval is required.' };
  }
  const authorized = new Set(chain.autoRepairAuthorizedFeatures);
  if ((task.requestedFeatures || []).some((feature) => !authorized.has(feature))) {
    return { allowed: false, reason: 'This repair exceeds the initially approved feature scope; fresh approval is required.' };
  }
  if (verificationRepairPresentation(task, chain).reviewFlags.length) {
    return { allowed: false, reason: 'This repair touches sensitive test or verification configuration; fresh approval is required.' };
  }
  return { allowed: true };
}

function redactRepairOutput(value) {
  return String(value || '')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, MAX_REPAIR_DIAGNOSTIC_CHARS);
}

async function verificationConfigHash(root) {
  const configuration = {};
  for (const relative of ['package.json', 'composer.json']) {
    try {
      const filePath = path.join(root, relative);
      const real = await fs.realpath(filePath);
      if (projectChainKey(path.dirname(real)) !== projectChainKey(root)) continue;
      const parsed = JSON.parse(await fs.readFile(real, 'utf8'));
      configuration[relative] = parsed.scripts && typeof parsed.scripts === 'object'
        ? Object.fromEntries(Object.entries(parsed.scripts).sort(([left], [right]) => left.localeCompare(right)))
        : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not validate verification configuration (${relative}).`);
      configuration[relative] = {};
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

function registerGeneralRenderer(event) {
  const ownerId = event.sender.id;
  if (generalSessionRenderers.has(ownerId)) return ownerId;
  generalSessionRenderers.add(ownerId);
  event.sender.once('destroyed', () => {
    generalAgent.releaseSession(ownerId);
    generalSessionRenderers.delete(ownerId);
  });
  return ownerId;
}

const OVERLAY_STATE_PATH = path.join(app.getPath('userData'), 'overlay-state.json');
const OVERLAY_VISIBILITY_VALUES = new Set(['VISIBLE', 'MINIMIZED', 'HIDDEN']);
const OVERLAY_TAB_VALUES = new Set(['answer', 'analysis', 'summary', 'action-items', 'search', 'history']);
const OVERLAY_PREFERENCE_KEYS = new Set(['lowVisibility', 'autoHideEnabled', 'autoHideDelay', 'alwaysOnTop', 'activeTab', 'opacity']);
const OVERLAY_MIN_OPACITY = electronSettings.overlay.minOpacity;
const OVERLAY_MAX_OPACITY = electronSettings.overlay.maxOpacity;
const OVERLAY_MIN_WIDTH = electronSettings.overlay.minWidth;
const OVERLAY_MIN_HEIGHT = electronSettings.overlay.minHeight;
const OVERLAY_DEFAULT_WIDTH = electronSettings.overlay.defaultWidth;
const OVERLAY_DEFAULT_HEIGHT = electronSettings.overlay.defaultHeight;
const OVERLAY_MINI_WIDTH = electronSettings.overlay.miniWidth;
const OVERLAY_MINI_HEIGHT = electronSettings.overlay.miniHeight;
const defaultOverlayState = {
  visibility: 'VISIBLE',
  lowVisibility: false,
  opacity: OVERLAY_MAX_OPACITY,
  autoHideEnabled: true,
  autoHideDelay: electronSettings.overlay.autoHideDelayMs,
  alwaysOnTop: true,
  activeTab: 'answer',
  bounds: { x: 0, y: 0, width: OVERLAY_DEFAULT_WIDTH, height: OVERLAY_DEFAULT_HEIGHT },
  expandedBounds: { x: 0, y: 0, width: OVERLAY_DEFAULT_WIDTH, height: OVERLAY_DEFAULT_HEIGHT },
};
let overlayState = { ...defaultOverlayState };
let meetingOverlayRuntimeState = {
  answer: '',
  question: '',
  analysis: '',
  summary: '',
  actionItems: [],
  transcripts: [],
  answeredSegments: [],
  status: 'ready',
  error: '',
  statusMessage: '',
  statusStartedAt: 0,
  agent: 'meeting',
  captureActive: false,
  transcribing: false,
  audioSignalDetected: false,
  meetingActive: false,
  version: 0,
  updatedAt: 0,
};
const overlayShortcutMap = new Map();
let overlayBoundsPersistTimer = null;
let overlayWriteSequence = 0;
let overlayWriteQueue = Promise.resolve();

function waitForPort(port, timeoutMs = electronSettings.backendStartupTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`Timed out waiting for backend port ${port}.`));
        else setTimeout(attempt, electronSettings.portRetryDelayMs);
      });
      socket.setTimeout(electronSettings.portConnectTimeoutMs, () => socket.destroy());
    };
    attempt();
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(electronSettings.portProbeTimeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startPackagedBackend() {
  if (isDev || backendProcess) return;
  const [httpReady, websocketReady, codingWebsocketReady] = await Promise.all([
    isPortOpen(services.http.port),
    isPortOpen(services.websocket.port),
    isPortOpen(services.codingWebsocket.port),
  ]);
  if (httpReady || websocketReady || codingWebsocketReady) {
    throw new Error('A backend is already listening without this application launch token. Restart the desktop app and its backend together.');
  }
  const backendExecutable = process.platform === 'win32'
    ? path.join(process.resourcesPath, 'backend', 'ai-help-agent-backend.exe')
    : path.join(process.resourcesPath, 'backend', 'ai-help-agent-backend');
  backendProcess = spawn(backendExecutable, [], {
    cwd: path.dirname(backendExecutable),
    env: {
      ...process.env,
      AI_CODING_AUTH_TOKEN: codingAuthToken,
      AI_CODING_MUTATION_HANDSHAKE_SECRET: codingMutationHandshakeSecret,
      PYTHONUNBUFFERED: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  backendProcess.once('exit', (code) => {
    if (code && !isQuitting) {
      dialog.showErrorBox('AI Assistant backend stopped', `The backend exited before the application was ready (code ${code}).`);
    }
    backendProcess = null;
  });
  await waitForPort(services.http.port);
  await waitForPort(services.websocket.port);
  await waitForPort(services.codingWebsocket.port);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function getDefaultOverlayBounds() {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = OVERLAY_DEFAULT_WIDTH;
  const height = OVERLAY_DEFAULT_HEIGHT;
  const x = clampNumber(workArea.x + Math.max(16, (workArea.width - width) / 2), workArea.x + 16, Math.max(workArea.x + 16, workArea.x + workArea.width - width - 16));
  const y = clampNumber(workArea.y + Math.max(16, (workArea.height - height) / 2), workArea.y + 16, Math.max(workArea.y + 16, workArea.y + workArea.height - height - 16));
  return { x, y, width, height };
}

function getNormalizedOverlayBounds(rawBounds = {}) {
  const fallback = getDefaultOverlayBounds();
  const source = isPlainObject(rawBounds) ? rawBounds : {};
  const rawX = Number.isFinite(source.x) ? source.x : fallback.x;
  const rawY = Number.isFinite(source.y) ? source.y : fallback.y;
  const display = screen.getDisplayNearestPoint({ x: rawX, y: rawY }) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = clampNumber(Number.isFinite(source.width) ? source.width : fallback.width, OVERLAY_MIN_WIDTH, Math.max(OVERLAY_MIN_WIDTH, workArea.width - 48));
  const height = clampNumber(Number.isFinite(source.height) ? source.height : fallback.height, OVERLAY_MIN_HEIGHT, Math.max(OVERLAY_MIN_HEIGHT, workArea.height - 48));
  const maxX = Math.max(workArea.x + 16, workArea.x + workArea.width - width - 16);
  const maxY = Math.max(workArea.y + 16, workArea.y + workArea.height - height - 16);
  const x = clampNumber(rawX, workArea.x + 16, maxX);
  const y = clampNumber(rawY, workArea.y + 16, maxY);
  return { x, y, width, height };
}

function getCompactOverlayBounds(bounds) {
  const safeBounds = getNormalizedOverlayBounds(bounds);
  return {
    ...safeBounds,
    width: Math.min(safeBounds.width, OVERLAY_MINI_WIDTH),
    height: Math.min(safeBounds.height, OVERLAY_MINI_HEIGHT),
  };
}

function normalizeOverlayState(rawState = {}) {
  const source = isPlainObject(rawState) ? rawState : {};
  const expandedBounds = getNormalizedOverlayBounds(
    isPlainObject(source.expandedBounds) ? source.expandedBounds : source.bounds,
  );
  const visibility = OVERLAY_VISIBILITY_VALUES.has(source.visibility)
    ? source.visibility
    : defaultOverlayState.visibility;
  const nextBounds = getNormalizedOverlayBounds(
    isPlainObject(source.bounds)
      ? source.bounds
      : visibility === 'MINIMIZED'
        ? getCompactOverlayBounds(expandedBounds)
        : expandedBounds,
  );
  const nextState = {
    ...defaultOverlayState,
    visibility,
    lowVisibility: typeof source.lowVisibility === 'boolean' ? source.lowVisibility : defaultOverlayState.lowVisibility,
    opacity: clampNumber(
      Number.isFinite(source.opacity) ? source.opacity : defaultOverlayState.opacity,
      OVERLAY_MIN_OPACITY,
      OVERLAY_MAX_OPACITY,
    ),
    autoHideEnabled: typeof source.autoHideEnabled === 'boolean' ? source.autoHideEnabled : defaultOverlayState.autoHideEnabled,
    autoHideDelay: clampNumber(
      Number.isFinite(source.autoHideDelay) ? source.autoHideDelay : defaultOverlayState.autoHideDelay,
      500,
      60000,
    ),
    alwaysOnTop: typeof source.alwaysOnTop === 'boolean' ? source.alwaysOnTop : defaultOverlayState.alwaysOnTop,
    activeTab: OVERLAY_TAB_VALUES.has(source.activeTab) ? source.activeTab : defaultOverlayState.activeTab,
    bounds: nextBounds,
    expandedBounds,
  };
  return nextState;
}

function validateOverlayPreferences(prefs) {
  assertPlainObject(prefs, 'Overlay preferences');
  for (const key of Object.keys(prefs)) {
    if (!OVERLAY_PREFERENCE_KEYS.has(key)) {
      throw new TypeError(`Unsupported overlay preference: ${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'lowVisibility') && typeof prefs.lowVisibility !== 'boolean') {
    throw new TypeError('lowVisibility must be a boolean.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'opacity')
    && (typeof prefs.opacity !== 'number' || !Number.isFinite(prefs.opacity))) {
    throw new TypeError('opacity must be a finite number.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'autoHideEnabled') && typeof prefs.autoHideEnabled !== 'boolean') {
    throw new TypeError('autoHideEnabled must be a boolean.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'autoHideDelay')
    && (!Number.isFinite(prefs.autoHideDelay) || typeof prefs.autoHideDelay !== 'number')) {
    throw new TypeError('autoHideDelay must be a finite number.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'alwaysOnTop') && typeof prefs.alwaysOnTop !== 'boolean') {
    throw new TypeError('alwaysOnTop must be a boolean.');
  }
  if (Object.prototype.hasOwnProperty.call(prefs, 'activeTab') && !OVERLAY_TAB_VALUES.has(prefs.activeTab)) {
    throw new TypeError('activeTab is not supported.');
  }
  return prefs;
}

function validateOverlayBounds(bounds) {
  assertPlainObject(bounds, 'Overlay bounds');
  const expectedKeys = ['x', 'y', 'width', 'height'];
  if (Object.keys(bounds).some((key) => !expectedKeys.includes(key))) {
    throw new TypeError('Overlay bounds contain unsupported keys.');
  }
  for (const key of expectedKeys) {
    if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key])) {
      throw new TypeError(`Overlay bounds.${key} must be a finite number.`);
    }
  }
  return bounds;
}

async function readOverlayState() {
  try {
    const raw = await fs.readFile(OVERLAY_STATE_PATH, 'utf8');
    if (!raw.trim()) return normalizeOverlayState({ bounds: getDefaultOverlayBounds(), expandedBounds: getDefaultOverlayBounds() });
    const parsed = JSON.parse(raw);
    return normalizeOverlayState(parsed);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[OVERLAY] state read failed:', error);
    }
    const bounds = getDefaultOverlayBounds();
    return normalizeOverlayState({ bounds, expandedBounds: bounds });
  }
}

function getOverlayStateForRenderer() {
  return {
    ...overlayState,
    bounds: { ...overlayState.bounds },
    expandedBounds: { ...overlayState.expandedBounds },
  };
}

function publishOverlayState() {
  if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.webContents.isDestroyed()) return;
  overlayWindow.webContents.send('overlay:state', getOverlayStateForRenderer());
}

async function persistOverlayState(nextState) {
  const safeState = normalizeOverlayState(nextState);
  overlayState = safeState;
  publishOverlayState();
  const writePath = `${OVERLAY_STATE_PATH}.${process.pid}.${overlayWriteSequence += 1}.tmp`;
  overlayWriteQueue = overlayWriteQueue
    .catch((error) => {
      console.error('[OVERLAY] previous state persistence failed:', error);
    })
    .then(async () => {
      try {
        await authorizeAppOwnedMutation({
          root: app.getPath('userData'),
          target: writePath,
          resource: 'app-state',
          operation: 'write',
        });
        await fs.mkdir(path.dirname(OVERLAY_STATE_PATH), { recursive: true });
        await fs.writeFile(writePath, JSON.stringify(safeState, null, 2), 'utf8');
        await authorizeAppOwnedMutation({
          root: app.getPath('userData'),
          target: OVERLAY_STATE_PATH,
          resource: 'app-state',
          operation: 'replace',
        });
        try {
          await fs.rename(writePath, OVERLAY_STATE_PATH);
        } catch (error) {
          if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
          await authorizeAppOwnedMutation({
            root: app.getPath('userData'),
            target: OVERLAY_STATE_PATH,
            resource: 'app-state',
            operation: 'remove',
          });
          await fs.rm(OVERLAY_STATE_PATH, { force: true });
          await authorizeAppOwnedMutation({
            root: app.getPath('userData'),
            target: OVERLAY_STATE_PATH,
            resource: 'app-state',
            operation: 'replace',
          });
          await fs.rename(writePath, OVERLAY_STATE_PATH);
        }
      } catch (error) {
        console.error('[OVERLAY] state write failed:', error);
        await authorizeAppOwnedMutation({
          root: app.getPath('userData'),
          target: writePath,
          resource: 'app-state',
          operation: 'remove',
        });
        await fs.rm(writePath, { force: true });
        throw new Error('Overlay state could not be persisted.', { cause: error });
      }
    });
  await overlayWriteQueue;
  return safeState;
}

function applyOverlayWindowState(nextState = overlayState, { reveal = false, focus = false } = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return nextState;
  const safeState = normalizeOverlayState(nextState);
  overlayWindow.setAlwaysOnTop(Boolean(safeState.alwaysOnTop));
  const bounds = safeState.visibility === 'MINIMIZED'
    ? getCompactOverlayBounds(safeState.bounds)
    : getNormalizedOverlayBounds(safeState.bounds);
  overlayWindow.setBounds(bounds, true);
  if (reveal && safeState.visibility === 'HIDDEN') {
    overlayWindow.hide();
  } else if (reveal) {
    if (overlayWindow.isMinimized()) overlayWindow.restore();
    overlayWindow.show();
    if (focus) overlayWindow.focus();
  }
  overlayState = safeState;
  publishOverlayState();
  return safeState;
}

function updateOverlayBoundsFromWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const nextBounds = getNormalizedOverlayBounds(overlayWindow.getBounds());
  const nextState = overlayState.visibility === 'MINIMIZED'
    ? normalizeOverlayState({ ...overlayState, bounds: nextBounds })
    : normalizeOverlayState({ ...overlayState, bounds: nextBounds, expandedBounds: nextBounds });
  overlayState = nextState;
  publishOverlayState();
  if (overlayBoundsPersistTimer) clearTimeout(overlayBoundsPersistTimer);
  overlayBoundsPersistTimer = setTimeout(() => {
    overlayBoundsPersistTimer = null;
    void persistOverlayState(overlayState);
  }, electronSettings.overlay.boundsPersistDelayMs);
}

async function showOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    await createOverlayWindow();
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) return overlayState;
  const expandedBounds = getNormalizedOverlayBounds(
    overlayState.visibility === 'MINIMIZED' ? overlayState.expandedBounds : overlayState.bounds,
  );
  const nextState = normalizeOverlayState({
    ...overlayState,
    visibility: 'VISIBLE',
    lowVisibility: false,
    bounds: expandedBounds,
    expandedBounds,
  });
  applyOverlayWindowState(nextState, { reveal: true, focus: true });
  void persistOverlayState(nextState);
  return nextState;
}

async function hideOverlayWindow() {
  const nextState = normalizeOverlayState({ ...overlayState, visibility: 'HIDDEN', lowVisibility: true });
  applyOverlayWindowState(nextState, { reveal: true });
  void persistOverlayState(nextState);
  return nextState;
}

async function toggleOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return showOverlayWindow();
  }
  if (overlayState.visibility === 'HIDDEN') {
    return showOverlayWindow();
  }
  if (overlayState.visibility === 'MINIMIZED') {
    const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds);
    const expandedState = normalizeOverlayState({
      ...overlayState,
      visibility: 'VISIBLE',
      lowVisibility: false,
      bounds: expandedBounds,
      expandedBounds,
    });
    applyOverlayWindowState(expandedState, { reveal: true, focus: true });
    void persistOverlayState(expandedState);
    return expandedState;
  }
  return hideOverlayWindow();
}

async function minimizeOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return overlayState;
  const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
  const compactBounds = getCompactOverlayBounds(expandedBounds);
  const nextState = normalizeOverlayState({
    ...overlayState,
    visibility: 'MINIMIZED',
    lowVisibility: true,
    bounds: compactBounds,
    expandedBounds,
  });
  applyOverlayWindowState(nextState, { reveal: true, focus: true });
  void persistOverlayState(nextState);
  return nextState;
}

async function expandOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
    const nextState = normalizeOverlayState({
      ...overlayState,
      visibility: 'VISIBLE',
      lowVisibility: false,
      bounds: expandedBounds,
      expandedBounds,
    });
    overlayState = nextState;
    void persistOverlayState(nextState);
    return showOverlayWindow();
  }
  const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
  const nextState = normalizeOverlayState({
    ...overlayState,
    visibility: 'VISIBLE',
    lowVisibility: false,
    bounds: expandedBounds,
    expandedBounds,
  });
  applyOverlayWindowState(nextState, { reveal: true, focus: true });
  void persistOverlayState(nextState);
  return nextState;
}

async function setOverlayPreferences(prefs = {}) {
  validateOverlayPreferences(prefs);
  const nextState = normalizeOverlayState({ ...overlayState, ...prefs });
  await persistOverlayState(nextState);
  // Preference and opacity changes must not reveal or focus the overlay.
  applyOverlayWindowState(nextState);
  return nextState;
}

async function setOverlayBounds(bounds = overlayState.bounds) {
  validateOverlayBounds(bounds);
  const nextBounds = getNormalizedOverlayBounds(bounds);
  const nextState = normalizeOverlayState({
    ...overlayState,
    bounds: overlayState.visibility === 'MINIMIZED' ? getCompactOverlayBounds(nextBounds) : nextBounds,
    expandedBounds: nextBounds,
  });
  await persistOverlayState(nextState);
  applyOverlayWindowState(nextState);
  return nextState;
}

async function setOverlayAlwaysOnTop(alwaysOnTop) {
  return setOverlayPreferences({ alwaysOnTop });
}

function registerOverlayShortcuts() {
  const keyHandlers = [
    { key: 'CommandOrControl+Shift+C', action: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createWindow();
      }
      mainWindow.show();
      mainWindow.focus();
    } },
    { key: 'CommandOrControl+Shift+Space', action: async () => { const visible = overlayState.visibility === 'VISIBLE'; const hidden = overlayState.visibility === 'HIDDEN'; const next = hidden ? 'VISIBLE' : visible ? 'HIDDEN' : 'VISIBLE'; if (!overlayWindow || overlayWindow.isDestroyed()) { await showOverlayWindow(); return; } if (next === 'VISIBLE') { await showOverlayWindow(); } else { await hideOverlayWindow(); } } },
    { key: 'CommandOrControl+Shift+M', action: async () => { if (!overlayWindow || overlayWindow.isDestroyed()) { await showOverlayWindow(); return; } if (overlayState.visibility === 'MINIMIZED') { await expandOverlayWindow(); } else { await minimizeOverlayWindow(); } } },
    { key: 'CommandOrControl+Shift+A', action: async () => { if (!overlayWindow || overlayWindow.isDestroyed()) { await showOverlayWindow(); return; } await showOverlayWindow(); if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.focus(); } } },
    { key: 'CommandOrControl+Shift+R', action: async () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('screen:read-shortcut');
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('screen:read-shortcut');
    } },
  ];

  keyHandlers.forEach(({ key, action }) => {
    try {
      if (globalShortcut.isRegistered(key)) {
        console.warn(`[OVERLAY] shortcut unavailable (already registered): ${key}`);
        return;
      }
      const registered = globalShortcut.register(key, () => { void action(); });
      if (registered) {
        overlayShortcutMap.set(key, action);
      } else {
        console.warn(`[OVERLAY] shortcut unavailable: ${key}`);
      }
    } catch (error) {
      console.warn(`[OVERLAY] shortcut conflict for ${key}:`, error);
    }
  });
}

function unregisterOverlayShortcuts() {
  overlayShortcutMap.forEach((_action, key) => {
    try {
      globalShortcut.unregister(key);
    } catch (error) {
      console.warn(`[OVERLAY] shortcut unregister failed for ${key}:`, error);
    }
  });
  overlayShortcutMap.clear();
}

function assertTrustedOverlaySender(event) {
  const sender = event?.sender;
  const isMainRenderer = Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents);
  const isOverlayRenderer = Boolean(overlayWindow && !overlayWindow.isDestroyed() && sender === overlayWindow.webContents);
  if (!isMainRenderer && !isOverlayRenderer) {
    throw new Error('Unauthorized overlay IPC sender.');
  }
}

function assertTrustedMainRendererSender(event) {
  const sender = event?.sender;
  if (!mainWindow || mainWindow.isDestroyed() || sender !== mainWindow.webContents) {
    throw new Error('This action is only available from the main AI Help Agent window.');
  }
}

function assertTrustedCodingRendererSender(event) {
  assertTrustedMainRendererSender(event);
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (isDev) {
    if (new URL(senderUrl).origin !== new URL(devServerUrl).origin) {
      throw new Error('Unauthorized Coding Agent IPC origin.');
    }
    return;
  }
  const expectedFile = path.resolve(__dirname, '..', 'dist', 'index.html');
  let actualFile = '';
  try {
    if (new URL(senderUrl).protocol === 'file:') actualFile = path.resolve(fileURLToPath(senderUrl));
  } catch {
    actualFile = '';
  }
  if (actualFile !== expectedFile) {
    throw new Error('Unauthorized Coding Agent IPC origin.');
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Windows uses this to exclude the AI window from supported screen capture APIs.
  window.setContentProtection(true);

  // Closing the main UI should keep the assistant and overlay alive in the
  // background. The process exits only during the explicit app quit flow.
  window.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });

  if (isDev) {
    window.loadURL(process.env.ELECTRON_DEV_URL || devServerUrl);
  } else {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  window.webContents.once('did-finish-load', () => {
    const warmOverlayTimer = setTimeout(() => {
      if (window !== mainWindow) return;
      void createOverlayWindow().catch((error) => {
        console.error('[OVERLAY] background warm-up failed:', error);
      });
    }, 500);
    warmOverlayTimer.unref();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) return { action: 'allow' };
    return { action: 'deny' };
  });

  return window;
}

async function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return;
  }

  const bounds = getNormalizedOverlayBounds(overlayState.bounds || getDefaultOverlayBounds());
  overlayWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: OVERLAY_MIN_WIDTH,
    minHeight: OVERLAY_MIN_HEIGHT,
    transparent: true,
    frame: false,
    alwaysOnTop: Boolean(overlayState.alwaysOnTop),
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep the overlay protected from supported screen-capture APIs just like
  // the main window.
  overlayWindow.setContentProtection(true);

  overlayWindow.on('move', () => updateOverlayBoundsFromWindow());
  overlayWindow.on('resize', () => updateOverlayBoundsFromWindow());
  overlayWindow.on('show', () => {
    if (overlayState.visibility === 'HIDDEN') {
      overlayState = normalizeOverlayState({ ...overlayState, visibility: 'VISIBLE', lowVisibility: false });
      void persistOverlayState(overlayState);
    }
    publishOverlayState();
  });
  overlayWindow.on('hide', () => {
    if (overlayState.visibility !== 'HIDDEN') {
      overlayState = normalizeOverlayState({ ...overlayState, visibility: 'HIDDEN', lowVisibility: true });
      void persistOverlayState(overlayState);
    }
    publishOverlayState();
  });
  overlayWindow.on('minimize', () => {
    const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
    overlayState = normalizeOverlayState({
      ...overlayState,
      visibility: 'MINIMIZED',
      lowVisibility: true,
      bounds: getCompactOverlayBounds(expandedBounds),
      expandedBounds,
    });
    void persistOverlayState(overlayState);
  });
  overlayWindow.on('restore', () => {
    if (overlayState.visibility === 'MINIMIZED') {
      const expandedBounds = getNormalizedOverlayBounds(overlayState.expandedBounds || overlayState.bounds);
      overlayState = normalizeOverlayState({
        ...overlayState,
        visibility: 'VISIBLE',
        lowVisibility: false,
        bounds: expandedBounds,
        expandedBounds,
      });
      overlayWindow.setBounds(expandedBounds, true);
      void persistOverlayState(overlayState);
    }
  });

  const overlayUrl = isDev
    ? `${process.env.ELECTRON_DEV_URL || devServerUrl}?overlay=1`
    : `file://${path.join(__dirname, '..', 'dist', 'index.html')}?overlay=1`;
  overlayWindow.loadURL(overlayUrl);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  overlayState = normalizeOverlayState({ ...overlayState, bounds });
  publishOverlayState();
}

app.whenReady().then(async () => {
  try {
    await startPackagedBackend();
  } catch (error) {
    dialog.showErrorBox('AI Assistant backend unavailable', `The Python backend could not start.\n\n${error.message}`);
    app.quit();
    return;
  }
  developerAgent.configureDurability({
    journalFile: path.join(app.getPath('userData'), 'developer-task-journal.json'),
    auditFile: path.join(app.getPath('userData'), 'developer-audit.jsonl'),
  });
  developerAgent.configureCheckpointStorageRoot(
    path.join(app.getPath('userData'), 'developer-checkpoints'),
  );
  try {
    await developerAgent.loadJournal();
  } catch (error) {
    console.error('[DEV][JOURNAL] startup reconciliation failed:', error);
  }
  ipcMain.handle('overlay:open', async (event) => {
    assertTrustedOverlaySender(event);
    return showOverlayWindow();
  });
  ipcMain.handle('overlay:show', async (event) => {
    assertTrustedOverlaySender(event);
    return showOverlayWindow();
  });
  ipcMain.handle('overlay:hide', async (event) => {
    assertTrustedOverlaySender(event);
    return hideOverlayWindow();
  });
  ipcMain.handle('overlay:toggle', async (event) => {
    assertTrustedOverlaySender(event);
    return toggleOverlayWindow();
  });
  ipcMain.handle('overlay:minimize', async (event) => {
    assertTrustedOverlaySender(event);
    return minimizeOverlayWindow();
  });
  ipcMain.handle('overlay:expand', async (event) => {
    assertTrustedOverlaySender(event);
    return expandOverlayWindow();
  });
  ipcMain.handle('overlay:close', (event) => {
    assertTrustedOverlaySender(event);
    return hideOverlayWindow();
  });
  ipcMain.handle('overlay:get-preferences', async (event) => {
    assertTrustedOverlaySender(event);
    return getOverlayStateForRenderer();
  });
  ipcMain.handle('provider-secrets:read', async (event) => {
    assertTrustedCodingRendererSender(event);
    return providerSecretVault.readAll();
  });
  ipcMain.handle('provider-secrets:assert-available', (event) => {
    assertTrustedCodingRendererSender(event);
    return providerSecretVault.assertAvailable();
  });
  ipcMain.handle('provider-secrets:write', async (event, secrets) => {
    assertTrustedCodingRendererSender(event);
    await providerSecretVault.writeAll(secrets);
    return { saved: true };
  });
  ipcMain.handle('provider:confirm-delete', async (event, providerId, providerLabel) => {
    assertTrustedCodingRendererSender(event);
    if (typeof providerId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(providerId)
      || typeof providerLabel !== 'string' || !providerLabel.trim() || providerLabel.length > 160) {
      throw new Error('Provider deletion confirmation target is invalid.');
    }
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Remove provider and saved credential'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Confirm provider deletion',
      message: `Delete provider "${providerLabel.trim()}"?`,
      detail: `This removes provider ${providerId} from the backend and its encrypted saved credential. This is the second confirmation, immediately before deletion.`,
    });
    return response.response === 1;
  });
  ipcMain.handle('meeting-overlay:publish-state', (event, state) => {
    assertTrustedMainRendererSender(event);
    if (!isPlainObject(state)
      || !Number.isSafeInteger(state.version)
      || state.version < 0
      || !Number.isFinite(state.updatedAt)
      || state.updatedAt < 0) {
      throw new Error('Invalid Meeting overlay state.');
    }
    if (state.version < meetingOverlayRuntimeState.version
      || (state.version === meetingOverlayRuntimeState.version
        && state.updatedAt < meetingOverlayRuntimeState.updatedAt)) {
      return meetingOverlayRuntimeState;
    }
    meetingOverlayRuntimeState = {
      answer: typeof state.answer === 'string' ? state.answer.slice(0, 20000) : '',
      question: typeof state.question === 'string' ? state.question.slice(0, 2000) : '',
      analysis: typeof state.analysis === 'string' ? state.analysis.slice(0, 20000) : '',
      summary: typeof state.summary === 'string' ? state.summary.slice(0, 20000) : '',
      actionItems: Array.isArray(state.actionItems) ? state.actionItems.filter((item) => typeof item === 'string').slice(0, 20) : [],
      transcripts: Array.isArray(state.transcripts) ? state.transcripts
        .filter((item) => isPlainObject(item)
          && typeof item.id === 'string'
          && typeof item.source === 'string'
          && typeof item.text === 'string')
        .slice(0, 100)
        .map((item) => ({
          id: item.id.slice(0, 160),
          source: item.source.slice(0, 80),
          text: item.text.slice(0, 4000),
          createdAt: typeof item.createdAt === 'string' ? item.createdAt.slice(0, 80) : '',
        })) : meetingOverlayRuntimeState.transcripts,
      answeredSegments: Array.isArray(state.answeredSegments) ? state.answeredSegments
        .filter((item) => isPlainObject(item)
          && typeof item.question === 'string'
          && typeof item.answer === 'string')
        .slice(-30)
        .map((item) => ({
          question: item.question.slice(0, 4000),
          answer: item.answer.slice(0, 12000),
          ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt.slice(0, 80) } : {}),
        })) : meetingOverlayRuntimeState.answeredSegments,
      status: typeof state.status === 'string' ? state.status.slice(0, 80) : 'ready',
      error: typeof state.error === 'string' ? state.error.slice(0, 1000) : '',
      statusMessage: typeof state.statusMessage === 'string' ? state.statusMessage.slice(0, 500) : '',
      statusStartedAt: Number.isFinite(state.statusStartedAt) ? state.statusStartedAt : Date.now(),
      agent: 'meeting',
      captureActive: state.captureActive === true,
      transcribing: state.transcribing === true,
      audioSignalDetected: state.audioSignalDetected === true,
      meetingActive: state.meetingActive === true,
      version: state.version,
      updatedAt: state.updatedAt,
    };
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('meeting-overlay:state', meetingOverlayRuntimeState);
    }
    return meetingOverlayRuntimeState;
  });
  ipcMain.handle('meeting-overlay:get-state', (event) => {
    assertTrustedOverlaySender(event);
    return meetingOverlayRuntimeState;
  });
  ipcMain.handle('meeting-overlay:command', (event, command) => {
    assertTrustedOverlaySender(event);
    if (!isPlainObject(command) || !['start-listening', 'stop-listening', 'cancel-request', 'open-audio-settings', 'question'].includes(command.type)) {
      throw new Error('Invalid Meeting overlay command.');
    }
    if (command.type === 'question' && typeof command.question !== 'string') {
      throw new Error('Meeting overlay questions must be text.');
    }
    if (typeof command.commandId !== 'string' || !command.commandId.trim() || command.commandId.length > 100) {
      throw new Error('Meeting overlay command ID is invalid.');
    }
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('The Meeting window is unavailable.');
    mainWindow.webContents.send('meeting-overlay:command', {
      type: command.type,
      commandId: command.commandId,
      ...(typeof command.question === 'string' ? { question: command.question.slice(0, 2000) } : {}),
    });
  });
  ipcMain.handle('meeting-overlay:command-result', (event, result) => {
    assertTrustedMainRendererSender(event);
    if (!isPlainObject(result)
      || typeof result.commandId !== 'string'
      || !result.commandId.trim()
      || result.commandId.length > 100
      || typeof result.ok !== 'boolean'
      || (typeof result.captureActive !== 'undefined' && typeof result.captureActive !== 'boolean')
      || (typeof result.message !== 'undefined' && typeof result.message !== 'string')) {
      throw new Error('Invalid Meeting overlay command result.');
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('meeting-overlay:command-result', {
        commandId: result.commandId,
        ok: result.ok,
        ...(typeof result.captureActive === 'boolean' ? { captureActive: result.captureActive } : {}),
        ...(typeof result.message === 'string' ? { message: result.message.slice(0, 500) } : {}),
      });
    }
  });
  ipcMain.handle('overlay:set-preferences', async (event, prefs) => {
    assertTrustedOverlaySender(event);
    return setOverlayPreferences(prefs);
  });
  ipcMain.handle('overlay:get-bounds', async (event) => {
    assertTrustedOverlaySender(event);
    return { ...overlayState.bounds };
  });
  ipcMain.handle('overlay:set-bounds', async (event, bounds) => {
    assertTrustedOverlaySender(event);
    return setOverlayBounds(typeof bounds === 'undefined' ? overlayState.bounds : bounds);
  });
  ipcMain.handle('overlay:set-always-on-top', async (event, alwaysOnTop) => {
    assertTrustedOverlaySender(event);
    return setOverlayAlwaysOnTop(alwaysOnTop);
  });
  ipcMain.handle('overlay:focus-answer', async (event) => {
    assertTrustedOverlaySender(event);
    await showOverlayWindow();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.focus();
    }
    return overlayState;
  });
  ipcMain.handle('screen:capture', async (event) => {
    assertTrustedOverlaySender(event);
    const visibleWindows = [mainWindow, overlayWindow].filter((window) => (
      window && !window.isDestroyed() && window.isVisible()
    ));
    visibleWindows.forEach((window) => window.hide());
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const display = screen.getPrimaryDisplay();
      const nativeWidth = Math.round(display.bounds.width * display.scaleFactor);
      const nativeHeight = Math.round(display.bounds.height * display.scaleFactor);
      const imageScale = Math.min(1, 3840 / Math.max(nativeWidth, nativeHeight));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(nativeWidth * imageScale),
          height: Math.round(nativeHeight * imageScale),
        },
        fetchWindowIcons: false,
      });
      const source = sources.find((candidate) => candidate.display_id === String(display.id))
        || (sources.length === 1 ? sources[0] : null);
      if (!source?.thumbnail || source.thumbnail.isEmpty()) throw new Error('No screen could be captured.');
      return source.thumbnail.toDataURL();
    } finally {
      visibleWindows.forEach((window) => {
        if (!window.isDestroyed()) window.showInactive();
      });
    }
  });
  ipcMain.handle('developer:project-state', async (event) => {
    developerAgent.getSession(event.sender.id);
    return developerFiles.getProjectState(event.sender.id);
  });
  ipcMain.handle('developer:acceptance-preflight', async (event) => {
    developerAgent.getSession(event.sender.id);
    const projectState = await developerFiles.getProjectState(event.sender.id);
    let providerConfigured = false;
    let providerCheckError = null;
    try {
      const response = await fetch(`http://127.0.0.1:${services.http.port}/api/settings/providers`, {
        headers: { 'X-Coding-Auth': codingAuthToken },
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error(`provider endpoint returned HTTP ${response.status}`);
      const data = await response.json();
      const providers = Array.isArray(data?.providers) ? data.providers : [];
      const activeProvider = providers.find((provider) => provider.id === data.activeProvider);
      providerConfigured = activeProvider?.enabled === true
        && activeProvider?.hasApiKey === true
        && activeProvider?.assistantCapable === true
        && activeProvider?.developerToolCalling === true;
    } catch (error) {
      providerCheckError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    return buildCodingAcceptancePreflight({
      providerConfigured,
      providerCheckError,
      projectState,
      isolation: projectProcessIsolationStatus(),
    });
  });
  ipcMain.handle('developer:backend-auth-token', (event) => {
    assertTrustedCodingRendererSender(event);
    return codingAuthToken;
  });
  ipcMain.handle('developer:mutation-handshake', async (event, connectionId) => {
    assertTrustedCodingRendererSender(event);
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    if (typeof connectionId !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(connectionId)) {
      throw new TypeError('A valid authenticated Coding Agent connection is required.');
    }
    if (!developerMutationIpcReady) {
      throw new Error('The typed Developer mutation IPC path is not fully registered.');
    }
    const proof = crypto.createHmac('sha256', codingMutationHandshakeSecret).update(connectionId).digest('hex');
    const response = await fetch(`http://127.0.0.1:${services.http.port}/api/coding/mutation-handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coding-Auth': codingAuthToken },
      body: JSON.stringify({ connectionId, proof }),
    });
    if (!response.ok) throw new Error(`Mutation capability handshake failed (${response.status}).`);
    return response.json();
  });
  ipcMain.handle('developer:project-attach', async (event, payload) => {
    developerAgent.getSession(event.sender.id);
    const result = await developerFiles.attachProject(payload?.projectRoot, event.sender.id);
    if (result.status === 'PROJECT_ATTACHED' && result.projectRoot) {
      developerIndexCaches.delete(result.projectRoot);
      developerContext.invalidateContextCache(result.projectRoot);
    }
    return result;
  });
  ipcMain.handle('developer:choose-project', (event) => {
    developerAgent.getSession(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    if (currentRoot) {
      developerIndexCaches.delete(currentRoot);
      developerContext.invalidateContextCache(currentRoot);
    }
    return developerFiles.chooseProjectFolder(dialog, event.sender.id);
  });
  ipcMain.handle('developer:discover-project', async (event, payload) => {
    developerAgent.getSession(event.sender.id);
    const projectName = typeof payload?.projectName === 'string' ? payload.projectName.trim() : '';
    const result = await developerFiles.discoverProjectByName(projectName, event.sender.id);
    if (result.timedOut || result.directoryLimitReached) {
      throw new Error(
        `Project discovery for '${projectName}' stopped at its safety limit while searching [${result.roots.join(', ')}]. Use Advanced > Select folder to choose it directly.`,
      );
    }
    if (!result.matches.length) {
      throw new Error(
        `Project '${projectName}' was not found in [${result.roots.join(', ')}]. Use Advanced > Select folder to choose it directly.`,
      );
    }
    return { matches: result.matches, projectRoot: result.projectRoot };
  });
  ipcMain.handle('developer:clear-project', (event) => {
    developerAgent.getSession(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    if (currentRoot) {
      developerIndexCaches.delete(currentRoot);
      developerContext.invalidateContextCache(currentRoot);
    }
    developerFiles.clearProject(event.sender.id);
  });
  ipcMain.handle('developer:list-directory', (event, relativePath) => {
    developerAgent.getSession(event.sender.id);
    return developerFiles.listDirectory(relativePath, event.sender.id);
  });
  ipcMain.handle('developer:read-file', (event, relativePath) => {
    developerAgent.getSession(event.sender.id);
    return developerFiles.readFile(relativePath, event.sender.id);
  });
  ipcMain.handle('developer:search-code', (event, payload) => {
    developerAgent.getSession(event.sender.id);
    const query = typeof payload === 'string' ? payload : payload?.query;
    const scope = typeof payload === 'string' ? '.' : payload?.scope;
    return developerFiles.searchCode(query, event.sender.id, scope);
  });
  const ownedDeveloperSession = (event) => {
    const sessionId = developerAgent.getSession(event.sender.id);
    return { sessionId, ownerWebContentsId: event.sender.id };
  };
  ipcMain.handle('developer:conversation-start', async (event, payload) => {
    const owner = ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const root = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    const scope = await developerFiles.resolveProjectScope(event.sender.id, payload?.scope || '.');
    const repairToken = typeof payload?.repairToken === 'string' ? payload.repairToken : null;
    const activeChain = activeVerificationRepairChain(root);
    if (repairToken) {
      const authorizedChain = verificationRepairChainsByToken.get(repairToken);
      if (!authorizedChain
        || authorizedChain !== activeChain
        || authorizedChain.repairToken !== repairToken
        || authorizedChain.ownerWebContentsId !== owner.ownerWebContentsId
        || authorizedChain.sessionId !== owner.sessionId
        || authorizedChain.status !== 'awaiting_repair') {
        throw new Error('Verification repair authorization is invalid or expired.');
      }
      const parentTask = developerAgent.getTaskForTest(authorizedChain.taskIds.at(-1));
      if (!parentTask?.authorizationContext || !Array.isArray(parentTask.approval?.authorizedFeatures)) {
        throw new Error('The repair task has no valid original request-bound feature authorization.');
      }
      authorizedChain.parentAuthorizationContext = {
        ...parentTask.authorizationContext,
        authorizedFeatures: [...parentTask.approval.authorizedFeatures],
      };
    } else if (activeChain) {
      clearVerificationRepairChain(activeChain);
    }
    const turn = developerAgent.beginConversationTurn({
      root,
      scope,
      request: payload?.request,
      parentAuthorizationContext: repairToken ? activeChain.parentAuthorizationContext : null,
      ...owner,
    });
    return { ...turn, projectRoot: root, scope };
  });
  ipcMain.handle('developer:database-inspect', async (event, payload) => {
    const owner = ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const root = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    return developerAgent.inspectDatabaseRequest({
      root,
      request: payload?.request,
      contextMessages: Array.isArray(payload?.contextMessages)
        ? payload.contextMessages
          .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
          .slice(-8)
          .map((message) => ({ role: message.role, content: message.content.slice(-2000) }))
        : [],
      ...owner,
    });
  });
  ipcMain.handle('developer:conversation-update', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const allowedRendererStates = new Set(['understanding', 'completed', 'failed', 'cancelled']);
    if (!allowedRendererStates.has(payload?.state)) throw new Error('Unsupported Coding conversation lifecycle update.');
    return developerAgent.advanceConversationTurn(payload?.turnId, payload.state, owner, {
      phase: payload.phase,
      fileCount: Number.isInteger(payload.fileCount) ? payload.fileCount : undefined,
    });
  });
  ipcMain.handle('developer:index', async (event) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return { capabilities: nextIndex.capabilities, files: Object.keys(nextIndex.files), cacheHits: nextIndex.cacheHits };
  });
  ipcMain.handle('developer:symbol-search', async (event, query) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return developerIndex.searchSymbols(nextIndex, query).slice(0, 100);
  });
  ipcMain.handle('developer:repository-map', async (event) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return developerIndex.buildRepositoryMap(currentRoot, nextIndex?.repositoryMap || null);
  });
  ipcMain.handle('developer:find-references', async (event, query) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const cached = developerIndexCaches.get(currentRoot) || null;
    const nextIndex = await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null);
    developerIndexCaches.set(currentRoot, nextIndex);
    return developerIndex.findReferences(nextIndex, String(query || '').trim()).slice(0, 100);
  });
  ipcMain.handle('developer:context', async (event, payload) => {
    ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const query = payload?.query;
    const currentRoot = developerFiles.getProjectRoot(event.sender.id);
    const search = await developerFiles.searchCode(query, event.sender.id, payload?.scope);
    const normalizedScope = String(payload?.scope || '.').replace(/\\/g, '/').replace(/^\.\/+|\/+$/g, '');
    const cached = currentRoot ? developerIndexCaches.get(currentRoot) || null : null;
    const nextIndex = currentRoot ? await developerIndex.buildIndex(currentRoot, cached && cached.root === currentRoot ? cached : null) : null;
    if (currentRoot) developerIndexCaches.set(currentRoot, nextIndex);
    const symbols = nextIndex
      ? developerIndex.searchSymbols(nextIndex, query)
        .filter((item) => !normalizedScope || String(item.path || '').replace(/\\/g, '/').startsWith(`${normalizedScope}/`))
        .slice(0, 50)
      : [];
    return developerContext.assembleContext({ root: currentRoot, query, results: [...search.results, ...symbols], maxTokens: payload?.maxTokens });
  });
  ipcMain.handle('developer:tool', async (event, payload) => {
    const owner = ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    let name = String(payload?.name || '');
    let args = payload?.args;
    if (!isPlainObject(args)) throw new TypeError('Coding Agent tool arguments must be an object.');
    args = { ...args };

    // Resolve tool aliases
    if (name === 'repo_browser.search_code' || name === 'find_code' || name === 'search_files') {
      name = 'search_code';
    } else if (name === 'repo_browser.read_file' || name === 'open_file') {
      name = 'read_file';
    } else if (name === 'repo_browser.list_directory' || name === 'ls') {
      name = 'list_directory';
    } else if (name === 'repo_browser.search_symbols' || name === 'find_symbols') {
      name = 'search_symbols';
    } else if (name === 'repo_browser.find_references' || name === 'references') {
      name = 'find_references';
    } else if (name === 'execute_sql' || name === 'run_query' || name === 'db_query' || name === 'database.query' || name === 'sql_query' || name === 'query_database' || name === 'executeQuery' || name === 'check_db' || name === 'inspect_database' || name === 'show_tables' || name === 'list_tables') {
      name = 'run_verification';
    }

    // Normalize arguments
    if (name === 'search_code' && !args.query && typeof args.pattern === 'string') {
      args.query = args.pattern;
    }
    if (name === 'search_code' && !args.query && typeof args.q === 'string') {
      args.query = args.q;
    }
    if (name === 'read_file' && !args.relativePath && typeof args.path === 'string') {
      args.relativePath = args.path;
    }
    if (name === 'list_directory' && !args.relativePath && typeof args.path === 'string') {
      args.relativePath = args.path;
    }

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const scope = await developerFiles.resolveProjectScope(event.sender.id, payload?.scope || '.');
    const root = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    developerAgent.validateConversationToolContext(payload?.turnId, owner, root, scope);
    if (name === 'list_directory') {
      const relativePath = developerFiles.normalizeScopedProjectPath(root, scope, args.relativePath || '.');
      return { ok: true, tool: name, data: await developerFiles.listDirectory(relativePath, event.sender.id) };
    }
    if (name === 'read_file') {
      const relativePath = developerFiles.normalizeScopedProjectPath(root, scope, args.relativePath);
      return { ok: true, tool: name, data: await developerFiles.readFile(relativePath, event.sender.id) };
    }
    if (name === 'search_code') {
      if (!query || query.length > 200) throw new TypeError('Coding Agent search query is invalid.');
      const lexical = await developerFiles.searchCode(query, event.sender.id, scope);
      let semantic = { status: 'unavailable', error: 'Semantic search did not run.', results: [] };
      try {
        const cached = developerIndexCaches.get(root) || null;
        const nextIndex = await developerIndex.buildIndex(root, cached && cached.root === root ? cached : null);
        developerIndexCaches.set(root, nextIndex);
        semantic = await developerIndex.searchSemantic(nextIndex, query, { scope });
      } catch (error) {
        semantic = {
          status: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
          results: [],
        };
      }
      return {
        ok: true,
        tool: name,
        data: {
          ...lexical,
          results: developerIndex.mergeSearchResults(lexical.results, semantic.results),
          semantic: {
            status: semantic.status,
            model: semantic.model,
            indexedFiles: semantic.indexedFiles,
            cachedFiles: semantic.cachedFiles,
            indexedChunks: semantic.indexedChunks,
            skippedFiles: semantic.skippedFiles,
            truncated: semantic.truncated,
            error: semantic.error,
          },
        },
      };
    }
    if (name === 'get_context') {
      if (!query || query.length > 200) throw new TypeError('Coding Agent context query is invalid.');
      const search = await developerFiles.searchCode(query, event.sender.id, scope);
      return {
        ok: true,
        tool: name,
        data: developerContext.assembleContext({ root, query, results: search.results, maxTokens: args.maxTokens }),
      };
    }
    const rawToolName = String(payload?.name || '');
    const isDbTool = ['execute_sql', 'run_query', 'db_query', 'database.query', 'sql_query', 'query_database', 'executeQuery', 'check_db', 'inspect_database', 'show_tables', 'list_tables'].includes(rawToolName)
      || Boolean(args.sql || (typeof args.query === 'string' && /\b(?:SELECT|SHOW|EXPLAIN|PRAGMA|FROM|WHERE)\b/i.test(args.query)));
    if (isDbTool) {
      const rawSql = String(args.sql || args.query || args.command || '').trim();
      if (!rawSql) {
        return {
          ok: false,
          tool: rawToolName || 'execute_sql',
          error: {
            code: 'SQL_REQUIRED',
            message: 'A SQL statement is required; no query was executed.',
          },
        };
      }
      const isDestructive = /\b(?:DROP|TRUNCATE|DELETE|ALTER|GRANT|REVOKE)\b/i.test(rawSql);
      if (isDestructive) {
        return {
          ok: false,
          tool: rawToolName || 'execute_sql',
          error: 'DESTRUCTIVE_COMMAND_BLOCKED: Destructive database operations are permanently forbidden by policy gate.',
        };
      }
      try {
        const res = await fetch('http://127.0.0.1:3001/api/coding/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'execute_sql', arguments: { sql: rawSql }, scope }),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.ok === true && body.data) {
          return {
            ok: true,
            tool: rawToolName || 'execute_sql',
            data: body.data,
          };
        }
        return {
          ok: false,
          tool: rawToolName || 'execute_sql',
          error: body?.error?.message || body?.error || `Database query backend returned HTTP ${res.status}.`,
        };
      } catch {
        return {
          ok: false,
          tool: rawToolName || 'execute_sql',
          error: 'Database query backend is unavailable; no query was executed.',
        };
      }
    }
    if (name === 'run_verification' || name === 'terminal.run_command') {
      const script = String(args.command || args.script || args.check || '');
      return { ok: true, tool: name, data: await developerFiles.runVerification(script, event.sender.id) };
    }
    if (name === 'search_symbols' || name === 'find_references' || name === 'get_repository_map') {
      const cached = developerIndexCaches.get(root) || null;
      const nextIndex = await developerIndex.buildIndex(root, cached && cached.root === root ? cached : null);
      developerIndexCaches.set(root, nextIndex);
      const scopePrefix = scope === '.' ? '' : `${scope.replace(/\\/g, '/')}/`;
      if (name === 'search_symbols') {
        if (!query || query.length > 200) throw new TypeError('Coding Agent symbol query is invalid.');
        const data = developerIndex.searchSymbols(nextIndex, query)
          .filter((item) => !scopePrefix || String(item.path || '').replace(/\\/g, '/').startsWith(scopePrefix))
          .slice(0, 50);
        return { ok: true, tool: name, data };
      }
      if (name === 'find_references') {
        if (!query || query.length > 200) throw new TypeError('Coding Agent reference query is invalid.');
        const data = developerIndex.findReferences(nextIndex, query)
          .filter((item) => !scopePrefix || String(item.file || '').replace(/\\/g, '/').startsWith(scopePrefix))
          .slice(0, 50);
        return { ok: true, tool: name, data };
      }
      const map = developerIndex.buildRepositoryMap(root, nextIndex?.repositoryMap || null);
      if (scope === '.') return { ok: true, tool: name, data: map };
      const withinScope = (value) => String(value || '').replace(/\\/g, '/').startsWith(scopePrefix);
      return {
        ok: true,
        tool: name,
        data: {
          ...map,
          sourceDirectories: map.sourceDirectories.filter(withinScope),
          testDirectories: map.testDirectories.filter(withinScope),
          entryPoints: map.entryPoints.filter(withinScope),
          configFiles: map.configFiles.filter(withinScope),
          importantFiles: map.importantFiles.filter(withinScope),
          structure: map.structure.filter((item) => withinScope(item.path)),
        },
      };
    }
    return {
      ok: false,
      tool: name,
      error: {
        code: 'TOOL_UNAVAILABLE',
        message: `Unsupported Coding Agent tool: ${name}. Available tools: list_directory, read_file, search_code, get_context, search_symbols, find_references, get_repository_map, run_verification.`,
      },
    };
  });
  ipcMain.handle('developer:provider-discovery', (_event, providers) => developerBenchmark.discoverProviders(providers));
  ipcMain.handle('developer:run-verification', (event, script) => {
    ownedDeveloperSession(event);
    return developerFiles.runVerification(script, event.sender.id);
  });
  ipcMain.handle('developer:session', (event) => {
    event.sender.once('destroyed', () => {
      const currentRoot = developerFiles.getProjectRoot(event.sender.id);
      if (currentRoot) {
        developerIndexCaches.delete(currentRoot);
        developerContext.invalidateContextCache(currentRoot);
      }
      developerAgent.releaseSession(event.sender.id);
      developerFiles.releaseProject(event.sender.id);
    });
    return { sessionId: developerAgent.getSession(event.sender.id) };
  });
  ipcMain.handle('developer:session-resume', (event, sessionId) => ({ sessionId: developerAgent.resumeSession(event.sender.id, sessionId) }));
  ipcMain.handle('developer:git-inspect', (event, kind) => {
    ownedDeveloperSession(event);
    return developerFiles.runGit(kind === 'diff' ? ['diff', '--no-ext-diff'] : ['status', '--short'], event.sender.id);
  });
  ipcMain.handle('developer:proposal-create', async (event, payload) => {
    const owner = ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const root = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    const scope = await developerFiles.resolveProjectScope(event.sender.id, payload?.scope || '.');
    const repairToken = typeof payload?.repairToken === 'string' ? payload.repairToken : null;
    const tokenChain = repairToken ? verificationRepairChainsByToken.get(repairToken) : null;
    if (repairToken && (!tokenChain
      || tokenChain !== activeVerificationRepairChain(root)
      || tokenChain.ownerWebContentsId !== owner.ownerWebContentsId
      || tokenChain.sessionId !== owner.sessionId
      || tokenChain.status !== 'awaiting_repair')) {
      throw new Error('Verification repair authorization is invalid or expired.');
    }
    const verificationPlan = tokenChain
      ? { scripts: tokenChain.verificationScripts || [], missing: [] }
      : await developerFiles.getVerificationScripts(event.sender.id, [], scope);
    const preProposalVerificationConfigHash = tokenChain?.verificationConfigHash
      || await verificationConfigHash(root);
    const proposal = await developerAgent.createProposal({
      root, raw: payload?.raw, expectedSnapshots: payload?.snapshots,
      sessionId: owner.sessionId, ownerWebContentsId: owner.ownerWebContentsId,
      workspace: payload?.workspace,
      verificationScripts: verificationPlan.scripts,
      scope,
      conversationTurnId: payload?.conversationTurnId || null,
    });
    const task = developerAgent.getTaskForTest(proposal.id);
    const chain = bindRepairProposalToChain(task, owner, root, repairToken);
    if (!chain.verificationScripts) {
      chain.verificationScripts = [...verificationPlan.scripts];
      chain.verificationConfigHash = preProposalVerificationConfigHash;
    }
    task.verificationScripts = [...chain.verificationScripts];
    let registeredProposal = proposal;
    let autoRepairAuthorized = false;
    if (chain.autoRepairEnabled) {
      const eligibility = autoRepairProposalScope(task, chain);
      if (eligibility.allowed) {
        const taskRecord = developerAgent.getTaskForTest(task.taskId);
        const baselineFeatures = taskRecord.authorizationContext.authorizedFeatures;
        const additionalFeatures = task.requestedFeatures.filter((feature) => !baselineFeatures.includes(feature));
        const featureAuthorization = additionalFeatures.length ? {
          source: 'main-process-feature-confirmation',
          proposalId: task.proposalId,
          authorizedFeatures: chain.autoRepairAuthorizedFeatures,
        } : null;
        registeredProposal = developerAgent.approve(task.taskId, owner, featureAuthorization);
        autoRepairAuthorized = true;
      } else {
        chain.autoRepairEnabled = false;
        chain.autoRepairBlockedReason = eligibility.reason;
      }
    }
    return {
      ...registeredProposal,
      ...verificationRepairPresentation(task, chain),
      verificationScripts: [...chain.verificationScripts],
      autoRepairAuthorized,
      autoRepairBlockedReason: chain.autoRepairBlockedReason || null,
    };
  });
  ipcMain.handle('developer:verification-repair-context', async (event, id) => {
    const owner = ownedDeveloperSession(event);
    const task = developerAgent.getTask(id, owner);
    developerFiles.assertProjectOwner(event.sender.id);
    const chain = verificationRepairChainsByTask.get(task.taskId);
    if (!chain || chain !== activeVerificationRepairChain(task.workspace.root)
      || chain.ownerWebContentsId !== owner.ownerWebContentsId
      || chain.sessionId !== owner.sessionId
      || task.state !== 'failed'
      || task.verification?.status !== 'CODE_FAILURE'
      || task.error?.startsWith('Rollback verification failed:')
      || chain.attemptCount >= chain.maxAttempts
      || !chain.verificationScripts?.length) {
      throw new Error('A verified rollback and remaining repair attempt are required before requesting a repair.');
    }
    if (chain.repairToken) verificationRepairChainsByToken.delete(chain.repairToken);
    const repairToken = crypto.randomBytes(32).toString('base64url');
    chain.repairToken = repairToken;
    chain.status = 'awaiting_repair';
    verificationRepairChainsByToken.set(repairToken, chain);
    const failed = task.verification.attempts?.find((attempt) => !attempt.ok) || task.verification.attempts?.[0] || {};
    return {
      repairToken,
      attemptNumber: chain.attemptCount + 1,
      maxAttempts: chain.maxAttempts,
      attemptLabel: `attempt ${chain.attemptCount + 1} of ${chain.maxAttempts}`,
      check: failed.check || null,
      classification: failed.classification || task.verification.classification || task.verification.status,
      location: failed.extracted?.file
        ? `${failed.extracted.file}${failed.extracted.line ? `:${failed.extracted.line}` : ''}`
        : null,
      output: redactRepairOutput(`${failed.stdout || ''}\n${failed.stderr || ''}`),
    };
  });
  ipcMain.handle('developer:verification-repair-cancel', (event, id) => {
    const owner = ownedDeveloperSession(event);
    const task = developerAgent.getTask(id, owner);
    developerFiles.assertProjectOwner(event.sender.id);
    const chain = verificationRepairChainsByTask.get(task.taskId);
    if (chain && chain.ownerWebContentsId === owner.ownerWebContentsId && chain.sessionId === owner.sessionId) {
      clearVerificationRepairChain(chain);
    }
    return { cancelled: true };
  });
  ipcMain.handle('developer:proposal-approve', async (event, id, options = {}) => {
    const owner = { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id };
    const task = developerAgent.getProposalAuthorizationContext(id, owner);
    const baselineFeatures = task.authorizedFeatures;
    const requestedFeatures = task.requestedFeatures;
    if (!Array.isArray(baselineFeatures) || !Array.isArray(requestedFeatures)) {
      throw new Error('Request-bound feature authorization is unavailable for this proposal.');
    }
    const additionalFeatures = requestedFeatures.filter((feature) => !baselineFeatures.includes(feature));
    let featureAuthorization = null;
    if (additionalFeatures.length) {
      const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
        type: 'warning',
        title: 'Confirm cross-feature proposal',
        message: `This Coding request proposes changes to additional feature areas: ${additionalFeatures.join(', ')}.`,
        detail: [
          `Original request: ${String(task.requestSummary || '').slice(0, 512)}`,
          '',
          ...task.changedPaths,
        ].join('\n'),
        buttons: ['Approve these feature changes', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) throw new Error('Cross-feature authorization was not granted; proposal remains unapproved.');
      featureAuthorization = {
        source: 'main-process-feature-confirmation',
        proposalId: task.proposalId,
        authorizedFeatures: [...new Set([...baselineFeatures, ...additionalFeatures])],
      };
    }
    const approved = developerAgent.approve(id, owner, featureAuthorization);
    const chain = verificationRepairChainsByTask.get(approved.taskId);
    if (options?.autoRepair !== true || !chain || chain.taskIds[0] !== approved.taskId) {
      return {
        ...approved,
        autoRepairEnabled: false,
        autoRepairReason: options?.autoRepair === true
          ? 'Auto mode is available only for the initial proposal in this verification chain.'
          : null,
      };
    }
    const taskRecord = developerAgent.getTaskForTest(approved.taskId);
    const eligibility = autoRepairEligibility(taskRecord);
    if (!eligibility.allowed) {
      chain.autoRepairBlockedReason = eligibility.reason;
      return { ...approved, autoRepairEnabled: false, autoRepairReason: eligibility.reason };
    }
    chain.autoRepairEnabled = true;
    chain.autoRepairBlockedReason = null;
    chain.maxAttempts = runtimeSettings.developer.maxAutoRepairAttempts + 1;
    chain.autoRepairPaths = taskRecord.files.map((file) => ({
      path: file.path,
      operation: file.operation,
    }));
    chain.autoRepairAuthorizedFeatures = [...(taskRecord.approval?.authorizedFeatures || [])];
    return {
    ...approved,
    autoRepairEnabled: true,
    autoRepairReason: null,
    maxAttempts: chain.maxAttempts,
    attemptLabel: `attempt 1 of ${chain.maxAttempts}`,
    };
  });
  ipcMain.handle('developer:proposal-reject', (event, id) => developerAgent.reject(id, { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id }));
  ipcMain.handle('developer:proposal-apply', async (event, id) => {
    const owner = { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id };
    const task = developerAgent.getTaskForTest(id);
    if (!task) throw new Error('Unknown Developer task.');
    developerAgent.getTask(id, owner);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    const chain = verificationRepairChainsByTask.get(task.taskId);
    if (chain && (chain !== activeVerificationRepairChain(currentRoot)
      || chain.ownerWebContentsId !== owner.ownerWebContentsId
      || chain.sessionId !== owner.sessionId
      || chain.status !== 'ready')) {
      throw new Error('Verification repair chain is no longer active.');
    }
    const requestedScripts = chain?.verificationScripts || task.verificationScripts || [];
    const verificationPlan = await developerFiles.getVerificationScripts(event.sender.id, requestedScripts, task.scope);
    const verify = () => {
      if (chain?.verificationConfigHash) {
        return verificationConfigHash(currentRoot).then((currentHash) => {
          if (currentHash !== chain.verificationConfigHash) {
            return {
              ok: false,
              status: 'UNVERIFIED',
              executed: false,
              exitCode: null,
              checks: verificationPlan.scripts,
              attempts: [],
              reason: 'A proposed change altered verification script configuration; the pinned verification command was not run.',
            };
          }
          return runConfiguredVerification();
        });
      }
      return runConfiguredVerification();
    };
    const runConfiguredVerification = () => {
      if (verificationPlan.missing?.length) {
        return Promise.resolve({
          ok: false,
          status: 'COMMAND_NOT_AVAILABLE',
          classification: 'COMMAND_NOT_AVAILABLE',
          failure: 'missing_dependency',
          checks: verificationPlan.scripts,
          attempts: [],
          reason: verificationPlan.reason,
        });
      }
      return developerAgent.runVerificationChecks({
        checks: verificationPlan.scripts,
        isCancelled: () => developerAgent.isCancellationRequested(id, owner),
        onProgress: (progress) => {
          if (progress.check) console.log(`[DEV][VERIFY] task=${id} check=${progress.check}`);
        },
        runCheck: (script) => developerFiles.runVerification(script, event.sender.id, {
          scope: task.scope,
          isCancelled: () => developerAgent.isCancellationRequested(id, owner),
        }).catch((error) => ({
          ok: false,
          script,
          exitCode: null,
          stdout: '',
          stderr: error.message,
          error: error.message,
        })),
      }).then((result) => verificationPlan.reason && result.status === 'NOT_AVAILABLE'
        ? { ...result, reason: verificationPlan.reason }
        : result);
    };
    let attemptNumber = 1;
    if (chain) {
      if (chain.attemptCount >= chain.maxAttempts) {
        chain.status = 'exhausted';
        throw new Error('Verification attempt limit has been reached.');
      }
      attemptNumber = ++chain.attemptCount;
      chain.status = 'applying';
    }
    const authorizeMutation = async (request) => {
      developerAgent.getTask(id, owner);
      developerFiles.assertProjectOwner(event.sender.id);
      if ((await fs.realpath(developerFiles.getProjectRoot(event.sender.id))) !== currentRoot) {
        throw new Error('The selected project changed before the mutation was authorized.');
      }
      const binding = request.requestBinding;
      const taskBinding = task.authorizationContext;
      if (!binding || !taskBinding
        || binding.taskId !== taskBinding.taskId
        || binding.turnId !== taskBinding.turnId
        || binding.requestHash !== taskBinding.requestHash
        || binding.root !== currentRoot
        || binding.scope !== task.scope
        || JSON.stringify(binding.authorizedFeatures) !== JSON.stringify(task.approval?.authorizedFeatures)) {
        throw new Error('Mutation request binding does not match the approved task and feature scope.');
      }
      let deleteConfirmed = false;
      if (request.deleteConfirmationRequired) {
        const targetPaths = request.paths.map((relative) => path.resolve(currentRoot, relative));
        const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning',
          title: 'Confirm file deletion',
          message: request.rollback
            ? 'Confirm deletion of this exact target during rollback?'
            : 'Confirm deletion of this exact approved target?',
          detail: targetPaths.join('\n'),
          buttons: ['Delete target', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (confirmation.response !== 0) return { allowed: false, reason: 'Deletion was not confirmed.' };
        deleteConfirmed = true;
      }
      if ((await fs.realpath(developerFiles.getProjectRoot(event.sender.id))) !== currentRoot) {
        throw new Error('The selected project changed while mutation confirmation was pending.');
      }
      const policyPayload = {
        operation: request.operation,
        paths: request.paths,
        proposalApproved: request.proposalApproved === true,
        deleteConfirmed,
        requestBinding: binding,
      };
      const response = await fetch('http://127.0.0.1:3001/api/coding/policy/file-mutation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coding-Auth': codingAuthToken,
          'X-Coding-Mutation-Proof': codingMutationProof(policyPayload),
        },
        body: JSON.stringify(policyPayload),
      });
      if (!response.ok) throw new Error(`Policy Gate request failed (${response.status}).`);
      const decision = await response.json();
      return {
        allowed: decision?.decision === 'ALLOW',
        reason: typeof decision?.reason === 'string' ? decision.reason : 'Policy Gate denied the mutation.',
      };
    };
    try {
      const result = await developerAgent.apply(id, owner, verify, currentRoot, authorizeMutation, attemptNumber);
      const verifiedSuccess = result.verification?.status === 'PASS'
        && result.verification.executed === true
        && result.verification.exitCode === 0;
      if (chain) chain.status = verifiedSuccess ? 'completed' : 'exhausted';
      return {
        ...result,
        ...verificationRepairPresentation(task, chain),
        attemptNumber,
        attemptLabel: `attempt ${attemptNumber} of ${chain?.maxAttempts || runtimeSettings.developer.maxVerificationAttempts}`,
        repairAvailable: false,
        chainStatus: chain?.status || 'completed',
      };
    } catch (error) {
      if (chain && error.taskSnapshot) {
        chain.status = error.taskSnapshot.verification?.status === 'CODE_FAILURE'
          && chain.attemptCount < chain.maxAttempts
          && !String(error.taskSnapshot.error || '').startsWith('Rollback verification failed:')
          ? 'awaiting_repair'
          : 'exhausted';
        return {
          ...error.taskSnapshot,
          ...verificationRepairPresentation(task, chain),
          attemptNumber,
          attemptLabel: `attempt ${attemptNumber} of ${chain.maxAttempts}`,
          repairAvailable: chain.status === 'awaiting_repair',
          chainStatus: chain.status,
          fileState: chain.status === 'awaiting_repair'
            ? 'Restored to the pre-attempt snapshot.'
            : 'Inspect the recorded verification result and current project files; no further repairs are available.',
        };
      }
      if (error.taskSnapshot) return error.taskSnapshot;
      throw error;
    }
  });
  ipcMain.handle('developer:proposal-undo', async (event, id) => {
    const owner = { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id };
    const task = developerAgent.getTaskMutationContext(id, owner);
    developerFiles.assertProjectOwner(event.sender.id);
    const root = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    if (root !== task.root) throw new Error('The selected project changed after this proposal was applied.');
    const affectedPaths = task.affectedPaths.map((item) => path.resolve(root, item));
    const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      title: 'Confirm proposal undo',
      message: 'Undo this proposal and restore the previous files?',
      detail: affectedPaths.join('\n'),
      buttons: ['Undo and restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return developerAgent.getTask(id, owner);
    const authorizeMutation = async (request) => {
      developerAgent.getTask(id, owner);
      developerFiles.assertProjectOwner(event.sender.id);
      if ((await fs.realpath(developerFiles.getProjectRoot(event.sender.id))) !== root) {
        throw new Error('The selected project changed before the undo mutation was authorized.');
      }
      const binding = request.requestBinding;
      if (!binding
        || binding.taskId !== task.requestBinding.taskId
        || binding.turnId !== task.requestBinding.turnId
        || binding.requestHash !== task.requestBinding.requestHash
        || binding.root !== root
        || binding.scope !== task.scope
        || JSON.stringify(binding.authorizedFeatures) !== JSON.stringify(task.authorizedFeatures)) {
        throw new Error('Undo request binding does not match the original approved task scope.');
      }
      let deleteConfirmed = false;
      if (request.deleteConfirmationRequired) {
        const targetPaths = request.paths.map((relative) => path.resolve(root, relative));
        const deleteApproval = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning',
          title: 'Confirm file deletion',
          message: 'Confirm deletion of this exact target as part of undo?',
          detail: targetPaths.join('\n'),
          buttons: ['Delete target', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (deleteApproval.response !== 0) return { allowed: false, reason: 'Undo deletion was not confirmed.' };
        deleteConfirmed = true;
      }
      if ((await fs.realpath(developerFiles.getProjectRoot(event.sender.id))) !== root) {
        throw new Error('The selected project changed while undo confirmation was pending.');
      }
      const policyPayload = {
        operation: request.operation,
        paths: request.paths,
        proposalApproved: true,
        deleteConfirmed,
        requestBinding: binding,
      };
      const response = await fetch('http://127.0.0.1:3001/api/coding/policy/file-mutation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coding-Auth': codingAuthToken,
          'X-Coding-Mutation-Proof': codingMutationProof(policyPayload),
        },
        body: JSON.stringify(policyPayload),
      });
      if (!response.ok) throw new Error(`Policy Gate request failed (${response.status}).`);
      const decision = await response.json();
      return {
        allowed: decision?.decision === 'ALLOW',
        reason: typeof decision?.reason === 'string' ? decision.reason : 'Policy Gate denied the undo.',
      };
    };
    return developerAgent.undo(id, owner, authorizeMutation, true);
  });
  developerMutationIpcReady = true;
  ipcMain.handle('developer:proposal-get', (event, id) => developerAgent.getTask(id, { sessionId: developerAgent.getSession(event.sender.id), ownerWebContentsId: event.sender.id }));
  ipcMain.handle('developer:proposal-cancel', (event) => {
    const owner = ownedDeveloperSession(event);
    for (const chain of verificationRepairChainsByRoot.values()) {
      if (chain.ownerWebContentsId === owner.ownerWebContentsId && chain.sessionId === owner.sessionId) {
        clearVerificationRepairChain(chain);
      }
    }
    return developerAgent.cancelSession(event.sender.id);
  });
  ipcMain.handle('developer:task-pause', (event, taskId) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.pauseTask(taskId, owner);
  });
  ipcMain.handle('developer:task-resume', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.resumeTask(payload?.taskId, payload?.targetPhase, owner);
  });
  ipcMain.handle('developer:task-steer', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.steerTask(payload?.taskId, payload || {}, owner);
  });
  ipcMain.handle('developer:task-checkpoint-save', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.saveTaskCheckpoint(payload?.taskId, payload?.milestone, {}, owner);
  });
  ipcMain.handle('developer:task-checkpoint-restore', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.restoreTaskCheckpoint(payload?.taskId, payload?.checkpointId, owner);
  });
  ipcMain.handle('developer:task-artifacts', (event, taskId) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.getTaskArtifacts(taskId, owner);
  });
  ipcMain.handle('developer:task-browser-verify', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.verifyTaskBrowser(payload?.taskId, payload?.options || {}, owner);
  });
  ipcMain.handle('developer:dev-server-manage', async (event, payload) => {
    const owner = ownedDeveloperSession(event);
    const task = developerAgent.getTaskMutationContext(payload?.taskId, owner);
    developerFiles.assertProjectOwner(event.sender.id);
    const selectedRoot = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    if (selectedRoot !== task.root) {
      throw new Error('The selected project changed before dev server management.');
    }
    if (payload?.projectRoot && (await fs.realpath(payload.projectRoot)) !== selectedRoot) {
      throw new Error('Renderer-supplied dev server root does not match the selected project.');
    }
    return developerAgent.manageDevServer(payload?.taskId, payload?.action, selectedRoot, owner);
  });
  ipcMain.handle('developer:skills-list', () => developerAgent.listSkills());
  ipcMain.handle('developer:task-skill-assign', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.assignTaskSkill(payload?.taskId, payload?.skillId, owner);
  });
  ipcMain.handle('developer:task-mode-set', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.setTaskOperatingMode(payload?.taskId, payload?.mode, payload?.complexity, owner);
  });
  ipcMain.handle('developer:mcp-tools-list', () => developerAgent.listMcpTools());
  ipcMain.handle('developer:task-mcp-invoke', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.invokeTaskMcpTool(payload?.taskId, payload?.toolName, payload?.params || {}, owner);
  });
  ipcMain.handle('developer:task-checkpoint-save-disk', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.saveTaskCheckpointToDisk(payload?.taskId, payload?.milestone, owner);
  });
  ipcMain.handle('developer:task-checkpoint-restore-disk', async (event, payload) => {
    const owner = ownedDeveloperSession(event);
    developerFiles.assertProjectOwner(event.sender.id);
    const root = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    return developerAgent.restoreTaskFromDisk(payload?.taskId, owner, root);
  });
  ipcMain.handle('developer:task-context-freshness', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.validateTaskContextFreshness(payload?.taskId, payload?.targetSnapshots || [], owner);
  });
  ipcMain.handle('developer:task-hypothesis-refute', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.refuteTaskHypothesis(payload?.taskId, payload?.text, payload?.evidence || {}, owner);
  });
  ipcMain.handle('developer:task-multi-repo-rollback', async (event, payload) => {
    const owner = ownedDeveloperSession(event);
    const taskId = payload?.taskId;
    const task = developerAgent.getTaskMutationContext(taskId, owner);
    developerFiles.assertProjectOwner(event.sender.id);
    const currentRoot = await fs.realpath(developerFiles.getProjectRoot(event.sender.id));
    if (currentRoot !== task.root) {
      throw new Error('The selected project changed before multi-repository rollback.');
    }
    const plan = await developerAgent.getMultiRepoRollbackPlan(taskId, owner);
    if (!plan.length) return { ok: true, rolledBackRepos: [] };
    const scopeRoot = path.resolve(currentRoot, task.scope && task.scope !== '.' ? task.scope : '.');
    const plannedTargets = plan.map((entry) => {
      const repoRoot = path.resolve(entry.repoRoot);
      const target = path.resolve(repoRoot, entry.path);
      const relative = path.relative(scopeRoot, target);
      if (
        path.relative(currentRoot, repoRoot).startsWith(`..${path.sep}`)
        || path.relative(currentRoot, repoRoot) === '..'
        || path.isAbsolute(path.relative(currentRoot, repoRoot))
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new Error(`Multi-repository rollback target is outside the approved project scope: ${entry.path}.`);
      }
      return { ...entry, repoRoot, target };
    });
    const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      title: 'Confirm multi-repository rollback',
      message: 'Restore these exact files to their captured pre-change state?',
      detail: plannedTargets.map((entry) => entry.target).join('\n'),
      buttons: ['Restore listed files', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return { ok: false, cancelled: true, rolledBackRepos: [] };

    const authorizeMutation = async (request) => {
      developerAgent.getTask(taskId, owner);
      developerFiles.assertProjectOwner(event.sender.id);
      if ((await fs.realpath(developerFiles.getProjectRoot(event.sender.id))) !== currentRoot) {
        throw new Error('The selected project changed while rollback confirmation was pending.');
      }
      const requested = request.paths.map((relative) => path.resolve(request.repoRoot, relative));
      if (
        request.paths.length !== 1
        || !plannedTargets.some((entry) => (
          entry.repoRoot === path.resolve(request.repoRoot)
          && entry.operation === request.operation
          && entry.target === requested[0]
        ))
      ) {
        return { allowed: false, reason: 'Rollback target was not included in the confirmed plan.' };
      }
      const relativeToScope = path.relative(scopeRoot, requested[0]);
      if (
        relativeToScope === '..'
        || relativeToScope.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeToScope)
      ) {
        return { allowed: false, reason: 'Rollback target is outside the approved project scope.' };
      }
      let deleteConfirmed = false;
      if (request.deleteConfirmationRequired) {
        const deletion = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning',
          title: 'Confirm rollback deletion',
          message: 'Confirm deletion of this exact file created by the change?',
          detail: requested[0],
          buttons: ['Delete target', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (deletion.response !== 0) return { allowed: false, reason: 'Rollback deletion was not confirmed.' };
        deleteConfirmed = true;
      }
      if ((await fs.realpath(developerFiles.getProjectRoot(event.sender.id))) !== currentRoot) {
        throw new Error('The selected project changed while rollback deletion confirmation was pending.');
      }
      const projectRelativePath = path.relative(currentRoot, requested[0]).replace(/\\/g, '/');
      const requestBinding = {
        ...task.requestBinding,
        authorizedFeatures: [...task.authorizedFeatures],
      };
      if (requestBinding.root !== currentRoot || requestBinding.scope !== task.scope) {
        throw new Error('Rollback request binding no longer matches the approved project scope.');
      }
      const policyPayload = {
        operation: request.operation,
        paths: [projectRelativePath],
        proposalApproved: true,
        deleteConfirmed,
        requestBinding,
      };
      const response = await fetch('http://127.0.0.1:3001/api/coding/policy/file-mutation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coding-Auth': codingAuthToken,
          'X-Coding-Mutation-Proof': codingMutationProof(policyPayload),
        },
        body: JSON.stringify(policyPayload),
      });
      if (!response.ok) throw new Error(`Policy Gate request failed (${response.status}).`);
      const decision = await response.json();
      return {
        allowed: decision?.decision === 'ALLOW',
        reason: typeof decision?.reason === 'string' ? decision.reason : 'Policy Gate denied the rollback.',
      };
    };
    return developerAgent.rollbackMultiRepo(taskId, owner, authorizeMutation);
  });
  ipcMain.handle('developer:task-heartbeat', (event, taskId) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.getTaskHeartbeat(taskId, owner);
  });
  ipcMain.handle('developer:task-disconnect', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.handleClientDisconnect(payload?.taskId, payload?.clientId || String(event.sender.id), owner);
  });
  ipcMain.handle('developer:task-reconnect', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.handleClientReconnect(payload?.taskId, payload?.clientId || String(event.sender.id), owner);
  });
  ipcMain.handle('developer:task-replay', (event, taskId) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.replayTaskEvents(taskId, owner);
  });
  ipcMain.handle('developer:task-worker-cancel', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.cancelWorker(payload?.taskId, payload?.workerId, payload?.reason, owner);
  });
  ipcMain.handle('developer:worktree-baseline-capture', (_event, payload) => {
    return developerAgent.captureWorktreeBaseline(payload?.taskId, payload?.repoRoot, payload?.files || []);
  });
  ipcMain.handle('developer:worktree-preserve-verify', (_event, payload) => {
    return developerAgent.verifyDirtyWorktreePreserved(payload?.taskId, payload?.agentFiles || []);
  });
  ipcMain.handle('developer:task-hidden-contract-define', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.defineHiddenContract(payload?.taskId, payload?.contract || {}, owner);
  });
  ipcMain.handle('developer:task-correctness-evaluate', (event, payload) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.evaluateIndependentCorrectness(payload?.taskId, payload?.patchPayload || {}, payload?.workspaceContext || {}, owner);
  });
  ipcMain.handle('developer:task-patch-quality-evaluate', (_event, payload) => {
    return developerAgent.evaluatePatchQuality(payload?.diffText, payload?.modifiedFiles || [], payload?.targetScope || []);
  });
  ipcMain.handle('developer:task-diff-review-independent', (_event, payload) => {
    return developerAgent.reviewDiffIndependently(payload?.diffText, payload?.taskGoal, payload?.modifiedFiles || []);
  });
  ipcMain.handle('developer:task-defect-diagnose', (_event, payload) => {
    return developerAgent.diagnoseFailureType(payload?.errorOutput, payload?.exitCode, payload?.environmentState || {});
  });
  ipcMain.handle('developer:task-edge-cases-inspect', (_event, payload) => {
    return developerAgent.inspectEdgeCasesAndContract(payload?.symbolInfo || {}, payload?.preInterface || {}, payload?.postInterface || {});
  });
  ipcMain.handle('developer:task-blindness-verify', (event, taskId) => {
    const owner = ownedDeveloperSession(event);
    return developerAgent.verifyTaskBlindness(taskId, owner);
  });
  ipcMain.handle('developer:task-oracle-discovery-audit', (_event, taskId) => {
    return developerAgent.attemptOracleDiscovery(taskId);
  });
  ipcMain.handle('developer:task-worker-conflict-adjudicate', (_event, payload) => {
    return developerAgent.adjudicateWorkerConflict(payload?.workerA || {}, payload?.workerB || {}, payload?.repositoryEvidence || {});
  });
  ipcMain.handle('developer:task-reality-level-classify', (_event, payload) => {
    return developerAgent.classifyRealityLevel(payload?.executionTrace || {});
  });
  ipcMain.handle('developer:business-task-revalidate', (_event, payload) => {
    return developerAgent.revalidateBusinessTask(payload?.taskDef || {});
  });
  ipcMain.handle('developer:business-claim-redline', (_event, payload) => {
    return developerAgent.redlineBusinessClaim(payload?.claim || {});
  });
  ipcMain.handle('general:session', (event) => {
    registerGeneralRenderer(event);
    return generalAgent.getPublicSession(event.sender.id);
  });
  ipcMain.handle('general:task-create', (event, input) => { registerGeneralRenderer(event); return generalAgent.createTask(event.sender.id, input || {}); });
  ipcMain.handle('general:task-get', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.getTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-start', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.startTask(taskId, event.sender.id); });
  ipcMain.handle('general:browser-session-create', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.createExecutionBrowserSession(taskId, event.sender.id); });
  ipcMain.handle('general:browser-operation', (event, taskId, operation, target) => { registerGeneralRenderer(event); return generalAgent.performBrowserOperation(taskId, event.sender.id, operation, target || {}); });
  ipcMain.handle('general:execution-plan', (event, taskId, input) => { registerGeneralRenderer(event); return generalAgent.planExecutionAction(taskId, event.sender.id, input || {}); });
  ipcMain.handle('general:execution-get', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.getExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-validate', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.validateExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-confirmation', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.requestExecutionConfirmation(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-confirm', (event, taskId, actionId, confirmationId) => { registerGeneralRenderer(event); return generalAgent.confirmExecutionAction(taskId, event.sender.id, actionId, confirmationId); });
  ipcMain.handle('general:execution-execute', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.executeExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-observe', (event, taskId, actionId) => { registerGeneralRenderer(event); return generalAgent.observeExecutionAction(taskId, event.sender.id, actionId); });
  ipcMain.handle('general:execution-verify', (event, taskId, actionId, evidence) => { registerGeneralRenderer(event); return generalAgent.verifyExecutionAction(taskId, event.sender.id, actionId, evidence || {}); });
  ipcMain.handle('general:execution-recover', (event, taskId, actionId, options) => { registerGeneralRenderer(event); return generalAgent.recoverExecutionAction(taskId, event.sender.id, actionId, options || {}); });
  ipcMain.handle('general:execution-cancel', (event, taskId, actionId, reason) => { registerGeneralRenderer(event); return generalAgent.cancelExecutionAction(taskId, event.sender.id, actionId, reason); });
  ipcMain.handle('general:task-replan', (event, taskId, input) => { registerGeneralRenderer(event); return generalAgent.replanTask(taskId, event.sender.id, input || {}); });
  ipcMain.handle('general:task-handoff-developer', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.prepareDeveloperHandoff(taskId, event.sender.id); });
  ipcMain.handle('general:capabilities', () => generalAgent.getCapabilityCatalog());
  ipcMain.handle('general:task-stop', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.stopTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-pause', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.pauseTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-resume', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.resumeTask(taskId, event.sender.id); });
  ipcMain.handle('general:task-recover', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.recoverTask(taskId, event.sender.id); });
  ipcMain.handle('general:observe', (event, taskId, observation) => { registerGeneralRenderer(event); return generalAgent.observe(taskId, event.sender.id, observation || {}); });
  ipcMain.handle('general:model-response', (event, taskId, input) => { registerGeneralRenderer(event); return generalAgent.recordModelResponse(taskId, event.sender.id, input || {}); });
  ipcMain.handle('general:prepare-action', (event, taskId, name, args) => { registerGeneralRenderer(event); return generalAgent.prepareAction(taskId, event.sender.id, name, args || {}); });
  ipcMain.handle('general:begin-action', (event, taskId) => { registerGeneralRenderer(event); return generalAgent.beginAction(taskId, event.sender.id); });
  ipcMain.handle('general:confirm-action', (event, taskId, confirmationId) => { registerGeneralRenderer(event); return generalAgent.confirmAction(taskId, event.sender.id, confirmationId); });
  ipcMain.handle('general:complete-action', (event, taskId, result) => { registerGeneralRenderer(event); return generalAgent.completeAction(taskId, event.sender.id, result || {}); });
  ipcMain.handle('general:verify-action', (event, taskId, evidence) => { registerGeneralRenderer(event); return generalAgent.verifyAction(taskId, event.sender.id, evidence || {}); });
  ipcMain.handle('general:login-required', (event, taskId, reason) => { registerGeneralRenderer(event); return generalAgent.requestLogin(taskId, event.sender.id, reason); });
  ipcMain.handle('general:login-status', (event, taskId, status) => { registerGeneralRenderer(event); return generalAgent.completeLogin(taskId, event.sender.id, status); });
  ipcMain.handle('general:task-complete', (event, taskId, status, evidence) => { registerGeneralRenderer(event); return generalAgent.finishTask(taskId, event.sender.id, status, evidence); });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ['media'].includes(permission);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (process.platform !== 'win32') {
      // Electron does not provide a general system-output loopback stream on
      // macOS/Linux. Those platforms require a supported virtual audio route.
      callback({});
      return;
    }

    try {
      const screenSources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
      const windowSources = screenSources.length > 0
        ? []
        : await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 1, height: 1 },
        });
      const source = screenSources[0] || windowSources[0];
      if (!source) {
        callback({});
        return;
      }

      // Chromium's Windows loopback captures the selected display/window
      // output, not the physical microphone. The renderer discards the video
      // track and records only the loopback audio track.
      callback({ video: source, audio: 'loopback' });
    } catch (error) {
      console.error('[AUDIO] System-audio source setup failed:', error);
      callback({});
    }
  });

  overlayState = await readOverlayState();
  registerOverlayShortcuts();
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  isQuitting = true;
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
  unregisterOverlayShortcuts();
  globalShortcut.unregisterAll();
});
