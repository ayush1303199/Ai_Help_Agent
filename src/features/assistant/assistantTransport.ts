import { runtimeConfig } from '../../config/runtimeConfig';

export interface AssistantChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

export interface AssistantChatRequest {
  mode: string;
  messages: AssistantChatMessage[];
  interviewContext?: Record<string, unknown>;
  pdfContext?: string;
}

export interface AssistantChatResult {
  content: string;
  provider?: string;
  model?: string;
  timing?: Record<string, unknown>;
}

export interface AssistantTransportHandlers {
  onToken?: (content: string) => void;
}

interface PendingRequest {
  handlers: AssistantTransportHandlers;
  resolve: (result: AssistantChatResult) => void;
  reject: (error: Error) => void;
}

interface AssistantTransportOptions {
  onConnectionChange?: (connected: boolean) => void;
}

const ASSISTANT_WS_URL = `${runtimeConfig.wsUrl.replace(/\/+$/, '')}/assistant`;

/**
 * The Assistant socket is deliberately owned by the Assistant feature.  A
 * single multiplexed connection keeps streaming and draft-improvement
 * requests independent without exposing WebSocket details to App.tsx.
 */
export class AssistantAgentTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: AssistantTransportOptions = {}) {}

  warm() {
    void this.connect().catch(() => undefined);
  }

  async send(
    request: AssistantChatRequest & { requestId: string },
    handlers: AssistantTransportHandlers = {},
  ): Promise<AssistantChatResult> {
    const socket = await this.connect();
    let rejectResult: (error: Error) => void = () => undefined;
    const result = new Promise<AssistantChatResult>((resolve, reject) => {
      rejectResult = reject;
      this.pending.set(request.requestId, { handlers, resolve, reject });
    });
    try {
      socket.send(JSON.stringify({
        type: 'chat',
        agent: 'assistant',
        ...request,
      }));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.pending.delete(request.requestId);
      // Return the same promise so the caller observes the synchronous send
      // failure through the normal request error path.
      rejectResult(failure);
    }
    return result;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    socket?.close();
    this.options.onConnectionChange?.(false);
    for (const [requestId, request] of this.pending) {
      this.pending.delete(requestId);
      request.reject(new Error('The Assistant connection was closed before the answer completed.'));
    }
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    const promise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(ASSISTANT_WS_URL);
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to the Assistant service.'));
      }, 10000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.socket = socket;
        this.options.onConnectionChange?.(true);
        resolve(socket);
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        window.clearTimeout(timeout);
        this.options.onConnectionChange?.(false);
        reject(new Error('WebSocket connection failed. Is the WS server running on port 3002?'));
      };
      socket.onclose = () => {
        window.clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        this.connecting = null;
        this.options.onConnectionChange?.(false);
        for (const [requestId, request] of this.pending) {
          this.pending.delete(requestId);
          request.reject(new Error('The Assistant connection closed before the answer completed.'));
        }
      };
    }).finally(() => {
      this.connecting = null;
    });
    this.connecting = promise;
    return promise;
  }

  private handleMessage(raw: unknown) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const requestId = String(message.requestId || '');
    const request = this.pending.get(requestId);
    if (!request) return;
    if (message.type === 'token') {
      request.handlers.onToken?.(String(message.content || ''));
      return;
    }
    if (message.type === 'done') {
      this.pending.delete(requestId);
      request.resolve({
        content: String(message.content || ''),
        provider: typeof message.provider === 'string' ? message.provider : undefined,
        model: typeof message.model === 'string' ? message.model : undefined,
        timing: message.timing && typeof message.timing === 'object'
          ? message.timing as Record<string, unknown>
          : undefined,
      });
      return;
    }
    if (message.type === 'error') {
      this.pending.delete(requestId);
      const failure = new Error(String(message.message || 'The Assistant request failed.'));
      Object.assign(failure, {
        remote: true,
        failureClassification: typeof message.failureClassification === 'string'
          ? message.failureClassification
          : undefined,
      });
      request.reject(failure);
    }
  }
}
