import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import OpenAI, { toFile } from 'openai';
import {
  config,
  getConfiguredProviders,
  removeConfiguredProvider,
  reorderConfiguredProviders,
  setAgentPermissions,
  setFallbackEnabled,
  setConfiguredProviderStatus,
  setRuntimeProvider,
  updateConfiguredProvider,
  upsertConfiguredProvider,
} from './config.js';
import { getConfiguredProviderCapabilities, getProviderCapabilities, getProviderInfo, selfTestProvider } from './llm/provider.js';
import { extractTextFromPdfBuffer } from './pdf/pdfExtractor.js';
import { startWebSocketServer } from './ws/websocketServer.js';

// The server can start without a configured key so the local health and
// provider-settings endpoints remain available for first-time setup.
const activeProvider = config[config.provider];
if (activeProvider?.apiKey && !activeProvider.apiKey.includes('your_')) {
  console.log(`Using LLM provider: ${config.provider} (model: ${activeProvider.model})`);
} else {
  console.warn(`No API key configured for provider "${config.provider}". Configure one in the app before chatting.`);
}

const app = express();
const agentActivity = [];
const MAX_AGENT_ACTIVITY = 100;

function recordAgentActivity(target) {
  agentActivity.unshift({
    id: randomUUID(),
    target,
    action: 'open-requested',
    createdAt: new Date().toISOString(),
  });
  if (agentActivity.length > MAX_AGENT_ACTIVITY) agentActivity.length = MAX_AGENT_ACTIVITY;
}

function configuredProvidersWithCapabilities() {
  const capabilities = new Map(getConfiguredProviderCapabilities().map((item) => [item.id, item]));
  return getConfiguredProviders().map((provider) => ({
    ...provider,
    ...(capabilities.get(provider.id) || {}),
  }));
}

function storeSelfTestStatus(adapterType, model, result) {
  const storedStatus = result.status === 'READY' ? 'ok' : String(result.status || 'unknown').toLowerCase().replace(/_/g, '-');
  for (const provider of config.configuredProviders) {
    if (provider.adapterType === adapterType && (!model || provider.model === model)) {
      setConfiguredProviderStatus(provider.id, storedStatus, result.status === 'READY' ? '' : (result.reason || result.status || ''));
    }
  }
}

// Desktop-control endpoints must never accept requests from another machine.
// Electron, Vite, and a local browser all reach this server through loopback.
function requireLocalControlRequest(req, res, next) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    return res.status(403).json({ error: 'Desktop controls are available only from this computer.' });
  }
  next();
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// --- Multer: accept a single PDF upload in memory ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.server.maxPdfMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed.'));
    }
  },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.server.maxPdfMb * 1024 * 1024 },
});

const STT_TRANSCRIPTION_PROMPT = process.env.TRANSCRIPTION_PROMPT
  || 'Technical vocabulary: Spring Boot, Spring Security, Java, JavaScript, TypeScript, React, Node.js, Python, FastAPI, OpenAI, Copilot, Groq, API, SQL, PostgreSQL, MySQL, Docker, Kubernetes, AWS, Azure, GitHub.';

function classifySttError(error) {
  const status = error?.status || error?.statusCode;
  const message = String(error?.message || '').toLowerCase();
  if (status === 401 || status === 403 || /unauthorized|forbidden|api key|authentication/.test(message)) return 'STT_AUTH_ERROR';
  if (status === 429 || /rate limit|too many requests/.test(message)) return 'STT_RATE_LIMIT';
  if ([404, 405, 501].includes(status) || /not found|method not allowed|transcription is not supported|audio transcription/.test(message)) return 'STT_PROVIDER_ERROR';
  if (status === 400 || status === 422) return 'STT_BAD_REQUEST';
  if (/unsupported|codec|mime|audio format/.test(message)) return 'STT_UNSUPPORTED_AUDIO';
  if (/timeout|timed out/.test(message)) return 'STT_TIMEOUT';
  if (/network|fetch|connection/.test(message)) return 'STT_NETWORK_ERROR';
  return 'STT_UNKNOWN';
}

// --- Health / info endpoint ---
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    ...getProviderInfo(),
    wsPort: config.server.wsPort,
  });
});

app.get('/api/settings/providers/capabilities', (_req, res) => {
  res.json({
    active: getProviderInfo(),
    providers: getProviderCapabilities(),
  });
});

app.post('/api/settings/providers/self-test', async (req, res) => {
  const requested = typeof req.body?.provider === 'string' ? req.body.provider : config.provider;
  try {
    const result = await selfTestProvider(requested);
    storeSelfTestStatus(requested, result.model, result);
    res.status(result.status === 'READY' ? 200 : 503).json(result);
  } catch (error) {
    storeSelfTestStatus(requested, config[requested]?.model, { status: 'NETWORK_ERROR' });
    res.status(503).json({
      provider: requested,
      status: 'NETWORK_ERROR',
      message: 'Provider self-test failed.',
    });
  }
});

app.post('/api/settings/provider', async (req, res) => {
  try {
    const { provider, apiKey, model, baseURL, fallbackEnabled } = req.body || {};
    setRuntimeProvider({ provider, apiKey, model, baseURL });
    if (typeof fallbackEnabled === 'boolean') setFallbackEnabled(fallbackEnabled);
    const capability = await selfTestProvider(provider);
    storeSelfTestStatus(provider, model, capability);
    res.json({
      status: 'ok',
      provider: config.provider,
      model: config[config.provider].model,
      capability,
    });
  } catch (err) {
    const status = err?.status === 429 ? 429 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/settings/providers', (_req, res) => {
  res.json({ providers: configuredProvidersWithCapabilities(), fallbackEnabled: config.fallbackEnabled });
});

app.post('/api/settings/providers', async (req, res) => {
  try {
    const provider = upsertConfiguredProvider(req.body || {});
    const capability = await selfTestProvider(provider.adapterType);
    storeSelfTestStatus(provider.adapterType, provider.model, capability);
    res.json({
      provider: { ...provider, apiKey: undefined, ...capability },
      providers: configuredProvidersWithCapabilities(),
      capability,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/settings/providers/:id', (req, res) => {
  try {
    const provider = updateConfiguredProvider(req.params.id, req.body || {});
    res.json({ provider: { ...provider, apiKey: undefined }, providers: configuredProvidersWithCapabilities() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/settings/providers/:id', (req, res) => {
  removeConfiguredProvider(req.params.id);
  res.json({ providers: configuredProvidersWithCapabilities() });
});

app.post('/api/settings/providers/reorder', (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) throw new Error('Provider IDs must be an array.');
    reorderConfiguredProviders(req.body.ids);
    res.json({ providers: configuredProvidersWithCapabilities() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/settings/agent', requireLocalControlRequest, (req, res) => {
  setAgentPermissions(req.body || {});
  res.json({ status: 'ok', permissions: config.agentPermissions });
});

app.get('/api/agent/activity', requireLocalControlRequest, (_req, res) => {
  res.json({ activity: agentActivity });
});

app.post('/api/agent/open', requireLocalControlRequest, (req, res) => {
  const { target, url, confirmed } = req.body || {};
  if (confirmed !== true) return res.status(400).json({ error: 'A local user confirmation is required before opening an app.' });
  const allowedApps = {
    teams: { permission: 'openTeams', command: 'msteams:' },
    camera: { permission: 'openCamera', command: 'microsoft.windows.camera:' },
    chrome: { permission: 'openChrome', command: 'chrome:' },
    vscode: { permission: 'openVSCode', command: 'code:' },
    desktop: { permission: 'openDesktop', command: 'shell:Desktop' },
    sourcetree: { permission: 'openSourceTree', command: 'sourcetree:' },
    sqlserver: { permission: 'openSqlServer', command: 'ssms:' },
    notepad: { permission: 'openNotepad', command: 'notepad.exe' },
    sublime: { permission: 'openSublime', command: 'sublime_text:' },
  };
  if (allowedApps[target]) {
    const app = allowedApps[target];
    if (!config.agentPermissions[app.permission]) return res.status(403).json({ error: `Permission to open ${target} is disabled.` });
    spawn('cmd.exe', ['/c', 'start', '', app.command], { windowsHide: true, detached: true }).unref();
    recordAgentActivity(target);
    return res.json({ status: 'ok', action: `${target}-open-requested` });
  }
  if (target === 'browser') {
    if (!config.agentPermissions.openBrowser) return res.status(403).json({ error: 'Open browser permission is disabled.' });
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Only http and https URLs are allowed.' });
    spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref();
    // The URL is intentionally not retained in the activity log.
    recordAgentActivity(target);
    return res.json({ status: 'ok', action: 'browser-open-requested' });
  }
  return res.status(400).json({ error: 'Unsupported safe action.' });
});

// --- PDF upload endpoint ---
// POST /api/extract-pdf  with multipart form field "file"
app.post('/api/extract-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const text = await extractTextFromPdfBuffer(req.file.buffer);
    res.json({
      text,
      pages: text.length > 0 ? Math.ceil(text.length / 3000) : 0,
      filename: req.file.originalname,
      size: req.file.size,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Meeting audio transcription endpoint ---
// POST /api/transcribe-audio with multipart form field "file"
app.post('/api/transcribe-audio', audioUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio recording uploaded.', classification: 'STT_BAD_REQUEST' });
  }

  try {
    const sttSession = req.get('X-STT-Session-ID') || 'unknown';
    const segmentId = req.get('X-STT-Segment-ID') || 'unknown';
    console.log(JSON.stringify({
      event: 'STT_REQUEST_STARTED',
      sttSession,
      segmentId,
      payloadBytes: req.file.size,
      encoding: req.file.mimetype || 'unknown',
    }));
    const active = config[config.provider];
    const client = new OpenAI({ apiKey: active.apiKey, baseURL: active.baseURL });
    const transcriptionModel = process.env.TRANSCRIPTION_MODEL
      || (config.provider === 'openai' ? 'whisper-1' : 'whisper-large-v3-turbo');
    const transcriptionOptions = {
      file: await toFile(req.file.buffer, req.file.originalname || 'meeting.webm'),
      model: transcriptionModel,
      response_format: 'text',
      prompt: STT_TRANSCRIPTION_PROMPT,
      temperature: 0,
    };
    const transcriptionLanguage = process.env.TRANSCRIPTION_LANGUAGE?.trim();
    if (transcriptionLanguage) transcriptionOptions.language = transcriptionLanguage;
    const transcript = await client.audio.transcriptions.create(transcriptionOptions);
    console.log(JSON.stringify({
      event: 'STT_RESPONSE_RECEIVED',
      sttSession,
      segmentId,
      status: 200,
      transcriptLength: String(transcript).length,
      classification: 'STT_SUCCESS',
    }));
    res.json({ text: transcript, confidence: null, isFinal: true, classification: 'STT_SUCCESS' });
  } catch (err) {
    const classification = classifySttError(err);
    console.error(JSON.stringify({
      event: 'STT_RESPONSE_FAILED',
      classification,
      errorType: err?.constructor?.name || 'Error',
    }));
    res.status(502).json({ error: 'Audio transcription failed.', classification });
  }
});

// --- Start HTTP server ---
app.listen(config.server.port, () => {
  console.log(`HTTP API server listening on http://localhost:${config.server.port}`);
});

// --- Start WebSocket server (separate port) ---
startWebSocketServer(config.server.wsPort);
