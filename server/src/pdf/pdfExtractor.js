import fs from 'fs';
import path from 'path';
import os from 'os';
import pdfParse from 'pdf-parse';

/**
 * Extracts plain text from a PDF file buffer.
 *
 * @param {Buffer} buffer  — raw PDF bytes (from multer upload)
 * @returns {Promise<string>} extracted text
 */
export async function extractTextFromPdfBuffer(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
}

/**
 * Extracts text from a PDF file path on disk.
 * Used when the server reads a local file.
 */
export async function extractTextFromPdfPath(filePath) {
  const buffer = fs.readFileSync(filePath);
  return extractTextFromPdfBuffer(buffer);
}

/**
 * Trims extracted text to a maximum character count so we don't
 * blow the LLM context window.  Keeps the first N characters and
 * appends a truncation notice.
 */
export function trimContext(text, maxChars = 12000) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[... document truncated ...]';
}
