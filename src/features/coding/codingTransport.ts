import { runtimeConfig } from '../../config/runtimeConfig.ts';
import {
  parseCodingActivityEvent,
  type CodingActivity,
  type CodingActivityMessage,
} from './codingActivity.ts';

export {
  finalizeCodingActivities,
  parseCodingActivityEvent,
  upsertCodingActivity,
} from './codingActivity.ts';
export type {
  CodingActivity,
  CodingActivityError,
  CodingActivityEvent,
  CodingActivityMessage,
  CodingActivityResult,
  CodingActivityStatus,
  CodingActivityType,
} from './codingActivity';

export function latestCodingUserRequest(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content;
  }
  return '';
}

export function adaptiveCodingIdleTimeoutMs(
  configuredIdleTimeoutMs: number,
  operationTimeoutMs: number,
) {
  return Math.min(
    Math.max(1000, configuredIdleTimeoutMs),
    Math.max(1000, operationTimeoutMs + 10000),
  );
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
  agentTaskState?: {
    status?: string;
    originalRequest?: string;
    nextAction?: {
      tool?: string;
      reason?: string;
      expectedEvidence?: string[];
    } | null;
  } | null;
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
  verificationAttempt?: { attemptNumber: number; maxAttempts: number; label: string } | null;
}

export interface CodingProviderRecovery {
  state: string;
  classification: string;
  retryable: boolean;
  suggestedAction?: string;
  retryAfterSeconds?: number;
}

export class CodingTransportError extends Error {
  classification?: string;
  category?: string;
  retryable?: boolean;
  suggestedAction?: string;
  providerRecovery?: CodingProviderRecovery;

  constructor(message: string, details: {
    classification?: string;
    category?: string;
    retryable?: boolean;
    suggestedAction?: string;
    providerRecovery?: CodingProviderRecovery;
  }) {
    super(message);
    this.name = 'CodingTransportError';
    this.classification = details.classification;
    this.category = details.category;
    this.retryable = details.retryable;
    this.suggestedAction = details.suggestedAction;
    this.providerRecovery = details.providerRecovery;
  }
}

export type CodingMutationNotification =
  | 'approval_request'
  | 'approval_response'
  | 'patch_applied'
  | 'undo';

interface CodingHandlers {
  onStart: (turnId: string, projectRoot: string, scope: string) => void;
  onActivity: (activity: CodingActivity) => void;
  onToken: (content: string) => void;
  onDone: (result: CodingTransportResult) => void;
  onError: (error: Error) => void;
}

interface CodingRequestState {
  requestId: string;
  turnId: string;
  scope: string;
  projectRoot: string;
  handlers: CodingHandlers;
  chunks: string[];
  filesRead: Map<string, string>;
  filesSearched: Set<string>;
  toolCalls: CodingTransportResult['toolCalls'];
  activityCount: number;
  idleTimer: number | null;
  maxDurationTimer: number | null;
  cancellationTimer: number | null;
  cancellationRequested: boolean;
  cancellationReported: boolean;
  operation: 'model' | 'tool';
}

const CODING_WS_URL = runtimeConfig.codingWsUrl;

function isLocalBrowserDevelopment(): boolean {
  return !window.electronAPI
    && window.location.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && window.location.port === String(runtimeConfig.services.devServer.port);
}

export async function codingAuthHeaders(): Promise<Record<string, string>> {
  const getToken = window.electronAPI?.getDeveloperBackendAuthToken;
  if (!getToken) {
    if (isLocalBrowserDevelopment()) return {};
    throw new Error('Coding Agent backend access is available only through the trusted desktop application.');
  }
  const token = await getToken();
  if (!token) throw new Error('Coding Agent backend authentication is unavailable.');
  return { 'X-Coding-Auth': token };
}

export async function codingFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const auth = await codingAuthHeaders();
  if (auth['X-Coding-Auth']) headers.set('X-Coding-Auth', auth['X-Coding-Auth']);
  return fetch(input, { ...init, headers });
}

export class CodingAgentTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly requests = new Map<string, CodingRequestState>();
  private readonly requestReservations = new Set<string>();

  async send(
    requestId: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    scope: string,
    projectRoot: string,
    handlers: CodingHandlers,
    conversationId?: string,
    verificationAttempt?: { attemptNumber: number; maxAttempts: number; label: string; repairToken?: string } | null,
    resumeProviderTask = false,
  ): Promise<string> {
    const request = latestCodingUserRequest(messages);
    if (!request.trim()) throw new Error('The current Coding Agent request is missing. Please send it again.');
    if (this.requests.has(requestId) || this.requestReservations.has(requestId)) {
      throw new Error('This Coding request ID is already active; duplicate execution was prevented.');
    }
    if ([...this.requests.values()].some((active) => (
      active.projectRoot === projectRoot && active.cancellationRequested
    ))) {
      throw new Error('A previous Coding request for this project has unconfirmed cancellation. Wait for its final status before retrying.');
    }
    this.requestReservations.add(requestId);
    let socket: WebSocket;
    let turnId = `browser-turn-${requestId.slice(0, 8)}`;
    let sessionId = conversationId
      ? (conversationId.startsWith('coding-session-') ? conversationId : `coding-session-${conversationId}`)
      : `browser-session-${requestId.slice(0, 8)}`;
    let currentProjectRoot = projectRoot;
    let currentScope = scope || '.';

    try {
      socket = await this.connect();
      if (window.electronAPI) {
        const turn = await window.electronAPI.beginDeveloperConversation(request, scope, verificationAttempt?.repairToken || null);
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
        handlers.onStart(turnId, currentProjectRoot, currentScope);
      }
    } finally {
      this.requestReservations.delete(requestId);
    }

    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error('The Coding Agent connection closed before the request could be sent.');
    }
    this.requests.set(requestId, {
      requestId,
      turnId,
      scope: currentScope,
      projectRoot: currentProjectRoot,
      handlers,
      chunks: [],
      filesRead: new Map(),
      filesSearched: new Set(),
      toolCalls: [],
      activityCount: 0,
      idleTimer: null,
      maxDurationTimer: null,
      cancellationTimer: null,
      cancellationRequested: false,
      cancellationReported: false,
      operation: 'model',
    });
    this.armRequestDeadlines(this.requests.get(requestId)!);
    try {
      socket.send(JSON.stringify({
        type: 'chat',
        requestId,
        sessionId,
        conversationId: conversationId || sessionId,
        turnId,
        projectRoot: currentProjectRoot,
        scope: currentScope,
        messages,
        verificationAttempt: verificationAttempt
          ? {
              attemptNumber: verificationAttempt.attemptNumber,
              maxAttempts: verificationAttempt.maxAttempts,
              label: verificationAttempt.label,
            }
          : undefined,
        resumeProviderTask: resumeProviderTask || undefined,
      }));
    } catch (error) {
      const pending = this.requests.get(requestId);
      if (pending) {
        this.requests.delete(requestId);
        this.clearRequestTimers(pending);
      }
      throw error;
    }
    return turnId;
  }

  async markTurn(turnId: string, state: 'completed' | 'failed' | 'cancelled' | 'blocked', phase?: string, fileCount?: number) {
    if (window.electronAPI) {
      return window.electronAPI.advanceDeveloperConversation({ turnId, state, phase, fileCount });
    }
    return { ok: true, state };
  }

  notifyMutation(type: CodingMutationNotification, details: {
    proposalId: string;
    manifestHash?: string | null;
    approved?: boolean;
    verificationStatus?: string | null;
  }) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, ...details }));
  }

  cancel(requestId: string) {
    if (!requestId || this.socket?.readyState !== WebSocket.OPEN) return false;
    const request = this.requests.get(requestId);
    if (!request) return false;
    this.requestCancellation(request, 'Cancellation requested by the user.');
    return true;
  }

  close() {
    for (const request of this.requests.values()) {
      this.clearRequestTimers(request);
    }
    this.requests.clear();
    this.requestReservations.clear();
    this.socket?.close();
    this.socket = null;
    this.connecting = null;
  }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const token = (await codingAuthHeaders())['X-Coding-Auth'] || '';
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
          this.clearRequestTimers(request);
          if (!request.cancellationReported) {
            request.handlers.onError(new Error('The Coding Agent connection closed before the request completed; execution status is unverified.'));
          }
        }
      };
      socket.onmessage = async (event) => {
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
          if (window.electronAPI && typeof response.connectionId === 'string') {
            try {
              await window.electronAPI.registerDeveloperMutationConnection(response.connectionId);
            } catch (error) {
              console.warn('Coding Agent mutation capability handshake was not accepted.', error);
            }
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
    const requestId = String(
      message.type === 'activity_event'
        ? message.executionId || message.requestId || ''
        : message.requestId || '',
    );
    const request = this.requests.get(requestId);
    if (!request) {
      if (message.type === 'tool_call' && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'tool_result',
          requestId,
          toolCallId: String(message.toolCallId || ''),
          result: {
            ok: false,
            code: 'REQUEST_NOT_FOUND',
            error: 'The request is no longer active on the client.',
          },
        }));
      }
      return;
    }
    this.resetIdleDeadline(request);
    if (message.type === 'done' && request.cancellationRequested) {
      this.requests.delete(requestId);
      this.clearRequestTimers(request);
      if (!request.cancellationReported) {
        request.cancellationReported = true;
        request.handlers.onDone({
          requestId,
          content: 'The request returned after cancellation was requested. Its final execution outcome is unverified; inspect the task state before retrying.',
          proposalRequired: false,
          status: 'CANCELLATION_UNVERIFIED',
          readOnly: true,
          writeRequired: false,
          applyRequired: false,
          approvalRequired: false,
          toolCalls: request.toolCalls,
          filesRead: [...request.filesRead.entries()].map(([path, content]) => ({ path, content })),
          filesSearched: [...request.filesSearched],
        });
      }
      return;
    }
    if (message.type === 'activity_event') {
      const activity = parseCodingActivityEvent(message);
      if (activity && activity.executionId === requestId) {
        request.handlers.onActivity(activity);
      }
      return;
    }
    if (message.type === 'activity') {
      const phase = String(message.phase || 'working');
      const detail = typeof message.message === 'string' ? message.message : 'Working on your request.';
      const activity: CodingActivityMessage = {
        id: `message:${requestId}:${request.activityCount++}`,
        executionId: requestId,
        phase,
        message: detail,
        plan: message.plan && typeof message.plan === 'object' ? message.plan as Record<string, unknown> : undefined,
      };
      request.handlers.onActivity(activity);
      return;
    }
    if (message.type === 'token') {
      const chunk = String(message.content || '');
      request.chunks.push(chunk);
      request.handlers.onToken(chunk);
      return;
    }
    if (message.type === 'tool_call') {
      request.operation = 'tool';
      this.resetIdleDeadline(request);
      const toolCallId = String(message.toolCallId || '');
      const rawName = String(message.name || '');
      const rawArgs = message.arguments && typeof message.arguments === 'object'
        ? message.arguments as Record<string, unknown>
        : {};
      if (message.turnId !== request.turnId) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'tool_result',
            requestId,
            toolCallId,
            result: {
              ok: false,
              code: 'REQUEST_BINDING_MISMATCH',
              error: 'The tool call is not bound to the active Coding request.',
            },
          }));
        }
        return;
      }

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
          result = await window.electronAPI.executeDeveloperTool(name, args, request.scope, request.turnId);
        } else {
          const res = await codingFetch(`${runtimeConfig.services.http.baseUrl}/api/coding/tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId: request.requestId,
              turnId: request.turnId,
              name,
              arguments: args,
              scope: request.scope,
            }),
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
      if (socket.readyState === WebSocket.OPEN && !request.cancellationRequested) {
        socket.send(JSON.stringify({ type: 'tool_result', requestId, toolCallId, result }));
      }
      if (!request.cancellationRequested) {
        request.operation = 'model';
        this.resetIdleDeadline(request);
      }
      return;
    }
    if (message.type === 'done') {
      this.requests.delete(requestId);
      this.clearRequestTimers(request);
      const rawVerificationAttempt = (message as Record<string, unknown>).verificationAttempt;
      const verificationAttempt = rawVerificationAttempt && typeof rawVerificationAttempt === 'object'
        ? rawVerificationAttempt as { attemptNumber?: unknown; maxAttempts?: unknown; label?: unknown }
        : null;
      const rawAgentTaskState = (message as Record<string, unknown>).agentTaskState;
      const rawNextAction = rawAgentTaskState && typeof rawAgentTaskState === 'object'
        ? (rawAgentTaskState as Record<string, unknown>).nextAction
        : null;
      request.handlers.onDone({
        requestId,
        content: String(message.content || request.chunks.join('')),
        proposalRequired: message.proposalRequired === true,
        status: typeof message.status === 'string' ? message.status : undefined,
        agentTaskState: rawAgentTaskState && typeof rawAgentTaskState === 'object'
          ? {
              status: typeof (rawAgentTaskState as Record<string, unknown>).status === 'string'
                ? (rawAgentTaskState as Record<string, unknown>).status as string
                : undefined,
              originalRequest: typeof (rawAgentTaskState as Record<string, unknown>).originalRequest === 'string'
                ? (rawAgentTaskState as Record<string, unknown>).originalRequest as string
                : undefined,
              nextAction: rawNextAction && typeof rawNextAction === 'object'
                ? {
                    tool: typeof (rawNextAction as Record<string, unknown>).tool === 'string'
                      ? (rawNextAction as Record<string, unknown>).tool as string
                      : undefined,
                    reason: typeof (rawNextAction as Record<string, unknown>).reason === 'string'
                      ? (rawNextAction as Record<string, unknown>).reason as string
                      : undefined,
                    expectedEvidence: Array.isArray((rawNextAction as Record<string, unknown>).expectedEvidence)
                      ? ((rawNextAction as Record<string, unknown>).expectedEvidence as unknown[])
                        .filter((entry): entry is string => typeof entry === 'string')
                      : undefined,
                  }
                : null,
            }
          : null,
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
        verificationAttempt: verificationAttempt
          && Number.isSafeInteger(verificationAttempt.attemptNumber)
          && Number.isSafeInteger(verificationAttempt.maxAttempts)
          ? {
              attemptNumber: verificationAttempt.attemptNumber as number,
              maxAttempts: verificationAttempt.maxAttempts as number,
              label: typeof verificationAttempt.label === 'string'
                ? verificationAttempt.label.slice(0, 40)
                : `attempt ${verificationAttempt.attemptNumber} of ${verificationAttempt.maxAttempts}`,
            }
          : null,
      });
      return;
    }
    if (message.type === 'cancelled') {
      const cancellationConfirmed = message.status === 'CANCELLED';
      const cancellationReported = request.cancellationReported;
      this.requests.delete(requestId);
      this.clearRequestTimers(request);
      if (cancellationReported) return;
      request.cancellationReported = true;
      request.handlers.onDone({
        requestId,
        content: cancellationConfirmed
          ? 'Request cancelled.'
          : 'Cancellation requested, but termination was not confirmed.',
        proposalRequired: false,
        status: cancellationConfirmed ? 'CANCELLED' : 'CANCELLATION_UNVERIFIED',
        readOnly: true,
        writeRequired: false,
        applyRequired: false,
        approvalRequired: false,
        toolCalls: request.toolCalls,
        filesRead: [...request.filesRead.entries()].map(([path, content]) => ({ path, content })),
        filesSearched: [...request.filesSearched],
      });
      return;
    }
    if (message.type === 'error') {
      this.requests.delete(requestId);
      this.clearRequestTimers(request);
      const taskState = message.agentTaskState && typeof message.agentTaskState === 'object'
        ? message.agentTaskState as Record<string, unknown>
        : null;
      const rawRecovery = message.providerRecovery && typeof message.providerRecovery === 'object'
        ? message.providerRecovery
        : taskState?.providerRecovery;
      const recovery = rawRecovery && typeof rawRecovery === 'object'
        ? rawRecovery as Record<string, unknown>
        : null;
      const providerRecovery = recovery
        && typeof recovery.state === 'string'
        && typeof recovery.classification === 'string'
        && typeof recovery.retryable === 'boolean'
        ? {
            state: recovery.state,
            classification: recovery.classification,
            retryable: recovery.retryable,
            suggestedAction: typeof recovery.suggestedAction === 'string' ? recovery.suggestedAction : undefined,
            retryAfterSeconds: typeof recovery.retryAfterSeconds === 'number' ? recovery.retryAfterSeconds : undefined,
          }
        : undefined;
      request.handlers.onError(new CodingTransportError(
        String(message.message || 'Coding Agent request failed.'),
        {
          classification: typeof message.classification === 'string' ? message.classification : undefined,
          category: typeof message.category === 'string' ? message.category : undefined,
          retryable: typeof message.retryable === 'boolean' ? message.retryable : undefined,
          suggestedAction: typeof message.suggestedAction === 'string' ? message.suggestedAction : undefined,
          providerRecovery,
        },
      ));
    }
  }

  private armRequestDeadlines(request: CodingRequestState) {
    const idleTimeout = Math.max(1000, runtimeConfig.limits.codingIdleTimeoutMs);
    const maxDuration = Math.max(idleTimeout, runtimeConfig.limits.codingMaxDurationMs);
    request.maxDurationTimer = window.setTimeout(
      () => this.requestCancellation(request, 'The Coding request reached its configured maximum duration.'),
      maxDuration,
    );
    this.resetIdleDeadline(request);
  }

  private resetIdleDeadline(request: CodingRequestState) {
    if (request.cancellationRequested || !this.requests.has(request.requestId)) return;
    if (request.idleTimer !== null) window.clearTimeout(request.idleTimer);
    const operationTimeout = request.operation === 'tool'
      ? runtimeConfig.limits.codingToolTimeoutMs
      : runtimeConfig.limits.codingModelTimeoutMs;
    const adaptiveIdleTimeout = adaptiveCodingIdleTimeoutMs(
      runtimeConfig.limits.codingIdleTimeoutMs,
      operationTimeout,
    );
    request.idleTimer = window.setTimeout(
      () => this.requestCancellation(request, 'The Coding request stopped reporting progress before its idle deadline.'),
      adaptiveIdleTimeout,
    );
  }

  private requestCancellation(request: CodingRequestState, reason: string) {
    if (request.cancellationRequested || !this.requests.has(request.requestId)) return;
    request.cancellationRequested = true;
    if (request.idleTimer !== null) window.clearTimeout(request.idleTimer);
    if (request.maxDurationTimer !== null) window.clearTimeout(request.maxDurationTimer);
    request.idleTimer = null;
    request.maxDurationTimer = null;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'cancel', requestId: request.requestId }));
    }
    request.handlers.onActivity({
      id: `cancel:${request.requestId}`,
      executionId: request.requestId,
      phase: 'cancelling',
      message: reason,
    });
    request.cancellationTimer = window.setTimeout(() => {
      if (!this.requests.has(request.requestId) || request.cancellationReported) return;
      request.cancellationReported = true;
      request.handlers.onDone({
        requestId: request.requestId,
        content: `${reason} Cancellation was not confirmed. The request may still be running; do not retry until its final state is known.`,
        proposalRequired: false,
        status: 'CANCELLATION_UNVERIFIED',
        readOnly: true,
        writeRequired: false,
        applyRequired: false,
        approvalRequired: false,
        toolCalls: request.toolCalls,
        filesRead: [...request.filesRead.entries()].map(([path, content]) => ({ path, content })),
        filesSearched: [...request.filesSearched],
      });
    }, Math.max(1000, runtimeConfig.limits.codingCancellationWaitMs));
  }

  private clearRequestTimers(request: CodingRequestState) {
    if (request.idleTimer !== null && request.idleTimer !== undefined) globalThis.clearTimeout(request.idleTimer);
    if (request.maxDurationTimer !== null && request.maxDurationTimer !== undefined) globalThis.clearTimeout(request.maxDurationTimer);
    if (request.cancellationTimer !== null && request.cancellationTimer !== undefined) globalThis.clearTimeout(request.cancellationTimer);
    request.idleTimer = null;
    request.maxDurationTimer = null;
    request.cancellationTimer = null;
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

export type CodingRequestIntent =
  | 'QUESTION_OR_EXPLANATION'
  | 'CLARIFICATION_REQUIRED'
  | 'AUTONOMOUS_WORKFLOW_TASK';

export interface CodingRequestClassification {
  intent: CodingRequestIntent;
  clarificationPrompt?: string;
  isActionableTask: boolean;
}

export function classifyCodingRequestIntent(rawRequest: string): CodingRequestClassification {
  const text = String(rawRequest || '').trim();
  if (!text) {
    return {
      intent: 'CLARIFICATION_REQUIRED',
      clarificationPrompt: 'Please provide task requirements or the target issue to investigate.',
      isActionableTask: false,
    };
  }

  // 1. Detect vague/ambiguous requests that require clarification before any action
  const isVague = /^(?:make\s+[\w\s]*\s*(?:better|faster|cleaner|nicer|cool(?:er)?)|improve\s+(?:the\s+)?performance|fix\s+(?:the\s+)?(?:bug|issue|code|it|problem)|clean\s+(?:it\s+)?up|do\s+something|look\s+into\s+this|check\s+this|investigate\s+this)\s*[.!?]*$/i.test(text)
    || (/^(?:make|improve|optimize)\b.*\b(?:faster|better|cleaner)\b/i.test(text) && !/\b(?:ms|seconds?|query|queries|index|profile|benchmark|endpoint|test|error)\b/i.test(text));
  if (isVague) {
    return {
      intent: 'CLARIFICATION_REQUIRED',
      clarificationPrompt: `The request "${text}" is ambiguous. Please specify the target behavior, expected outcome, or error details.`,
      isActionableTask: false,
    };
  }

  // 2. Detect ambiguous mixed-intent requests combining action directives and informational/exploratory questions
  // e.g. "Fix the rollback or explain why it failed", "Should I fix this or what do you recommend?", "Either add tests or explain why"
  const hasDisjunctiveInquiry = /\b(?:or\s+(?:should|can|could|would|what|why|how|explain|tell|describe|clarify|discuss|else)|either\b.*\bor\b|not\s+sure\s+(?:if|whether))\b/i.test(text);
  const hasActionVerb = /\b(?:fix|repair|patch|modify|change|refactor|remove|delete|add|create|implement|write|apply|update|replace)\b/i.test(text);
  if (hasDisjunctiveInquiry && hasActionVerb) {
    return {
      intent: 'CLARIFICATION_REQUIRED',
      clarificationPrompt: 'Your request combines an action directive and an informational inquiry. Please clarify whether you would like the agent to apply code changes or provide an explanation first.',
      isActionableTask: false,
    };
  }

  const isExplicitNoChange = /\b(?:do\s+not|don't|dont|never)\s+(?:(?:just|only|actually|any)\s+){0,2}(?:modify|change|edit|write|apply|implement|fix|repair|patch|add|create|refactor|update|remove|delete|touch)\b/i.test(text)
    || /\bwithout\s+(?:(?:just|only|actually|any)\s+)?(?:modifying|changing|editing|writing|applying|implementing|fixing|repairing|patching|adding|creating|refactoring|updating|removing|deleting|touching)\b/i.test(text)
    || /\b(?:do\s+not|don't|dont)\s+(?:want|need|expect)\s+(?:any\s+)?(?:code\s+)?(?:changes?|modifications?|edits?|patches?)\b/i.test(text)
    || /\b(?:do\s+not|don't|dont|never)\s+(?:make|apply)\s+(?:any\s+)?(?:code\s+)?changes?(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(text)
    || /\bwithout\s+making\s+(?:any\s+)?(?:code\s+)?changes?(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(text)
    || /\bno\s+(?:(?:code|file|source)\s+)?(?:changes?|modifications?|edits?|writes?|patches?)(?:\s+to\s+(?:the\s+)?(?:code|files?|source))?\b/i.test(text);
  if (isExplicitNoChange) {
    const requestsInvestigation = /\b(?:investigate|diagnose|find\s+(?:the\s+)?cause|root\s+cause|why|failing|fails|failed|broken|error|bug|bottleneck|performance|trace)\b/i.test(text);
    if (requestsInvestigation) {
      return {
        intent: 'AUTONOMOUS_WORKFLOW_TASK',
        isActionableTask: true,
      };
    }
    return {
      intent: 'QUESTION_OR_EXPLANATION',
      isActionableTask: false,
    };
  }

  // 3. Detect explicit informational & explanation requests (giving explanation precedence over embedded action verbs)
  // e.g. "Can you explain...", "Please describe...", "Tell me about...", "Explain how X works", "Help me understand..."
  const isExplicitExplanation = /^(?:(?:can\s+you|could\s+you|would\s+you|please|will\s+you)\s+(?:please\s+)?)?(?:explain|describe|clarify|summarize|walk\s+me\s+through|tell\s+me(?:\s+about|\s+how|\s+why|\s+what|\s+if|\s+whether)?|show\s+me|help\s+me\s+understand|give\s+me\s+(?:an?\s+)?(?:overview|summary|explanation|details|breakdown)|provide\s+(?:an?\s+)?(?:overview|summary|explanation|details|breakdown))\b/i.test(text)
    || /^(?:i\s+(?:want|would\s+like)\s+to\s+understand)\b/i.test(text);
  if (isExplicitExplanation) {
    return {
      intent: 'QUESTION_OR_EXPLANATION',
      isActionableTask: false,
    };
  }

  // 4. Detect inquiry questions (e.g. "How does developerAgent implement rollback?", "What does this do?", "Why is this failing?")
  // Inquiries about behavior, architecture, or rationale stay conversational even if containing action verbs.
  const isQuestionInquiry = /^(?:what\s+(?:is|are|does|do|can|would|happened|happens|was|were)|how\s+(?:does|do|did|is|are|was|were|would|should|might|will|can|could|to)|why\s+(?:is|are|does|do|did|was|were|would|should)|where\s+(?:is|are|can|do|does)|who\s+(?:is|are|wrote|modified)|which\s+(?:file|module|class|function|method|component|test|part)|is\s+there\s+|are\s+there\s+|does\s+it\s+|do\s+we\s+|should\s+(?:i|we|it)\s+|could\s+(?:we|i)\s+|can\s+(?:we|i)\s+|would\s+it\s+be\s+)/i.test(text);
  if (isQuestionInquiry) {
    return {
      intent: 'QUESTION_OR_EXPLANATION',
      isActionableTask: false,
    };
  }

  // 5. Detect polite action directives (e.g. "Can you fix...", "Please add...", "Could you refactor...")
  // When polite framing is followed immediately by an action verb, it represents a command to execute changes.
  const isPoliteActionDirective = /^(?:can\s+you|could\s+you|would\s+you|please|will\s+you)\s+(?:please\s+)?(?:fix|repair|patch|modify|change|refactor|remove|delete|add|create|implement|write|apply|update|replace|resolve|investigate)\b/i.test(text);
  if (isPoliteActionDirective) {
    return {
      intent: 'AUTONOMOUS_WORKFLOW_TASK',
      isActionableTask: true,
    };
  }

  // 6. Detect trailing questions that do not start with a direct action command
  const startsWithDirectAction = /^(?:fix|repair|patch|modify|change|refactor|remove|delete|add|create|implement|write|apply|update|replace|resolve|investigate|find\s+and\s+fix)\b/i.test(text);
  if (text.endsWith('?') && !startsWithDirectAction) {
    return {
      intent: 'QUESTION_OR_EXPLANATION',
      isActionableTask: false,
    };
  }

  // 7. Actionable coding task, bug fix, or investigation requiring autonomous workflow
  return {
    intent: 'AUTONOMOUS_WORKFLOW_TASK',
    isActionableTask: true,
  };
}
