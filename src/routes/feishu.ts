import { Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import {
  isFeishuUrlVerification,
  verifyWebhookToken,
  verifyEncryptKey,
  isEventPayload,
} from '@/services/feishu';
import { handleMessage } from '@/services/handle-message';
import logger from '@/utils/logger';

const router = new Hono();

// IP 级别限流：60 秒内最多 60 次请求
router.use(rateLimiter({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-6',
  keyGenerator: (c) => c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown',
  message: { code: 429, msg: 'Too many requests' },
}));

router.post('/webhook', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 400, msg: 'invalid body' }, 400);
  }

  if (isFeishuUrlVerification(body)) {
    if (!verifyWebhookToken(body.token)) {
      return c.json({ code: 401, msg: 'Invalid verification token' }, 401);
    }
    return c.json({ challenge: body.challenge });
  }

  if (verifyEncryptKey(body)) {
    return c.json({ code: 501, msg: 'Encrypted events are not currently supported.' }, 501);
  }

  if (!isEventPayload(body)) {
    return c.json({ code: 400, msg: 'Invalid event payload' }, 400);
  }

  if (!verifyWebhookToken(body.header.token)) {
    return c.json({ code: 401, msg: 'Invalid verification token' }, 401);
  }

  // 异步处理，立即返回 200 避免飞书重试
  handleMessage(body).catch((e) => logger.error({ err: e }, 'handleMessage error'));
  return c.json({ code: 0 });
});

export default router;
