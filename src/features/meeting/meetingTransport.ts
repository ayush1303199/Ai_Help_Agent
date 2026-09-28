import { runtimeConfig } from '../../config/runtimeConfig.ts';

export interface MeetingChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

export interface MeetingChatRequest {
  mode: string;
  messages: MeetingChatMessage[];
  providerId?: string;
  interviewContext?: Record<string, unknown>;
  pdfContext?: string;
}

export interface MeetingChatResult {
  content: string;
  provider?: string;
  model?: string;
}

interface PendingRequest {
  resolve: (result: MeetingChatResult) => void;
  reject: (error: Error) => void;
  timeout: number;
  signal?: AbortSignal;
  abortListener?: () => void;
}

const MEETING_WS_URL = `${runtimeConfig.wsUrl.replace(/\/+$/, '')}/meeting`;

export class MeetingAgentTransport {
  private socket: WebSocket | null = null;
  private connectingSocket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  async send(request: MeetingChatRequest, signal?: AbortSignal): Promise<MeetingChatResult> {
    if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    const socket = await this.connect(signal);
    if (signal?.aborted) {
      socket.close();
      throw new DOMException('The request was cancelled.', 'AbortError');
    }
    const requestId = crypto.randomUUID();
    const result = new Promise<MeetingChatResult>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        signal?.removeEventListener('abort', abortListener);
        reject(new Error('The Meeting Assistant did not return an answer in time. Please try again.'));
      }, runtimeConfig.limits.transportRequestTimeoutMs);
      const abortListener = () => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        window.clearTimeout(pending.timeout);
        signal?.removeEventListener('abort', abortListener);
        socket.close();
        reject(new DOMException('The request was cancelled.', 'AbortError'));
      };
      this.pending.set(requestId, { resolve, reject, timeout, signal, abortListener });
      signal?.addEventListener('abort', abortListener, { once: true });
    });
    try {
      socket.send(JSON.stringify({
        type: 'chat',
        agent: 'meeting',
        requestId,
        ...request,
      }));
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        window.clearTimeout(pending.timeout);
        pending.signal?.removeEventListener('abort', pending.abortListener!);
        this.pending.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  close() {
    const socket = this.socket;
    const connectingSocket = this.connectingSocket;
    this.socket = null;
    this.connectingSocket = null;
    this.connecting = null;
    socket?.close();
    if (connectingSocket && connectingSocket !== socket) connectingSocket.close();
    for (const [requestId, request] of this.pending) {
      window.clearTimeout(request.timeout);
      request.signal?.removeEventListener('abort', request.abortListener!);
      this.pending.delete(requestId);
      request.reject(new Error('The Meeting Assistant connection was closed before the answer completed.'));
    }
  }

  private connect(signal?: AbortSignal): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const promise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(MEETING_WS_URL);
      this.connectingSocket = socket;
      let settled = false;
      const timeout = window.setTimeout(() => {
        settled = true;
        socket.close();
        if (this.connectingSocket === socket) this.connectingSocket = null;
        reject(new Error('Timed out connecting to the Meeting Assistant service.'));
      }, runtimeConfig.limits.transportConnectTimeoutMs);
      socket.onopen = () => {
        if (signal?.aborted || settled) {
          window.clearTimeout(timeout);
          socket.close();
          reject(new DOMException('The request was cancelled.', 'AbortError'));
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        if (this.connectingSocket === socket) this.connectingSocket = null;
        this.socket = socket;
        resolve(socket);
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        settled = true;
        window.clearTimeout(timeout);
        if (this.connectingSocket === socket) this.connectingSocket = null;
        reject(new Error('Could not connect to the isolated Meeting Assistant service.'));
      };
      socket.onclose = () => {
        const wasSettled = settled;
        settled = true;
        window.clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        if (this.connectingSocket === socket) this.connectingSocket = null;
        this.connecting = null;
        if (!wasSettled) reject(new Error('The Meeting Assistant connection closed before it was ready.'));
        for (const [requestId, request] of this.pending) {
          this.pending.delete(requestId);
          window.clearTimeout(request.timeout);
          request.signal?.removeEventListener('abort', request.abortListener!);
          request.reject(new Error('The Meeting Assistant connection closed before the answer completed.'));
        }
      };
    }).finally(() => {
      if (this.connectingSocket === null) this.connecting = null;
    });
    this.connecting = promise;
    if (!signal) return promise;
    return Promise.race([
      promise,
      new Promise<WebSocket>((_resolve, reject) => {
        const abort = () => {
          this.connectingSocket?.close();
          reject(new DOMException('The request was cancelled.', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
        promise.finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
      }),
    ]);
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
    if (message.type === 'done') {
      window.clearTimeout(request.timeout);
      request.signal?.removeEventListener('abort', request.abortListener!);
      this.pending.delete(requestId);
      request.resolve({
        content: String(message.content || ''),
        provider: typeof message.provider === 'string' ? message.provider : undefined,
        model: typeof message.model === 'string' ? message.model : undefined,
      });
    } else if (message.type === 'error') {
      window.clearTimeout(request.timeout);
      request.signal?.removeEventListener('abort', request.abortListener!);
      this.pending.delete(requestId);
      request.reject(new Error(String(message.message || 'The Meeting Assistant request failed.')));
    }
  }
}
