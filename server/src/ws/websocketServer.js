import { WebSocketServer } from 'ws';
import { streamDirect } from '../llm/directLlm.js';
import { streamLangChain } from '../llm/langchainLlm.js';
import { completeDeveloper, validateToolCall } from '../llm/developerTools.js';
import { trimContext } from '../pdf/pdfExtractor.js';
import { developerDecisionPrompt, buildReadPlan, updateEvidence, evidenceContinuationPrompt, evaluateUnderstanding, clarificationDecision } from '../llm/developerDecisionEngine.js';

/**
 * WebSocket server — the heart of the streaming experience.
 *
 * Protocol (JSON messages from client → server):
 *   { type: "chat", messages: [...], mode: "direct"|"langchain", pdfContext: "..." }
 *
 * Server → client messages:
 *   { type: "token",  content: "..." }   — one token chunk
 *   { type: "done",   content: "..." }   — full text, stream finished
 *   { type: "tool_call", name, arguments, toolCallId } — developer read request
 *   { type: "error",  message: "..." }  — something went wrong
 *
 * Developer clients answer tool_call with:
 *   { type: "tool_result", requestId, toolCallId, result|error }
 */
function buildFinalizationMessages(toolMessages, lastUserMessage) {
  let remainingChars = 12000;
  const evidenceMessages = toolMessages
    .filter((message) => message.role === 'tool' && remainingChars > 0)
    .map((message) => {
      const content = String(message.content || '').slice(0, Math.min(3000, remainingChars));
      remainingChars -= content.length;
      return {
        role: 'system',
        content: `Read-only tool result (${message.tool_call_id}): ${content}`,
      };
    });
  return [
    {
      role: 'system',
      content: 'Finalization turn. Tools are disabled. Do not emit a tool call. Use only the read-only evidence below and answer the user in plain text. Clearly state any remaining uncertainty.',
    },
    { role: 'user', content: lastUserMessage },
    ...evidenceMessages,
  ];
}

export function startWebSocketServer(port) {
  const wss = new WebSocketServer({ port });

  console.log(`WebSocket server listening on ws://localhost:${port}`);

  wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    const pendingToolCalls = new Map();
    const completedToolCalls = new Map();

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

      if (payload.type === 'tool_result') {
        const key = `${payload.requestId}:${payload.toolCallId}`;
        const pending = pendingToolCalls.get(key);
        if (!pending) return;
        pendingToolCalls.delete(key);
        completedToolCalls.set(key, payload.result);
        pending.resolve(payload.result);
        return;
      }

      if (payload.type !== 'chat') {
        return ws.send(JSON.stringify({
          type: 'error',
          message: `Unknown message type: ${payload.type}`,
        }));
      }

      const { messages, mode = 'direct', pdfContext = '', requestId = '', developer = false } = payload;
      const responseMeta = typeof requestId === 'string' ? { requestId } : {};

      if (!Array.isArray(messages) || messages.length === 0) {
        return ws.send(JSON.stringify({
          type: 'error',
          message: 'No messages provided.',
        }));
      }

      // Developer tools are an explicit, request-scoped protocol. The server
      // never touches the filesystem: the Electron renderer executes each
      // approved read-only call through its existing IPC handlers.
      if (developer === true || mode === 'developer') {
        const startedAt = performance.now();
        const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
        const readPlan = buildReadPlan(lastUserMessage);
        console.log(`[DEVELOPER][DECISION] request=${requestId} intent=${readPlan.classification.intent} writeRequired=${readPlan.classification.writeRequired} risk=${readPlan.classification.risk} next=${readPlan.nextStep}`);
        const toolMessages = [
          { role: 'system', content: developerDecisionPrompt(lastUserMessage) },
          ...messages.map((message) => ({ ...message })),
        ];
        const evidence = {};
        const maxRounds = 6;
        let finalMessage = null;
        try {
          for (let round = 0; round < maxRounds; round += 1) {
            console.log(`[DEVELOPER][ROUND] request=${requestId} round=${round + 1}`);
            const message = await completeDeveloper({ messages: toolMessages });
            toolMessages.push(message);
            if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
              finalMessage = message;
              break;
            }
            for (const call of message.tool_calls) {
              const { name, args } = validateToolCall(call);
              const toolCallId = String(call.id || `${name}-${round}`);
              const key = `${requestId}:${toolCallId}`;
              console.log(`[DEVELOPER][TOOL] request=${requestId} round=${round + 1} tool=${name}`);
              if (completedToolCalls.has(key)) {
                toolMessages.push({
                  role: 'tool',
                  tool_call_id: toolCallId,
                  name,
                  content: JSON.stringify(completedToolCalls.get(key)).slice(0, 12000),
                });
                continue;
              }
              if (ws.readyState !== ws.OPEN) throw new Error('Developer client disconnected.');
              const resultPromise = new Promise((resolve, reject) => {
                pendingToolCalls.set(key, { resolve, reject });
                setTimeout(() => {
                  if (!pendingToolCalls.has(key)) return;
                  pendingToolCalls.delete(key);
                  reject(new Error('Developer tool timed out.'));
                }, 30000);
              });
              ws.send(JSON.stringify({
                type: 'tool_call',
                requestId,
                toolCallId,
                name,
                arguments: args,
              }));
              const result = await resultPromise;
              const serialized = JSON.stringify(result ?? null);
              Object.assign(evidence, updateEvidence(evidence, name, result));
              toolMessages.push({
                role: 'tool',
                tool_call_id: toolCallId,
                name,
                content: serialized.slice(0, 12000),
              });
            }
            const understanding = evaluateUnderstanding({ request: lastUserMessage, evidence });
            const clarification = clarificationDecision(evidence);
            console.log(`[DEVELOPER][EVIDENCE] request=${requestId} state=${understanding.state} decision=${understanding.decision} scope=${understanding.scope.state}`);
            if (clarification && evidence.searches > 1 && (evidence.filesRead || []).length >= 2) {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'decision', requestId, decision: clarification }));
              finalMessage = { content: clarification.question };
              break;
            }
            toolMessages.push({ role: 'system', content: evidenceContinuationPrompt(lastUserMessage, evidence) });
          }
          if (!finalMessage) {
            // Preserve the bounded tool-call budget, then give the provider one
            // final answer-only turn using the evidence already collected.
            toolMessages.push({
              role: 'system',
              content: 'The read-only exploration budget is complete. Do not request another tool. Give the best evidence-based final answer now, and clearly state any remaining uncertainty.',
            });
            finalMessage = await completeDeveloper({
              messages: buildFinalizationMessages(toolMessages, lastUserMessage),
              allowTools: false,
            });
          }
          const content = typeof finalMessage.content === 'string' ? finalMessage.content : '';
          if (content && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'token', content, ...responseMeta }));
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
            type: 'done',
            content,
            rounds: toolMessages.filter((message) => message.role === 'assistant' && message.tool_calls).length,
            timing: { providerRequestMs: Math.round(performance.now() - startedAt), timeToFirstTokenMs: content ? 0 : null },
            ...responseMeta,
          }));
        } catch (err) {
          console.error(`[DEVELOPER][ERROR] request=${requestId}:`, err.message);
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: err.message, ...responseMeta }));
        }
        return;
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
      const requestStartedAt = performance.now();
      let firstTokenAt = null;
      console.log(`[TIMING] Provider request started at: ${new Date().toISOString()} request=${requestId}`);
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
        if (firstTokenAt === null) {
          firstTokenAt = performance.now();
          console.log(`[TIMING] First provider token at: ${new Date().toISOString()} request=${requestId} elapsed=${Math.round(firstTokenAt - requestStartedAt)}ms`);
        }
        tokenBuffer += token;
        // Batch tiny provider chunks for one animation frame's worth of work.
        if (!tokenFlushTimer) tokenFlushTimer = setTimeout(flushTokens, 16);
      };

      try {
        const streamFn = mode === 'langchain' ? streamLangChain : streamDirect;
        const fullText = await streamFn({ messages: finalMessages, onToken, requestId });
        const responseReceivedAt = performance.now();
        console.log(`[LLM][FINAL] request=${requestId} length=${fullText.length} startsWith=${JSON.stringify(fullText.slice(0, 80))}`);
        console.log(`[TIMING] Provider response received at: ${new Date().toISOString()} request=${requestId} elapsed=${Math.round(responseReceivedAt - requestStartedAt)}ms`);

        flushTokens();
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
          type: 'done',
          content: fullText,
          timing: {
            providerRequestMs: Math.round(responseReceivedAt - requestStartedAt),
            timeToFirstTokenMs: firstTokenAt === null ? null : Math.round(firstTokenAt - requestStartedAt),
          },
          ...responseMeta,
        }));
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
