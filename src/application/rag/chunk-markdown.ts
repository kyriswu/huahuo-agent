import { createHash } from 'node:crypto';
import type { MarkdownChunk } from '../../extensions/huahuo/rag/types.ts';

export const CHUNKER_VERSION = 'markdown-heading-v1';
export const TOKEN_COUNT_STRATEGY = 'heuristic-v1';

export interface ChunkMarkdownInput {
  documentId: string;
  documentVersion: string;
  content: string;
  maxTokens: number;
  overlapTokens: number;
  chunkerVersion?: string;
}

interface MarkdownBlock {
  text: string;
  startOffset: number;
  endOffset: number;
  headingPath: string[];
  kind: 'paragraph' | 'code' | 'table' | 'heading';
}

export function normalizeMarkdown(content: string): string {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A deterministic, model-independent estimate:
 * - CJK code points count as one estimated token.
 * - ASCII words count as one token plus punctuation runs.
 * - Other Unicode words count as one token.
 *
 * This is deliberately named an estimate. A production model tokenizer can
 * replace it in a future pipeline version without changing this chunk contract.
 */
export function estimateTokenCount(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const withoutCjk = text.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ');
  const words = withoutCjk.match(/[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*/g)?.length ?? 0;
  const punctuation = withoutCjk.match(/[^\sA-Za-z0-9_]+/g)?.length ?? 0;
  return cjk + words + punctuation;
}

function headingMatch(line: string): { level: number; title: string } | undefined {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
  return match ? { level: match[1].length, title: match[2].trim() } : undefined;
}

function updateHeadingPath(path: string[], level: number, title: string): string[] {
  const next = path.slice(0, level - 1);
  next[level - 1] = title;
  return next;
}

function createBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];
  let headingPath: string[] = [];
  let offset = 0;
  let current: { start: number; lines: string[]; kind: MarkdownBlock['kind']; headingPath: string[] } | undefined;
  let inFence = false;
  let fenceMarker = '';

  const flush = (endOffset: number): void => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) {
      const leading = current.lines.join('\n').length - current.lines.join('\n').trimStart().length;
      blocks.push({
        text,
        startOffset: current.start + leading,
        endOffset: Math.max(current.start + leading, endOffset - (current.lines.join('\n').length - current.lines.join('\n').trimEnd().length)),
        headingPath: current.headingPath,
        kind: current.kind,
      });
    }
    current = undefined;
  };

  const start = (kind: MarkdownBlock['kind'], line: string, lineOffset: number): void => {
    current = { start: lineOffset, lines: [line], kind, headingPath: [...headingPath] };
  };

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const fence = /^ {0,3}(```+|~~~+)/.exec(line);

    if (fence) {
      if (!inFence) {
        flush(lineStart);
        inFence = true;
        fenceMarker = fence[1][0];
        start('code', line, lineStart);
      } else {
        current?.lines.push(line);
        if (fence[1][0] === fenceMarker) {
          inFence = false;
          fenceMarker = '';
          flush(lineEnd);
        }
      }
      offset = lineEnd + 1;
      continue;
    }

    if (inFence) {
      current?.lines.push(line);
      offset = lineEnd + 1;
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      flush(lineStart);
      headingPath = updateHeadingPath(headingPath, heading.level, heading.title);
      start('heading', line, lineStart);
      flush(lineEnd);
      offset = lineEnd + 1;
      continue;
    }

    if (!line.trim()) {
      flush(lineStart);
      offset = lineEnd + 1;
      continue;
    }

    const isTable = line.trimStart().startsWith('|') || line.includes(' | ');
    if (!current) {
      start(isTable ? 'table' : 'paragraph', line, lineStart);
    } else if (current.kind === 'table' || isTable) {
      current.lines.push(line);
      current.kind = 'table';
    } else {
      current.lines.push(line);
    }
    offset = lineEnd + 1;
  }
  flush(content.length);
  return blocks;
}

function splitAtSentenceOrWord(text: string, maxTokens: number): string[] {
  if (estimateTokenCount(text) <= maxTokens) return [text];
  const units = text.match(/[^.!?。！？；;\n]+[.!?。！？；;]?[\n]?/g) ?? [text];
  const pieces: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current}${unit}` : unit;
    if (current && estimateTokenCount(candidate) > maxTokens) {
      pieces.push(current.trim());
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  if (pieces.length > 1 || estimateTokenCount(pieces[0] ?? '') <= maxTokens) return pieces;

  const tokens = tokenUnits(text);
  const fallback: string[] = [];
  for (let index = 0; index < tokens.length; index += maxTokens) {
    fallback.push(joinTokenUnits(tokens.slice(index, index + maxTokens), text));
  }
  return fallback;
}

function tokenUnits(text: string): string[] {
  if (/\s/.test(text)) return text.trim().split(/\s+/);
  return text.match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|[^\s]/g) ?? [];
}

function joinTokenUnits(units: string[], source: string): string {
  return /\s/.test(source) ? units.join(' ') : units.join('');
}

function overlapText(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return '';
  const tokens = tokenUnits(text);
  return joinTokenUnits(tokens.slice(Math.max(0, tokens.length - overlapTokens)), text);
}

export function chunkMarkdown(input: ChunkMarkdownInput): MarkdownChunk[] {
  if (!input.documentId.trim() || !input.documentVersion.trim()) {
    throw new Error('documentId and documentVersion are required');
  }
  if (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0) {
    throw new Error('maxTokens must be a positive integer');
  }
  if (!Number.isInteger(input.overlapTokens) || input.overlapTokens < 0 || input.overlapTokens >= input.maxTokens) {
    throw new Error('overlapTokens must be an integer smaller than maxTokens');
  }

  const content = normalizeMarkdown(input.content);
  if (!content.trim()) return [];

  const blocks = createBlocks(content);
  const chunks: MarkdownChunk[] = [];
  let pending: { text: string; startOffset: number; endOffset: number; headingPath: string[] } | undefined;

  const emit = (): void => {
    if (!pending?.text.trim()) return;
    const text = pending.text.trim();
    const contentHash = sha256(text);
    const index = chunks.length;
    const chunkerVersion = input.chunkerVersion ?? CHUNKER_VERSION;
    chunks.push({
      chunkId: sha256(`${input.documentId}:${input.documentVersion}:${index}:${contentHash}:${chunkerVersion}`),
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      chunkIndex: index,
      text,
      headingPath: pending.headingPath,
      startOffset: pending.startOffset,
      endOffset: pending.endOffset,
      tokenCount: estimateTokenCount(text),
      contentHash,
      chunkerVersion,
    });
    pending = undefined;
  };

  for (const block of blocks) {
    const pieces = splitAtSentenceOrWord(block.text, input.maxTokens);
    for (const piece of pieces) {
      const candidate = pending ? `${pending.text}\n${piece}` : piece;
      if (pending && estimateTokenCount(candidate) > input.maxTokens) {
        const previous = pending.text;
        emit();
        const overlap = overlapText(previous, input.overlapTokens);
        pending = {
          text: overlap ? `${overlap}\n${piece}` : piece,
          startOffset: Math.max(0, block.startOffset - overlap.length),
          endOffset: block.endOffset,
          headingPath: [...block.headingPath],
        };
      } else {
        pending = {
          text: candidate,
          startOffset: pending ? Math.min(pending.startOffset, block.startOffset) : block.startOffset,
          endOffset: block.endOffset,
          headingPath: pending && pending.headingPath.join('\u0000') === block.headingPath.join('\u0000')
            ? pending.headingPath
            : [...block.headingPath],
        };
      }
      if (pending && estimateTokenCount(pending.text) >= input.maxTokens) emit();
    }
  }
  emit();
  return chunks;
}

