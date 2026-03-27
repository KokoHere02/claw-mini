import { USER_FACING_TEXT } from '@/constants/user-facing-text';
import type { MemoryService } from '@/services/memory';

export function formatSummaryDebugText(summary: string): string {
  return summary.trim()
    ? `${USER_FACING_TEXT.summaryTitle}\n${summary}`
    : USER_FACING_TEXT.summaryEmpty;
}

export function formatMemoryDebugText(memoryService: MemoryService, chatId: string): string {
  const session = memoryService.getSession(chatId);
  return [
    `${USER_FACING_TEXT.memorySummaryLengthLabel}: ${session.summary.length}`,
    `${USER_FACING_TEXT.memoryRecentMessageCountLabel}: ${session.recentMessages.length}`,
    '',
    session.summary.trim()
      ? `${USER_FACING_TEXT.memorySummaryLabel}:\n${session.summary}`
      : `${USER_FACING_TEXT.memorySummaryLabel}:\n(空)`,
  ].join('\n');
}
