import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const appSource = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

assert.match(appSource, /const openConfiguration = useCallback\(\(\) => \{\s*setSettingsOpen\(true\);\s*\}, \[\]\);/);
assert.match(appSource, /onClick=\{openConfiguration\}/);
assert.doesNotMatch(
  appSource,
  /onClick=\{\(\) => \{\s*setSettingsOpen\(true\);\s*void loadAgentActivity\(\);\s*\}\}/,
);

const configurationButtons = [...appSource.matchAll(/<button(?=[^>]*aria-label="Configuration")[^>]*>[\s\S]*?<\/button>/g)];
assert.equal(configurationButtons.length, 2, 'both visible header variants must expose Configuration');
for (const match of configurationButtons) {
  assert.match(match[0], /type="button"/);
  assert.doesNotMatch(match[0], /\bdisabled=/);
}

assert.match(appSource, /useEffect\(\(\) => \{\s*if \(!settingsOpen\) return;\s*void loadAgentActivity\(\);\s*\}, \[loadAgentActivity, settingsOpen\]\);/);

const settingsStart = appSource.indexOf('{settingsOpen && (');
assert.notEqual(settingsStart, -1, 'configuration UI must be rendered from local state');
const settingsSource = appSource.slice(settingsStart, settingsStart + 1200);
assert.match(settingsSource, /role="dialog"/);
assert.match(settingsSource, /aria-modal="true"/);
assert.match(settingsSource, /aria-labelledby="configuration-title"/);
assert.doesNotMatch(settingsSource, /onMouseDown=\{\(\) => \{/);

const openConfigurationBody = appSource.slice(
  appSource.indexOf('const openConfiguration'),
  appSource.indexOf('const enableAllAgentPermissions'),
);
assert.doesNotMatch(openConfigurationBody, /fetch\(|sendMessage|provider|refusal|blocked|confirmation/i);

console.log(JSON.stringify({
  configurationAction: true,
  localOpenHandler: true,
  busyStateIndependent: true,
  asyncRefreshDecoupled: true,
  stableBackdrop: true,
}));
