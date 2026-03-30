import { USER_FACING_TEXT } from '@/constants/user-facing-text';
import type { MemoryService } from '@/services/memory';
import { runtimeMetrics } from '@/services/runtime-metrics';

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

export function formatRuntimeMetricsDebugText(): string {
  const snapshot = runtimeMetrics.snapshot();
  const counterEntries = Object.entries(snapshot.counters);
  const durationEntries = Object.entries(snapshot.durations);
  const recentTaskStatus = snapshot.recentTaskStatus;

  const lines: string[] = ['runtime metrics'];
  lines.push('');
  lines.push('[counters]');
  if (!counterEntries.length) {
    lines.push('(empty)');
  } else {
    for (const [name, value] of counterEntries) {
      lines.push(`${name}: ${value}`);
    }
  }

  lines.push('');
  lines.push('[durations_ms]');
  if (!durationEntries.length) {
    lines.push('(empty)');
  } else {
    for (const [name, stats] of durationEntries) {
      lines.push(
        `${name}: count=${stats.count}, avg=${stats.avg}, min=${stats.min}, max=${stats.max}, sum=${stats.sum}`,
      );
    }
  }

  lines.push('');
  lines.push('[recent_task_status_distribution_last_50]');
  lines.push(`total: ${recentTaskStatus.total}`);
  lines.push(`completed: ${recentTaskStatus.completed}`);
  lines.push(`cancelled: ${recentTaskStatus.cancelled}`);
  lines.push(`timed_out: ${recentTaskStatus.timed_out}`);
  lines.push(`failed: ${recentTaskStatus.failed}`);

  return lines.join('\n');
}
