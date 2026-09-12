import { WebSocketServer } from 'ws';
import { streamDirect } from '../llm/directLlm.js';
import { streamLangChain } from '../llm/langchainLlm.js';
import { trimContext } from '../pdf/pdfExtractor.js';

/**
 * WebSocket server — the heart of the streaming experience.
 *
 * Protocol (JSON messages from client → server):
 *   { type: "chat", messages: [...], mode: "direct"|"langchain", pdfContext: "..." }
 *
 * Server → client messages:
 *   { type: "token",  content: "..." }   — one token chunk
 *   { type: "done",   content: "..." }   — full text, stream finished
 *   { type: "error",  message: "..." }  — something went wrong
 */
export function startWebSocketServer(port) {
  const wss = new WebSocketServer({ port });

  console.log(`WebSocket server listening on ws://localhost:${port}`);

  wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');

    ws.on('message', async (raw) => {
      let payload;

      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid JSON message.',
        }));
      }

      if (payload.type !== 'chat') {
        return ws.send(JSON.stringify({
          type: 'error',
          message: `Unknown message type: ${payload.type}`,
        }));
      }

      const { messages, mode = 'direct', pdfContext = '', requestId = '' } = payload;
      const responseMeta = typeof requestId === 'string' ? { requestId } : {};

      if (!Array.isArray(messages) || messages.length === 0) {
        return ws.send(JSON.stringify({
          type: 'error',
          message: 'No messages provided.',
        }));
      }

      // Give the assistant a stable role without pretending it can inspect files
      // or services that the user has not supplied in this conversation.
      const finalMessages = [{
        role: 'system',
        content:
          'You are a concise AI software-engineering assistant. Use only the project context, code, documents, and conversation supplied by the user. ' +
          'Do not claim to access files, repositories, services, credentials, or test results that were not provided. ' +
          'When enough context is supplied, answer directly; otherwise ask for the smallest useful missing detail. ' +
          'For general conversation, respond naturally and briefly.',
      }, ...(messages || [])];

      if (pdfContext && pdfContext.trim()) {
        const trimmed = trimContext(pdfContext);
        finalMessages.push({
          role: 'system',
          content:
            'The following is supporting project context, code, meeting text, or document text provided by the user. ' +
            'Use it only when it is relevant to answer their question.\n\n--- SUPPLIED CONTEXT ---\n' +
            trimmed +
            '\n--- END SUPPLIED CONTEXT ---',
        });
      }

      let tokenBuffer = '';
      let tokenFlushTimer = null;
      const flushTokens = () => {
        if (tokenFlushTimer) {
          clearTimeout(tokenFlushTimer);
          tokenFlushTimer = null;
        }
        if (!tokenBuffer) return;
        if (ws.readyState !== ws.OPEN) {
          tokenBuffer = '';
          return;
        }
        ws.send(JSON.stringify({ type: 'token', content: tokenBuffer, ...responseMeta }));
        tokenBuffer = '';
      };
      const onToken = (token) => {
        tokenBuffer += token;
        // Batch tiny provider chunks for one animation frame's worth of work.
        if (!tokenFlushTimer) tokenFlushTimer = setTimeout(flushTokens, 16);
      };

      try {
        const streamFn = mode === 'langchain' ? streamLangChain : streamDirect;
        const fullText = await streamFn({ messages: finalMessages, onToken });

        flushTokens();
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'done', content: fullText, ...responseMeta }));
      } catch (err) {
        flushTokens();
        console.error('Stream error:', err.message);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'error',
            message: err.message,
            ...responseMeta,
          }));
        }
      }
    });

    ws.on('close', () => console.log('WebSocket client disconnected'));
    ws.on('error', (err) => console.error('WebSocket error:', err.message));
  });

  return wss;
}
