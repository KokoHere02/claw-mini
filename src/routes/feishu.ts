import { Hono } from 'hono';
import {
  isFeishuUrlVerification,
  verifyWebhookToken,
  verifyEncryptKey,
  isEventPayload,
} from '@/services/feishu';
import { handleMessage } from '@/services/handle-message';

const router = new Hono();

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
  handleMessage(body).catch(console.error);
  return c.json({ code: 0 });
});

export default router;
