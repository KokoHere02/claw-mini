import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_FACING_TEXT } from '@/constants/user-facing-text';

const mocked = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => {}),
  runTaskAgent: vi.fn(),
  buildUserMessage: vi.fn(async () => ({ role: 'user', content: 'mock-user-message' })),
  isChatRateLimited: vi.fn(() => false),
  buildSummaryContextMessage: vi.fn(() => null),
  runBackgroundTask: vi.fn(),
  maybeSummarizeSession: vi.fn(async () => null),
}));

vi.mock('@/agent/task-agent', () => ({
  runTaskAgent: mocked.runTaskAgent,
}));

vi.mock('@/services/feishu', () => ({
  sendTextMessage: mocked.sendTextMessage,
  isResetCommand: () => false,
  isSummaryDebugCommand: () => false,
  isMemoryDebugCommand: () => false,
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

function makeTextEvent(eventId: string, chatId: string, text: string) {
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

async function loadHandleMessage() {
  const mod = await import('@/services/handle-message');
  return mod.handleMessage;
}

describe('handleMessage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
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
});
