import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const settings = require('../src/config/runtimeSettings.json');
const packageConfig = require('../package.json');
const backendBuild = fs.readFileSync(path.join(root, 'scripts', 'build-backend.mjs'), 'utf8');

for (const service of ['http', 'websocket', 'codingWebsocket']) {
  assert.ok(Number.isInteger(settings.services[service].port), `${service} port must be an integer`);
  assert.equal(Number(new URL(settings.services[service].baseUrl).port), settings.services[service].port);
}
assert.ok(Number.isInteger(settings.services.devServer.port));
assert.ok(settings.client.transport.requestTimeoutMs > settings.backend.modelRequestTimeoutSeconds * 1000);
assert.equal(settings.client.audio.systemSilenceMs, 1800, 'Meeting voice should finalize speech promptly after a short pause');
assert.equal(settings.client.audio.shortFragmentMaxWords, 2);
assert.equal(settings.client.audio.shortFragmentMaxDurationMs, 5000);
assert.ok(settings.client.audio.voiceHighPassHz > 0);
assert.ok(settings.client.audio.voiceLowPassHz > settings.client.audio.voiceHighPassHz);
assert.ok(settings.client.audio.voiceCompressorRatio > 1);
assert.ok(packageConfig.build.files.includes('src/config/runtimeSettings.json'));
assert.ok(backendBuild.includes('runtimeSettings.json'), 'PyInstaller must bundle the shared settings');

const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
  '-c',
  'import json,sys; sys.path.insert(0,"server/src"); import backend_config as c; print(json.dumps({"ports":[c.PORT,c.WS_PORT,c.CODING_WS_PORT],"max_tokens":c.MAX_TOKENS,"model_timeout":c.MODEL_REQUEST_TIMEOUT_SECONDS}))',
], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, PORT: '3981', AI_MAX_TOKENS: '777' },
});
assert.equal(python.status, 0, python.stderr || 'Python backend settings failed to load');
const backend = JSON.parse(python.stdout.trim());
assert.deepEqual(backend.ports, [
  3981,
  settings.services.websocket.port,
  settings.services.codingWebsocket.port,
]);
assert.equal(backend.max_tokens, 777, 'existing backend environment overrides must remain supported');
assert.equal(backend.model_timeout, settings.backend.modelRequestTimeoutSeconds);

console.log('Runtime settings loading, packaging, and environment overrides passed.');
