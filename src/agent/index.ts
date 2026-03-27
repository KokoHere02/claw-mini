import { stepCountIs, streamText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from '@/config';
import { registry } from './tool-registry';
import type { ToolDefinition } from './tool-types';
import { runner } from './tool-runner';
import logger from '@/utils/logger';
import { buildAnswerPrompt, buildPlannerPrompt, buildRecoveryPrompt } from './prompt-builder';

const provider = createOpenAICompatible({
  name: config.model.id,
  apiKey: config.model.apiKey,
  baseURL: config.model.baseURL,
});

type AgentDecision =
  | { action: 'respond'; answer: string }
  | { action: 'call_tool'; tool: string; arguments?: Record<string, unknown> };

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

function normalizeDecision(raw: unknown): AgentDecision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;

  if (value.action === 'respond' && typeof value.answer === 'string' && value.answer.trim()) {
    return { action: 'respond', answer: value.answer.trim() };
  }

  if (value.action === 'call_tool' && typeof value.tool === 'string' && value.tool.trim()) {
    return {
      action: 'call_tool',
      tool: value.tool.trim(),
      arguments:
        value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)
          ? (value.arguments as Record<string, unknown>)
          : {},
    };
  }

  return null;
}

function getMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;

  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join(' ');
}

function findLastUserMessageIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }

  return -1;
}

function hasPostUserAgentContext(messages: ModelMessage[]): boolean {
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex < 0) return false;

  return messages.slice(lastUserIndex + 1).some((message) => {
    if (message.role !== 'assistant' && message.role !== 'system') return false;

    const text = getMessageText(message);
    return text.includes('[tool_result]') || text.includes('[tool_error]') || text.includes('"action":"call_tool"');
  });
}

function shouldReturnDirectToolAnswer(messages: ModelMessage[], tool: ToolDefinition): boolean {
  const hasTaskExecutionContext = messages.some((message) => {
    if (message.role !== 'system') return false;
    return getMessageText(message).includes('[TASK_EXECUTION_CONTEXT]');
  });
  if (hasTaskExecutionContext) {
    return tool.directReturn === true;
  }

  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex < 0) return false;

  const text = getMessageText(messages[lastUserIndex]).trim();
  if (!text) return false;

  if (/(先|然后|再|接着|并且|总结|分析|判断|告诉我|说明|为什么|是否|有没有)/.test(text)) {
    return false;
  }

  return tool.directReturn === true;
}

async function inferToolDecision(
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<AgentDecision | null> {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUserMessage) return null;

  const text = getMessageText(lastUserMessage).trim();
  if (!text) return null;

  try {
    const rawText = await collectPromptText(
      [
        'You are a lightweight tool selector.',
        'Decide whether the latest user message should immediately call one available tool.',
        'If you are not confident, return no_tool.',
        'Only choose from the available tools.',
        'For calculate_expression, provide the expression argument.',
        'For http_request, provide the url argument.',
        'For run_command, provide a single safe read-only PowerShell command string in the command argument.',
        'Do not use command chaining, redirection, pipes, networking, or write operations.',
        'For get_current_time, provide timeZone only when explicitly requested.',
      ].join('\n'),
      [
        '[latest_user_message]',
        text,
        '',
        '[available_tools]',
        JSON.stringify(registry.summary()),
        '',
        '[output]',
        'Return JSON only.',
        '{"decision":"no_tool"}',
        '{"decision":"get_current_time","arguments":{"timeZone":"Asia/Shanghai"}}',
        '{"decision":"calculate_expression","arguments":{"expression":"1+2"}}',
        '{"decision":"http_request","arguments":{"url":"https://example.com"}}',
        '{"decision":"run_command","arguments":{"command":"Get-Date"}}',
      ].join('\n'),
      signal,
    );

    let parsed: unknown;
    try {
      parsed = parseJsonLikeText(rawText);
    } catch {
      logger.warn({ text: rawText }, '[agent] tool inference returned non-json');
      return null;
    }

    const object = z
      .object({
        decision: z.enum([
          'no_tool',
          'get_current_time',
          'calculate_expression',
          'http_request',
          'run_command',
        ]),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(parsed);

    if (object.decision === 'no_tool') return null;

    return {
      action: 'call_tool',
      tool: object.decision,
      arguments:
        object.arguments && typeof object.arguments === 'object' && !Array.isArray(object.arguments)
          ? (object.arguments as Record<string, unknown>)
          : {},
    };
  } catch (error) {
    logger.warn({ err: error }, '[agent] ai tool inference failed');
    return null;
  }
}

async function collectPromptText(
  system: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = streamText({
    model: provider(config.model.id),
    system,
    prompt,
    stopWhen: stepCountIs(1),
    abortSignal: signal,
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
  }

  return text.trim();
}

async function collectText(
  messages: ModelMessage[],
  system: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = streamText({
    model: provider(config.model.id),
    system,
    messages,
    stopWhen: stepCountIs(1),
    abortSignal: signal,
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
  }

  return text.trim();
}

function getPromptContext(step: number, messages: ModelMessage[]) {
  return {
    step,
    maxSteps: config.agent.maxSteps,
    messages,
    tools: registry.summary(),
    currentTime: new Date().toISOString(),
    workspace: process.cwd(),
  };
}

async function planNextStep(
  step: number,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<AgentDecision | null> {
  if (!hasPostUserAgentContext(messages)) {
    const inferred = await inferToolDecision(messages, signal);
    if (inferred) {
      logger.info({ decision: inferred }, '[agent] ai tool selection');
      return inferred;
    }
  }

  const text = await collectText(
    messages,
    buildPlannerPrompt(getPromptContext(step, messages)),
    signal,
  );

  try {
    return normalizeDecision(parseJsonLikeText(text));
  } catch (error) {
    logger.warn({ text, err: error }, '[agent] failed to parse planner JSON');
    return null;
  }
}

function makeToolContextMessage(
  toolName: string,
  description: string,
  input: Record<string, unknown>,
  result: unknown,
): ModelMessage {
  return {
    role: 'system',
    content: [
      '[tool_result]',
      `name: ${toolName}`,
      `description: ${description}`,
      `input: ${JSON.stringify(input)}`,
      `result: ${JSON.stringify(result)}`,
    ].join('\n'),
  };
}

function makeToolErrorMessage(toolName: string, error: unknown): ModelMessage {
  return {
    role: 'system',
    content: [
      '[tool_error]',
      `name: ${toolName}`,
      `error: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n'),
  };
}

function getToolDisplayText(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  return typeof value.displayText === 'string' && value.displayText.trim() ? value.displayText : null;
}

export async function runAgent(
  messages: ModelMessage[],
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const workingMessages = [...messages];
  const maxSteps = config.agent.maxSteps;
  const { signal } = options;

  for (let step = 1; step <= maxSteps; step += 1) {
    let decision: AgentDecision | null;
    try {
      decision = await planNextStep(step, workingMessages, signal);
      logger.info({ decision }, '[agent] planner output');
    } catch (error) {
      logger.error({ err: error, step }, '[agent] failed while planning next step');
      return '模型服务暂时返回了非预期结果，工具已经执行的话你可以稍后重试，或检查模型网关配置。';
    }
    logger.info({ step, decision }, '[agent] planner decision');

    if (!decision) {
      try {
        const fallback = await collectText(
          workingMessages,
          buildAnswerPrompt(getPromptContext(step, workingMessages)),
          signal,
        );
        logger.info({ step, text: fallback }, '[agent] execution finished without tool plan');
        return fallback;
      } catch (error) {
        logger.error({ err: error, step }, '[agent] direct fallback generation failed');
        return '模型服务暂时返回了非预期结果，无法整理最终答复。';
      }
    }

    if (decision.action === 'respond') {
      logger.info({ step, text: decision.answer }, '[agent] execution finished with direct answer');
      return decision.answer;
    }

    const toolDefinition = registry.get(decision.tool);
    if (!toolDefinition) {
      logger.warn({ step, tool: decision.tool }, '[agent] planner selected unknown tool');
      workingMessages.push({
        role: 'system',
        content: [
          '[planner_feedback]',
          `Tool "${decision.tool}" is unavailable.`,
          'Choose a different tool or respond directly.',
        ].join('\n'),
      });
      continue;
    }

    const toolArgs = decision.arguments ?? {};
    logger.info({ step, tool: toolDefinition.name, arguments: toolArgs }, '[agent] tool selected');

    try {
      const toolResult = await runner.run(toolDefinition, toolArgs, { signal });
      const directAnswer = getToolDisplayText(toolResult);
      if (directAnswer && shouldReturnDirectToolAnswer(workingMessages, toolDefinition)) {
        logger.info({ step, tool: toolDefinition.name, text: directAnswer }, '[agent] execution finished with direct tool answer');
        return directAnswer;
      }

      workingMessages.push(
        {
          role: 'assistant',
          content: JSON.stringify({
            action: 'call_tool',
            tool: toolDefinition.name,
            arguments: toolArgs,
          }),
        },
        makeToolContextMessage(toolDefinition.name, toolDefinition.description, toolArgs, toolResult),
      );
      logger.info({ step, tool: toolDefinition.name, result: toolResult }, '[agent] tool execution finished');
      continue;
    } catch (error) {
      logger.error({ err: error, step, tool: toolDefinition.name }, '[agent] tool execution failed');
      workingMessages.push(
        {
          role: 'assistant',
          content: JSON.stringify({
            action: 'call_tool',
            tool: toolDefinition.name,
            arguments: toolArgs,
          }),
        },
        makeToolErrorMessage(toolDefinition.name, error),
      );
    }
  }

  try {
    const fallback = await collectText(
      workingMessages,
      buildRecoveryPrompt(
        getPromptContext(maxSteps, workingMessages),
        `You have reached the maximum tool/planning steps (${maxSteps}). Use the information already gathered and provide the best final answer now.`,
      ),
      signal,
    );
    logger.warn({ text: fallback, maxSteps }, '[agent] execution stopped at max steps');
    return fallback;
  } catch (error) {
    logger.error({ err: error, maxSteps }, '[agent] final fallback generation failed');
    return '工具已经执行，但模型服务返回了非预期结果，最终答案暂时无法生成。';
  }
}
