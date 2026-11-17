import type { Processor, ProcessInputArgs, ProcessOutputStreamArgs } from '@mastra/core/processors';
import { SpanType, type AnySpan } from '@mastra/core/observability';
import { agentMetrics, observeSafely, type AgentMetrics } from './metrics.js';

function runSpan(args: ProcessInputArgs | ProcessOutputStreamArgs): AnySpan | undefined {
  let span = args.tracingContext?.currentSpan;
  for (let depth = 0; span && depth < 32; depth++, span = span.parent) if (span.type === SpanType.AGENT_RUN) return span;
  return undefined;
}
/** Native passthrough observer, retaining only timestamp/flag in per-request processor state. */
export function firstTextProcessor(agent: 'huox' | 'weather-agent', metrics: AgentMetrics = agentMetrics) {
  return {
    id: 'huahuo-first-text',
    processInput(args: ProcessInputArgs) {
      observeSafely(() => {
        const root = runSpan(args);
        if (root && !root.metadata?.resumed) args.state.firstTextStart = root.startTime.getTime();
      });
      return args.messageList;
    },
    async processOutputStream(args: ProcessOutputStreamArgs) {
      observeSafely(() => {
        if (args.state.firstTextObserved || args.part.type !== 'text-delta' || args.part.payload.text.length === 0 || args.abortSignal?.aborted) return;
        const root = runSpan(args);
        if (!root || root.metadata?.resumed) return;
        const start = typeof args.state.firstTextStart === 'number' ? args.state.firstTextStart : root.startTime.getTime();
        args.state.firstTextObserved = true;
        metrics.firstText.observe({ agent }, Math.max(0, Date.now() - start) / 1_000);
      });
      return args.part;
    },
  } satisfies Processor;
}
