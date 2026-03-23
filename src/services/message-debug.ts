import type { MemoryService } from '@/services/memory';

export function formatSummaryDebugText(summary: string): string {
  return summary.trim() ? `current summary:\n${summary}` : 'current summary is empty.';
}

export function formatMemoryDebugText(memoryService: MemoryService, chatId: string): string {
  const session = memoryService.getSession(chatId);
  return [
    `summary_length: ${session.summary.length}`,
    `recent_message_count: ${session.recentMessages.length}`,
    '',
    session.summary.trim() ? `summary:\n${session.summary}` : 'summary:\n(empty)',
  ].join('\n');
}
