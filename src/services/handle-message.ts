import { MemoryService } from '@/services/memory';
import { config } from '@/config';
import { generateAssistantReply } from '@/services/llm';
import {
  sendTextMessage,
  extractTextContent,
  isResetCommand,
} from '@/services/feishu';
import { FeishuEventPayload } from '@/types/feishu';
import logger from '@/utils/logger';

const memoryService = new MemoryService(config.sessionMaxTurns, config.eventDedupeTtlMs);

// chat_id 级别限流：同一会话 5 秒内只处理 1 条
const chatRateLimit = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of chatRateLimit) {
    if (now - ts > 5_000) chatRateLimit.delete(id);
  }
}, 10_000);

export async function handleMessage(body: FeishuEventPayload): Promise<void> {
  const { event, header } = body;

  if (header.event_type !== 'im.message.receive_v1') return;

  if (event.sender?.sender_type === 'app') return;

  const chatId = event.message.chat_id;
  const now = Date.now();
  const lastTs = chatRateLimit.get(chatId) ?? 0;
  if (now - lastTs < 5_000) {
    logger.warn({ chatId, eventId: header.event_id }, 'chat rate limited');
    return;
  }
  chatRateLimit.set(chatId, now);

  if (!memoryService.tryStartEvent(header.event_id)) return;

  logger.info({ chatId, eventId: header.event_id }, 'handling message');

  try {
    if (event.message?.message_type !== 'text') {
      logger.info({ chatId, messageType: event.message.message_type }, 'unsupported message type');
      await sendTextMessage(chatId, '目前只支持文本形式的消息，敬请期待更多功能！');
      memoryService.markEventDone(header.event_id);
      return;
    }

    const content = extractTextContent(event.message.content);
    if (!content) {
      logger.warn({ chatId, eventId: header.event_id }, 'empty message content');
      await sendTextMessage(chatId, '消息内容为空，可以再发一次文本试试。');
      memoryService.markEventDone(header.event_id);
      return;
    }

    if (isResetCommand(content)) {
      memoryService.resetConversation(chatId);
      logger.info({ chatId }, 'conversation reset');
      await sendTextMessage(chatId, '已经重置会话历史了哦！');
      memoryService.markEventDone(header.event_id);
      return;
    }

    const conversation = [
      ...memoryService.getConversation(chatId),
      { role: 'user' as const, content },
    ];

    const reply = (await generateAssistantReply(conversation)) || '我暂时没组织好回答，你可以再试一次。';

    memoryService.appendExchange(chatId, content, reply);
    await sendTextMessage(chatId, reply);
    logger.info({ chatId, eventId: header.event_id }, 'reply sent');
    memoryService.markEventDone(header.event_id);
  } catch (error) {
    memoryService.markEventFailed(header.event_id);
    logger.error({ err: error, chatId, eventId: header.event_id }, 'error handling message');
    await sendTextMessage(chatId, '服务暂时异常，我已经记录了问题。').catch(() => {});
  }
}
