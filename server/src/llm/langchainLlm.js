import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { config } from '../config.js';
import { isFallbackError, normalizeProviderError, providerOrder } from './provider.js';
import { setConfiguredProviderStatus } from '../config.js';

/**
 * LangChain implementation.
 *
 * Why LangChain here?
 *   - `ChatOpenAI` gives a provider-agnostic chat model that works with
 *     any OpenAI-compatible endpoint (Groq, OpenAI, local, etc.).
 *   - The `stream()` method yields `AIMessageChunk` objects token-by-token,
 *     which we forward to the WebSocket.
 *   - In a larger app you could compose this model into chains, RAG
 *     retrievers, or agents — the interface stays the same.
 *
 * To switch providers, only `config.js` changes — this file does not.
 */

let _model = null;
let _modelKey = null;

function getModel(provider) {
  const active = typeof provider === 'string' ? config[provider] : provider;
  const providerId = typeof provider === 'string' ? provider : provider.adapterType;
  const modelKey = `${providerId}|${active.apiKey}|${active.model}|${active.baseURL}`;
  if (_model && _modelKey === modelKey) return _model;

  _model = new ChatOpenAI({
    openAIApiKey: active.apiKey,
    modelName: active.model,
    temperature: 0.7,
    streaming: true,
    configuration: { baseURL: active.baseURL },
  });
  _modelKey = modelKey;

  return _model;
}

/**
 * Stream a response using LangChain's `model.stream()`.
 * `onToken` fires for every chunk; resolves with the full text.
 */
async function streamOne({ provider, messages, onToken }) {
  try {
    const model = getModel(provider);

    const lcMessages = messages.map((m) => {
      if (m.role === 'system') return new SystemMessage(m.content);
      return new HumanMessage(m.content);
    });

    const stream = await model.stream(lcMessages);
    let fullText = '';

    for await (const chunk of stream) {
      const token = chunk.content;
      if (typeof token === 'string' && token) {
        fullText += token;
        onToken(token);
      }
    }

    return fullText;
  } catch (err) {
    throw normalizeProviderError(err, provider.label || provider.adapterType || provider);
  }
}

export async function streamLangChain({ messages, onToken }) {
  let lastError;
  for (const provider of providerOrder()) {
    try {
      const result = await streamOne({ provider, messages, onToken });
      if (provider.id) setConfiguredProviderStatus(provider.id, 'ok');
      return result;
    } catch (error) {
      lastError = normalizeProviderError(error, provider.label || provider.adapterType || provider);
      if (provider.id) setConfiguredProviderStatus(provider.id, lastError.kind === 'quota' ? 'quota-exceeded' : lastError.kind === 'invalid_key' ? 'invalid-key' : 'error', lastError.message);
      if (!isFallbackError(lastError)) throw lastError;
    }
  }
  throw lastError || new Error('No configured provider available.');
}
