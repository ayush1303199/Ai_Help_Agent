import { runtimeConfig } from '../../config/runtimeConfig';

export interface CodingReadFile {
  path: string;
  content: string;
}

export interface CodingTransportResult {
  requestId: string;
  content: string;
  proposalRequired: boolean;
  plan?: Record<string, unknown>;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; round: number }>;
  filesRead: CodingReadFile[];
  filesSearched: string[];
  provider?: string | null;
  model?: string | null;
}

export interface CodingActivity {
  phase: string;
  message: string;
  plan?: Record<string, unknown>;
}

interface CodingHandlers {
  onStart: (turnId: string, projectRoot: string, scope: string) => void;
  onActivity: (activity: CodingActivity) => void;
  onToken: (content: string) => void;
  onDone: (result: CodingTransportResult) => void;
  onError: (error: Error) => void;
}

interface CodingRequestState {
  scope: string;
  handlers: CodingHandlers;
  chunks: string[];
  filesRead: Map<string, string>;
  filesSearched: Set<string>;
  toolCalls: CodingTransportResult['toolCalls'];
}

const CODING_WS_URL = runtimeConfig.codingWsUrl;

export class CodingAgentTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly requests = new Map<string, CodingRequestState>();

  async send(
    requestId: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    scope: string,
    providerId: string | null,
    handlers: CodingHandlers,
  ): Promise<string> {
    if (!window.electronAPI) throw new Error('Coding Agent desktop IPC is unavailable.');
    const socket = await this.connect();
    const turn = await window.electronAPI.beginDeveloperConversation(messages[messages.length - 1]?.content || '', scope);
    handlers.onStart(turn.turnId, turn.projectRoot, turn.scope);
    await window.electronAPI.advanceDeveloperConversation({
      turnId: turn.turnId,
      state: 'understanding',
      phase: 'understanding',
    });
    this.requests.set(requestId, {
      scope: turn.scope,
      handlers,
      chunks: [],
      filesRead: new Map(),
      filesSearched: new Set(),
      toolCalls: [],
    });
    socket.send(JSON.stringify({
      type: 'chat',
      requestId,
      scope: turn.scope,
      ...(providerId ? { providerId } : {}),
      messages,
    }));
    return turn.turnId;
  }

  async markTurn(turnId: string, state: 'completed' | 'failed' | 'cancelled', phase?: string, fileCount?: number) {
    if (!window.electronAPI) throw new Error('Coding Agent desktop IPC is unavailable.');
    return window.electronAPI.advanceDeveloperConversation({ turnId, state, phase, fileCount });
  }

  close() {
    this.requests.clear();
    this.socket?.close();
    this.socket = null;
    this.connecting = null;
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(CODING_WS_URL);
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to the Coding Agent service.'));
      }, runtimeConfig.limits.transportConnectTimeoutMs);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.socket = socket;
        resolve(socket);
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Could not connect to the isolated Coding Agent service.'));
      };
      socket.onclose = () => {
        this.socket = null;
        this.connecting = null;
        for (const [requestId, request] of this.requests) {
          this.requests.delete(requestId);
          request.handlers.onError(new Error('The Coding Agent connection closed before the request completed.'));
        }
      };
      socket.onmessage = (event) => {
        void this.handleMessage(socket, event.data);
      };
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async handleMessage(socket: WebSocket, raw: unknown) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const requestId = String(message.requestId || '');
    const request = this.requests.get(requestId);
    if (!request) return;
    if (message.type === 'activity') {
      const phase = String(message.phase || 'working');
      const detail = typeof message.message === 'string' ? message.message : 'Working on your request.';
      request.handlers.onActivity({
        phase,
        message: detail,
        plan: message.plan && typeof message.plan === 'object' ? message.plan as Record<string, unknown> : undefined,
      });
      return;
    }
    if (message.type === 'token') {
      const chunk = String(message.content || '');
      request.chunks.push(chunk);
      request.handlers.onToken(chunk);
      return;
    }
    if (message.type === 'tool_call') {
      const toolCallId = String(message.toolCallId || '');
      const name = String(message.name || '');
      const args = message.arguments && typeof message.arguments === 'object'
        ? message.arguments as Record<string, unknown>
        : {};
      request.toolCalls.push({ name, arguments: args, round: request.toolCalls.length + 1 });
      let result: unknown;
      try {
        if (!window.electronAPI) throw new Error('Coding Agent desktop IPC is unavailable.');
        result = await window.electronAPI.executeDeveloperTool(name, args, request.scope);
        this.collectFileEvidence(name, result, request);
      } catch (error) {
        result = {
          ok: false,
          tool: name,
          error: {
            code: 'CODING_TOOL_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'tool_result', requestId, toolCallId, result }));
      }
      return;
    }
    if (message.type === 'done') {
      this.requests.delete(requestId);
      request.handlers.onDone({
        requestId,
        content: String(message.content || request.chunks.join('')),
        proposalRequired: message.proposalRequired === true,
        plan: message.plan && typeof message.plan === 'object' ? message.plan as Record<string, unknown> : undefined,
        toolCalls: request.toolCalls,
        filesRead: [...request.filesRead].map(([path, content]) => ({ path, content })),
        filesSearched: [...request.filesSearched],
        provider: typeof message.provider === 'string' ? message.provider : null,
        model: typeof message.model === 'string' ? message.model : null,
      });
      return;
    }
    if (message.type === 'error') {
      this.requests.delete(requestId);
      request.handlers.onError(new Error(String(message.message || 'Coding Agent request failed.')));
    }
  }

  private collectFileEvidence(name: string, value: unknown, request: CodingRequestState) {
    if (!value || typeof value !== 'object') return;
    const response = value as { data?: unknown };
    const data = response.data;
    if (name === 'read_file' && data && typeof data === 'object') {
      const file = data as Partial<CodingReadFile>;
      if (typeof file.path === 'string' && typeof file.content === 'string') request.filesRead.set(file.path, file.content);
    }
    if ((name === 'search_code' || name === 'get_context') && data && typeof data === 'object') {
      const results = (data as { results?: unknown }).results;
      if (Array.isArray(results)) {
        for (const result of results) {
          if (result && typeof result === 'object' && typeof (result as { path?: unknown }).path === 'string') {
            request.filesSearched.add((result as { path: string }).path);
          }
        }
      }
    }
  }
}
