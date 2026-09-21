import type { runtimeConfig } from '../config/runtimeConfig';

export type DocumentType = 'resume' | 'job-description' | 'session';
export type DocumentSource = 'pdf' | 'pasted-text';

export interface NormalizedDocument {
  id: string;
  type: DocumentType;
  name: string;
  text: string;
  source: DocumentSource;
  uploadedAt: number;
}

export type DocumentServiceConfig = typeof runtimeConfig;

function documentLabel(type: DocumentType) {
  if (type === 'resume') return 'Resume';
  if (type === 'job-description') return 'Job Description';
  return 'Session Document';
}

function isPdfFile(file: File) {
  return file.name.toLowerCase().endsWith('.pdf');
}

export function validatePdfFile(file: File, maxSizeBytes: number) {
  if (!isPdfFile(file)) {
    throw new Error('Only PDF files can be uploaded to the context area.');
  }
  if (file.size > maxSizeBytes) {
    throw new Error(`${file.name} is larger than ${Math.round(maxSizeBytes / (1024 * 1024))}MB PDF limit.`);
  }
}

async function extractPdfFile(file: File, config: DocumentServiceConfig, type: DocumentType): Promise<NormalizedDocument> {
  validatePdfFile(file, config.limits.maxPdfSizeBytes);

  const formData = new FormData();
  formData.append('file', file);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), config.limits.pdfUploadTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.httpUrl}/api/extract-pdf`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Failed to extract ${file.name}.`);
  }

  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) {
    throw new Error(`${file.name} was not readable as text. Try a different PDF or an OCR-enabled file.`);
  }

  return {
    id: crypto.randomUUID(),
    type,
    name: `${documentLabel(type)}: ${file.name}`,
    text: data.text,
    source: 'pdf',
    uploadedAt: Date.now(),
  };
}

export async function extractPdfDocuments(
  files: readonly File[],
  type: DocumentType,
  config: DocumentServiceConfig,
) {
  const documents: NormalizedDocument[] = [];
  for (const file of files) {
    documents.push(await extractPdfFile(file, config, type));
  }
  return documents;
}

export function createPastedDocument(text: string): NormalizedDocument | null {
  const normalizedText = text.trim();
  if (!normalizedText) return null;
  return {
    id: crypto.randomUUID(),
    type: 'job-description',
    name: 'Job Description: Pasted text',
    text: normalizedText,
    source: 'pasted-text',
    uploadedAt: Date.now(),
  };
}
