import { describe, expect, it } from 'vitest';
import {
  DocumentParseError,
  parseDocument,
} from '../../src/application/rag/document-parser.ts';

describe('document parser boundary', () => {
  it('normalizes a markdown file into the contract consumed by chunking', async () => {
    const result = await parseDocument({
      content: new TextEncoder().encode('# Title\n\n正文'),
      fileName: 'guide.md',
      title: 'Guide',
    });
    expect(result).toMatchObject({
      content: '# Title\n\n正文',
      format: 'markdown',
      parserVersion: 'markdown-text-v1',
      title: 'Guide',
    });
  });

  it('rejects unsupported binary formats instead of indexing undecoded bytes', async () => {
    await expect(parseDocument({ content: new Uint8Array([0, 1, 2]), mimeType: 'application/pdf' }))
      .rejects.toBeInstanceOf(DocumentParseError);
  });
});
