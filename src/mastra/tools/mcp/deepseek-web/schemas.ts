import { isIP } from 'node:net';
import { z } from 'zod';

// DeepSeek's limits count Unicode characters, not UTF-16 code units.
function unicodeString(maxLength: number) {
  return z.string().min(1).refine(value => [...value].length <= maxLength, {
    message: `Must contain at most ${maxLength} Unicode characters.`,
  });
}

export const deepseekSearchInputSchema = z.object({
  query: unicodeString(128)
    .refine(value => value.trim().length > 0, 'Query cannot be all whitespace.')
    .describe('Search query, 1–128 Unicode characters. Supports site:, -site:, quoted phrases, lang:, after:, and before: operators.'),
  count: z.number().int().min(1).max(50).default(10)
    .describe('Number of ranked results to return, from 1 to 50.'),
  ori_question: unicodeString(128).nullable().optional()
    .describe('Optional original user question, 1–128 Unicode characters, to improve query understanding.'),
  localization: z.string().refine(value => value === '' || isIP(value) !== 0, 'Must be an IP address or an empty string.')
    .default('').describe('Optional IPv4 or IPv6 address for localized results.'),
  need_content: z.boolean().default(false)
    .describe('Include page content in results. Leave false for summaries; use Fetch to read a selected page.'),
}).strict();

export const deepseekSearchOutputSchema = z.object({
  results: z.array(z.object({
    rerank_score: z.number().min(0).max(3),
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    summary: z.string(),
    content: z.string(),
    site_name: z.string().nullable(),
    site_icon: z.string().nullable(),
    date: z.string().datetime({ offset: true }).nullable(),
    authority: z.number().int().min(-1).max(4),
  })),
});

export const deepseekFetchInputSchema = z.object({
  url: unicodeString(8192).refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Must be an HTTP or HTTPS URL with a host and no username or password.')
    .describe('Page URL to read, at most 8192 characters. Must use HTTP or HTTPS and contain no embedded credentials.'),
}).strict();

export const deepseekFetchOutputSchema = z.object({
  title: z.string(),
  content: z.string(),
});

export type DeepSeekSearchInput = z.input<typeof deepseekSearchInputSchema>;
export type DeepSeekSearchOutput = z.output<typeof deepseekSearchOutputSchema>;
export type DeepSeekFetchInput = z.input<typeof deepseekFetchInputSchema>;
export type DeepSeekFetchOutput = z.output<typeof deepseekFetchOutputSchema>;
