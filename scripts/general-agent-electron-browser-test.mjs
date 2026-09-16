import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createElectronBrowserAdapter } = require('../electron/generalAgentElectronBrowser.cjs');

class FakeWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.closed = false;
    this.nextObservation = {
      url: 'https://example.com/',
      title: 'Example',
      visibleText: 'Public page',
      interactiveElements: [{ id: 'continue', label: 'Continue', enabled: true }],
      loginState: 'UNKNOWN',
      pageState: 'complete',
    };
    this.observationSources = [];
    this.popupHandler = null;
    this.webContents = {
      setWindowOpenHandler: (handler) => { this.popupHandler = handler; },
      executeJavaScript: async (source) => {
        new Function(source);
        if (source.includes('const requested')) return true;
        this.observationSources.push(source);
        return this.nextObservation;
      },
      canGoBack: () => false,
      goBack: async () => {},
      capturePage: async () => ({ getSize: () => ({ width: 1280, height: 900 }) }),
    };
    FakeWindow.instances.push(this);
  }

  on() {}
  isDestroyed() { return this.closed; }
  async loadURL(url) { this.url = url; }
  show() {}
  focus() {}
  close() { this.closed = true; }
}

function createSession(id) {
  return {
    sessionId: id,
    state: {
      closed: false,
      observationVersion: 0,
      extractionCount: 0,
      navigationCount: 0,
      screenshotNumber: 0,
      lastObservation: null,
      url: '',
    },
    limits: { maxExtractions: 10, maxNavigations: 10, maxScreenshots: 2 },
  };
}

const adapter = createElectronBrowserAdapter({ BrowserWindow: FakeWindow });
const first = createSession('browser-test-1');
const second = createSession('browser-test-2');
const observation = await adapter.navigate(first, { url: 'https://example.com' });
assert.equal(observation.version, 1);
assert.equal(first.state.url, 'https://example.com/');
assert.equal(FakeWindow.instances[0].options.webPreferences.partition, 'general-agent-browser-test-1');
assert.equal(FakeWindow.instances[0].observationSources.some((source) => /\.value\b/.test(source)), false);

await adapter.observe(second);
assert.notEqual(FakeWindow.instances[0].options.webPreferences.partition, FakeWindow.instances[1].options.webPreferences.partition);
assert.deepEqual(FakeWindow.instances[0].popupHandler({ url: 'https://popup.example' }), { action: 'deny' });
await adapter.click(first, { target: 'continue' });
await adapter.screenshot(first);

await assert.rejects(
  () => adapter.navigate(first, { url: 'https://user:password@example.com' }),
  (error) => error.code === 'CREDENTIALS_REJECTED',
);
await assert.rejects(
  () => adapter.type(first, { field: 'password', text: 'secret' }),
  (error) => error.code === 'CREDENTIALS_REJECTED',
);

await adapter.closeSession(first);
assert.equal(first.state.closed, true);
console.log('electron browser adapter tests passed');
