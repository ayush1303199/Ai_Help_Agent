'use strict';

const crypto = require('node:crypto');

const SENSITIVE_FIELD = /password|passwd|credential|secret|token|api.?key|access.?key|authorization|cookie|card|cvv|cvc|pin/i;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;
const OBSERVE_SCRIPT = `(() => {
  const visibleText = String(document.body?.innerText || '').slice(0, 4000);
  const lowerText = visibleText.toLowerCase();
  const elements = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"]')].slice(0, 100).map((element, index) => ({
    id: String(element.id || element.name || element.getAttribute('aria-label') || element.getAttribute('data-testid') || \`element-\${index + 1}\`).slice(0, 120),
    role: String(element.getAttribute('role') || element.tagName || 'unknown').slice(0, 40),
    label: String(element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || element.name || element.id || '').trim().slice(0, 200),
    type: String(element.type || element.tagName || 'element').slice(0, 40),
    enabled: !element.disabled
  }));
  const results = [...document.querySelectorAll('a[href]')].map((anchor) => {
    const url = String(anchor.href || '');
    const title = String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
    const container = anchor.closest('article, li, [data-testid], div') || anchor.parentElement;
    const snippet = String(container?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    let source = '';
    try { source = new URL(url).hostname; } catch {}
    return { title, url, snippet, source };
  }).filter((result) => (result.url.startsWith('http://') || result.url.startsWith('https://')) && result.title.length >= 4).slice(0, 30);
  const hasPasswordField = [...document.querySelectorAll('input')].some((element) => /password/i.test(String(element.type || '') + ' ' + String(element.name || '') + ' ' + String(element.id || '')));
  const hasLoginInput = [...document.querySelectorAll('input')].some((element) => /email|username|user/i.test(String(element.type || '') + ' ' + String(element.name || '') + ' ' + String(element.id || '')));
  const hasLoginPair = hasLoginInput && /sign in|log in|login|password/i.test(lowerText);
  const captchaDetected = /captcha|verify you are human|robot check/i.test(lowerText);
  return {
    url: location.href,
    title: document.title,
    visibleText,
    results,
    interactiveElements: elements,
    loginState: hasPasswordField || hasLoginPair ? 'LOGIN_REQUIRED' : 'UNKNOWN',
    pageState: captchaDetected ? 'CAPTCHA_REQUIRED' : document.readyState,
    errorState: captchaDetected ? { code: 'CAPTCHA_REQUIRED', message: 'The page requires user CAPTCHA or human verification.', retryable: false } : null
  };
})()`;

function bounded(value, limit, fallback = '') {
  const text = String(value ?? fallback);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function safeUrl(value) {
  if (!HTTP_URL.test(String(value || ''))) throw Object.assign(new Error('Only valid http(s) URLs are allowed.'), { code: 'INVALID_TARGET' });
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw Object.assign(new Error('Credential-bearing URLs are not allowed.'), { code: 'CREDENTIALS_REJECTED' });
  return parsed.toString();
}

function safeTarget(value) {
  if (typeof value === 'string') return bounded(value, 200);
  return bounded(value?.target || value?.id || value?.label || value?.field || '', 200);
}

function safeObservation(session, data, screenshotReference = null) {
  const version = Number(session.state.observationVersion || 0) + 1;
  const observation = {
    url: bounded(data?.url || session.state.url || '', 2048),
    title: bounded(data?.title || '', 200),
    visibleText: bounded(data?.visibleText || '', 4000),
    interactiveElements: Array.isArray(data?.interactiveElements) ? data.interactiveElements.slice(0, 100).map((element, index) => ({
      id: bounded(element?.id || `element-${index + 1}`, 120),
      role: bounded(element?.role || 'unknown', 40),
      label: bounded(element?.label || '', 200),
      type: bounded(element?.type || 'element', 40),
      enabled: element?.enabled !== false,
    })) : [],
    pageState: data?.pageState || 'UNKNOWN',
    screenshotReference,
    loginState: ['LOGGED_IN', 'LOGGED_OUT', 'UNKNOWN', 'LOGIN_REQUIRED'].includes(data?.loginState) ? data.loginState : 'UNKNOWN',
    errorState: data?.errorState ? {
      code: bounded(data.errorState.code, 80),
      message: bounded(data.errorState.message, 300),
      retryable: Boolean(data.errorState.retryable),
    } : null,
    results: Array.isArray(data?.results) ? data.results.slice(0, 30).map((result) => ({
      title: bounded(result?.title || result?.name || '', 300),
      url: bounded(result?.url || '', 2048),
      snippet: bounded(result?.snippet || result?.description || '', 600),
      source: bounded(result?.source || '', 160),
    })) : [],
    version,
  };
  session.state.observationVersion = version;
  session.state.url = observation.url;
  session.state.title = observation.title;
  session.state.visibleText = observation.visibleText;
  session.state.interactiveElements = observation.interactiveElements;
  session.state.pageState = observation.pageState;
  session.state.loginState = observation.loginState;
  session.state.errorState = observation.errorState;
  session.state.lastObservation = observation;
  return observation;
}

class ElectronBrowserAdapter {
  constructor(options = {}) {
    this.providerId = options.providerId || 'isolated-browser';
    this.displayName = 'Electron isolated browser';
    this.description = 'Task-scoped non-persistent Electron browser context with structured DOM interaction.';
    this.operations = Object.freeze(['navigate', 'observe', 'click', 'type', 'scroll', 'wait', 'back', 'screenshot', 'takeover', 'closeSession']);
    this.requiredOperations = this.operations;
    this.tracksLimits = true;
    this.windows = new Map();
    this.partitionPrefix = options.partitionPrefix || 'general-agent-';
    this.BrowserWindow = options.BrowserWindow || null;
  }

  _getBrowserWindow() {
    if (this.BrowserWindow) return this.BrowserWindow;
    try {
      ({ BrowserWindow: this.BrowserWindow } = require('electron'));
    } catch {
      throw Object.assign(new Error('Electron browser execution is only available inside the Electron main process.'), { code: 'ENVIRONMENT_BLOCKED' });
    }
    return this.BrowserWindow;
  }

  async _window(session) {
    if (!session || session.state?.closed) throw Object.assign(new Error('Browser session is stale.'), { code: 'STALE_SESSION' });
    const existing = this.windows.get(session.sessionId);
    if (existing && !existing.isDestroyed()) return existing;
    const BrowserWindow = this._getBrowserWindow();
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `${this.partitionPrefix}${session.sessionId}`,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('closed', () => this.windows.delete(session.sessionId));
    this.windows.set(session.sessionId, window);
    return window;
  }

  async _observe(session, window) {
    if (session.state.extractionCount >= session.limits.maxExtractions) {
      throw Object.assign(new Error('Observation limit exceeded.'), { code: 'LIMIT_EXCEEDED' });
    }
    const data = await window.webContents.executeJavaScript(OBSERVE_SCRIPT, true);
    const observation = safeObservation(session, data);
    session.state.extractionCount += 1;
    return observation;
  }

  async navigate(session, target = {}) {
    if (session.state.navigationCount >= session.limits.maxNavigations) {
      throw Object.assign(new Error('Navigation limit exceeded.'), { code: 'LIMIT_EXCEEDED' });
    }
    const window = await this._window(session);
    const url = safeUrl(typeof target === 'string' ? target : target.url);
    session.state.navigationCount += 1;
    try {
      await window.loadURL(url);
    } catch (error) {
      const message = error && error.message ? String(error.message) : 'The page could not be loaded.';
      return safeObservation(session, {
        url,
        title: '',
        visibleText: '',
        interactiveElements: [],
        loginState: 'UNKNOWN',
        pageState: 'LOAD_ERROR',
        errorState: {
          code: 'LOAD_ERROR',
          message: /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_CERT/i.test(message)
            ? 'The page could not be loaded from the current network. The request was not completed, but the task remains bounded and user-visible.'
            : message,
          retryable: true,
        },
      });
    }
    return this._observe(session, window);
  }

  async observe(session) {
    return this._observe(session, await this._window(session));
  }

  async click(session, target = {}) {
    const window = await this._window(session);
    const requested = safeTarget(target);
    const script = `(() => {
      const requested = ${JSON.stringify(requested)};
      const elements = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"]')];
      const element = elements.find((candidate) => [candidate.id, candidate.name, candidate.getAttribute('aria-label'), candidate.getAttribute('placeholder'), candidate.innerText].some((value) => String(value || '').trim() === requested));
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`;
    if (!(await window.webContents.executeJavaScript(script, true))) {
      throw Object.assign(new Error('The requested interactive element was not found.'), { code: 'ELEMENT_NOT_FOUND' });
    }
    return this._observe(session, window);
  }

  async type(session, target = {}) {
    const field = safeTarget(target);
    const fieldType = typeof target === 'object' ? String(target.fieldType || '') : '';
    if (SENSITIVE_FIELD.test(`${field} ${fieldType}`)) {
      throw Object.assign(new Error('Credentials must be entered by the user during login handoff.'), { code: 'CREDENTIALS_REJECTED' });
    }
    const text = bounded(typeof target === 'string' ? '' : target.text, 500);
    const window = await this._window(session);
    const script = `(() => {
      const requested = ${JSON.stringify(field)};
      const value = ${JSON.stringify(text)};
      const elements = [...document.querySelectorAll('input, textarea, select')];
      const element = elements.find((candidate) => [candidate.id, candidate.name, candidate.getAttribute('aria-label'), candidate.getAttribute('placeholder')].some((item) => String(item || '').trim() === requested));
      if (!element || element.disabled) return false;
      const setter = Object.getOwnPropertyDescriptor(element.__proto__, 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    if (!(await window.webContents.executeJavaScript(script, true))) {
      throw Object.assign(new Error('The requested input field was not found.'), { code: 'ELEMENT_NOT_FOUND' });
    }
    return this._observe(session, window);
  }

  async scroll(session, target = {}) {
    const amount = Number(typeof target === 'number' ? target : target.amount || target.delta || 0);
    const window = await this._window(session);
    await window.webContents.executeJavaScript(`window.scrollBy(0, ${Number.isFinite(amount) ? Math.max(-10000, Math.min(10000, amount)) : 0})`, true);
    return this._observe(session, window);
  }

  async wait(session, target = {}) {
    const amount = Math.max(0, Math.min(30000, Number(typeof target === 'number' ? target : target.milliseconds || target.duration || 0) || 0));
    await new Promise((resolve) => setTimeout(resolve, amount));
    return this._observe(session, await this._window(session));
  }

  async back(session) {
    const window = await this._window(session);
    if (!window.webContents.canGoBack()) throw Object.assign(new Error('Browser history is empty.'), { code: 'INVALID_TARGET' });
    await window.webContents.goBack();
    return this._observe(session, window);
  }

  async screenshot(session) {
    const window = await this._window(session);
    if (session.state.screenshotNumber >= session.limits.maxScreenshots) {
      throw Object.assign(new Error('Screenshot limit exceeded.'), { code: 'LIMIT_EXCEEDED' });
    }
    const image = await window.webContents.capturePage();
    const size = image.getSize();
    session.state.screenshotNumber += 1;
    const screenshotReference = `electron-screenshot://${session.sessionId}/${crypto.randomUUID()}`;
    const observation = await this._observe(session, window);
    observation.screenshotReference = screenshotReference;
    session.state.lastObservation = observation;
    return { screenshotReference, width: size.width, height: size.height, version: observation.version };
  }

  async takeover(session) {
    const window = await this._window(session);
    window.show();
    window.focus();
    return {
      handedOff: true,
      reason: session.state.lastObservation?.errorState?.message || 'User takeover requested for this browser session.',
      sessionId: session.sessionId,
    };
  }

  async closeSession(session) {
    const window = this.windows.get(session?.sessionId);
    this.windows.delete(session?.sessionId);
    if (window && !window.isDestroyed()) window.close();
    if (session?.state) session.state.closed = true;
    return { closed: true, sessionId: session?.sessionId || null };
  }

  closeAll() {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.close();
    }
    this.windows.clear();
  }
}

function createElectronBrowserAdapter(options = {}) {
  return new ElectronBrowserAdapter(options);
}

module.exports = {
  ElectronBrowserAdapter,
  createElectronBrowserAdapter,
};
