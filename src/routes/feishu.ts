import { Hono } from 'hono';
import { 
  isFeishuUrlVerification, 
  verifyWebhookToken, 
  verifyEncryptKey, 
  isEventPayload,
  sendTextMessage,
  extractTextContent,
  isResetCommand
} from '@/services/feishu';
import { MemoryService } from "@/services/memory";
import { config } from '@/config';
import { generateAssistantReply } from '@/services/llm';

const memoryService = new MemoryService(config.sessionMaxTurns, config.eventDedupeTtlMs); 
const router = new Hono();

router.post('/webhook', async (c) => {
  const textBody = await c.req.text();
  let body: unknown;

  try {
    body = JSON.parse(textBody);
  } catch {
    return c.json({ code: 400, msg: 'invalid body' }, 400);
  }
  
  console.log('received feishu event:', body);
  console.log(`isFeishuUrlVerification(body): ${isFeishuUrlVerification(body)}`);
  if (isFeishuUrlVerification(body)) {
    console.log('handling feishu url verification');
    if (!verifyWebhookToken(body.token)) {
      return c.json({ code: 401, msg: "Invalid verification token" }, 401);
    }
    return c.json({ challenge: body.challenge });
  }

  console.log(`verifyEncryptKey(body): ${verifyEncryptKey(body)}`);
  if (verifyEncryptKey(body)) {
    return c.json({ code: 501, msg: "Encrypted events are not currently supported." }, 501);
  }

  console.log(`isEventPayload(body): ${isEventPayload(body)}`);
  if (!isEventPayload(body)) {
    return c.json({ code: 400, msg: "Invalid event payload" }, 400);
  }

  const { event, header } = body;

  if (!verifyWebhookToken(header.token)) {
    return c.json({ code: 401, msg: "Invalid verification token" }, 401);
  }

  if (header.event_type !== "im.message.receive_v1") {
    return c.json({ code: 0, msg: "ignored" });
  }

  if (event.sender?.sender_type === "app") {
    return c.json({ code: 0, msg: "ignored self event" });
  }
  console.log(`Processing event ${header.event_id} of type ${header.event_type}`);

  if (!memoryService.tryStartEvent(header.event_id)) {
    return c.json({ code: 0, msg: "duplicate event ignored" });
  }
  try {
    if (event.message?.message_type !== "text") {
      await sendTextMessage(
        event.message.chat_id,
        "目前只支持文本形式的消息，敬请期待更多功能！"
      );
      memoryService.markEventDone(header.event_id);
      return c.json({ code: 0, msg: "unsupported message type" });
    }
    const content = extractTextContent(event.message.content);
    if (!content) {
      await sendTextMessage(
        event.message.chat_id,
        "消息内容为空，可以再发一次文本试试。"
      );
      memoryService.markEventDone(header.event_id);
      return c.json({ code: 0, msg: "empty message content" });
    }

    if (isResetCommand(content)) {
      memoryService.resetConversation(event.message.chat_id);
      await sendTextMessage(
        event.message.chat_id,
        "已经重置会话历史了哦！"
      );
      memoryService.markEventDone(header.event_id);
      return c.json({ code: 0, msg: "conversation reset" });
    }

    const conversation = [
      ...memoryService.getConversation(event.message.chat_id),
      { role: "user" as const, content: content }
    ];

    const reply =
      (await generateAssistantReply(conversation)) ||
      "我暂时没组织好回答，你就可以再试一次。";
      
    memoryService.appendExchange(event.message.chat_id, content, reply);
    await sendTextMessage(event.message.chat_id, reply);
    memoryService.markEventDone(header.event_id);

    return c.json({ code: 0, msg: "success" });
  } catch (error) {
    memoryService.markEventFailed(header.event_id);
    console.error("Error handling Feishu event:", error);
    await sendTextMessage(
      event.message.chat_id,
      "服务暂时异常，我已经记录了问题。"
    ).catch(() => {
      console.error("Failed to send error message to Feishu:", error);
    });
    return c.json({ code: 500, msg: "internal error" }, 500);
  }

});

export default router;