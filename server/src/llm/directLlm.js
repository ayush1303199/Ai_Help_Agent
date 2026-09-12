import { config } from '../config.js';
import { getClient } from './provider.js';

/**
 * Direct LLM implementation — calls the Groq/OpenAI API with the
 * official SDK, no framework.  This is the simplest path: you build
 * the messages array, call `chat.completions.create`, and stream the
 * response token-by-token.
 *
 * `onToken` is called for every chunk as it arrives.
 * The function resolves with the full text once the stream ends.
 */
async function streamProvider({ provider, messages, onToken }) {
  const active = config[provider];
  if (!active?.apiKey || !active?.model) throw new Error(`Provider ${provider} is not configured.`);

  if (provider === 'anthropic') {
      const response = await fetch(`${active.baseURL}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': active.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: active.model, max_tokens: config.server.maxTokens, stream: true, messages: messages.filter((message) => message.role !== 'system') }),
      });
      if (!response.ok || !response.body) throw new Error(`${response.status} ${await response.text()}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          const token = event.delta?.text || '';
          if (token) { fullText += token; onToken(token); }
        }
      }
      return fullText;
  }

    const client = getClient(provider);
    const stream = await client.chat.completions.create({
      model: active.model,
      messages,
      stream: true,
      max_tokens: config.server.maxTokens,
      temperature: 0.3,
    });

    let fullText = '';

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || '';
      if (token) {
        fullText += token;
        onToken(token);
      }
    }

    return fullText;
}

export async function streamDirect({ messages, onToken }) {
  const providers = [
    config.provider,
    ...(config.fallbackEnabled ? Object.keys(config.runtimeProviders) : []),
  ].filter((provider, index, list) => list.indexOf(provider) === index);
  let lastError;

  for (const provider of providers) {
    try {
      return await streamProvider({ provider, messages, onToken });
    } catch (err) {
      lastError = err;
      console.warn(`Provider ${provider} failed; trying fallback: ${err.message}`);
    }
  }

  throw new Error(`Direct LLM error: ${lastError?.message || 'No configured provider available.'}`);
}
