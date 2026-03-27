import { randomUUID } from 'node:crypto';
import { config } from '@/config';
import { USER_FACING_TEXT } from '@/constants/user-facing-text';
import { buildSummaryContextMessage } from '@/agent/dynamic-prompt';
import { runTaskAgent } from '@/agent/task-agent';
import type { TaskProgressEvent } from '@/agent/task-types';
import { isAbortError } from '@/utils/abort';
import {
  isMemoryDebugCommand,
  isResetCommand,
  isSummaryDebugCommand,
  sendTextMessage,
} from '@/services/feishu';
import { MemoryService } from '@/services/memory';
import type { FeishuEventPayload } from '@/types/feishu';
import logger from '@/utils/logger';
import { isChatRateLimited } from './chat-rate-limit';
import { runBackgroundTask } from './background-task';
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
const activeChatRuns = new Map<string, { runId: string; controller: AbortController }>();

function summarizeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const value = error as Error & { url?: string; statusCode?: number };
  return {
    name: value.name,
    message: value.message,
    url: value.url,
    statusCode: value.statusCode,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isTimeoutError(error: unknown): boolean {
  return /\btimed out after \d+ms\b/i.test(getErrorMessage(error));
}

function isSupersededRunError(error: unknown): boolean {
  return /run superseded by a newer message/i.test(getErrorMessage(error));
}

function buildUserFacingErrorMessage(error: unknown): string | null {
  if (isSupersededRunError(error)) {
    return null;
  }

  if (isTimeoutError(error)) {
    return USER_FACING_TEXT.requestTimedOut;
  }

  if (isAbortError(error)) {
    return USER_FACING_TEXT.requestCancelled;
  }

  return USER_FACING_TEXT.genericFailure;
}

function sameConversationSnapshot(
  left: { summary: string; recentMessages: unknown[] },
  right: { summary: string; recentMessages: unknown[] },
): boolean {
  return (
    left.summary.trim() === right.summary.trim() &&
    JSON.stringify(left.recentMessages) === JSON.stringify(right.recentMessages)
  );
}

function startChatRun(chatId: string, runId: string): AbortController {
  const nextController = new AbortController();
  const existing = activeChatRuns.get(chatId);
  if (existing && existing.runId !== runId) {
    existing.controller.abort(new Error(`Run superseded by a newer message in chat ${chatId}`));
  }

  activeChatRuns.set(chatId, {
    runId,
    controller: nextController,
  });
  return nextController;
}

function isActiveChatRun(chatId: string, runId: string): boolean {
  return activeChatRuns.get(chatId)?.runId === runId;
}

async function refreshSummaryInBackground(input: {
  chatId: string;
  runId: string;
  snapshot: {
    summary: string;
    recentMessages: ReturnType<MemoryService['getConversation']>;
  };
}): Promise<void> {
  const { chatId, runId, snapshot } = input;

  try {
    if (!isActiveChatRun(chatId, runId)) {
      logger.info({ chatId, runId }, '[message] summary_refresh_skipped_stale_before');
      return;
    }

    const summarizeResult = await maybeSummarizeSession({
      currentSummary: snapshot.summary,
      recentMessages: snapshot.recentMessages,
    });

    if (!summarizeResult) return;
    if (!isActiveChatRun(chatId, runId)) {
      logger.info({ chatId, runId }, '[message] summary_refresh_skipped_stale_after');
      return;
    }

    const currentSession = memoryService.getSession(chatId);
    if (
      !sameConversationSnapshot(
        {
          summary: snapshot.summary,
          recentMessages: snapshot.recentMessages,
        },
        currentSession,
      )
    ) {
      logger.info(
        { chatId, currentRecentMessages: currentSession.recentMessages.length },
        '[message] summary_refresh_skipped_snapshot_mismatch',
      );
      return;
    }

    memoryService.updateSummary(chatId, summarizeResult.summary);
    memoryService.replaceRecentMessages(chatId, summarizeResult.recentMessages);
    logger.info(
      {
        chatId,
        summaryLength: summarizeResult.summary.length,
        remainingRecentMessages: summarizeResult.recentMessages.length,
      },
      '[message] summary_refresh_completed',
    );
  } catch (error) {
    logger.warn({ chatId, err: summarizeError(error) }, '[message] summary_refresh_failed');
  }
}

function logTaskProgress(chatId: string, eventId: string, event: TaskProgressEvent): void {
  switch (event.type) {
    case 'planned':
      logger.info(
        {
          chatId,
          eventId,
          goal: event.plan.goal,
          steps: event.plan.steps.map((step) => ({
            id: step.id,
            title: step.title,
          })),
        },
        '[task] planned',
      );
      return;
    case 'step_started':
      logger.info(
        {
          chatId,
          eventId,
          stepId: event.stepId,
          index: event.index,
          total: event.total,
          title: event.title,
        },
        '[task] step_started',
      );
      return;
    case 'step_completed':
      logger.info(
        {
          chatId,
          eventId,
          stepId: event.stepId,
          index: event.index,
          total: event.total,
          title: event.title,
          resultPreview: event.result.slice(0, 200),
        },
        '[task] step_completed',
      );
      return;
    case 'step_failed':
      logger.warn(
        {
          chatId,
          eventId,
          stepId: event.stepId,
          index: event.index,
          total: event.total,
          title: event.title,
          error: event.error,
        },
        '[task] step_failed',
      );
      return;
    case 'step_cancelled':
      logger.warn(
        {
          chatId,
          eventId,
          stepId: event.stepId,
          index: event.index,
          total: event.total,
          title: event.title,
          error: event.error,
        },
        '[task] step_cancelled',
      );
      return;
    case 'step_timed_out':
      logger.warn(
        {
          chatId,
          eventId,
          stepId: event.stepId,
          index: event.index,
          total: event.total,
          title: event.title,
          error: event.error,
        },
        '[task] step_timed_out',
      );
      return;
    case 'completed':
      logger.info(
        {
          chatId,
          eventId,
          answerPreview: event.answer.slice(0, 200),
        },
        '[task] completed',
      );
      return;
    case 'cancelled':
      logger.warn(
        {
          chatId,
          eventId,
          error: event.error,
        },
        '[task] cancelled',
      );
      return;
    case 'timed_out':
      logger.warn(
        {
          chatId,
          eventId,
          error: event.error,
        },
        '[task] timed_out',
      );
      return;
    case 'failed':
      logger.warn(
        {
          chatId,
          eventId,
          error: event.error,
        },
        '[task] failed',
      );
      return;
  }
}

async function handleConversationMessage(input: {
  chatId: string;
  eventId: string;
  runId: string;
  messageId: string;
  messageType: string;
  parsedContent: ReturnType<typeof extractMessageContent>;
  contentForMemory: string;
}): Promise<void> {
  const { chatId, eventId, runId, messageId, messageType, parsedContent, contentForMemory } = input;
  const taskAbortController = startChatRun(chatId, runId);
  const summary = memoryService.getSummary(chatId);
  const summaryMessage = buildSummaryContextMessage(summary);
  const userMessage = await buildUserMessage(messageType, messageId, parsedContent);
  const conversation = [
    ...(summaryMessage ? [summaryMessage] : []),
    ...memoryService.getConversation(chatId),
    userMessage,
  ];

  const taskResult = await runTaskAgent({
    messages: conversation,
    signal: taskAbortController.signal,
    onProgress(progressEvent) {
      logTaskProgress(chatId, eventId, progressEvent);
    },
  });
  if (!isActiveChatRun(chatId, runId)) {
    logger.info({ chatId, eventId, runId }, '[message] task_result_skipped_stale_before_reply');
    memoryService.markEventDone(eventId);
    return;
  }

  const reply = taskResult.answer || USER_FACING_TEXT.emptyReplyFallback;

  await sendTextMessage(chatId, reply);
  if (!isActiveChatRun(chatId, runId)) {
    logger.info({ chatId, eventId, runId }, '[message] memory_write_skipped_stale_after_reply');
    memoryService.markEventDone(eventId);
    return;
  }

  memoryService.appendExchange(chatId, contentForMemory, reply);
  logger.info({ chatId, eventId }, '[message] reply_sent');
  memoryService.markEventDone(eventId);

  const sessionSnapshot = memoryService.getSession(chatId);
  runBackgroundTask(
    () =>
      refreshSummaryInBackground({
        chatId,
        runId,
        snapshot: {
          summary: sessionSnapshot.summary,
          recentMessages: sessionSnapshot.recentMessages,
        },
      }),
    `refresh summary for ${chatId}`,
  );
}

async function handleMessageError(input: {
  chatId: string;
  eventId: string;
  error: unknown;
  runId?: string;
}): Promise<void> {
  const { chatId, eventId, error, runId } = input;

  memoryService.markEventFailed(eventId);
  if (runId && !isActiveChatRun(chatId, runId)) {
    logger.info({ chatId, eventId, runId, err: summarizeError(error) }, '[message] error_handling_skipped_stale');
    memoryService.markEventDone(eventId);
    return;
  }

  if (isSupersededRunError(error)) {
    logger.info({ chatId, eventId, runId, err: summarizeError(error) }, '[message] run_superseded');
    memoryService.markEventDone(eventId);
    return;
  }

  if (isAbortError(error)) {
    logger.info({ chatId, eventId, runId, err: summarizeError(error) }, '[message] run_aborted');
  }

  if (error instanceof UnsupportedAttachmentError) {
    logger.warn({ chatId, eventId, err: summarizeError(error) }, '[message] unsupported_attachment');
    await sendTextMessage(chatId, error.message).catch(() => {});
    return;
  }

  logger.error({ chatId, eventId, err: summarizeError(error) }, '[message] handling_failed');
  const userFacingMessage = buildUserFacingErrorMessage(error);
  if (userFacingMessage) {
    await sendTextMessage(chatId, userFacingMessage).catch(() => {});
  }
  memoryService.markEventDone(eventId);
}

export async function handleMessage(body: FeishuEventPayload): Promise<void> {
  const { event, header } = body;

  if (header.event_type !== 'im.message.receive_v1') return;
  if (event.sender?.sender_type === 'app') return;

  const chatId = event.message.chat_id;
  if (isChatRateLimited(chatId)) {
    logger.warn({ chatId, eventId: header.event_id }, '[message] chat_rate_limited');
    return;
  }

  if (!memoryService.tryStartEvent(header.event_id)) return;

  logger.info({ chatId, eventId: header.event_id }, '[message] handling_started');
  const runId = `${header.event_id}:${randomUUID()}`;

  try {
    logger.info(
      {
        chatId,
        eventId: header.event_id,
        messageId: event.message.message_id,
        messageType: event.message.message_type,
        senderType: event.sender?.sender_type,
      },
      '[message] received',
    );
    if (!['text', 'post', 'image', 'file'].includes(event.message.message_type)) {
      logger.info({ chatId, messageType: event.message.message_type }, '[message] unsupported_message_type');
      await sendTextMessage(chatId, USER_FACING_TEXT.unsupportedMessageType);
      memoryService.markEventDone(header.event_id);
      return;
    }

    const parsedContent = extractMessageContent(event.message.message_type, event.message.content);
    if (!parsedContent.text && !parsedContent.imageKeys.length && !parsedContent.files.length) {
      logger.warn({ chatId, eventId: header.event_id }, '[message] empty_content');
      await sendTextMessage(chatId, USER_FACING_TEXT.emptyMessageContent);
      memoryService.markEventDone(header.event_id);
      return;
    }

    const contentForMemory =
      parsedContent.text ||
      parsedContent.files.map((file) => `[file] ${file.fileName || file.fileKey}`).join('\n') ||
      '[image]';

    if (isResetCommand(contentForMemory)) {
      memoryService.resetConversation(chatId);
      logger.info({ chatId }, '[message] conversation_reset');
      await sendTextMessage(chatId, USER_FACING_TEXT.conversationReset);
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

    await handleConversationMessage({
      chatId,
      eventId: header.event_id,
      runId,
      messageId: event.message.message_id,
      messageType: event.message.message_type,
      parsedContent,
      contentForMemory,
    });
  } catch (error) {
    await handleMessageError({
      chatId,
      eventId: header.event_id,
      runId,
      error,
    });
  }
}
