import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const HEALTH_URL = 'http://127.0.0.1:3001/api/health';
const WS_URL = 'ws://127.0.0.1:3002';
const timeoutMs = 90000;

async function fetchHealth() {
  const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
  const health = await response.json();
  return {
    httpStatus: response.status,
    configured: Boolean(health.configured),
    provider: health.provider || null,
    model: health.model || null,
    reachable: response.ok,
    toolCallingVerified: Boolean(health.toolCallingVerified),
    assistantCapable: Boolean(health.assistantCapable),
    developerStatus: health.developerStatus || null,
  };
}

function safeArgumentSummary(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object') return {};
  return Object.fromEntries(Object.entries(argumentsValue).map(([key, value]) => [
    key,
    typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}...` : value,
  ]));
}

async function safeReadOnlyTool(name, argumentsValue) {
  const requested = argumentsValue?.relativePath || argumentsValue?.path || '';
  if (name === 'list_directory' && (requested === '' || requested === '.')) {
    const entries = await fs.readdir(path.resolve('.'), { withFileTypes: true });
    return {
      ok: true,
      tool: name,
      relativePath: '.',
      entries: entries.filter((entry) => entry.name === 'package.json').map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      })),
    };
  }
  if (name === 'read_file' && path.normalize(requested) === 'package.json') {
    const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
    return {
      ok: true,
      tool: name,
      relativePath: 'package.json',
      exists: true,
      content: JSON.stringify({ name: packageJson.name, version: packageJson.version }),
    };
  }
  return {
    ok: false,
    tool: name,
    error: 'Validation only permits bounded read-only access to package.json.',
  };
}

function runWebSocketRequest(payload) {
  return new Promise((resolve, reject) => {
    const requestId = `provider-live-e2e-${Date.now()}`;
    const socket = new WebSocket(WS_URL);
    const startedAt = Date.now();
    const result = {
      requestId,
      events: [],
      toolCalls: [],
      toolResults: [],
      continuations: 0,
      content: '',
      timing: null,
    };
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Provider-backed WebSocket request timed out.'));
    }, timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve({ ...result, elapsedMs: Date.now() - startedAt });
    };
    socket.on('open', () => socket.send(JSON.stringify({ ...payload, requestId })));
    socket.on('message', async (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        finish(new Error('Provider WebSocket returned invalid JSON.'));
        return;
      }
      result.events.push(event.type);
      if (event.type === 'token') result.content += event.content || '';
      if (event.type === 'tool_call') {
        const call = {
          name: event.name,
          arguments: safeArgumentSummary(event.arguments),
          toolCallId: event.toolCallId,
        };
        result.toolCalls.push(call);
        const toolResult = await safeReadOnlyTool(event.name, event.arguments || {});
        result.toolResults.push({
          name: event.name,
          ok: toolResult.ok,
          relativePath: toolResult.relativePath || null,
        });
        socket.send(JSON.stringify({
          type: 'tool_result',
          requestId,
          toolCallId: event.toolCallId,
          result: toolResult,
        }));
      }
      if (event.type === 'done') {
        result.content = event.content || result.content;
        result.continuations = Number(event.rounds || 0);
        result.timing = event.timing || null;
        result.runtimeState = {
          phase: event.runtimeState?.phase || null,
          completionStatus: event.completionState?.status || null,
        };
        finish();
      }
      if (event.type === 'error') finish(new Error(event.message || 'Provider WebSocket request failed.'));
    });
    socket.on('error', (error) => finish(error));
  });
}

const health = await fetchHealth();
assert.equal(health.reachable, true);
assert.equal(health.configured, true, 'Provider must be configured for live E2E.');
assert.equal(health.toolCallingVerified, true, 'Provider tool calling must be verified.');

const direct = await runWebSocketRequest({
  type: 'chat',
  mode: 'direct',
  messages: [{ role: 'user', content: 'Hello. Reply with exactly: GENERAL_AGENT_LIVE_OK' }],
});
assert.equal(direct.content.trim(), 'GENERAL_AGENT_LIVE_OK');
assert.ok(direct.events.includes('done'));

const loop = await runWebSocketRequest({
  type: 'chat',
  mode: 'developer',
  developer: true,
  messages: [{
    role: 'user',
    content: 'Use only read-only tools. Inspect package.json exactly once, then answer with the package name and whether the file exists. Do not propose changes.',
  }],
});
assert.ok(loop.toolCalls.length >= 1, 'The live model must emit at least one tool call.');
assert.equal(loop.toolCalls.some((call) => call.name === 'read_file'), true, 'The live model must request read_file.');
assert.equal(loop.toolResults.some((result) => result.name === 'read_file' && result.ok), true);
assert.ok(loop.events.includes('tool_call'));
assert.ok(loop.events.includes('done'));
assert.ok(loop.continuations >= 1, 'The model/tool continuation must complete at least one round.');
assert.match(loop.content, /vite-react-typescript-starter/);
assert.match(loop.content, /exists/i);

console.log(JSON.stringify({
  provider: {
    configured: health.configured,
    reachable: health.reachable,
    name: health.provider,
    model: health.model,
    toolCallingVerified: health.toolCallingVerified,
    assistantCapable: health.assistantCapable,
    developerStatus: health.developerStatus,
  },
  directModelRequest: {
    status: 'PASS',
    response: direct.content,
    events: direct.events,
    elapsedMs: direct.elapsedMs,
    timing: direct.timing,
  },
  modelToolLoop: {
    status: 'PASS',
    toolCalls: loop.toolCalls.map(({ name, arguments: args }) => ({ name, arguments: args })),
    toolResults: loop.toolResults,
    continuationRounds: loop.continuations,
    events: loop.events,
    finalAnswer: loop.content,
    elapsedMs: loop.elapsedMs,
    timing: loop.timing,
    runtimeCompletionStatus: loop.runtimeState?.completionStatus || null,
  },
}));
