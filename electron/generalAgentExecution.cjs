'use strict';

/*
 * Phase 13.4 execution foundation.
 *
 * This module intentionally contains no network, filesystem, credential, or
 * arbitrary-code execution. Providers are small adapters and browser sessions
 * contain only structured state. Synchronous adapters remain supported for
 * deterministic tests, while Electron adapters may return Promises that flow
 * through the same lifecycle and safety checks.
 */

const crypto = require('node:crypto');

const ACTION_STATES = Object.freeze([
  'PLANNED',
  'VALIDATING',
  'WAITING_FOR_CONFIRMATION',
  'EXECUTING',
  'OBSERVING',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
]);

const TERMINAL_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']);
const PROVIDER_LIFECYCLES = Object.freeze([
  'AVAILABLE',
  'LOGIN_REQUIRED',
  'PERMISSION_REQUIRED',
  'TEMPORARILY_UNAVAILABLE',
  'AUTOMATION_BLOCKED',
  'CAPTCHA_REQUIRED',
  'UNSUPPORTED',
]);
const RISK_LEVELS = Object.freeze([
  'READ_ONLY',
  'LOW_RISK',
  'USER_DATA',
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL',
  'ACCOUNT_CHANGE',
  'DESTRUCTIVE',
]);

const IRREVERSIBLE_OPERATIONS = new Set([
  'buy', 'purchase', 'pay', 'checkout', 'order', 'book', 'reserve',
  'submit', 'send', 'publish', 'post', 'reply', 'delete', 'cancel',
  'execute', 'create',
]);

const ACTION_TRANSITIONS = Object.freeze({
  PLANNED: Object.freeze(['VALIDATING', 'CANCELLED', 'BLOCKED']),
  VALIDATING: Object.freeze(['WAITING_FOR_CONFIRMATION', 'EXECUTING', 'FAILED', 'BLOCKED', 'CANCELLED']),
  WAITING_FOR_CONFIRMATION: Object.freeze(['EXECUTING', 'CANCELLED', 'BLOCKED']),
  EXECUTING: Object.freeze(['OBSERVING', 'FAILED', 'BLOCKED', 'CANCELLED']),
  OBSERVING: Object.freeze(['VERIFYING', 'FAILED', 'BLOCKED']),
  VERIFYING: Object.freeze(['SUCCEEDED', 'FAILED', 'BLOCKED']),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze(['VALIDATING', 'CANCELLED', 'BLOCKED']),
  BLOCKED: Object.freeze(['VALIDATING', 'CANCELLED']),
  CANCELLED: Object.freeze([]),
});

const FAILURE_CLASSIFICATIONS = Object.freeze([
  'INVALID_ACTION',
  'INVALID_REQUIREMENT',
  'STALE_OBSERVATION',
  'STALE_STATE',
  'DUPLICATE_ACTION',
  'PRICE_CHANGED',
  'UNAVAILABLE',
  'PAYMENT_UNKNOWN',
  'LOGIN_REQUIRED',
  'CAPTCHA_REQUIRED',
  'PERMISSION_REQUIRED',
  'AUTOMATION_BLOCKED',
  'NETWORK',
  'ENVIRONMENT_BLOCKED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'LIMIT_EXCEEDED',
  'VERIFICATION_FAILED',
  'CREDENTIALS_REJECTED',
  'UNKNOWN',
]);

const DEFAULT_LIMITS = Object.freeze({
  maxActions: 50,
  maxRetries: 2,
  maxScreenshots: 10,
  maxNavigations: 50,
  maxExtractions: 50,
  maxVisibleText: 4000,
  maxInteractiveElements: 100,
});
const BROWSER_REQUIRED_OPERATIONS = Object.freeze([
  'navigate',
  'observe',
  'click',
  'type',
  'scroll',
  'wait',
  'back',
  'screenshot',
  'closeSession',
]);

class ExecutionError extends Error {
  constructor(message, code = 'EXECUTION_ERROR', details = {}) {
    super(redactText(message));
    this.name = 'ExecutionError';
    this.code = code;
    this.details = redactSensitive(details);
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function isPromise(value) {
  return value && typeof value.then === 'function';
}

function redactText(value) {
  let text = String(value ?? '');
  text = text.replace(/(bearer\s+)[a-z0-9._~+/=-]+/ig, '$1[REDACTED]');
  text = text.replace(/((?:password|passwd|token|secret|api[_-]?key|access[_-]?key|authorization)\s*[:=]\s*)["']?[^"',\s}]+/ig, '$1[REDACTED]');
  text = text.replace(/\b(?:sk|pk)-[a-z0-9_-]{12,}\b/ig, '[REDACTED]');
  return text.slice(0, 2000);
}

const SENSITIVE_KEY = /password|passwd|credential|secret|token|api.?key|access.?key|authorization|cookie|session.?cookie|card|cvv|cvc|pin/i;

function redactSensitive(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([name, item]) => [name, redactSensitive(item, name)]));
  }
  return value;
}

function boundedString(value, limit, fallback = '') {
  const text = String(value ?? fallback);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function boundedTarget(value) {
  if (value && typeof value === 'object') return redactSensitive(value);
  return boundedString(value, 500);
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assertState(state) {
  if (!ACTION_STATES.includes(state)) throw new ExecutionError(`Unknown action state: ${state}`, 'INVALID_STATE');
}

function transitionAction(action, nextState, metadata = {}) {
  if (!action || typeof action !== 'object') throw new ExecutionError('An action is required.', 'INVALID_ACTION');
  assertState(action.state);
  assertState(nextState);
  if (!ACTION_TRANSITIONS[action.state].includes(nextState)) {
    throw new ExecutionError(`Invalid action transition ${action.state} -> ${nextState}.`, 'INVALID_TRANSITION', {
      actionId: action.actionId,
      from: action.state,
      to: nextState,
    });
  }
  action.state = nextState;
  action.updatedAt = new Date().toISOString();
  if (!Array.isArray(action.lifecycle)) action.lifecycle = [];
  action.lifecycle.push({ state: nextState, at: action.updatedAt, ...redactSensitive(metadata) });
  return action;
}

function normalizeRisk(value) {
  if (value === undefined || value === null || value === '') return 'READ_ONLY';
  if (!RISK_LEVELS.includes(value)) throw new ExecutionError(`Invalid risk level: ${value}`, 'INVALID_ACTION');
  return value;
}

function operationRisk(operation) {
  const normalized = String(operation || '').toLowerCase();
  if (['delete', 'remove', 'erase', 'destroy'].includes(normalized)) return 'DESTRUCTIVE';
  if (['send', 'publish', 'post', 'reply', 'submit', 'share'].includes(normalized)) return 'EXTERNAL_COMMUNICATION';
  if (['buy', 'purchase', 'pay', 'checkout', 'order', 'book', 'reserve', 'execute'].includes(normalized)) return 'FINANCIAL';
  if (['change_password', 'authorize', 'connect_account'].includes(normalized)) return 'ACCOUNT_CHANGE';
  return 'READ_ONLY';
}

function maxRisk(requested, inferred) {
  const order = ['READ_ONLY', 'LOW_RISK', 'USER_DATA', 'EXTERNAL_COMMUNICATION', 'FINANCIAL', 'ACCOUNT_CHANGE', 'DESTRUCTIVE'];
  return order.indexOf(inferred) > order.indexOf(requested) ? inferred : requested;
}

function createAction(input = {}) {
  const requestedRisk = normalizeRisk(input.riskLevel);
  const riskLevel = maxRisk(requestedRisk, operationRisk(input.operation));
  const irreversible = IRREVERSIBLE_OPERATIONS.has(String(input.operation || '').toLowerCase());
  const requiresConfirmation = irreversible || (input.requiresConfirmation === undefined
    ? ['FINANCIAL', 'EXTERNAL_COMMUNICATION', 'ACCOUNT_CHANGE', 'DESTRUCTIVE'].includes(riskLevel)
    : Boolean(input.requiresConfirmation));
  const action = {
    actionId: boundedString(input.actionId || makeId('action'), 120),
    taskId: boundedString(input.taskId, 120),
    generalSessionId: boundedString(input.generalSessionId, 120),
    capability: boundedString(input.capability, 80),
    provider: boundedString(input.provider, 80),
    operation: boundedString(input.operation, 80),
    target: boundedTarget(input.target),
    arguments: redactSensitive(input.arguments && typeof input.arguments === 'object' ? input.arguments : {}),
    riskLevel,
    requiresConfirmation,
    expectedOutcome: redactSensitive(input.expectedOutcome ?? {}),
    observationVersion: Number.isInteger(input.observationVersion) ? input.observationVersion : 0,
    state: 'PLANNED',
    lifecycle: [{ state: 'PLANNED', at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmationId: requiresConfirmation ? `confirm-${boundedString(input.actionId || '', 96) || makeId('confirmation')}` : null,
    confirmedAt: null,
    attempts: 0,
    retryCount: 0,
    result: null,
    observation: null,
    verification: null,
    failure: null,
    irreversible,
  };
  if (!action.taskId || !action.generalSessionId || !action.capability || !action.provider || !action.operation) {
    throw new ExecutionError('taskId, generalSessionId, capability, provider, and operation are required.', 'INVALID_ACTION');
  }
  return action;
}

function boundedObservation(input = {}, version = 0, limits = DEFAULT_LIMITS) {
  const pageState = input.pageState && typeof input.pageState === 'object'
    ? redactSensitive(input.pageState)
    : {};
  const interactiveElements = Array.isArray(input.interactiveElements)
    ? input.interactiveElements.slice(0, limits.maxInteractiveElements).map((element, index) => ({
      id: boundedString(element?.id || `element-${index + 1}`, 120),
      role: boundedString(element?.role || 'unknown', 40),
      label: redactText(boundedString(element?.label || '', 200)),
      type: boundedString(element?.type || 'button', 40),
      enabled: element?.enabled !== false,
    }))
    : [];
  return {
    url: redactText(boundedString(input.url, 2048)),
    title: redactText(boundedString(input.title, 200)),
    visibleText: redactText(boundedString(input.visibleText ?? input.text, limits.maxVisibleText)),
    interactiveElements,
    pageState,
    results: Array.isArray(input.results) ? input.results.slice(0, 12).map((result) => redactSensitive(result)) : [],
    screenshotReference: boundedString(input.screenshotReference, 256) || null,
    loginState: ['LOGGED_IN', 'LOGGED_OUT', 'UNKNOWN', 'LOGIN_REQUIRED'].includes(input.loginState)
      ? input.loginState : 'UNKNOWN',
    errorState: input.errorState ? {
      code: boundedString(input.errorState.code, 80),
      message: redactText(input.errorState.message),
      retryable: Boolean(input.errorState.retryable),
    } : null,
    version,
  };
}

class BrowserSessionStore {
  constructor(options = {}) {
    this.sessions = new Map();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  }

  create({ generalSessionId, taskId, owner, sessionId, initialState } = {}) {
    if (!generalSessionId || !taskId || owner === undefined || owner === null) {
      throw new ExecutionError('generalSessionId, taskId, and owner are required.', 'INVALID_SESSION');
    }
    const id = sessionId || makeId('browser');
    if (this.sessions.has(id)) throw new ExecutionError('Browser session already exists.', 'DUPLICATE_SESSION');
    const state = {
      url: '',
      title: '',
      visibleText: '',
      interactiveElements: [],
      pageState: 'EMPTY',
      loginState: 'UNKNOWN',
      history: [],
      inputs: {},
      scrollY: 0,
      screenshotNumber: 0,
      navigationCount: 0,
      extractionCount: 0,
      actionCount: 0,
      closed: false,
      observationVersion: 0,
      lastObservation: null,
      ...redactSensitive(initialState || {}),
    };
    const session = {
      sessionId: id,
      generalSessionId: boundedString(generalSessionId, 120),
      taskId: boundedString(taskId, 120),
      owner,
      createdAt: new Date().toISOString(),
      closedAt: null,
      state,
      limits: { ...this.limits },
    };
    this.sessions.set(id, session);
    return clone(session);
  }

  get(sessionId, owner, binding = {}) {
    if (owner && typeof owner === 'object') {
      binding = { ...owner, ...binding };
      owner = binding.owner;
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new ExecutionError('Browser session is stale or does not exist.', 'STALE_SESSION');
    if (session.closed || session.state.closed) throw new ExecutionError('Browser session is closed.', 'STALE_SESSION');
    if (owner !== session.owner) throw new ExecutionError('Browser session is not owned by this owner.', 'SESSION_OWNERSHIP');
    if (binding.generalSessionId && binding.generalSessionId !== session.generalSessionId) {
      throw new ExecutionError('Browser session is bound to a different General session.', 'SESSION_BINDING');
    }
    if (binding.taskId && binding.taskId !== session.taskId) {
      throw new ExecutionError('Browser session is bound to a different task.', 'SESSION_BINDING');
    }
    return session;
  }

  close(sessionId, owner, binding = {}) {
    const session = this.get(sessionId, owner, binding);
    session.state.closed = true;
    session.closedAt = new Date().toISOString();
    return clone(session);
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }
}

function sessionObservation(session) {
  return boundedObservation({
    url: session.state.url,
    title: session.state.title,
    visibleText: session.state.visibleText,
    interactiveElements: session.state.interactiveElements,
    pageState: {
      name: session.state.pageState,
      scrollY: session.state.scrollY,
      inputFields: Object.keys(session.state.inputs),
    },
    screenshotReference: session.state.lastObservation?.screenshotReference || null,
    loginState: session.state.loginState,
    errorState: session.state.errorState || null,
  }, session.state.observationVersion, session.limits || DEFAULT_LIMITS);
}

function bumpObservation(session, statePatch = {}) {
  Object.assign(session.state, redactSensitive(statePatch));
  session.state.observationVersion += 1;
  session.state.lastObservation = sessionObservation(session);
  return clone(session.state.lastObservation);
}

class MockBrowserAdapter {
  constructor(options = {}) {
    this.providerId = options.providerId || 'mock-browser';
    this.displayName = 'Mock Browser Adapter (deterministic; no external provider)';
    this.operations = Object.freeze(['navigate', 'observe', 'click', 'type', 'scroll', 'wait', 'back', 'screenshot', 'closeSession']);
    this.requiredOperations = this.operations;
  }

  _session(session) {
    if (!session || session.state?.closed) throw new ExecutionError('Browser session is stale.', 'STALE_SESSION');
    return session;
  }

  navigate(session, target = {}) {
    const current = this._session(session);
    const url = typeof target === 'string' ? target : target.url;
    if (!/^https?:\/\/[^\s]+$/i.test(String(url || ''))) {
      throw new ExecutionError('Mock browser navigation requires an http(s) URL.', 'INVALID_TARGET');
    }
    if (current.state.url) current.state.history.push(current.state.url);
    current.state.navigationCount += 1;
    return bumpObservation(current, {
      url: boundedString(url, 2048),
      title: boundedString((typeof target === 'object' && target.title) || `Mock page: ${url}`, 200),
      visibleText: boundedString((typeof target === 'object' && target.visibleText) || `Structured mock page at ${url}`, 4000),
      pageState: 'LOADED',
      interactiveElements: (typeof target === 'object' && Array.isArray(target.interactiveElements))
        ? target.interactiveElements : [{ id: 'continue', role: 'button', label: 'Continue', type: 'button', enabled: true }],
      loginState: (typeof target === 'object' && target.loginState) || 'UNKNOWN',
      errorState: null,
    });
  }

  observe(session) {
    const current = this._session(session);
    current.state.observationVersion += 1;
    current.state.lastObservation = sessionObservation(current);
    return clone(current.state.lastObservation);
  }

  click(session, target = {}) {
    const current = this._session(session);
    const requested = typeof target === 'string' ? target : target.target || target.id || target.label;
    const element = current.state.interactiveElements.find((item) => item.id === requested || item.label === requested);
    if (!element || element.enabled === false) throw new ExecutionError('Mock browser target is not an enabled interactive element.', 'INVALID_TARGET');
    const label = boundedString(element.label || element.id, 200);
    return bumpObservation(current, {
      visibleText: `${current.state.visibleText} Selected ${label}.`.slice(0, 4000),
      pageState: 'INTERACTION_COMPLETE',
      interactiveElements: current.state.interactiveElements,
    });
  }

  type(session, target = {}) {
    const current = this._session(session);
    const field = typeof target === 'string' ? 'text' : target.target || target.field || 'text';
    const fieldType = typeof target === 'object' ? target.fieldType || 'text' : 'text';
    if (fieldType === 'password' || SENSITIVE_KEY.test(field)) {
      throw new ExecutionError('Credentials must be entered by the user; mock browser will not handle them.', 'CREDENTIALS_REJECTED');
    }
    const value = boundedString(typeof target === 'string' ? target : target.text, 500);
    current.state.inputs[boundedString(field, 120)] = redactText(value);
    return bumpObservation(current, {
      pageState: 'INPUT_UPDATED',
      visibleText: current.state.visibleText,
    });
  }

  scroll(session, target = {}) {
    const current = this._session(session);
    const delta = Number(typeof target === 'number' ? target : target.delta || target.amount || 0);
    current.state.scrollY = Math.max(0, Math.min(100000, current.state.scrollY + (Number.isFinite(delta) ? delta : 0)));
    return bumpObservation(current, { pageState: 'SCROLLED' });
  }

  wait(session, target = {}) {
    const current = this._session(session);
    const duration = Math.max(0, Math.min(30000, Number(typeof target === 'number' ? target : target.milliseconds || target.duration || 0) || 0));
    return bumpObservation(current, { pageState: `WAITED_${duration}MS` });
  }

  back(session) {
    const current = this._session(session);
    const previous = current.state.history.pop();
    if (!previous) throw new ExecutionError('Mock browser history is empty.', 'INVALID_TARGET');
    return bumpObservation(current, {
      url: previous,
      title: `Mock page: ${previous}`,
      visibleText: `Structured mock page at ${previous}`,
      pageState: 'LOADED',
    });
  }

  screenshot(session) {
    const current = this._session(session);
    current.state.screenshotNumber += 1;
    if (current.state.screenshotNumber > current.limits.maxScreenshots) {
      throw new ExecutionError('Screenshot limit exceeded.', 'LIMIT_EXCEEDED');
    }
    const reference = `mock-screenshot://${current.sessionId}/${current.state.screenshotNumber}`;
    bumpObservation(current, { pageState: 'SCREENSHOT_CAPTURED', lastObservation: { screenshotReference: reference } });
    current.state.lastObservation.screenshotReference = reference;
    return { screenshotReference: reference, version: current.state.observationVersion };
  }

  closeSession(session) {
    if (!session || session.state?.closed) return { closed: true };
    session.state.closed = true;
    return { closed: true, sessionId: session.sessionId };
  }
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(adapter.providerId || '')) {
    throw new ExecutionError('Provider adapter requires a valid providerId.', 'INVALID_PROVIDER');
  }
  const operationMap = adapter.operations && !Array.isArray(adapter.operations) && typeof adapter.operations === 'object'
    ? adapter.operations : {};
  const operations = Array.isArray(adapter.operations)
    ? adapter.operations
    : Object.keys(operationMap);
  if (adapter.lifecycle && !PROVIDER_LIFECYCLES.includes(adapter.lifecycle)) {
    throw new ExecutionError(`Provider ${adapter.providerId} has an invalid lifecycle.`, 'INVALID_PROVIDER');
  }
  const normalized = {
    ...adapter,
    operations: Object.freeze([...new Set(operations.map((operation) => String(operation)))]),
    capabilities: Object.freeze(Array.isArray(adapter.capabilities) ? [...new Set(adapter.capabilities)] : Object.keys(adapter.capabilities || {})),
    lifecycle: adapter.lifecycle || 'AVAILABLE',
  };
  for (const operation of normalized.operations) {
    if (typeof normalized[operation] !== 'function' && typeof operationMap[operation] === 'function') {
      normalized[operation] = operationMap[operation].bind(normalized);
    }
  }
  return normalized;
}

function adapterSupports(adapter, capability, operation) {
  if (!adapter.operations.includes(operation)) return false;
  if (typeof adapter.supports === 'function') return Boolean(adapter.supports(capability, operation));
  if (adapter.capabilities && adapter.capabilities.length && !adapter.capabilities.includes(capability) && !adapter.capabilities.includes('*')) return false;
  return true;
}

function providerLifecycle(adapter, action, context) {
  if (typeof adapter.getLifecycle === 'function') return adapter.getLifecycle(action, context);
  return adapter.lifecycle || 'AVAILABLE';
}

function classifyFailure(error, context = {}) {
  const code = String(error?.code || '').toUpperCase();
  const text = `${code} ${error?.message || error || ''}`.toLowerCase();
  let classification = code && FAILURE_CLASSIFICATIONS.includes(code) ? code : null;
  if (!classification) {
    if (/payment.*unknown|unknown.*payment|indeterminate/.test(text)) classification = 'PAYMENT_UNKNOWN';
    else if (/price|cost|amount.*changed/.test(text)) classification = 'PRICE_CHANGED';
    else if (/network|offline|socket|connection reset|timed out|timeout/.test(text)) classification = 'NETWORK';
    else if (/environment|electron|browser executable|display|sandbox/.test(text)) classification = 'ENVIRONMENT_BLOCKED';
    else if (/stale state|state changed/.test(text)) classification = 'STALE_STATE';
    else if (/invalid requirement|missing required|requirement/.test(text)) classification = 'INVALID_REQUIREMENT';
    else if (/availability|unavailable|sold out/.test(text)) classification = 'UNAVAILABLE';
    else if (/captcha/.test(text)) classification = 'CAPTCHA_REQUIRED';
    else if (/login|authenticat/.test(text)) classification = 'LOGIN_REQUIRED';
    else if (/permission|forbidden/.test(text)) classification = 'PERMISSION_REQUIRED';
    else if (/credential|password|secret|token/.test(text)) classification = 'CREDENTIALS_REJECTED';
    else if (/duplicate|already/.test(text)) classification = 'DUPLICATE_ACTION';
    else classification = context.provider ? 'PROVIDER_ERROR' : 'UNKNOWN';
  }
  return {
    classification,
    code: error?.code || classification,
    message: redactText(error?.message || String(error || 'Execution failed.')),
    retryable: classification !== 'PAYMENT_UNKNOWN'
      && !['DUPLICATE_ACTION', 'STALE_OBSERVATION', 'STALE_STATE', 'CREDENTIALS_REJECTED', 'PRICE_CHANGED', 'ENVIRONMENT_BLOCKED'].includes(classification),
    noRetry: classification === 'PAYMENT_UNKNOWN',
    provider: context.provider || null,
    fallback: context.fallback || null,
  };
}

class ExecutionEngine {
  constructor(options = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    this.sessions = options.sessionStore || new BrowserSessionStore({ limits: this.limits });
    this.providers = new Map();
    this.actions = new Map();
    this.taskCounts = new Map();
    this.completedIrreversible = new Set();
    this.providerFailures = new Map();
    if (Array.isArray(options.providers)) options.providers.forEach((adapter) => this.registerProviderAdapter(adapter));
  }

  registerProviderAdapter(adapter) {
    const validated = validateAdapter(adapter);
    this.providers.set(validated.providerId, validated);
    return {
      providerId: validated.providerId,
      capabilities: [...validated.capabilities],
      operations: [...validated.operations],
      lifecycle: validated.lifecycle,
    };
  }

  unregisterProviderAdapter(providerId) {
    return this.providers.delete(providerId);
  }

  getProviderAdapter(providerId) {
    return this.providers.get(providerId) || null;
  }

  createBrowserSession(generalSessionId, taskId, owner, options = {}) {
    if (generalSessionId && typeof generalSessionId === 'object') {
      return this.sessions.create(generalSessionId);
    }
    return this.sessions.create({ generalSessionId, taskId, owner, ...options });
  }

  getBrowserSession(sessionId, owner, binding = {}) {
    return clone(this.sessions.get(sessionId, owner, binding));
  }

  closeBrowserSession(sessionId, owner, binding = {}) {
    if (owner && typeof owner === 'object') {
      binding = { ...owner, ...binding };
      owner = binding.owner;
    }
    const session = this.sessions.get(sessionId, owner, binding);
    const adapter = this.browserAdapter || this.getProviderAdapter('mock-browser');
    const closeResult = adapter && typeof adapter.closeSession === 'function'
      ? adapter.closeSession(session)
      : null;
    const finish = () => {
      session.state.closed = true;
      session.closedAt = new Date().toISOString();
      return clone(session);
    };
    return isPromise(closeResult) ? closeResult.then(finish) : finish();
  }

  browserOperation(sessionId, owner, operation, target = {}, binding = {}) {
    const session = this.sessions.get(sessionId, owner, binding);
    const adapter = this.browserAdapter || this.getProviderAdapter('mock-browser');
    if (!adapter || typeof adapter[operation] !== 'function') throw new ExecutionError(`Unsupported browser operation: ${operation}`, 'UNSUPPORTED_OPERATION');
    if (operation === 'navigate' && session.state.navigationCount >= session.limits.maxNavigations) {
      throw new ExecutionError('Navigation limit exceeded.', 'LIMIT_EXCEEDED');
    }
    if (operation === 'observe' && session.state.extractionCount >= session.limits.maxExtractions) {
      throw new ExecutionError('Observation limit exceeded.', 'LIMIT_EXCEEDED');
    }
    const result = adapter[operation](session, target);
    const finish = (value) => {
      if (operation === 'observe' && !adapter.tracksLimits) session.state.extractionCount += 1;
      return clone(value);
    };
    return isPromise(result) ? result.then(finish) : finish(result);
  }

  registerBrowserAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') throw new ExecutionError('A browser adapter is required.', 'INVALID_PROVIDER');
    const operations = adapter.operations || [];
    for (const operation of ['navigate', 'observe', 'click', 'type', 'scroll', 'wait', 'back', 'screenshot', 'closeSession']) {
      if (!operations.includes(operation) || typeof adapter[operation] !== 'function') {
        throw new ExecutionError(`Browser adapter is missing ${operation}.`, 'INVALID_PROVIDER_CONTRACT');
      }
    }
    this.browserAdapter = adapter;
    const providerId = adapter.providerId || 'mock-browser';
    this.providers.set(providerId, {
      providerId,
      lifecycle: 'AVAILABLE',
      operations: ['execute', 'observe', ...operations],
      capabilities: ['*'],
      execute: (action, engine) => {
        const session = engine.sessions.get(action.browserSessionId, action.owner, {
          generalSessionId: action.generalSessionId,
          taskId: action.taskId,
        });
        const operation = action.operation;
        if (!operations.includes(operation) || typeof adapter[operation] !== 'function') {
          throw new ExecutionError(`Unsupported browser operation: ${operation}`, 'UNSUPPORTED_OPERATION');
        }
        const browserTarget = { ...(action.arguments || {}) };
        if (operation === 'navigate' && !browserTarget.url) browserTarget.url = action.target;
        if (operation !== 'navigate' && action.target
          && !browserTarget.target && !browserTarget.id && !browserTarget.label && !browserTarget.field) {
          browserTarget.target = action.target;
        }
        return adapter[operation](session, browserTarget);
      },
      observe: (action, engine) => {
        const session = engine.sessions.get(action.browserSessionId, action.owner, {
          generalSessionId: action.generalSessionId,
          taskId: action.taskId,
        });
        return adapter.observe(session);
      },
    });
    return providerId;
  }

  _countAction(action) {
    const key = `${action.generalSessionId}:${action.taskId}`;
    const count = (this.taskCounts.get(key) || 0) + 1;
    if (count > this.limits.maxActions) throw new ExecutionError('Action limit exceeded.', 'LIMIT_EXCEEDED');
    this.taskCounts.set(key, count);
  }

  _sessionForAction(action) {
    if (!action.browserSessionId) return null;
    return this.sessions.get(action.browserSessionId, action.owner, {
      generalSessionId: action.generalSessionId,
      taskId: action.taskId,
    });
  }

  planAction(input = {}) {
    const action = createAction(input);
    action.owner = input.owner;
    action.browserSessionId = input.browserSessionId || null;
    action.fallbackProvider = input.fallbackProvider || null;
    action.fallbackMetadata = redactSensitive(input.fallbackMetadata || null);
    this._countAction(action);
    if (action.browserSessionId) {
      const session = this.sessions.get(action.browserSessionId, action.owner, {
        generalSessionId: action.generalSessionId,
        taskId: action.taskId,
      });
      session.state.actionCount += 1;
    }
    this.actions.set(action.actionId, action);
    return clone(action);
  }

  createAction(input = {}) {
    return this.planAction(input);
  }

  getAction(actionId, owner) {
    const action = this.actions.get(actionId);
    if (!action) throw new ExecutionError('Action is stale or does not exist.', 'STALE_ACTION');
    if (owner !== undefined && action.owner !== owner) throw new ExecutionError('Action is not owned by this owner.', 'ACTION_OWNERSHIP');
    return clone(action);
  }

  _action(actionOrId, owner) {
    const action = typeof actionOrId === 'string' ? this.actions.get(actionOrId) : actionOrId;
    if (!action || !this.actions.has(action.actionId)) throw new ExecutionError('Action is stale or does not exist.', 'STALE_ACTION');
    const current = this.actions.get(action.actionId);
    if (owner !== undefined && current.owner !== owner) throw new ExecutionError('Action is not owned by this owner.', 'ACTION_OWNERSHIP');
    return current;
  }

  _validateProvider(action) {
    const adapter = this.providers.get(action.provider);
    if (!adapter) throw new ExecutionError(`Provider ${action.provider} is not registered.`, 'UNSUPPORTED_PROVIDER');
    if (!adapterSupports(adapter, action.capability, action.operation)) {
      throw new ExecutionError(`${action.provider} does not support ${action.capability}/${action.operation}.`, 'UNSUPPORTED_OPERATION');
    }
    const lifecycle = providerLifecycle(adapter, action, this);
    if (!PROVIDER_LIFECYCLES.includes(lifecycle)) throw new ExecutionError('Provider returned an invalid lifecycle.', 'INVALID_PROVIDER');
    if (lifecycle !== 'AVAILABLE') {
      const classification = lifecycle === 'CAPTCHA_REQUIRED' ? 'CAPTCHA_REQUIRED'
        : lifecycle === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED'
          : lifecycle === 'PERMISSION_REQUIRED' ? 'PERMISSION_REQUIRED'
            : lifecycle === 'AUTOMATION_BLOCKED' ? 'AUTOMATION_BLOCKED'
              : 'PROVIDER_UNAVAILABLE';
      throw new ExecutionError(`Provider lifecycle is ${lifecycle}.`, classification);
    }
    return adapter;
  }

  _checkObservation(action) {
    if (!action.browserSessionId) return;
    const session = this._sessionForAction(action);
    if (action.observationVersion !== session.state.observationVersion) {
      throw new ExecutionError('Action was planned against a stale observation.', 'STALE_OBSERVATION', {
        expectedVersion: action.observationVersion,
        actualVersion: session.state.observationVersion,
      });
    }
  }

  _duplicateKey(action) {
    return stableSerialize({
      taskId: action.taskId,
      provider: action.provider,
      capability: action.capability,
      operation: action.operation,
      target: action.target,
      arguments: action.arguments,
    });
  }

  validateAction(actionOrId, owner) {
    const action = this._action(actionOrId, owner);
    if (action.state === 'PLANNED') transitionAction(action, 'VALIDATING');
    else if (action.state === 'FAILED') transitionAction(action, 'VALIDATING', { resumed: true });
    else if (action.state !== 'VALIDATING') throw new ExecutionError(`Action cannot be validated from ${action.state}.`, 'INVALID_TRANSITION');
    try {
      this._validateProvider(action);
      this._checkObservation(action);
      if (action.irreversible && this.completedIrreversible.has(this._duplicateKey(action))) {
        throw new ExecutionError('An equivalent irreversible action has already completed.', 'DUPLICATE_ACTION');
      }
      if (action.requiresConfirmation) transitionAction(action, 'WAITING_FOR_CONFIRMATION');
      else transitionAction(action, 'EXECUTING');
      return clone(action);
    } catch (error) {
      const failure = classifyFailure(error, { provider: action.provider });
      action.failure = failure;
      if (['STALE_OBSERVATION', 'STALE_STATE', 'DUPLICATE_ACTION', 'LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'PERMISSION_REQUIRED', 'AUTOMATION_BLOCKED', 'ENVIRONMENT_BLOCKED'].includes(failure.classification)) {
        transitionAction(action, 'BLOCKED', { failure: failure.classification });
      } else {
        transitionAction(action, 'FAILED', { failure: failure.classification });
      }
      this.providerFailures.set(action.actionId, failure);
      throw new ExecutionError(failure.message, failure.classification, failure);
    }
  }

  requestConfirmation(actionOrId, owner) {
    const action = this._action(actionOrId, owner);
    if (action.state === 'PLANNED') this.validateAction(action, owner);
    if (action.state !== 'WAITING_FOR_CONFIRMATION') {
      throw new ExecutionError('This action does not require confirmation.', 'CONFIRMATION_NOT_REQUIRED');
    }
    return {
      actionId: action.actionId,
      confirmationId: action.confirmationId,
      summary: redactSensitive({
        capability: action.capability,
        operation: action.operation,
        target: action.target,
        arguments: action.arguments,
        expectedOutcome: action.expectedOutcome,
      }),
      riskLevel: action.riskLevel,
    };
  }

  confirmAction(actionOrId, confirmationId, owner) {
    const action = this._action(actionOrId, owner);
    if (action.state !== 'WAITING_FOR_CONFIRMATION') throw new ExecutionError('Action is not waiting for confirmation.', 'INVALID_TRANSITION');
    if (!confirmationId || confirmationId !== action.confirmationId) {
      throw new ExecutionError('Confirmation does not match this action.', 'CONFIRMATION_MISMATCH');
    }
    action.confirmedAt = new Date().toISOString();
    transitionAction(action, 'EXECUTING', { confirmed: true });
    return clone(action);
  }

  _executeProvider(action, adapter) {
    if (typeof adapter.execute !== 'function') {
      throw new ExecutionError(`Provider ${action.provider} does not implement execute.`, 'UNSUPPORTED_OPERATION');
    }
    const result = adapter.execute(action, this);
    const redactResult = (value) => redactSensitive(value && typeof value === 'object' ? value : { value });
    return isPromise(result) ? result.then(redactResult) : redactResult(result);
  }

  executeAction(actionOrId, owner) {
    const action = this._action(actionOrId, owner);
    if (action.state === 'PLANNED' || action.state === 'FAILED' || action.state === 'VALIDATING') this.validateAction(action, owner);
    if (action.state === 'WAITING_FOR_CONFIRMATION') {
      throw new ExecutionError('Explicit confirmation is required before execution.', 'CONFIRMATION_REQUIRED');
    }
    if (action.state !== 'EXECUTING') throw new ExecutionError(`Action cannot execute from ${action.state}.`, 'INVALID_TRANSITION');
    if (action.requiresConfirmation && !action.confirmedAt) throw new ExecutionError('Explicit confirmation is required before execution.', 'CONFIRMATION_REQUIRED');
    if (action.irreversible && this.completedIrreversible.has(this._duplicateKey(action))) {
      action.failure = classifyFailure(new ExecutionError('Equivalent irreversible action already completed.', 'DUPLICATE_ACTION'), { provider: action.provider });
      transitionAction(action, 'BLOCKED', { failure: 'DUPLICATE_ACTION' });
      throw new ExecutionError(action.failure.message, 'DUPLICATE_ACTION', action.failure);
    }
    const adapter = this.providers.get(action.provider);
    action.attempts += 1;
    const failure = (error) => {
      const classified = classifyFailure(error, {
        provider: action.provider,
        fallback: action.fallbackProvider ? {
          available: true,
          provider: action.fallbackProvider,
          metadata: action.fallbackMetadata,
        } : null,
      });
      action.failure = classified;
      if (classified.classification === 'PAYMENT_UNKNOWN' || classified.classification === 'DUPLICATE_ACTION') {
        transitionAction(action, 'BLOCKED', { failure: classified.classification });
      } else {
        transitionAction(action, 'FAILED', { failure: classified.classification });
      }
      this.providerFailures.set(action.actionId, classified);
      throw new ExecutionError(classified.message, classified.classification, classified);
    };
    const complete = (result) => {
      action.result = result;
      if (action.result?.paymentStatus === 'UNKNOWN' || action.result?.paymentUnknown === true) {
        throw new ExecutionError('Payment result is unknown; retry is prohibited.', 'PAYMENT_UNKNOWN', { paymentStatus: 'UNKNOWN' });
      }
      if (action.irreversible) this.completedIrreversible.add(this._duplicateKey(action));
      transitionAction(action, 'OBSERVING');
      return clone(action);
    };
    try {
      const result = this._executeProvider(action, adapter);
      return isPromise(result) ? result.then(complete).catch(failure) : complete(result);
    } catch (error) {
      return failure(error);
    }
  }

  observeAction(actionOrId, owner) {
    const action = this._action(actionOrId, owner);
    if (action.state !== 'OBSERVING') throw new ExecutionError(`Action cannot be observed from ${action.state}.`, 'INVALID_TRANSITION');
    const adapter = this.providers.get(action.provider);
    const complete = (observation) => {
      action.observation = boundedObservation(observation, observation.version ?? action.observationVersion, this.limits);
      transitionAction(action, 'VERIFYING');
      return clone(action);
    };
    const fail = (error) => {
      action.failure = classifyFailure(error, { provider: action.provider });
      transitionAction(action, 'FAILED', { failure: action.failure.classification });
      throw new ExecutionError(action.failure.message, action.failure.classification, action.failure);
    };
    try {
      const observation = typeof adapter.observe === 'function'
        ? adapter.observe(action, this)
        : boundedObservation({ pageState: 'NO_OBSERVATION_ADAPTER' }, action.observationVersion, this.limits);
      return isPromise(observation) ? observation.then(complete).catch(fail) : complete(observation);
    } catch (error) {
      return fail(error);
    }
  }

  verifyAction(actionOrId, owner, evidence = {}) {
    const action = this._action(actionOrId, owner);
    if (action.state !== 'VERIFYING') throw new ExecutionError(`Action cannot be verified from ${action.state}.`, 'INVALID_TRANSITION');
    const adapter = this.providers.get(action.provider);
    const complete = (verification) => {
      action.verification = redactSensitive(verification);
      if (verification?.verified === false || verification?.ok === false) {
        action.failure = {
          classification: 'VERIFICATION_FAILED',
          code: 'VERIFICATION_FAILED',
          message: 'The provider result could not be verified.',
          retryable: false,
          noRetry: false,
          provider: action.provider,
          fallback: null,
        };
        transitionAction(action, 'FAILED', { failure: 'VERIFICATION_FAILED' });
      } else {
        transitionAction(action, 'SUCCEEDED');
      }
      return clone(action);
    };
    const fail = (error) => {
      action.failure = classifyFailure(error, { provider: action.provider });
      transitionAction(action, 'FAILED', { failure: action.failure.classification });
      throw new ExecutionError(action.failure.message, action.failure.classification, action.failure);
    };
    try {
      const verification = typeof adapter.verify === 'function'
        ? adapter.verify(action, redactSensitive(evidence), this)
        : { verified: evidence.verified !== false, evidence: redactSensitive(evidence) };
      return isPromise(verification) ? verification.then(complete).catch(fail) : complete(verification);
    } catch (error) {
      return fail(error);
    }
  }

  recoverAction(actionOrId, owner, options = {}) {
    const action = this._action(actionOrId, owner);
    if (!['FAILED', 'BLOCKED'].includes(action.state)) throw new ExecutionError('Only failed or blocked actions can be recovered.', 'INVALID_TRANSITION');
    if (action.failure?.classification === 'PAYMENT_UNKNOWN' || action.failure?.noRetry) {
      throw new ExecutionError('Payment outcome is unknown; recovery must verify status and may not retry.', 'PAYMENT_UNKNOWN');
    }
    const adapter = this.providers.get(action.provider);
    const finish = (recovered) => {
      if (recovered?.verified) {
        action.result = redactSensitive(recovered);
        action.verification = redactSensitive(recovered);
        transitionAction(action, 'SUCCEEDED', { recovered: true });
        return clone(action);
      }
      if (options.fallbackProvider) {
        action.fallbackProvider = options.fallbackProvider;
        action.fallbackMetadata = redactSensitive(options.fallbackMetadata || null);
      }
      action.retryCount += 1;
      if (action.retryCount > this.limits.maxRetries) throw new ExecutionError('Retry limit exceeded.', 'LIMIT_EXCEEDED');
      transitionAction(action, 'VALIDATING', { recovered: true });
      return clone(action);
    };
    if (typeof adapter.recover === 'function') {
      const recovered = adapter.recover(action, redactSensitive(options), this);
      return isPromise(recovered) ? recovered.then(finish) : finish(recovered);
    }
    return finish(null);
  }

  cancelAction(actionOrId, owner, reason = 'Cancelled by owner') {
    const action = this._action(actionOrId, owner);
    if (TERMINAL_STATES.includes(action.state)) return clone(action);
    transitionAction(action, 'CANCELLED', { reason: redactText(reason) });
    return clone(action);
  }

  resetForTest() {
    this.sessions.sessions.clear();
    this.actions.clear();
    this.taskCounts.clear();
    this.completedIrreversible.clear();
    this.providerFailures.clear();
  }

  runAction(actionOrInput, owner, confirmationId, evidence = {}) {
    let actionOrId = actionOrInput;
    if (actionOrInput && typeof actionOrInput === 'object' && !this.actions.has(actionOrInput.actionId)) {
      actionOrId = this.planAction({ ...actionOrInput, owner });
    }
    if (confirmationId && typeof confirmationId === 'object') {
      evidence = confirmationId.evidence || evidence;
      confirmationId = confirmationId.confirmationId;
    }
    const action = this._action(actionOrId, owner);
    this.validateAction(action, owner);
    if (action.state === 'WAITING_FOR_CONFIRMATION') this.confirmAction(action, confirmationId, owner);
    const executed = this.executeAction(action, owner);
    if (isPromise(executed)) {
      return executed
        .then(() => this.observeAction(action, owner))
        .then(() => this.verifyAction(action, owner, evidence));
    }
    this.observeAction(action, owner);
    return this.verifyAction(action, owner, evidence);
  }
}

function createTaskGraphNode(input = {}) {
  const id = boundedString(input.nodeId || input.id || makeId('node'), 120);
  const dependencies = [...new Set((input.dependencies || input.dependsOn || []).map((dependency) => boundedString(dependency, 120)))];
  return {
    nodeId: id,
    id,
    title: boundedString(input.title || id, 200),
    capability: input.capability || null,
    operation: input.operation || input.action || null,
    dependencies,
    dependsOn: [...dependencies],
    status: input.status || 'PENDING',
    attempts: Number.isInteger(input.attempts) ? input.attempts : 0,
    inputs: redactSensitive(input.inputs || {}),
    outputs: redactSensitive(input.outputs || {}),
    result: redactSensitive(input.result ?? null),
    error: input.error ? redactSensitive(input.error) : null,
  };
}

class ExecutableTaskGraph {
  constructor(nodes = [], options = {}) {
    this.graphId = options.graphId || makeId('graph');
    this.nodes = nodes.map(createTaskGraphNode);
    this.resumeCount = 0;
    this._validateDependencies();
  }

  _validateDependencies() {
    const ids = new Set(this.nodes.map((node) => node.id));
    for (const node of this.nodes) {
      if (node.dependencies.some((dependency) => !ids.has(dependency))) {
        throw new ExecutionError(`Task graph node ${node.id} has an unknown dependency.`, 'INVALID_TASK_GRAPH');
      }
    }
  }

  getNode(nodeId) {
    const node = this.nodes.find((item) => item.id === nodeId);
    if (!node) throw new ExecutionError(`Task graph node ${nodeId} does not exist.`, 'INVALID_TASK_GRAPH');
    return node;
  }

  readyNodes() {
    return this.nodes.filter((node) => node.status === 'PENDING'
      && node.dependencies.every((dependency) => this.getNode(dependency).status === 'SUCCEEDED')).map(clone);
  }

  executeNode(nodeId, executor) {
    const node = this.getNode(nodeId);
    if (!node.dependencies.every((dependency) => this.getNode(dependency).status === 'SUCCEEDED')) {
      throw new ExecutionError(`Task graph dependencies for ${nodeId} are not complete.`, 'DEPENDENCY_BLOCKED');
    }
    if (!['PENDING', 'FAILED'].includes(node.status)) throw new ExecutionError(`Task graph node ${nodeId} is ${node.status}.`, 'INVALID_TASK_GRAPH');
    node.status = 'RUNNING';
    node.attempts += 1;
    const complete = (result) => {
      node.result = redactSensitive(result);
      node.outputs = redactSensitive(result?.outputs || result || {});
      node.status = 'SUCCEEDED';
      node.error = null;
      return clone(node);
    };
    const fail = (error) => {
      node.status = 'FAILED';
      node.error = { classification: classifyFailure(error).classification, message: redactText(error.message) };
      return clone(node);
    };
    try {
      const result = executor(node.inputs, this);
      return isPromise(result) ? result.then(complete).catch(fail) : complete(result);
    } catch (error) {
      return fail(error);
    }
  }

  resumeFromFailedNode(nodeId) {
    const failed = this.getNode(nodeId);
    if (failed.status !== 'FAILED') throw new ExecutionError(`Task graph node ${nodeId} is not failed.`, 'INVALID_TASK_GRAPH');
    const reset = new Set([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.nodes) {
        if (node.dependencies.some((dependency) => reset.has(dependency)) && !reset.has(node.id)) {
          reset.add(node.id);
          changed = true;
        }
      }
    }
    for (const node of this.nodes) {
      if (reset.has(node.id)) {
        node.status = 'PENDING';
        node.error = null;
        node.result = null;
        node.outputs = {};
      }
    }
    this.resumeCount += 1;
    return this;
  }
}

function createExecutableTaskGraph(nodes, options = {}) {
  return new ExecutableTaskGraph(nodes, options);
}

function resumeFromFailedNode(graph, nodeId) {
  if (!graph || typeof graph.resumeFromFailedNode !== 'function') {
    throw new ExecutionError('An executable task graph is required.', 'INVALID_TASK_GRAPH');
  }
  return graph.resumeFromFailedNode(nodeId);
}

function executeTaskGraphNode(graph, nodeId, executor) {
  if (!graph || typeof graph.executeNode !== 'function') {
    throw new ExecutionError('An executable task graph is required.', 'INVALID_TASK_GRAPH');
  }
  return graph.executeNode(nodeId, executor);
}

function mockProviderDefinition(providerId, capability, label, options = {}) {
  const irreversible = new Set(['order', 'book', 'reserve', 'send', 'publish', 'execute']);
  const state = new Map();
  const operations = Object.freeze(['search', 'get_details', 'compare', 'prepare', 'execute', 'verify', 'track', 'observe']);
  const adapter = {
    providerId,
    displayName: `Mock ${label} Provider (deterministic; no external support)`,
    description: 'Test-only provider adapter. It does not connect to a real service or accept credentials.',
    capabilities: [capability],
    operations,
    lifecycle: 'AVAILABLE',
    execute(action) {
      const args = action.arguments || {};
      if (Object.keys(args).some((key) => SENSITIVE_KEY.test(key))) {
        throw new ExecutionError('Mock providers do not accept payment credentials.', 'CREDENTIALS_REJECTED');
      }
      if (args.simulateLoginRequired) throw new ExecutionError('User login is required.', 'LOGIN_REQUIRED');
      if (args.simulateCaptcha) throw new ExecutionError('Provider requires a CAPTCHA.', 'CAPTCHA_REQUIRED');
      if (args.simulateProviderFailure) throw new ExecutionError('Deterministic mock provider failure.', 'PROVIDER_ERROR');
      if (args.simulatePaymentUnknown || args.paymentStatus === 'UNKNOWN') {
        return { ok: false, paymentStatus: 'UNKNOWN', retryable: false, evidence: 'Payment status must be checked by the user.' };
      }
      if (args.available === false || args.availability === false) {
        throw new ExecutionError('Requested option is unavailable.', 'UNAVAILABLE');
      }
      const expectedPrice = args.expectedPrice ?? action.expectedOutcome?.price;
      const currentPrice = args.currentPrice ?? args.price;
      if (expectedPrice !== undefined && currentPrice !== undefined
        && Number(expectedPrice) !== Number(currentPrice)) {
        throw new ExecutionError('Price changed since preparation.', 'PRICE_CHANGED');
      }
      const signature = stableSerialize({ target: action.target, arguments: args });
      const scopedSignature = `${action.generalSessionId}:${action.taskId}:${signature}`;
      if (irreversible.has(action.operation) && state.has(scopedSignature)) {
        throw new ExecutionError('Mock provider detected a duplicate irreversible action.', 'DUPLICATE_ACTION');
      }
      const result = {
        ok: true,
        provider: providerId,
        mock: true,
        operation: action.operation,
        reference: `mock-${providerId}-${state.size + 1}`,
        price: currentPrice ?? null,
        availability: args.available !== false,
        paymentStatus: 'NOT_HANDLED',
      };
      if (irreversible.has(action.operation)) state.set(scopedSignature, result.reference);
      return result;
    },
    observe(action) {
      const args = action.arguments || {};
      return boundedObservation({
        url: `mock://${providerId}/${boundedString(action.target || 'result', 100)}`,
        title: `${label} mock result`,
        visibleText: `Deterministic ${label} result is ready.`,
        pageState: 'RESULT',
        loginState: 'UNKNOWN',
      }, action.observationVersion);
    },
    verify(action, evidence = {}) {
      if (evidence?.verified === false || evidence?.ok === false) return { verified: false, evidence: redactSensitive(evidence) };
      return {
        verified: true,
        provider: providerId,
        reference: action.result?.reference || null,
        evidence: redactSensitive(evidence?.evidence || 'Structured mock evidence confirms the result.'),
      };
    },
    recover(action) {
      if (action.failure?.classification === 'PAYMENT_UNKNOWN') return { verified: false };
      return { verified: false };
    },
  };
  if (options.operations) adapter.operations = Object.freeze([...new Set([...operations, ...options.operations])]);
  return adapter;
}

const MOCK_PROVIDER_ADAPTERS = Object.freeze({
  shopping: mockProviderDefinition('mock-shopping', 'SHOPPING', 'Shopping'),
  grocery: mockProviderDefinition('mock-grocery', 'GROCERY', 'Grocery'),
  food: mockProviderDefinition('mock-food', 'FOOD', 'Food'),
  bus: mockProviderDefinition('mock-bus', 'BUS', 'Bus'),
  flight: mockProviderDefinition('mock-flight', 'FLIGHT', 'Flight'),
  hotel: mockProviderDefinition('mock-hotel', 'HOTEL', 'Hotel'),
  email: mockProviderDefinition('mock-email', 'EMAIL', 'Email', { operations: ['read', 'draft', 'send'] }),
  social: mockProviderDefinition('mock-social', 'SOCIAL_MEDIA', 'Social', { operations: ['read', 'draft', 'publish'] }),
});

function createMockProviderAdapters() {
  return {
    shopping: mockProviderDefinition('mock-shopping', 'SHOPPING', 'Shopping'),
    grocery: mockProviderDefinition('mock-grocery', 'GROCERY', 'Grocery'),
    food: mockProviderDefinition('mock-food', 'FOOD', 'Food'),
    bus: mockProviderDefinition('mock-bus', 'BUS', 'Bus'),
    flight: mockProviderDefinition('mock-flight', 'FLIGHT', 'Flight'),
    hotel: mockProviderDefinition('mock-hotel', 'HOTEL', 'Hotel'),
    email: mockProviderDefinition('mock-email', 'EMAIL', 'Email', { operations: ['read', 'draft', 'send'] }),
    social: mockProviderDefinition('mock-social', 'SOCIAL_MEDIA', 'Social', { operations: ['read', 'draft', 'publish'] }),
  };
}

function createExecutionEngine(options = {}) {
  const engine = new ExecutionEngine(options);
  const browser = options.browserAdapter || new MockBrowserAdapter();
  engine.registerBrowserAdapter(browser);
  if (options.registerMocks !== false) Object.values(createMockProviderAdapters()).forEach((adapter) => engine.registerProviderAdapter(adapter));
  return engine;
}

module.exports = {
  ACTION_STATES,
  ACTION_LIFECYCLE_STATES: ACTION_STATES,
  ACTION_TRANSITIONS,
  TERMINAL_STATES,
  PROVIDER_LIFECYCLES,
  RISK_LEVELS,
  FAILURE_CLASSIFICATIONS,
  DEFAULT_LIMITS,
  BROWSER_REQUIRED_OPERATIONS,
  ExecutionError,
  BrowserSessionStore,
  MockBrowserAdapter,
  ExecutableTaskGraph,
  ExecutionEngine,
  MOCK_PROVIDER_ADAPTERS,
  createMockProviderAdapters,
  createExecutionEngine,
  createAction,
  transitionAction,
  boundedObservation,
  classifyFailure,
  redactSensitive,
  validateAdapter,
  adapterSupports,
  createTaskGraphNode,
  createExecutableTaskGraph,
  resumeFromFailedNode,
  executeTaskGraphNode,
};
