import { runtimeConfig } from '../../config/runtimeConfig';

export interface MeetingChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

export interface MeetingChatRequest {
  mode: string;
  messages: MeetingChatMessage[];
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
}

const MEETING_WS_URL = `${runtimeConfig.wsUrl.replace(/\/+$/, '')}/meeting`;

export class MeetingAgentTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  async send(request: MeetingChatRequest): Promise<MeetingChatResult> {
    const socket = await this.connect();
    const requestId = crypto.randomUUID();
    const result = new Promise<MeetingChatResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    socket.send(JSON.stringify({
      type: 'chat',
      agent: 'meeting',
      requestId,
      ...request,
    }));
    return result;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    socket?.close();
    for (const [requestId, request] of this.pending) {
      this.pending.delete(requestId);
      request.reject(new Error('The Meeting Assistant connection was closed before the answer completed.'));
    }
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const promise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(MEETING_WS_URL);
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to the Meeting Assistant service.'));
      }, 10000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.socket = socket;
        resolve(socket);
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Could not connect to the isolated Meeting Assistant service.'));
      };
      socket.onclose = () => {
        window.clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        this.connecting = null;
        for (const [requestId, request] of this.pending) {
          this.pending.delete(requestId);
          request.reject(new Error('The Meeting Assistant connection closed before the answer completed.'));
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
    if (message.type === 'done') {
      this.pending.delete(requestId);
      request.resolve({
        content: String(message.content || ''),
        provider: typeof message.provider === 'string' ? message.provider : undefined,
        model: typeof message.model === 'string' ? message.model : undefined,
      });
    } else if (message.type === 'error') {
      this.pending.delete(requestId);
      request.reject(new Error(String(message.message || 'The Meeting Assistant request failed.')));
    }
  }
}
