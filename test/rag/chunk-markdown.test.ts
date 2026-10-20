import { describe, expect, it } from 'vitest';
import {
  chunkMarkdown,
  estimateTokenCount,
  normalizeMarkdown,
  sha256,
} from '../../src/application/rag/chunk-markdown.ts';

const defaults = {
  documentId: 'doc-1',
  documentVersion: 'v1',
  maxTokens: 20,
  overlapTokens: 3,
};

describe('chunkMarkdown', () => {
  it('returns an empty list for empty or whitespace-only documents', () => {
    expect(chunkMarkdown({ ...defaults, content: ' \n\t' })).toEqual([]);
  });

  it('preserves heading paths and stable chunk identity', () => {
    const input = { ...defaults, content: '# Intro\n\n## 中文\n\nHello world. 你好世界。' };
    const first = chunkMarkdown(input);
    const second = chunkMarkdown(input);
    expect(first).toEqual(second);
    expect(first[0]?.headingPath).toEqual(['Intro', '中文']);
    expect(first[0]?.chunkId).toHaveLength(64);
    expect(first[0]?.contentHash).toHaveLength(64);
  });

  it('handles Chinese, English, and mixed content with explicit estimated token counts', () => {
    const chunks = chunkMarkdown({
      ...defaults,
      content: '# 混合\n\n这是中文 paragraph with English words and API_v1. 继续测试。',
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.tokenCount === estimateTokenCount(chunk.text))).toBe(true);
    expect(chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
  });

  it('splits long text and keeps overlap when the configured budget is exceeded', () => {
    const chunks = chunkMarkdown({
      ...defaults,
      maxTokens: 8,
      overlapTokens: 2,
      content: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen.',
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.tokenCount <= 10)).toBe(true);
    expect(chunks[1]?.text).toContain('eight');
  });

  it('keeps fenced code in one block when it fits', () => {
    const chunks = chunkMarkdown({
      ...defaults,
      content: '# Code\n\n```ts\nconst value = 1;\nconsole.log(value);\n```\n',
    });
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain('```ts');
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain('console.log(value);');
  });

  it('normalizes line endings and hashes with SHA-256', () => {
    expect(normalizeMarkdown('a\r\nb\rc')).toBe('a\nb\nc');
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

