import { runtimeConfig } from '../../config/runtimeConfig.ts';

export function latestCodingUserRequest(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content;
  }
  return '';
}

export interface CodingReadFile {
  path: string;
  content: string;
}

export interface CodingTransportResult {
  requestId: string;
  content: string;
  proposalRequired: boolean;
  status?: string;
  readOnly?: boolean;
  writeRequired?: boolean;
  applyRequired?: boolean;
  approvalRequired?: boolean;
  intent?: string;
  confidence?: string;
  performanceEvidence?: Record<string, unknown> | null;
  plan?: Record<string, unknown>;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown>; round: number }>;
  filesRead: CodingReadFile[];
  filesSearched: string[];
  providerId?: string | null;
  provider?: string | null;
  model?: string | null;
  configuredProviderId?: string | null;
  fallback?: boolean;
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

export async function codingAuthHeaders(): Promise<Record<string, string>> {
  const getToken = window.electronAPI?.getDeveloperBackendAuthToken;
  if (!getToken) {
    throw new Error('Coding Agent backend access is available only through the trusted desktop application.');
  }
  const token = await getToken();
  if (!token) throw new Error('Coding Agent backend authentication is unavailable.');
  return { 'X-Coding-Auth': token };
}

export async function codingFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Coding-Auth', (await codingAuthHeaders())['X-Coding-Auth']);
  return fetch(input, { ...init, headers });
}

export class CodingAgentTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly requests = new Map<string, CodingRequestState>();

  async send(
    requestId: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    scope: string,
    handlers: CodingHandlers,
    conversationId?: string,
  ): Promise<string> {
    const request = latestCodingUserRequest(messages);
    if (!request.trim()) throw new Error('The current Coding Agent request is missing. Please send it again.');
    const socket = await this.connect();
    let turnId = `browser-turn-${requestId.slice(0, 8)}`;
    let sessionId = conversationId
      ? (conversationId.startsWith('coding-session-') ? conversationId : `coding-session-${conversationId}`)
      : `browser-session-${requestId.slice(0, 8)}`;
    let currentProjectRoot = '';
    let currentScope = scope || '.';

    if (window.electronAPI) {
      const turn = await window.electronAPI.beginDeveloperConversation(request, scope);
      turnId = turn.turnId;
      sessionId = turn.sessionId || sessionId;
      currentProjectRoot = turn.projectRoot;
      currentScope = turn.scope;
      handlers.onStart(turn.turnId, turn.projectRoot, turn.scope);
      await window.electronAPI.advanceDeveloperConversation({
        turnId: turn.turnId,
        state: 'understanding',
        phase: 'understanding',
      });
    } else {
      try {
        const stateRes = await codingFetch('http://127.0.0.1:3001/api/coding/project-state');
        if (stateRes.ok) {
          const st = await stateRes.json();
          if (st.projectRoot) currentProjectRoot = st.projectRoot;
        }
      } catch {
        // Fallback to unattached if backend query fails
      }
      handlers.onStart(turnId, currentProjectRoot, currentScope);
    }

    this.requests.set(requestId, {
      scope: currentScope,
      handlers,
      chunks: [],
      filesRead: new Map(),
      filesSearched: new Set(),
      toolCalls: [],
    });
    socket.send(JSON.stringify({
      type: 'chat',
      requestId,
      sessionId,
      conversationId: conversationId || sessionId,
      turnId,
      projectRoot: currentProjectRoot,
      scope: currentScope,
      messages,
    }));
    return turnId;
  }

  async markTurn(turnId: string, state: 'completed' | 'failed' | 'cancelled', phase?: string, fileCount?: number) {
    if (window.electronAPI) {
      return window.electronAPI.advanceDeveloperConversation({ turnId, state, phase, fileCount });
    }
    return { ok: true, state };
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
    this.connecting = (async () => {
      const token = (await codingAuthHeaders())['X-Coding-Auth'];
      return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(CODING_WS_URL);
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to the Coding Agent service.'));
      }, runtimeConfig.limits.transportConnectTimeoutMs);
      let authenticated = false;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'authenticate', token }));
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Could not connect to the isolated Coding Agent service.'));
      };
      socket.onclose = () => {
        this.socket = null;
        this.connecting = null;
        if (!authenticated) reject(new Error('Coding Agent authentication failed.'));
        for (const [requestId, request] of this.requests) {
          this.requests.delete(requestId);
          request.handlers.onError(new Error('The Coding Agent connection closed before the request completed.'));
        }
      };
      socket.onmessage = (event) => {
        if (!authenticated) {
          let response: Record<string, unknown>;
          try {
            response = JSON.parse(String(event.data)) as Record<string, unknown>;
          } catch {
            socket.close();
            reject(new Error('Coding Agent authentication failed.'));
            return;
          }
          if (response.type !== 'authenticated' || response.authenticated !== true) {
            socket.close();
            reject(new Error('Coding Agent authentication failed.'));
            return;
          }
          authenticated = true;
          window.clearTimeout(timeout);
          this.socket = socket;
          resolve(socket);
          return;
        }
        void this.handleMessage(socket, event.data);
      };
      });
    })().finally(() => {
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
      const rawName = String(message.name || '');
      const rawArgs = message.arguments && typeof message.arguments === 'object'
        ? message.arguments as Record<string, unknown>
        : {};

      let name = rawName;
      const args = { ...rawArgs };

      // Canonical tool aliases
      if (name === 'repo_browser.search_code' || name === 'find_code' || name === 'search_files') {
        name = 'search_code';
      } else if (name === 'repo_browser.read_file' || name === 'open_file') {
        name = 'read_file';
      } else if (name === 'repo_browser.list_directory' || name === 'ls') {
        name = 'list_directory';
      }

      // Argument aliases
      if (name === 'search_code' && !args.query && typeof args.pattern === 'string') {
        args.query = args.pattern;
      }
      if (name === 'search_code' && !args.query && typeof args.q === 'string') {
        args.query = args.q;
      }
      if (name === 'read_file' && !args.relativePath && typeof args.path === 'string') {
        args.relativePath = args.path;
      }
      if (name === 'list_directory' && !args.relativePath && typeof args.path === 'string') {
        args.relativePath = args.path;
      }

      request.toolCalls.push({ name, arguments: args, round: request.toolCalls.length + 1 });
      let result: unknown;
      try {
        if (window.electronAPI) {
          result = await window.electronAPI.executeDeveloperTool(name, args, request.scope);
        } else {
          const res = await codingFetch('http://127.0.0.1:3001/api/coding/tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, arguments: args, scope: request.scope }),
          });
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            result = {
              ok: false,
              tool: name,
              error: {
                code: 'CODING_TOOL_FAILED',
                message: (errBody as { detail?: string })?.detail || `HTTP ${res.status}`,
              },
            };
          } else {
            result = await res.json();
          }
        }
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
        status: typeof message.status === 'string' ? message.status : undefined,
        readOnly: message.readOnly === true,
        writeRequired: message.writeRequired === true,
        applyRequired: message.applyRequired === true,
        approvalRequired: message.approvalRequired === true,
        intent: typeof message.intent === 'string' ? message.intent : undefined,
        confidence: typeof message.confidence === 'string' ? message.confidence : undefined,
        performanceEvidence: message.performanceEvidence && typeof message.performanceEvidence === 'object'
          ? (message.performanceEvidence as Record<string, unknown>)
          : null,
        plan: message.plan && typeof message.plan === 'object' ? message.plan as Record<string, unknown> : undefined,
        toolCalls: request.toolCalls,
        filesRead: (() => {
          const map = new Map<string, string>(request.filesRead);
          const rawIncoming = (message as Record<string, unknown>).filesRead;
          const incoming = Array.isArray(rawIncoming) ? rawIncoming : [];
          for (const item of incoming) {
            if (item && typeof item === 'object') {
              const file = item as Partial<CodingReadFile>;
              if (typeof file.path === 'string' && typeof file.content === 'string' && !map.has(file.path)) {
                map.set(file.path, file.content);
              }
            }
          }
          return [...map.entries()].map(([path, content]) => ({ path, content }));
        })(),
        filesSearched: [...request.filesSearched],
        providerId: typeof message.providerId === 'string' ? message.providerId : null,
        provider: typeof message.provider === 'string' ? message.provider : null,
        model: typeof message.model === 'string' ? message.model : null,
        configuredProviderId: typeof message.configuredProviderId === 'string' ? message.configuredProviderId : null,
        fallback: message.fallback === true,
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
    const isReadTool = name === 'read_file' || name === 'repo_browser.read_file' || name === 'repo_browser.open_file' || name === 'open_file';
    const isSearchTool = name === 'search_code' || name === 'repo_browser.search_code' || name === 'find_code' || name === 'search_files' || name === 'get_context';

    if (isReadTool && data && typeof data === 'object') {
      const file = data as Partial<CodingReadFile>;
      if (typeof file.path === 'string' && typeof file.content === 'string') request.filesRead.set(file.path, file.content);
    }
    if (isSearchTool && data && typeof data === 'object') {
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
