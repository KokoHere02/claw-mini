import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from '@/config';
import logger from '@/utils/logger';
import feishuRouter from '@/routes/feishu';
import type { Adapter } from './types';

export class WebhookAdapter implements Adapter {
  private server: ServerType | null = null;

  async start(): Promise<void> {
    const app = new Hono();

    app.get('/health', (c) => c.json({ code: 0, timeStamp: new Date().toISOString(), service: 'claw-mini' }));
    app.route('/feishu', feishuRouter);
    app.notFound((c) => c.json({ code: 404, msg: 'Not Found' }, 404));

    return new Promise((resolve) => {
      this.server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
        logger.info({ address: info.address, port: info.port }, '[webhook] listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
