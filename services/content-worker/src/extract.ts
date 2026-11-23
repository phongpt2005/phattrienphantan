/**
 * Trích văn bản từ tệp. Trả về chuỗi rỗng + extractor 'unsupported' với định dạng chưa hỗ trợ:
 * worker vẫn báo cho node để phiên bản đó không bị xử lý lại.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (data: Buffer) => Promise<{ text: string }> = require('pdf-parse/lib/pdf-parse.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth: { extractRawText(input: { buffer: Buffer }): Promise<{ value: string }> } = require('mammoth');

const MAX_CHARS = 300000;
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'log', 'yml', 'yaml', 'sql']);

function clean(s: string): string {
  return s
    .split(String.fromCharCode(0))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}

export async function extractText(buf: Buffer, fileName: string, mimeType: string): Promise<{ text: string; extractor: string }> {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const mime = mimeType.toLowerCase();

  if (mime === 'application/pdf' || ext === 'pdf') {
    const out = await pdfParse(buf);
    return { text: clean(out.text || ''), extractor: 'pdf' };
  }
  if (mime.includes('wordprocessingml') || ext === 'docx') {
    const out = await mammoth.extractRawText({ buffer: buf });
    return { text: clean(out.value || ''), extractor: 'docx' };
  }
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXT.has(ext)) {
    return { text: clean(buf.toString('utf8')), extractor: 'text' };
  }
  return { text: '', extractor: 'unsupported' };
}
