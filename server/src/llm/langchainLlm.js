import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { config } from '../config.js';

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

function getModel() {
  const active = config[config.provider];
  const modelKey = `${config.provider}|${active.apiKey}|${active.model}|${active.baseURL}`;
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
export async function streamLangChain({ messages, onToken }) {
  try {
    const model = getModel();

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
    throw new Error(`LangChain LLM error: ${err.message}`);
  }
}
