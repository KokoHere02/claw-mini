import type { ModelMessage } from 'ai';
import logger from '@/utils/logger';
import { runBackgroundTask } from './background-task';
import type { MemoryRepository } from './memory-repository';

export type ConversationMessage = ModelMessage;

export type SessionMemory = {
  recentMessages: ConversationMessage[];
  summary: string;
};

type EventState = {
  status: 'processing' | 'done';
  timestamp: number;
};

export class MemoryService {
  private readonly sessions = new Map<string, SessionMemory>();
  private readonly events = new Map<string, EventState>();

  constructor(
    private readonly maxTurns: number,
    private readonly eventTtlMs: number,
    private readonly repository?: MemoryRepository,
  ) {}

  getSession(chatId: string): SessionMemory {
    const cached = this.sessions.get(chatId);
    if (cached) return cached;

    const loaded = this.repository?.load(chatId);
    if (loaded) {
      this.sessions.set(chatId, loaded);
      return loaded;
    }

    return {
      recentMessages: [],
      summary: '',
    };
  }

  getConversation(chatId: string): ConversationMessage[] {
    return this.getSession(chatId).recentMessages;
  }

  getSummary(chatId: string): string {
    return this.getSession(chatId).summary;
  }

  updateSummary(chatId: string, summary: string): void {
    const session = this.getSession(chatId);
    const nextSession = {
      ...session,
      summary: summary.trim(),
    };
    this.sessions.set(chatId, nextSession);
    this.schedulePersistSession(chatId, nextSession);
  }

  replaceRecentMessages(chatId: string, recentMessages: ConversationMessage[]): void {
    const session = this.getSession(chatId);
    const nextSession = {
      ...session,
      recentMessages,
    };
    this.sessions.set(chatId, nextSession);
    this.schedulePersistSession(chatId, nextSession);
  }

  appendExchange(chatId: string, userText: string, assistantText: string): void {
    const session = this.getSession(chatId);
    const existing = session.recentMessages;
    const next: ConversationMessage[] = [
      ...existing,
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText },
    ];
    const maxMessage = this.maxTurns * 2;
    const nextSession = {
      ...session,
      recentMessages: next.slice(-maxMessage),
    };
    this.sessions.set(chatId, nextSession);
    this.schedulePersistSession(chatId, nextSession);
  }

  resetConversation(chatId: string): void {
    this.sessions.delete(chatId);
    this.scheduleDeleteSession(chatId);
  }

  tryStartEvent(eventId: string): boolean {
    this.cleanupExpiredEvents();

    const existing = this.events.get(eventId);
    if (existing) {
      return false;
    }
    this.events.set(eventId, { status: 'processing', timestamp: Date.now() });
    return true;
  }

  markEventDone(eventId: string): void {
    if (!this.events.has(eventId)) {
      return;
    }
    this.events.set(eventId, { status: 'done', timestamp: Date.now() });
  }

  markEventFailed(eventId: string): void {
    this.events.delete(eventId);
  }

  private cleanupExpiredEvents(): void {
    const now = Date.now();

    for (const [eventId, state] of this.events) {
      if (now - state.timestamp > this.eventTtlMs) {
        this.events.delete(eventId);
      }
    }
  }

  private schedulePersistSession(chatId: string, session: SessionMemory): void {
    if (!this.repository) return;

    runBackgroundTask(() => {
      this.persistSession(chatId, session);
    }, `persist memory for ${chatId}`);
  }

  private scheduleDeleteSession(chatId: string): void {
    if (!this.repository) return;

    runBackgroundTask(() => {
      try {
        this.repository?.delete(chatId);
      } catch (error) {
        logger.warn({ err: error, chatId }, '[memory] persisted_delete_failed');
      }
    }, `delete memory for ${chatId}`);
  }

  private persistSession(chatId: string, session: SessionMemory): void {
    try {
      this.repository?.save(chatId, session);
    } catch (error) {
      logger.warn({ err: error, chatId }, '[memory] persisted_save_failed');
    }
  }
}
