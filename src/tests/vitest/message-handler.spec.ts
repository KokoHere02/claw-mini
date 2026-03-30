import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuEventPayload } from '@/types/feishu';
import { USER_FACING_TEXT } from '@/constants/user-facing-text';

const mocked = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => {}),
  runTaskAgent: vi.fn(),
  buildUserMessage: vi.fn(async () => ({ role: 'user', content: 'mock-user-message' })),
  isChatRateLimited: vi.fn(() => false),
  isResetCommand: vi.fn(() => false),
  isSummaryDebugCommand: vi.fn(() => false),
  isMemoryDebugCommand: vi.fn(() => false),
  isMetricsDebugCommand: vi.fn(() => false),
  buildSummaryContextMessage: vi.fn(() => null),
  runBackgroundTask: vi.fn(),
  maybeSummarizeSession: vi.fn(async () => null),
}));

vi.mock('@/agent/task-agent', () => ({
  runTaskAgent: mocked.runTaskAgent,
}));

vi.mock('@/services/feishu', () => ({
  sendTextMessage: mocked.sendTextMessage,
  isResetCommand: mocked.isResetCommand,
  isSummaryDebugCommand: mocked.isSummaryDebugCommand,
  isMemoryDebugCommand: mocked.isMemoryDebugCommand,
  isMetricsDebugCommand: mocked.isMetricsDebugCommand,
}));

vi.mock('@/services/chat-rate-limit', () => ({
  isChatRateLimited: mocked.isChatRateLimited,
}));

vi.mock('@/agent/dynamic-prompt', () => ({
  buildSummaryContextMessage: mocked.buildSummaryContextMessage,
}));

vi.mock('@/services/background-task', () => ({
  runBackgroundTask: mocked.runBackgroundTask,
}));

vi.mock('@/services/memory-summarizer', () => ({
  maybeSummarizeSession: mocked.maybeSummarizeSession,
}));

vi.mock('@/services/file-memory-repository', () => ({
  FileMemoryRepository: class {},
}));

vi.mock('@/services/user-message-builder', () => {
  class UnsupportedAttachmentError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UnsupportedAttachmentError';
    }
  }

  return {
    UnsupportedAttachmentError,
    buildUserMessage: mocked.buildUserMessage,
  };
});

vi.mock('@/services/memory', () => {
  class MemoryService {
    private readonly sessions = new Map<string, { summary: string; recentMessages: Array<{ role: string; content: string }> }>();
    private readonly events = new Set<string>();

    constructor() {}

    getSession(chatId: string) {
      return this.sessions.get(chatId) ?? { summary: '', recentMessages: [] };
    }

    getConversation(chatId: string) {
      return this.getSession(chatId).recentMessages;
    }

    getSummary(chatId: string) {
      return this.getSession(chatId).summary;
    }

    updateSummary(chatId: string, summary: string) {
      const current = this.getSession(chatId);
      this.sessions.set(chatId, { ...current, summary });
    }

    replaceRecentMessages(chatId: string, recentMessages: Array<{ role: string; content: string }>) {
      const current = this.getSession(chatId);
      this.sessions.set(chatId, { ...current, recentMessages });
    }

    appendExchange(chatId: string, userText: string, assistantText: string) {
      const current = this.getSession(chatId);
      this.sessions.set(chatId, {
        ...current,
        recentMessages: [
          ...current.recentMessages,
          { role: 'user', content: userText },
          { role: 'assistant', content: assistantText },
        ],
      });
    }

    resetConversation(chatId: string) {
      this.sessions.delete(chatId);
    }

    tryStartEvent(eventId: string) {
      if (this.events.has(eventId)) return false;
      this.events.add(eventId);
      return true;
    }

    markEventDone(_eventId: string) {}
    markEventFailed(_eventId: string) {}
  }

  return { MemoryService };
});

function makeTextEvent(eventId: string, chatId: string, text: string): FeishuEventPayload {
  return {
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      token: 'test-token',
    },
    event: {
      sender: { sender_type: 'user' },
      message: {
        chat_id: chatId,
        message_id: `${eventId}-message`,
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
  };
}

function makeEvent(input: {
  eventId: string;
  chatId: string;
  messageType: string;
  content: string;
}): FeishuEventPayload {
  const { eventId, chatId, messageType, content } = input;
  return {
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      token: 'test-token',
    },
    event: {
      sender: { sender_type: 'user' },
      message: {
        chat_id: chatId,
        message_id: `${eventId}-message`,
        message_type: messageType,
        content,
      },
    },
  };
}

async function loadHandleMessage() {
  const mod = await import('@/services/message-handler');
  return mod.handleMessage;
}

describe('handleMessage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mocked.isChatRateLimited.mockReturnValue(false);
    mocked.isResetCommand.mockReturnValue(false);
    mocked.isSummaryDebugCommand.mockReturnValue(false);
    mocked.isMemoryDebugCommand.mockReturnValue(false);
    mocked.isMetricsDebugCommand.mockReturnValue(false);
  });

  it('should skip stale first run when superseded by newer run in same chat', async () => {
    mocked.runTaskAgent.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(signal?.reason ?? new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => resolve({ answer: 'late-answer', taskRun: { status: 'completed' } }), 1000);
      });
    });
    mocked.runTaskAgent.mockResolvedValueOnce({
      answer: 'second-answer',
      taskRun: { status: 'completed' },
    });

    const handleMessage = await loadHandleMessage();
    const first = handleMessage(makeTextEvent('event-1', 'chat-1', 'first message'));
    await Promise.resolve();
    const second = handleMessage(makeTextEvent('event-2', 'chat-1', 'second message'));
    await Promise.all([first, second]);

    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage).toHaveBeenCalledWith('chat-1', 'second-answer');
  });

  it('should send timeout user-facing message on timed out error', async () => {
    mocked.runTaskAgent.mockRejectedValueOnce(new Error('Step "x" timed out after 10ms'));

    const handleMessage = await loadHandleMessage();
    await handleMessage(makeTextEvent('event-timeout', 'chat-timeout', 'please do work'));

    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage).toHaveBeenCalledWith(
      'chat-timeout',
      USER_FACING_TEXT.requestTimedOut,
    );
  });

  it('should send unsupported attachment message when buildUserMessage throws', async () => {
    const { UnsupportedAttachmentError } = await import('@/services/user-message-builder');
    mocked.buildUserMessage.mockRejectedValueOnce(
      new UnsupportedAttachmentError('暂不支持文件“demo.xlsx”。暂未实现该 Office 文档类型的直接解析。'),
    );

    const handleMessage = await loadHandleMessage();
    await handleMessage(makeTextEvent('event-unsupported', 'chat-unsupported', 'analyze file'));

    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage).toHaveBeenCalledWith(
      'chat-unsupported',
      '暂不支持文件“demo.xlsx”。暂未实现该 Office 文档类型的直接解析。',
    );
  });

  it('should skip handling when chat is rate limited', async () => {
    mocked.isChatRateLimited.mockReturnValue(true);
    const handleMessage = await loadHandleMessage();

    await handleMessage(makeTextEvent('event-rate-limit', 'chat-limit', 'hello'));

    expect(mocked.runTaskAgent).not.toHaveBeenCalled();
    expect(mocked.sendTextMessage).not.toHaveBeenCalled();
  });

  it('should send unsupported message type response', async () => {
    const handleMessage = await loadHandleMessage();

    await handleMessage(makeEvent({
      eventId: 'event-unsupported-type',
      chatId: 'chat-type',
      messageType: 'audio',
      content: JSON.stringify({ text: 'voice payload' }),
    }));

    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage).toHaveBeenCalledWith(
      'chat-type',
      USER_FACING_TEXT.unsupportedMessageType,
    );
  });

  it('should send empty content response when parsed message is empty', async () => {
    const handleMessage = await loadHandleMessage();

    await handleMessage(makeTextEvent('event-empty', 'chat-empty', '   '));

    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage).toHaveBeenCalledWith(
      'chat-empty',
      USER_FACING_TEXT.emptyMessageContent,
    );
  });

  it('should execute reset command branch', async () => {
    mocked.isResetCommand.mockReturnValue(true);
    const handleMessage = await loadHandleMessage();

    await handleMessage(makeTextEvent('event-reset', 'chat-reset', '/reset'));

    expect(mocked.runTaskAgent).not.toHaveBeenCalled();
    expect(mocked.sendTextMessage).toHaveBeenCalledWith(
      'chat-reset',
      USER_FACING_TEXT.conversationReset,
    );
  });

  it('should execute summary debug command branch', async () => {
    mocked.isSummaryDebugCommand.mockReturnValue(true);
    const handleMessage = await loadHandleMessage();

    await handleMessage(makeTextEvent('event-summary', 'chat-summary', '#summary'));

    expect(mocked.runTaskAgent).not.toHaveBeenCalled();
    expect(mocked.sendTextMessage).toHaveBeenCalledWith('chat-summary', USER_FACING_TEXT.summaryEmpty);
  });

  it('should execute memory debug command branch', async () => {
    mocked.isMemoryDebugCommand.mockReturnValue(true);
    const handleMessage = await loadHandleMessage();

    await handleMessage(makeTextEvent('event-memory', 'chat-memory', '#memory'));

    expect(mocked.runTaskAgent).not.toHaveBeenCalled();
    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage.mock.calls[0]?.[0]).toBe('chat-memory');
    expect(String(mocked.sendTextMessage.mock.calls[0]?.[1])).toContain(USER_FACING_TEXT.memorySummaryLabel);
  });

  it('should execute metrics debug command branch', async () => {
    mocked.isMetricsDebugCommand.mockReturnValue(true);
    const handleMessage = await loadHandleMessage();

    await handleMessage(makeTextEvent('event-metrics', 'chat-metrics', '#metrics'));

    expect(mocked.runTaskAgent).not.toHaveBeenCalled();
    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage.mock.calls[0]?.[0]).toBe('chat-metrics');
    expect(String(mocked.sendTextMessage.mock.calls[0]?.[1])).toContain('runtime metrics');
  });

  it('should dedupe same event id and process once', async () => {
    mocked.runTaskAgent.mockResolvedValue({ answer: 'deduped-reply', taskRun: { status: 'completed' } });
    const handleMessage = await loadHandleMessage();
    const event = makeTextEvent('event-dedupe', 'chat-dedupe', 'hello');

    await handleMessage(event);
    await handleMessage(event);

    expect(mocked.runTaskAgent).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendTextMessage).toHaveBeenCalledWith('chat-dedupe', 'deduped-reply');
  });
});
