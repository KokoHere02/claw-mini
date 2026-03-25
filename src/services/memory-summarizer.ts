import { stepCountIs, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
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

const LOCAL_SUMMARY_MAX_LENGTH = 1200;

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1).trim();
    }
  }

  return null;
}

function parseJsonLikeText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('JSON text is empty');
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      return parseJsonLikeText(parsed);
    }
    return parsed;
  } catch {}

  const extracted = extractJsonObject(trimmed);
  if (!extracted) {
    throw new Error('No JSON object found in text');
  }

  const parsed = JSON.parse(extracted);
  if (typeof parsed === 'string') {
    return parseJsonLikeText(parsed);
  }
  return parsed;
}

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

function buildLocalFallbackSummary(currentSummary: string, transcript: string): string {
  const parts = [
    currentSummary.trim(),
    transcript.trim(),
  ].filter(Boolean);

  const merged = parts.join('\n');
  if (!merged) return '';

  return merged.slice(-LOCAL_SUMMARY_MAX_LENGTH).trim();
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

  const result = streamText({
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
    stopWhen: stepCountIs(1),
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
  }

  try {
    const parsed = parseJsonLikeText(text) as { summary?: unknown };
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
      throw new Error('Memory summarizer returned an invalid summary');
    }

    return {
      summary: parsed.summary.trim(),
      recentMessages: messagesToKeep,
    };
  } catch {
    const fallbackSummary = buildLocalFallbackSummary(currentSummary, transcript);
    if (!fallbackSummary) {
      return null;
    }

    return {
      summary: fallbackSummary,
      recentMessages: messagesToKeep,
    };
  }
}
