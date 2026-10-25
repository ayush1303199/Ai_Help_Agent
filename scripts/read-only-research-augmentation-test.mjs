import assert from 'node:assert';
import http from 'node:http';
import {
  RESEARCH_EVIDENCE_TIER,
  RESEARCH_STATUSES,
  ALLOWLISTED_DOC_DOMAINS,
  MAX_DOC_SIZE_BYTES,
  sha256,
  sanitizeDocContent,
  isDomainAllowed,
  createResearchQuery,
  fetchReadOnlyDocumentation,
  LocalDocumentationStore,
  augmentDiagnosisWithResearch,
} from '../electron/coding-pipeline/readOnlyResearchAugmentation.cjs';

console.log('Starting Read-Only Research Augmentation regression tests (V6/V10)...');

// 1. Query creation and validation
console.log('Testing research query creation and input validation...');
{
  const query = createResearchQuery({
    query: 'Cannot find module express',
    ecosystem: 'Node',
    errorSignature: 'ERR_MODULE_NOT_FOUND',
  });

  assert.strictEqual(query.query, 'Cannot find module express');
  assert.strictEqual(query.ecosystem, 'node');
  assert.strictEqual(query.errorSignature, 'ERR_MODULE_NOT_FOUND');
  assert.strictEqual(typeof query.queryDigest, 'string');
  assert.strictEqual(query.queryDigest.length, 64);

  assert.throws(() => createResearchQuery({ query: '' }), /Research query must be a non-empty string/);
  assert.throws(() => createResearchQuery({ query: '   ' }), /Research query must be a non-empty string/);
  assert.throws(() => createResearchQuery({ query: null }), /Research query must be a non-empty string/);
}

// 2. Domain allowlisting and SSRF protections
console.log('Testing domain allowlist and SSRF private-range blocking...');
{
  assert.strictEqual(isDomainAllowed('https://developer.mozilla.org/en-US/docs/Web'), true);
  assert.strictEqual(isDomainAllowed('https://nodejs.org/api/fs.html'), true);
  assert.strictEqual(isDomainAllowed('https://docs.python.org/3/library/'), true);
  assert.strictEqual(isDomainAllowed('https://www.typescriptlang.org/docs/'), true);
  assert.strictEqual(isDomainAllowed('http://localhost:8080/doc'), true);

  // Blocked untrusted external domains
  assert.strictEqual(isDomainAllowed('https://attacker-controlled-site.com/exploit'), false);
  assert.strictEqual(isDomainAllowed('http://pastebin.com/raw/1234'), false);
  assert.strictEqual(isDomainAllowed('https://evil-nodejs.org/api'), false);
  assert.strictEqual(isDomainAllowed('http://evil.localhost/doc'), false);

  // Port restrictions on external public documentation hosts (only 80 / 443 allowed)
  assert.strictEqual(isDomainAllowed('https://nodejs.org:443/api'), true);
  assert.strictEqual(isDomainAllowed('http://nodejs.org:80/api'), true);
  assert.strictEqual(isDomainAllowed('https://nodejs.org:8443/api'), false);
  assert.strictEqual(isDomainAllowed('https://developer.mozilla.org:8080/api'), false);

  // Blocked SSRF & cloud metadata IPs
  assert.strictEqual(isDomainAllowed('http://169.254.169.254/latest/meta-data'), false);
  assert.strictEqual(isDomainAllowed('http://10.0.0.1/admin'), false);
  assert.strictEqual(isDomainAllowed('http://172.16.0.1/internal'), false);
  assert.strictEqual(isDomainAllowed('http://192.168.1.1/router'), false);
  assert.strictEqual(isDomainAllowed('http://metadata.google.internal/computeMetadata/v1/'), false);

  // Blocked non-HTTP protocols
  assert.strictEqual(isDomainAllowed('file:///etc/passwd'), false);
  assert.strictEqual(isDomainAllowed('ftp://anonymous@ftp.example.com'), false);
  assert.strictEqual(isDomainAllowed('javascript:alert(1)'), false);
  assert.strictEqual(isDomainAllowed('data:text/html,<b>pwn</b>'), false);
}

// 3. Sanitization and content filtering
console.log('Testing markup sanitization and control character stripping...');
{
  const rawHtml = '<div><h1>Module Guide</h1><script>alert("pwned")</script><style>body{color:red}</style><p>Use import.</p></div>';
  const sanitized = sanitizeDocContent(rawHtml);
  assert.ok(!sanitized.includes('<script>'), 'Script tag should be removed');
  assert.ok(!sanitized.includes('alert'), 'Script contents should be removed');
  assert.ok(!sanitized.includes('<style>'), 'Style tag should be removed');
  assert.ok(sanitized.includes('Module Guide'), 'Text content should be preserved');
  assert.ok(sanitized.includes('Use import.'), 'Text content should be preserved');
}

// 4. Read-only HTTP fetch with size limits and mock local server
console.log('Testing read-only HTTP fetch and size-cap enforcement...');
{
  // Test domain blocked fetch
  const blockedRes = await fetchReadOnlyDocumentation('https://untrusted-host.example.com/docs');
  assert.strictEqual(blockedRes.status, RESEARCH_STATUSES.DOMAIN_BLOCKED);
  assert.strictEqual(blockedRes.evidence, null);

  // Test local HTTP server on localhost
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    if (req.url === '/doc') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Official documentation: use export default or named exports.');
    } else if (req.url === '/oversized') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('A'.repeat(MAX_DOC_SIZE_BYTES + 100));
    } else if (req.url === '/redirect') {
      res.writeHead(302, { 'Location': 'http://169.254.169.254/latest/meta-data' });
      res.end();
    } else {
      res.writeHead(404).end('Not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // Normal fetch
    const okRes = await fetchReadOnlyDocumentation(`http://127.0.0.1:${port}/doc`);
    assert.strictEqual(okRes.status, RESEARCH_STATUSES.SUCCESS);
    assert.ok(okRes.evidence);
    assert.strictEqual(okRes.evidence.trust.isExternal, true);
    assert.strictEqual(okRes.evidence.trust.untrusted, true);
    assert.strictEqual(okRes.evidence.trust.evidenceTier, RESEARCH_EVIDENCE_TIER);
    assert.ok(okRes.evidence.snippet.includes('Official documentation'));
    assert.strictEqual(typeof okRes.evidence.contentDigest, 'string');

    // Oversized response fetch
    const overRes = await fetchReadOnlyDocumentation(`http://127.0.0.1:${port}/oversized`);
    assert.strictEqual(overRes.status, RESEARCH_STATUSES.SIZE_EXCEEDED);

    // Redirect fetch - fails safe and never blindly follows redirects (prevents SSRF via redirects)
    const redirectRes = await fetchReadOnlyDocumentation(`http://127.0.0.1:${port}/redirect`);
    assert.strictEqual(redirectRes.status, RESEARCH_STATUSES.ERROR);
    assert.ok(redirectRes.reason.includes('302'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// 5. Offline local documentation store
console.log('Testing deterministic offline documentation store...');
{
  const store = new LocalDocumentationStore();
  store.register('ts2345', {
    url: 'https://www.typescriptlang.org/docs/handbook/2/narrowing.html',
    content: 'TS2345: Argument of type X is not assignable to parameter of type Y.',
    ecosystem: 'node',
  });

  const entry = store.lookup('TS2345');
  assert.ok(entry);
  assert.strictEqual(entry.sourceUrl, 'https://www.typescriptlang.org/docs/handbook/2/narrowing.html');
  assert.strictEqual(entry.trust.untrusted, true);
  assert.strictEqual(entry.trust.evidenceTier, RESEARCH_EVIDENCE_TIER);
  assert.ok(entry.snippet.includes('TS2345'));

  const missing = store.lookup('UNKNOWN_NONEXISTENT_ERROR');
  assert.strictEqual(missing, null);
}

// 6. Augmenting diagnostic failures with research
console.log('Testing diagnosis augmentation with external research...');
{
  const store = new LocalDocumentationStore();
  store.register('err_module_not_found', {
    url: 'https://nodejs.org/api/errors.html#err_module_not_found',
    content: 'Node.js Error ERR_MODULE_NOT_FOUND: Package or module cannot be resolved.',
    ecosystem: 'node',
  });

  // Case A: Diagnostic is already clear and high confidence -> research is skipped
  const clearDiagnosis = {
    diagnosisId: 'diag-1',
    status: 'CONFIRMED',
    confidence: 'HIGH',
    failureCategory: 'SYNTAX_ERROR',
    evidence: { summary: 'SyntaxError: Unexpected token ; at line 12' },
  };

  const augmentedA = await augmentDiagnosisWithResearch(clearDiagnosis, { localStore: store });
  assert.strictEqual(augmentedA.researchAugmentation.status, RESEARCH_STATUSES.SKIPPED);
  assert.strictEqual(augmentedA.researchAugmentation.findings.length, 0);

  // Case B: Diagnostic has missing dependency / ERR_MODULE_NOT_FOUND signature -> research triggers
  const unknownDiagnosis = {
    diagnosisId: 'diag-2',
    status: 'INSUFFICIENT_EVIDENCE',
    confidence: 'LOW',
    failureCategory: 'UNKNOWN',
    evidence: { summary: 'Command failed with ERR_MODULE_NOT_FOUND: Cannot find module helper' },
  };

  const augmentedB = await augmentDiagnosisWithResearch(unknownDiagnosis, { localStore: store });
  assert.strictEqual(augmentedB.researchAugmentation.status, RESEARCH_STATUSES.SUCCESS);
  assert.strictEqual(augmentedB.researchAugmentation.findings.length, 1);
  const finding = augmentedB.researchAugmentation.findings[0];
  assert.strictEqual(finding.provenance.sourceUrl, 'https://nodejs.org/api/errors.html#err_module_not_found');
  assert.strictEqual(finding.trust.isExternal, true);
  assert.strictEqual(finding.trust.untrusted, true);
  assert.strictEqual(finding.trust.evidenceTier, RESEARCH_EVIDENCE_TIER);

  // Invariant: original diagnosis properties remain untouched
  assert.strictEqual(augmentedB.diagnosisId, 'diag-2');
  assert.strictEqual(augmentedB.status, 'INSUFFICIENT_EVIDENCE');
}

console.log('All Read-Only Research Augmentation regression tests passed successfully!');
