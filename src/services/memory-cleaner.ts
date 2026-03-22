import fs from 'node:fs';
import path from 'node:path';
import { config } from '@/config';
import logger from '@/utils/logger';

type PersistedMemoryEnvelope = {
  updatedAt?: number;
};

type CleanupResult = {
  scanned: number;
  deleted: number;
};

export function cleanupExpiredMemoryFiles(storageDir: string = config.memory.storageDir): CleanupResult {
  if (!fs.existsSync(storageDir)) {
    return { scanned: 0, deleted: 0 };
  }

  const ttlMs = config.memory.ttlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;

  for (const entry of fs.readdirSync(storageDir)) {
    if (!entry.endsWith('.json')) continue;

    scanned += 1;
    const filePath = path.join(storageDir, entry);

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedMemoryEnvelope;
      const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;

      if (!updatedAt || now - updatedAt > ttlMs) {
        fs.rmSync(filePath, { force: true });
        deleted += 1;
      }
    } catch (error) {
      logger.warn({ err: error, filePath }, 'failed to inspect persisted memory file');
    }
  }

  return { scanned, deleted };
}
