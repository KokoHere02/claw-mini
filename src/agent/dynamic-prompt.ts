import type { ModelMessage } from 'ai';

export function buildSummaryContextMessage(summary: string): ModelMessage | null {
  const trimmed = summary.trim();
  if (!trimmed) return null;

  return {
    role: 'system',
    content: [
      '[CONVERSATION_SUMMARY]',
      trimmed,
      '',
      'Use this summary as background context. Always prioritize the latest user message if there is any conflict.',
    ].join('\n'),
  };
}
