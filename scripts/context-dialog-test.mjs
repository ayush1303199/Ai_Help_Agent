import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const dialogSource = await fs.readFile(new URL('../src/ui/ContextInputDialog.tsx', import.meta.url), 'utf8');
const confirmationSource = await fs.readFile(new URL('../src/ui/ConfirmationDialog.tsx', import.meta.url), 'utf8');
const viteConfig = await fs.readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');

assert.doesNotMatch(appSource, /window\.prompt|globalThis\.prompt|\bprompt\(/);
assert.doesNotMatch(appSource, /window\.confirm|globalThis\.confirm|\bconfirm\(/);
assert.match(appSource, /<ContextInputDialog/);
assert.match(appSource, /<ConfirmationDialog/);
assert.match(appSource, /requestClearSessionContext/);
assert.match(appSource, /requestRemoveResume/);
assert.match(appSource, /requestRemoveJobDescription/);
assert.match(appSource, /setProfileDialogOpen\(true\)/);
assert.match(appSource, /completeProfileTraining/);
assert.match(dialogSource, /role="dialog"/);
assert.match(dialogSource, /aria-modal="true"/);
assert.match(dialogSource, /event\.key === 'Enter'/);
assert.match(dialogSource, /event\.key === 'Escape'/);
assert.match(dialogSource, /Enter a name or choose Cancel/);
assert.match(dialogSource, /aria-label="Close dialog"/);
assert.match(confirmationSource, /role="alertdialog"/);
assert.match(confirmationSource, /aria-modal="true"/);
assert.match(confirmationSource, /event\.key === 'Escape'/);
assert.match(confirmationSource, /event\.key !== 'Tab'/);
assert.match(viteConfig, /productionCsp/);
assert.match(viteConfig, /script-src 'self'/);
assert.doesNotMatch(viteConfig, /productionCsp[\s\S]{0,1200}unsafe-eval/);

console.log(JSON.stringify({
  contextDialog: true,
  nativePromptRemoved: true,
  keyboardAccess: true,
  productionCspConfigured: true,
}));
