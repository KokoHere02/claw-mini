import { config } from '@/config';
import { WebhookAdapter } from '@/adapters/webhook';
import { LongConnectionAdapter } from '@/adapters/long-connection';
import type { Adapter } from '@/adapters/types';

const adapters: Record<string, () => Adapter> = {
  'webhook':         () => new WebhookAdapter(),
  'long-connection': () => new LongConnectionAdapter(),
};

const factory = adapters[config.feishu.connectionMode];
if (!factory) throw new Error(`Unknown connection mode: ${config.feishu.connectionMode}`);

factory().start();
