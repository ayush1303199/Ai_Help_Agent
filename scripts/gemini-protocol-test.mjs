import assert from 'node:assert/strict';
import {
  buildGeminiContents,
  buildGeminiRequest,
  convertToolsToGemini,
  getProviderCapabilities,
  isGeminiFunctionCallingModel,
  isFallbackError,
  normalizeProviderError,
  parseGeminiResponse,
  providerOrder,
  providerSupportsToolCalling,
} from '../server/src/llm/provider.js';
import { config } from '../server/src/config.js';

const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file.',
    parameters: {
      type: 'object',
      required: ['relativePath'],
      properties: {
        relativePath: { type: 'string' },
        options: {
          type: 'object',
          properties: { encoding: { type: 'string' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
};

const original = {
  provider: config.provider,
  fallbackEnabled: config.fallbackEnabled,
  gemini: config.gemini,
  configuredProviders: config.configuredProviders,
};

try {
  assert.equal(isGeminiFunctionCallingModel('gemini-2.0-flash'), true);
  assert.equal(isGeminiFunctionCallingModel('gemini-2.0-flash-lite'), true);
  assert.equal(isGeminiFunctionCallingModel('gemini-1.0-pro-vision'), false);
  assert.equal(providerSupportsToolCalling('gemini', 'gemini-2.0-flash'), true);
  assert.equal(providerSupportsToolCalling('gemini', 'gemini-unknown'), false);
  const rateLimit = normalizeProviderError(Object.assign(new Error('Too many requests'), { status: 429 }), 'gemini');
  assert.equal(rateLimit.category, 'RATE_LIMIT');
  assert.equal(isFallbackError(rateLimit), true);
  const capacity = normalizeProviderError(Object.assign(new Error('high demand'), { status: 503 }), 'gemini');
  assert.equal(capacity.category, 'CAPACITY_503');
  assert.equal(isFallbackError(capacity), true);

  const converted = convertToolsToGemini([tool]);
  assert.deepEqual(converted[0], {
    name: 'read_file',
    description: 'Read a file.',
    parameters: {
      type: 'object',
      required: ['relativePath'],
      properties: {
        relativePath: { type: 'string' },
        options: {
          type: 'object',
          properties: { encoding: { type: 'string' } },
        },
      },
    },
  });

  const request = buildGeminiRequest({
    messages: [
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: 'Read package.json.' },
    ],
    tools: [tool],
    toolChoice: 'required',
  });
  assert.deepEqual(request.systemInstruction, { parts: [{ text: 'Use tools when needed.' }] });
  assert.equal(request.contents[0].role, 'user');
  assert.equal(request.contents[0].parts[0].text, 'Read package.json.');
  assert.deepEqual(request.tools[0].functionDeclarations, converted);
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: 'ANY' } });

  const convertedConversation = buildGeminiContents([
    { role: 'user', content: 'Read package.json.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"relativePath":"package.json"}' },
        geminiThoughtSignature: 'opaque-signature',
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'read_file',
      content: '{"ok":true,"text":"{}"}',
    },
  ]);
  assert.deepEqual(convertedConversation.contents, [
    { role: 'user', parts: [{ text: 'Read package.json.' }] },
    { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { relativePath: 'package.json' } }, thoughtSignature: 'opaque-signature' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { ok: true, text: '{}' } } }] },
  ]);

  const parsed = parseGeminiResponse({
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { relativePath: 'package.json' } }, thoughtSignature: 'opaque-signature' },
          { text: 'I will inspect that file.' },
        ],
      },
    }],
  });
  assert.equal(parsed.role, 'assistant');
  assert.equal(parsed.tool_calls.length, 1);
  assert.equal(parsed.tool_calls[0].function.name, 'read_file');
  assert.equal(parsed.tool_calls[0].geminiThoughtSignature, 'opaque-signature');
  assert.deepEqual(JSON.parse(parsed.tool_calls[0].function.arguments), { relativePath: 'package.json' });
  assert.match(parsed.tool_calls[0].id, /^gemini-call-/);
  assert.equal(parsed.content, 'I will inspect that file.');

  config.provider = 'gemini';
  config.fallbackEnabled = true;
  config.gemini = { apiKey: 'test-key', model: 'gemini-2.0-flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta' };
  config.configuredProviders = [
    {
      id: 'ready-gemini',
      label: 'Gemini',
      adapterType: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      baseURL: config.gemini.baseURL,
      enabled: true,
      priority: 1,
      status: 'ok',
    },
    {
      id: 'unverified-gemini',
      label: 'Unverified Gemini',
      adapterType: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      baseURL: config.gemini.baseURL,
      enabled: true,
      priority: 2,
      status: 'unknown',
    },
  ];
  const developerProviders = providerOrder({ requireToolCalling: true });
  assert.deepEqual(developerProviders.map((provider) => provider.id), ['ready-gemini']);
  const geminiCapability = getProviderCapabilities().find((item) => item.provider === 'gemini');
  assert.equal(geminiCapability.developerToolCalling, true);
  assert.equal(geminiCapability.assistantCapable, true);

  console.log('gemini protocol tests passed');
} finally {
  config.provider = original.provider;
  config.fallbackEnabled = original.fallbackEnabled;
  config.gemini = original.gemini;
  config.configuredProviders = original.configuredProviders;
}
