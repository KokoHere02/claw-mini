import { MemoryService } from '@/services/memory';
import { config } from '@/config';
import {
  sendTextMessage,
  extractTextContent,
  isMemoryDebugCommand,
  isResetCommand,
  isSummaryDebugCommand,
} from '@/services/feishu';
import { FeishuEventPayload } from '@/types/feishu';
import logger from '@/utils/logger';
import { runAgent } from '@/agent';
import { buildSummaryContextMessage } from '@/agent/dynamic-prompt';
import { maybeSummarizeSession } from './memory-summarizer';
import { FileMemoryRepository } from './file-memory-repository';

const memoryService = new MemoryService(
  config.sessionMaxTurns,
  config.eventDedupeTtlMs,
  new FileMemoryRepository(),
);

// Per-chat rate limit: process at most one message every 5 seconds.
const chatRateLimit = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of chatRateLimit) {
    if (now - ts > 5_000) chatRateLimit.delete(id);
  }
}, 10_000);

function formatSummaryDebugText(summary: string): string {
  return summary.trim() ? `current summary:\n${summary}` : 'current summary is empty.';
}

function formatMemoryDebugText(chatId: string): string {
  const session = memoryService.getSession(chatId);
  return [
    `summary_length: ${session.summary.length}`,
    `recent_message_count: ${session.recentMessages.length}`,
    '',
    session.summary.trim() ? `summary:\n${session.summary}` : 'summary:\n(empty)',
  ].join('\n');
}

export async function handleMessage(body: FeishuEventPayload): Promise<void> {
  const { event, header } = body;

  if (header.event_type !== 'im.message.receive_v1') return;
  if (event.sender?.sender_type === 'app') return;

  const chatId = event.message.chat_id;
  const now = Date.now();
  const lastTs = chatRateLimit.get(chatId) ?? 0;
  if (now - lastTs < 5_000) {
    logger.warn({ chatId, eventId: header.event_id }, 'chat rate limited');
    return;
  }
  chatRateLimit.set(chatId, now);

  if (!memoryService.tryStartEvent(header.event_id)) return;

  logger.info({ chatId, eventId: header.event_id }, 'handling message');

  try {
    if (event.message?.message_type !== 'text') {
      logger.info({ chatId, messageType: event.message.message_type }, 'unsupported message type');
      await sendTextMessage(chatId, '目前只支持文本形式的消息。');
      memoryService.markEventDone(header.event_id);
      return;
    }

    const content = extractTextContent(event.message.content);
    if (!content) {
      logger.warn({ chatId, eventId: header.event_id }, 'empty message content');
      await sendTextMessage(chatId, '消息内容为空，可以再发一次文本试试。');
      memoryService.markEventDone(header.event_id);
      return;
    }

    if (isResetCommand(content)) {
      memoryService.resetConversation(chatId);
      logger.info({ chatId }, 'conversation reset');
      await sendTextMessage(chatId, '已经重置会话历史了。');
      memoryService.markEventDone(header.event_id);
      return;
    }

    if (isSummaryDebugCommand(content)) {
      await sendTextMessage(chatId, formatSummaryDebugText(memoryService.getSummary(chatId)));
      memoryService.markEventDone(header.event_id);
      return;
    }

    if (isMemoryDebugCommand(content)) {
      await sendTextMessage(chatId, formatMemoryDebugText(chatId));
      memoryService.markEventDone(header.event_id);
      return;
    }

    const summary = memoryService.getSummary(chatId);
    const summaryMessage = buildSummaryContextMessage(summary);
    const conversation = [
      ...(summaryMessage ? [summaryMessage] : []),
      ...memoryService.getConversation(chatId),
      { role: 'user' as const, content },
    ];

    const reply = (await runAgent(conversation)) || '我暂时没组织好回答，你可以再试一次。';

    memoryService.appendExchange(chatId, content, reply);
    try {
      const session = memoryService.getSession(chatId);
      const summarizeResult = await maybeSummarizeSession({
        currentSummary: session.summary,
        recentMessages: session.recentMessages,
      });

      if (summarizeResult) {
        memoryService.updateSummary(chatId, summarizeResult.summary);
        memoryService.replaceRecentMessages(chatId, summarizeResult.recentMessages);
        logger.info(
          {
            chatId,
            summaryLength: summarizeResult.summary.length,
            summaryPreview: summarizeResult.summary.slice(0, 200),
            remainingRecentMessages: summarizeResult.recentMessages.length,
          },
          'conversation summary refreshed',
        );
      }
    } catch (error) {
      logger.warn({ err: error, chatId }, 'failed to refresh conversation summary');
    }

    await sendTextMessage(chatId, reply);
    logger.info({ chatId, eventId: header.event_id }, 'reply sent');
    memoryService.markEventDone(header.event_id);
  } catch (error) {
    memoryService.markEventFailed(header.event_id);
    logger.error({ err: error, chatId, eventId: header.event_id }, 'error handling message');
    await sendTextMessage(chatId, '服务暂时异常，我已经记录问题。').catch(() => {});
  }
}
