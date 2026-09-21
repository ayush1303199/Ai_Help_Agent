import assert from 'node:assert/strict';

const documents = await import('../src/documents/documentService.ts');

const pasted = documents.createPastedDocument('  Role requirements and responsibilities.  ');
assert.deepEqual(
  { type: pasted.type, source: pasted.source, name: pasted.name, text: pasted.text },
  {
    type: 'job-description',
    source: 'pasted-text',
    name: 'Job Description: Pasted text',
    text: 'Role requirements and responsibilities.',
  },
);
assert.equal(documents.createPastedDocument('   '), null);

const validPdf = new File(['%PDF-1.7'], 'candidate.pdf', { type: 'application/pdf' });
assert.doesNotThrow(() => documents.validatePdfFile(validPdf, 20 * 1024 * 1024));
assert.throws(
  () => documents.validatePdfFile(new File(['text'], 'candidate.txt'), 20 * 1024 * 1024),
  /Only PDF files/,
);
assert.throws(
  () => documents.validatePdfFile(new File(['12345'], 'large.pdf'), 4),
  /larger than 0MB PDF limit/,
);

console.log(JSON.stringify({
  documentService: true,
  pdfValidation: true,
  pastedTextNormalization: true,
  sharedDocumentModel: true,
}));
