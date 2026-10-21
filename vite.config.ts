import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { services } = require('./src/config/runtimeSettings.json');
const { http, websocket, codingWebsocket, devServer } = services;
const apiUrl = process.env.VITE_API_URL || http.baseUrl;
const websocketUrl = process.env.VITE_WS_URL || websocket.baseUrl;
const codingWebsocketUrl = process.env.VITE_CODING_WS_URL || codingWebsocket.baseUrl;
const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://${devServer.host}:${devServer.port}`;
const toWebSocketUrl = (url: string) => url.replace(/^http:/, 'ws:');
const e2eTestMode = process.env.AI_CODING_E2E_TEST_MODE === '1'
  ? require('./electron/electronE2eTestMode.cjs').loadElectronE2eTestMode(
    require('./src/config/runtimeSettings.json'),
  )
  : null;

const developmentCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline' ${devServerUrl}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiUrl} ${websocketUrl} ${toWebSocketUrl(devServerUrl)} ${codingWebsocketUrl}`,
  "media-src 'self' blob:",
].join('; ');

const productionCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiUrl} ${websocketUrl} ${codingWebsocketUrl}`,
  "media-src 'self' blob:",
].join('; ');

function contentSecurityPolicyPlugin(command: 'build' | 'serve') {
  const content = command === 'build' ? productionCsp : developmentCsp;
  return {
    name: 'content-security-policy',
    transformIndexHtml(html: string) {
      return html.replace('</head>', `    <meta http-equiv="Content-Security-Policy" content="${content}" />\n  </head>`);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Electron loads the production entrypoint from file://, so bundled assets
  // must resolve relative to dist/index.html rather than the filesystem root.
  base: command === 'build' ? './' : '/',
  ...(e2eTestMode ? { cacheDir: join(e2eTestMode.root, 'vite-cache') } : {}),
  plugins: [react(), contentSecurityPolicyPlugin(command)],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
}));
