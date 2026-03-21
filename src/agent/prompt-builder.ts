import type { ModelMessage } from 'ai';
import type { ToolSummary, ToolParameters } from './tool-types';
import { config } from '@/config';

type PromptContext = {
  step: number;
  maxSteps: number;
  messages: ModelMessage[];
  tools: ToolSummary[];
  currentTime: string;
  workspace: string;
};

function stringifyMessageContent(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;

  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

function findLastUserText(messages: ModelMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  return lastUser ? stringifyMessageContent(lastUser) : '';
}

function summarizeParameterTypes(parameters: ToolParameters): string {
  return Object.entries(parameters)
    .map(([key, meta]) => `${key}:${meta.type}${meta.optional ? '?' : ''}`)
    .join(', ');
}

function summarizeTools(tools: ToolSummary[]): string {
  return tools
    .map(({ name, description, parameters }) => {
      const parameterList = summarizeParameterTypes(parameters);
      return parameterList
        ? `- ${name}: ${description} | params: ${parameterList}`
        : `- ${name}: ${description}`;
    })
    .join('\n');
}

function summarizeRecentToolActivity(messages: ModelMessage[]): string {
  const entries = messages
    .filter((message) => message.role === 'system' || message.role === 'assistant')
    .map((message) => stringifyMessageContent(message))
    .filter((text) =>
      text.includes('[tool_result]') ||
      text.includes('[tool_error]') ||
      text.includes('"action":"call_tool"'),
    )
    .slice(-6);

  return entries.length ? entries.join('\n\n') : '(none)';
}

function summarizeConversation(messages: ModelMessage[]): string {
  const entries = messages
    .slice(-8)
    .map((message) => {
      const text = stringifyMessageContent(message);
      return text ? `[${message.role}] ${text}` : '';
    })
    .filter(Boolean);

  return entries.length ? entries.join('\n') : '(empty)';
}

function joinSections(sections: Array<[string, string | undefined]>): string {
  return sections
    .filter(([, content]) => content && content.trim())
    .map(([title, content]) => `[${title}]\n${content!.trim()}`)
    .join('\n\n');
}

export function buildPlannerPrompt(ctx: PromptContext): string {
  const remainingSteps = Math.max(ctx.maxSteps - ctx.step, 0);
  const plannerBasePrompt =
    config.agent.plannerPrompt || 'Return JSON only and decide whether to respond or call one available tool.';

  return joinSections([
    ['IDENTITY', 'You are the planning layer of an agent runtime.'],
    ['PLANNER_BASE', plannerBasePrompt],
    [
      'RUNTIME',
      [
        `step=${ctx.step}`,
        `max_steps=${ctx.maxSteps}`,
        `remaining_steps=${remainingSteps}`,
        `current_time=${ctx.currentTime}`,
        `workspace=${ctx.workspace}`,
      ].join('\n'),
    ],
    ['USER_GOAL', findLastUserText(ctx.messages) || '(missing user goal)'],
    ['TOOLS', summarizeTools(ctx.tools)],
    ['RECENT_TOOL_ACTIVITY', summarizeRecentToolActivity(ctx.messages)],
    ['RECENT_CONTEXT', summarizeConversation(ctx.messages)],
    [
      'POLICY',
      [
        'Prefer direct response if enough evidence already exists.',
        'Call a tool only if it materially improves correctness.',
        'Do not repeat the same ineffective tool call when recent tool activity already shows no progress.',
        'If a tool failed, adapt instead of blindly retrying.',
        'Choose only the next best action.',
      ].join('\n'),
    ],
    [
      'OUTPUT',
      [
        'Return JSON only.',
        '{"action":"respond","answer":"..."}',
        '{"action":"call_tool","tool":"tool_name","arguments":{"key":"value"}}',
      ].join('\n'),
    ],
  ]);
}

export function buildAnswerPrompt(ctx: PromptContext): string {
  return joinSections([
    ['IDENTITY', config.systemPrompt],
    [
      'RUNTIME',
      [
        `step=${ctx.step}`,
        `max_steps=${ctx.maxSteps}`,
        `current_time=${ctx.currentTime}`,
        `workspace=${ctx.workspace}`,
      ].join('\n'),
    ],
    ['USER_GOAL', findLastUserText(ctx.messages) || '(missing user goal)'],
    ['RELEVANT_CONTEXT', summarizeConversation(ctx.messages)],
    ['RECENT_TOOL_ACTIVITY', summarizeRecentToolActivity(ctx.messages)],
    [
      'POLICY',
      [
        'Answer directly and clearly.',
        'Do not mention internal planning or tool selection.',
        'Base the answer on available context and tool outputs.',
      ].join('\n'),
    ],
  ]);
}

export function buildRecoveryPrompt(ctx: PromptContext, reason: string): string {
  return joinSections([
    ['IDENTITY', config.systemPrompt],
    ['STATE', reason],
    [
      'RUNTIME',
      [
        `step=${ctx.step}`,
        `max_steps=${ctx.maxSteps}`,
        `current_time=${ctx.currentTime}`,
        `workspace=${ctx.workspace}`,
      ].join('\n'),
    ],
    ['USER_GOAL', findLastUserText(ctx.messages) || '(missing user goal)'],
    ['KNOWN_CONTEXT', summarizeConversation(ctx.messages)],
    ['KNOWN_TOOL_ACTIVITY', summarizeRecentToolActivity(ctx.messages)],
    [
      'POLICY',
      [
        'Do not invent missing information.',
        'State limitations clearly.',
        'Use the information already gathered to provide the best possible answer.',
      ].join('\n'),
    ],
  ]);
}
