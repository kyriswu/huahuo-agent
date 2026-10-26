import { extname } from 'node:path';

/** A parsed document is the boundary between file parsing and RAG indexing. */
export interface ParsedDocument {
  /** Canonical UTF-8 text passed to normalization and chunking. */
  content: string;
  /** Parser implementation and version used to produce the content. */
  parserVersion: string;
  format: 'markdown' | 'text';
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentParseInput {
  content: string | Uint8Array;
  fileName?: string;
  mimeType?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentParserPort {
  parse(input: DocumentParseInput): Promise<ParsedDocument>;
}

export class DocumentParseError extends Error {
  readonly code = 'DOCUMENT_PARSE_FAILED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DocumentParseError';
  }
}

function asText(content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new DocumentParseError('Document is not valid UTF-8 text', { cause: error });
  }
}

function normalizedExtension(fileName?: string): string {
  return fileName ? extname(fileName).toLowerCase() : '';
}

function isMarkdown(input: DocumentParseInput): boolean {
  const mime = input.mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return mime === 'text/markdown'
    || mime === 'text/x-markdown'
    || ['.md', '.markdown', '.mdown', '.mkdn'].includes(normalizedExtension(input.fileName));
}

function isPlainText(input: DocumentParseInput): boolean {
  const mime = input.mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return mime === undefined
    || mime === ''
    || mime === 'text/plain'
    || mime === 'text/csv'
    || ['.txt', '.csv'].includes(normalizedExtension(input.fileName));
}

/**
 * Parser for the formats currently accepted by the indexing pipeline.
 *
 * PDF/DOCX parsing stays behind DocumentParserPort so the parser already
 * verified in the upstream document service can be injected without changing
 * chunking, embedding, or storage code.
 */
export class TextDocumentParser implements DocumentParserPort {
  async parse(input: DocumentParseInput): Promise<ParsedDocument> {
    if (!isMarkdown(input) && !isPlainText(input)) {
      throw new DocumentParseError(
        `No text parser is registered for ${input.mimeType ?? input.fileName ?? 'the supplied document'}`,
      );
    }
    const content = asText(input.content);
    if (!content.trim()) throw new DocumentParseError('Document contains no text');
    return {
      content,
      parserVersion: isMarkdown(input) ? 'markdown-text-v1' : 'plain-text-v1',
      format: isMarkdown(input) ? 'markdown' : 'text',
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  }
}

/** Default parser used by the local ingest script and simple API adapters. */
export const textDocumentParser = new TextDocumentParser();

export function parseDocument(input: DocumentParseInput): Promise<ParsedDocument> {
  return textDocumentParser.parse(input);
}
