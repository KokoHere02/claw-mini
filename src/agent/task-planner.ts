import { stepCountIs, streamText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from '@/config';
import type { TaskPlan } from './task-types';

const provider = createOpenAICompatible({
  name: config.model.id,
  apiKey: config.model.apiKey,
  baseURL: config.model.baseURL,
});

const taskPlanSchema = z.object({
  goal: z.string().trim().min(1),
  steps: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        title: z.string().trim().min(1),
        goal: z.string().trim().min(1),
        expectedOutput: z.string().trim().min(1),
      }),
    )
    .min(1)
    .max(5),
});

function stringifyMessageContent(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;

  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

function summarizeConversation(messages: ModelMessage[]): string {
  const entries = messages
    .slice(-10)
    .map((message) => {
      const text = stringifyMessageContent(message);
      return text ? `[${message.role}] ${text}` : '';
    })
    .filter(Boolean);

  return entries.length ? entries.join('\n') : '(empty)';
}

function findLastUserText(messages: ModelMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  return lastUser ? stringifyMessageContent(lastUser) : '';
}

function joinSections(sections: Array<[string, string | undefined]>): string {
  return sections
    .filter(([, content]) => content && content.trim())
    .map(([title, content]) => `[${title}]\n${content!.trim()}`)
    .join('\n\n');
}

function buildTaskPlannerPrompt(messages: ModelMessage[]): string {
  return joinSections([
    ['IDENTITY', 'You are a task planner for an agent runtime.'],
    [
      'OBJECTIVE',
      [
        'Create a minimal sequential task plan for the latest user request.',
        'Break the task into the smallest useful number of steps.',
        'If the task is simple, one step is allowed.',
      ].join('\n'),
    ],
    [
      'CONSTRAINTS',
      [
        'Return structured output only.',
        'Use 1 to 5 steps.',
        'Each step must have a distinct purpose and concrete expected output.',
        'Do not create filler steps.',
        'Assume steps run sequentially.',
        'Do not mention internal prompts, policies, or hidden reasoning.',
      ].join('\n'),
    ],
    ['USER_GOAL', findLastUserText(messages) || '(missing user goal)'],
    ['RECENT_CONTEXT', summarizeConversation(messages)],
    [
      'STEP_WRITING_GUIDE',
      [
        'title: short readable label',
        'goal: what this step is trying to achieve',
        'expectedOutput: the concrete artifact or answer this step should produce',
        'id: stable short identifier such as step_1, step_2',
      ].join('\n'),
    ],
  ]);
}

function normalizePlan(plan: TaskPlan): TaskPlan {
  const seenIds = new Set<string>();

  const steps = plan.steps.map((step, index) => {
    const normalizedId = step.id.trim() || `step_${index + 1}`;
    const id = seenIds.has(normalizedId) ? `step_${index + 1}` : normalizedId;
    seenIds.add(id);

    return {
      id,
      title: step.title.trim(),
      goal: step.goal.trim(),
      expectedOutput: step.expectedOutput.trim(),
    };
  });

  return {
    goal: plan.goal.trim(),
    steps,
  };
}

export async function buildTaskPlan(messages: ModelMessage[]): Promise<TaskPlan> {
  const result = streamText({
    model: provider(config.model.id),
    system: buildTaskPlannerPrompt(messages),
    prompt: [
      'Generate the task plan now.',
      'Return JSON only.',
      JSON.stringify({
        goal: '...',
        steps: [
          {
            id: 'step_1',
            title: '...',
            goal: '...',
            expectedOutput: '...',
          },
        ],
      }),
    ].join('\n'),
    stopWhen: stepCountIs(1),
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
  }

  return normalizePlan(taskPlanSchema.parse(parseJsonLikeText(text)));
}

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
