import { config } from '@/config';
import { runAgent } from '@/agent';
import { buildSummaryContextMessage } from '@/agent/dynamic-prompt';
import {
  isMemoryDebugCommand,
  isResetCommand,
  isSummaryDebugCommand,
  sendTextMessage,
} from '@/services/feishu';
import { MemoryService } from '@/services/memory';
import { FeishuEventPayload } from '@/types/feishu';
import logger from '@/utils/logger';
import { isChatRateLimited } from './chat-rate-limit';
import { FileMemoryRepository } from './file-memory-repository';
import { extractMessageContent } from './message-content';
import { formatMemoryDebugText, formatSummaryDebugText } from './message-debug';
import { maybeSummarizeSession } from './memory-summarizer';
import { buildUserMessage, UnsupportedAttachmentError } from './user-message-builder';

const memoryService = new MemoryService(
  config.sessionMaxTurns,
  config.eventDedupeTtlMs,
  new FileMemoryRepository(),
);

export async function handleMessage(body: FeishuEventPayload): Promise<void> {
  const { event, header } = body;

  if (header.event_type !== 'im.message.receive_v1') return;
  if (event.sender?.sender_type === 'app') return;

  const chatId = event.message.chat_id;
  if (isChatRateLimited(chatId)) {
    logger.warn({ chatId, eventId: header.event_id }, 'chat rate limited');
    return;
  }

  if (!memoryService.tryStartEvent(header.event_id)) return;

  logger.info({ chatId, eventId: header.event_id }, 'handling message');

  try {
    logger.info({ event }, 'received message');
    if (!['text', 'post', 'image', 'file'].includes(event.message.message_type)) {
      logger.info({ chatId, messageType: event.message.message_type }, 'unsupported message type');
      await sendTextMessage(chatId, 'Currently only text, image, file, and post messages are supported.');
      memoryService.markEventDone(header.event_id);
      return;
    }

    const parsedContent = extractMessageContent(event.message.message_type, event.message.content);
    if (!parsedContent.text && !parsedContent.imageKeys.length && !parsedContent.files.length) {
      logger.warn({ chatId, eventId: header.event_id }, 'empty message content');
      await sendTextMessage(chatId, 'Message content is empty. Please try again.');
      memoryService.markEventDone(header.event_id);
      return;
    }

    const contentForMemory =
      parsedContent.text ||
      parsedContent.files.map((file) => `[file] ${file.fileName || file.fileKey}`).join('\n') ||
      '[image]';

    if (isResetCommand(contentForMemory)) {
      memoryService.resetConversation(chatId);
      logger.info({ chatId }, 'conversation reset');
      await sendTextMessage(chatId, 'Conversation history has been reset.');
      memoryService.markEventDone(header.event_id);
      return;
    }

    if (isSummaryDebugCommand(contentForMemory)) {
      await sendTextMessage(chatId, formatSummaryDebugText(memoryService.getSummary(chatId)));
      memoryService.markEventDone(header.event_id);
      return;
    }

    if (isMemoryDebugCommand(contentForMemory)) {
      await sendTextMessage(chatId, formatMemoryDebugText(memoryService, chatId));
      memoryService.markEventDone(header.event_id);
      return;
    }

    const summary = memoryService.getSummary(chatId);
    const summaryMessage = buildSummaryContextMessage(summary);
    const userMessage = await buildUserMessage(
      event.message.message_type,
      event.message.message_id,
      parsedContent,
    );
    const conversation = [
      ...(summaryMessage ? [summaryMessage] : []),
      ...memoryService.getConversation(chatId),
      userMessage,
    ];

    const reply = (await runAgent(conversation)) || 'I could not prepare a reply just now. Please try again.';

    memoryService.appendExchange(chatId, contentForMemory, reply);
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
    if (error instanceof UnsupportedAttachmentError) {
      logger.warn({ err: error, chatId, eventId: header.event_id }, 'unsupported attachment');
      await sendTextMessage(chatId, error.message).catch(() => {});
      return;
    }
    logger.error({ err: error, chatId, eventId: header.event_id }, 'error handling message');
    await sendTextMessage(chatId, 'Service error. The issue has been recorded.').catch(() => {});
  }
}
