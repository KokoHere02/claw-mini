import fs from 'node:fs';
import path from 'node:path';
import { config } from '@/config';
import logger from '@/utils/logger';
import type { SessionMemory } from './memory';
import type { MemoryRepository } from './memory-repository';

type PersistedSessionMemory = SessionMemory & {
  chatId: string;
  updatedAt: number;
};

function toSafeFileName(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class FileMemoryRepository implements MemoryRepository {
  constructor(private readonly storageDir: string = config.memory.storageDir) {}

  getStorageDir(): string {
    return this.storageDir;
  }

  load(chatId: string): SessionMemory | null {
    const filePath = this.getFilePath(chatId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedSessionMemory>;

      return {
        recentMessages: Array.isArray(parsed.recentMessages) ? parsed.recentMessages : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      };
    } catch (error) {
      logger.warn({ err: error, chatId, filePath }, 'failed to load memory file');
      return null;
    }
  }

  save(chatId: string, memory: SessionMemory): void {
    this.ensureStorageDir();

    const filePath = this.getFilePath(chatId);
    const tmpPath = `${filePath}.tmp`;
    const payload: PersistedSessionMemory = {
      chatId,
      summary: memory.summary,
      recentMessages: memory.recentMessages,
      updatedAt: Date.now(),
    };

    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      logger.warn({ err: error, chatId, filePath }, 'failed to save memory file');
      try {
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
      } catch {}
    }
  }

  delete(chatId: string): void {
    const filePath = this.getFilePath(chatId);
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (error) {
      logger.warn({ err: error, chatId, filePath }, 'failed to delete memory file');
    }
  }

  private ensureStorageDir(): void {
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  private getFilePath(chatId: string): string {
    return path.resolve(process.cwd(), this.storageDir, `${toSafeFileName(chatId)}.json`);
  }
}
