import { generateObject } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from '@/config';
import type { ConversationMessage } from './memory';

const provider = createOpenAICompatible({
  name: config.model.id,
  apiKey: config.model.apiKey,
  baseURL: config.model.baseURL,
});

type SummarizeResult = {
  summary: string;
  recentMessages: ConversationMessage[];
};

function stringifyMessage(message: ConversationMessage): string {
  if (typeof message.content === 'string') {
    return `[${message.role}] ${message.content}`;
  }

  const content = message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();

  return content ? `[${message.role}] ${content}` : `[${message.role}]`;
}

export async function maybeSummarizeSession(input: {
  currentSummary: string;
  recentMessages: ConversationMessage[];
}): Promise<SummarizeResult | null> {
  const { currentSummary, recentMessages } = input;

  if (recentMessages.length <= config.memory.summaryTriggerMessageCount) {
    return null;
  }

  const messagesToKeep = recentMessages.slice(-config.memory.summaryKeepRecentMessageCount);
  const messagesToSummarize = recentMessages.slice(0, -config.memory.summaryKeepRecentMessageCount);

  if (!messagesToSummarize.length) {
    return null;
  }

  const transcript = messagesToSummarize.map(stringifyMessage).join('\n');

  const { object } = await generateObject({
    model: provider(config.model.id),
    system:
      config.memory.summaryPrompt
      ?? 'You summarize conversation history for an agent runtime.',
    prompt: [
      '[existing_summary]',
      currentSummary || '(none)',
      '',
      '[new_messages_to_compress]',
      transcript,
    ].join('\n'),
    schema: z.object({
      summary: z.string(),
    }),
  });

  return {
    summary: object.summary.trim(),
    recentMessages: messagesToKeep,
  };
}
