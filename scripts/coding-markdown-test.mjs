import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
});

try {
  const { CodingMarkdown } = await vite.ssrLoadModule('/src/features/coding/CodingAgentWorkspace.tsx');
  const markdown = '### INSPECTED CONFIGURATION FILE: requirements.php ```php <?php echo 1; ``` ### DATABASE CONNECTION STATUS - **Target:** DB-001 - **Engine:** unknown - **Database:** Unknown - **Status:** DISCONNECTED #### 1. CONFIGURED DATABASE (Source Code) - **Configuration File:** requirements.php - **Status:** CONFIGURED #### 2. LIVE DATABASE (Runtime Verification) - **Connection State:** NOT_CONNECTED - **Verification Status:** NOT_VERIFIED';
  const response = markdown.replace(/([`*_#|>])/g, (_match, character) => `\\${character}`);
  const html = renderToStaticMarkup(createElement(CodingMarkdown, { content: response }));

  assert.match(html, /<h3[^>]*>INSPECTED CONFIGURATION FILE: requirements\.php<\/h3>/);
  assert.match(html, /<pre[^>]*><code class="language-php">&lt;\?php echo 1;/);
  assert.match(html, /<h3[^>]*>DATABASE CONNECTION STATUS<\/h3>/);
  assert.match(html, /<ul[^>]*><li><strong>Target:<\/strong> DB-001<\/li>/);
  assert.match(html, /<strong>Configuration File:<\/strong> requirements\.php/);
  assert.match(html, /<h3[^>]*>2\. LIVE DATABASE \(Runtime Verification\)<\/h3>/);
  assert.doesNotMatch(html, /\\`|\\\*|####|###/);

  const richMarkdown = [
    '| Name | State |',
    '| --- | :---: |',
    '| applicant | **active** |',
    '',
    '---',
    '',
    '[Documentation](https://example.com/docs)',
    '[Unsafe](javascript:alert(1))',
  ].join('\n');
  const richHtml = renderToStaticMarkup(createElement(CodingMarkdown, { content: richMarkdown }));
  assert.match(richHtml, /<table[^>]*>/);
  assert.match(richHtml, /<th[^>]*>Name<\/th>/);
  assert.match(richHtml, /<td[^>]*><strong>active<\/strong><\/td>/);
  assert.match(richHtml, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(richHtml, /href="javascript:/);
  assert.match(richHtml, /<hr[^>]*>/);

  console.log('Coding Agent Markdown rendering tests passed for reports, tables, links, and horizontal rules.');
} finally {
  await vite.close();
}
