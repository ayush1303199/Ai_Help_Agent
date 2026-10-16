import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  root: projectRoot,
  plugins: [react()],
  build: {
    outDir: path.join(projectRoot, 'ui-preview-dist'),
    emptyOutDir: false,
    rollupOptions: {
      input: path.join(projectRoot, 'preview.html'),
    },
  },
});
