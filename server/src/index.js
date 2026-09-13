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
  setRuntimeProvider,
  updateConfiguredProvider,
  upsertConfiguredProvider,
} from './config.js';
import { getProviderInfo } from './llm/provider.js';
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

// --- Health / info endpoint ---
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    ...getProviderInfo(),
    wsPort: config.server.wsPort,
  });
});

app.post('/api/settings/provider', async (req, res) => {
  try {
    const { provider, apiKey, model, baseURL, fallbackEnabled } = req.body || {};
    setRuntimeProvider({ provider, apiKey, model, baseURL });
    if (typeof fallbackEnabled === 'boolean') setFallbackEnabled(fallbackEnabled);
    res.json({ status: 'ok', provider: config.provider, model: config[config.provider].model });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/settings/providers', (_req, res) => {
  res.json({ providers: getConfiguredProviders(), fallbackEnabled: config.fallbackEnabled });
});

app.post('/api/settings/providers', (req, res) => {
  try {
    const provider = upsertConfiguredProvider(req.body || {});
    res.json({ provider: { ...provider, apiKey: undefined }, providers: getConfiguredProviders() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/settings/providers/:id', (req, res) => {
  try {
    const provider = updateConfiguredProvider(req.params.id, req.body || {});
    res.json({ provider: { ...provider, apiKey: undefined }, providers: getConfiguredProviders() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/settings/providers/:id', (req, res) => {
  removeConfiguredProvider(req.params.id);
  res.json({ providers: getConfiguredProviders() });
});

app.post('/api/settings/providers/reorder', (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) throw new Error('Provider IDs must be an array.');
    reorderConfiguredProviders(req.body.ids);
    res.json({ providers: getConfiguredProviders() });
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
    return res.status(400).json({ error: 'No audio recording uploaded.' });
  }

  try {
    console.log(`[AUDIO] Audio chunk received (${req.file.size} bytes, ${req.file.mimetype || 'unknown format'})`);
    console.log('[STT] Transcribing audio chunk');
    const active = config[config.provider];
    const client = new OpenAI({ apiKey: active.apiKey, baseURL: active.baseURL });
    const transcript = await client.audio.transcriptions.create({
      file: await toFile(req.file.buffer, req.file.originalname || 'meeting.webm'),
      model: process.env.TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo',
      response_format: 'text',
    });
    console.log(`[STT] Final transcript: "${String(transcript).slice(0, 240)}"`);
    res.json({ text: transcript, confidence: null, isFinal: true });
  } catch (err) {
    console.error('[STT] Speech-to-text failed:', err.message);
    res.status(502).json({ error: `Audio transcription failed: ${err.message}` });
  }
});

// --- Start HTTP server ---
app.listen(config.server.port, () => {
  console.log(`HTTP API server listening on http://localhost:${config.server.port}`);
});

// --- Start WebSocket server (separate port) ---
startWebSocketServer(config.server.wsPort);
