import { config } from '@/config';
import { LongConnectionAdapter } from '@/adapters/long-connection';
import type { Adapter } from '@/adapters/types';
import { WebhookAdapter } from '@/adapters/webhook';
import { runBackgroundTask } from '@/services/background-task';
import { cleanupExpiredMemoryFiles } from '@/services/memory-cleaner';
import logger from '@/utils/logger';

const adapters: Record<string, () => Adapter> = {
  webhook: () => new WebhookAdapter(),
  'long-connection': () => new LongConnectionAdapter(),
};

const factory = adapters[config.feishu.connectionMode];
if (!factory) throw new Error(`Unknown connection mode: ${config.feishu.connectionMode}`);

runBackgroundTask(() => {
  const cleanupResult = cleanupExpiredMemoryFiles();
  logger.info(
    {
      storageDir: config.memory.storageDir,
      ttlDays: config.memory.ttlDays,
      scanned: cleanupResult.scanned,
      deleted: cleanupResult.deleted,
    },
    '[app] startup_memory_cleanup_completed',
  );
}, 'startup memory cleanup');

factory().start();
