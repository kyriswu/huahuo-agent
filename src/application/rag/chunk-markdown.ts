import { createHash } from 'node:crypto';
import type { MarkdownChunk, SourceType } from '../../extensions/huahuo/rag/types.ts';

export const CHUNKER_VERSION = 'markdown-heading-v1';
export const TOKEN_COUNT_STRATEGY = 'heuristic-v1';

export interface ChunkMarkdownInput {
  documentId: string;
  documentVersion: string;
  /** Source context is accepted here so callers can pass the complete document DTO. */
  title?: string;
  content: string;
  sourceType?: SourceType;
  metadata?: Record<string, unknown>;
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

interface ChunkPiece {
  text: string;
  startOffset: number;
  endOffset: number;
  headingPath: string[];
}

interface CarryText {
  text: string;
  startOffset: number;
  endOffset: number;
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
  // Markdown permits heading levels to be skipped. Keep only concrete
  // ancestors so the serialized path never contains sparse/undefined slots.
  return [...path.slice(0, level - 1).filter(Boolean), title];
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function locateSourceText(
  source: string,
  text: string,
  fromOffset: number,
  endOffset: number,
  preferLast = false,
): number {
  const exact = preferLast
    ? source.lastIndexOf(text, Math.max(0, endOffset - text.length))
    : source.indexOf(text, Math.max(0, fromOffset));
  if (exact >= fromOffset && exact + text.length <= endOffset) return exact;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return Math.max(0, fromOffset);
  const pattern = words.map(escapeRegex).join('\\s+');
  const matcher = new RegExp(pattern, 'g');
  matcher.lastIndex = Math.max(0, fromOffset);
  let match: RegExpExecArray | null;
  let lastMatch = -1;
  while ((match = matcher.exec(source))) {
    if (match.index + match[0].length > endOffset) break;
    lastMatch = match.index;
  }
  return lastMatch >= 0 ? lastMatch : Math.max(0, Math.min(fromOffset, endOffset));
}

function blockPieces(block: MarkdownBlock, maxTokens: number): ChunkPiece[] {
  const pieces = splitAtSentenceOrWord(block.text, maxTokens)
    .map((piece) => piece.trim())
    .filter(Boolean);
  let cursor = 0;
  return pieces.map((text) => {
    const localStart = locateSourceText(block.text, text, cursor, block.text.length);
    const localEnd = Math.min(block.text.length, localStart + text.length);
    cursor = localEnd;
    return {
      text,
      startOffset: block.startOffset + localStart,
      endOffset: Math.max(block.startOffset + localStart, block.startOffset + localEnd),
      headingPath: [...block.headingPath],
    };
  });
}

export function chunkMarkdown(input: ChunkMarkdownInput): MarkdownChunk[] {
  if (!input.documentId.trim() || !input.documentVersion.trim()) {
    throw new Error('documentId and documentVersion are required');
  }
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error('title must not be empty when provided');
  }
  if (input.sourceType !== undefined && !['article', 'file', 'note'].includes(input.sourceType)) {
    throw new Error('sourceType must be article, file, or note');
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
  let carry: CarryText | undefined;

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
    const overlap = overlapText(text, input.overlapTokens);
    if (overlap) {
      const carryStart = locateSourceText(content, overlap, 0, pending.endOffset, true);
      carry = {
        text: overlap,
        startOffset: carryStart,
        endOffset: pending.endOffset,
      };
    } else {
      carry = undefined;
    }
    pending = undefined;
  };

  for (const block of blocks) {
    const pieces = blockPieces(block, input.maxTokens);
    for (const piece of pieces) {
      const firstPiece = !pending && carry ? `${carry.text}\n${piece.text}` : piece.text;
      const candidate = pending ? `${pending.text}\n${piece.text}` : firstPiece;
      if (pending && estimateTokenCount(candidate) > input.maxTokens) {
        emit();
        pending = {
          text: carry ? `${carry.text}\n${piece.text}` : piece.text,
          startOffset: carry?.startOffset ?? piece.startOffset,
          endOffset: piece.endOffset,
          headingPath: piece.headingPath,
        };
        carry = undefined;
      } else {
        pending = {
          text: candidate,
          startOffset: pending
            ? Math.min(pending.startOffset, piece.startOffset)
            : carry?.startOffset ?? piece.startOffset,
          endOffset: piece.endOffset,
          headingPath: pending && pending.headingPath.join('\u0000') === piece.headingPath.join('\u0000')
            ? pending.headingPath
            : piece.headingPath,
        };
        carry = undefined;
      }
      if (pending && estimateTokenCount(pending.text) >= input.maxTokens) emit();
    }
  }
  emit();
  return chunks;
}

