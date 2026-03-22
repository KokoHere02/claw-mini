import { config } from '@/config';
import { WebhookAdapter } from '@/adapters/webhook';
import { LongConnectionAdapter } from '@/adapters/long-connection';
import type { Adapter } from '@/adapters/types';
import logger from '@/utils/logger';
import { cleanupExpiredMemoryFiles } from '@/services/memory-cleaner';

const adapters: Record<string, () => Adapter> = {
  'webhook':         () => new WebhookAdapter(),
  'long-connection': () => new LongConnectionAdapter(),
};

const factory = adapters[config.feishu.connectionMode];
if (!factory) throw new Error(`Unknown connection mode: ${config.feishu.connectionMode}`);

const cleanupResult = cleanupExpiredMemoryFiles();
logger.info(
  {
    storageDir: config.memory.storageDir,
    ttlDays: config.memory.ttlDays,
    scanned: cleanupResult.scanned,
    deleted: cleanupResult.deleted,
  },
  'memory cleanup finished on startup',
);

factory().start();
