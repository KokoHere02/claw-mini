import type { SessionMemory } from './memory';

export interface MemoryRepository {
  load(chatId: string): SessionMemory | null;
  save(chatId: string, memory: SessionMemory): void;
  delete(chatId: string): void;
}
