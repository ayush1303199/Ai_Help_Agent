import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const developmentCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' http://localhost:5174",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:3001 ws://localhost:3002 ws://localhost:5174",
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
  "connect-src 'self' http://localhost:3001 ws://localhost:3002",
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
