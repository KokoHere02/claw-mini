import { MemoryService } from '@/services/memory';
import { config } from '@/config';
import { generateAssistantReply } from '@/services/llm';
import {
  sendTextMessage,
  extractTextContent,
  isResetCommand,
} from '@/services/feishu';
import { FeishuEventPayload } from '@/types/feishu';

const memoryService = new MemoryService(config.sessionMaxTurns, config.eventDedupeTtlMs);

export async function handleMessage(body: FeishuEventPayload): Promise<void> {
  const { event, header } = body;

  if (header.event_type !== 'im.message.receive_v1') return;

  if (event.sender?.sender_type === 'app') return;

  if (!memoryService.tryStartEvent(header.event_id)) return;

  try {
    if (event.message?.message_type !== 'text') {
      await sendTextMessage(event.message.chat_id, '目前只支持文本形式的消息，敬请期待更多功能！');
      memoryService.markEventDone(header.event_id);
      return;
    }

    const content = extractTextContent(event.message.content);
    if (!content) {
      await sendTextMessage(event.message.chat_id, '消息内容为空，可以再发一次文本试试。');
      memoryService.markEventDone(header.event_id);
      return;
    }

    if (isResetCommand(content)) {
      memoryService.resetConversation(event.message.chat_id);
      await sendTextMessage(event.message.chat_id, '已经重置会话历史了哦！');
      memoryService.markEventDone(header.event_id);
      return;
    }

    const conversation = [
      ...memoryService.getConversation(event.message.chat_id),
      { role: 'user' as const, content },
    ];

    const reply = (await generateAssistantReply(conversation)) || '我暂时没组织好回答，你可以再试一次。';

    memoryService.appendExchange(event.message.chat_id, content, reply);
    await sendTextMessage(event.message.chat_id, reply);
    memoryService.markEventDone(header.event_id);
  } catch (error) {
    memoryService.markEventFailed(header.event_id);
    console.error('Error handling Feishu event:', error);
    await sendTextMessage(event.message.chat_id, '服务暂时异常，我已经记录了问题。').catch(() => {});
  }
}
