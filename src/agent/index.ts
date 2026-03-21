import { streamText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from '@/config';
import { registry } from './tool-registry';
import type { ToolParameters } from './tool-types';
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

function extractQuotedTarget(text: string): string | null {
  const patterns = [
    /["'`](.+?)["'`]/,
    /read\s+([^\s]+)/i,
    /show\s+([^\s]+)/i,
    /fetch\s+(https?:\/\/[^\s]+)/i,
    /visit\s+(https?:\/\/[^\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
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

function shouldReturnDirectToolAnswer(messages: ModelMessage[], toolName: string): boolean {
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex < 0) return false;

  const text = getMessageText(messages[lastUserIndex]).trim();
  if (!text) return false;

  // Multi-step tasks should stay in the loop.
  if (/(先|然后|再|接着|并且|总结|分析|判断|告诉我|说明|为什么|是否|有没有)/.test(text)) {
    return false;
  }

  if (toolName === 'get_current_time') {
    return /(现在几点|当前时间|几点了|什么时间|time now|current time)/i.test(text);
  }

  if (toolName === 'calculate_expression') {
    return /(计算|算一下|evaluate|calculate)/i.test(text);
  }

  if (toolName === 'http_request') {
    return /(请求|访问|抓取|获取网页|fetch|http|url)/i.test(text);
  }

  if (toolName === 'run_command') {
    return /(列出文件|当前目录|读取文件|查看文件|whoami|hostname|node 版本|pnpm 版本|pwd|ls|cat)/i.test(text);
  }

  return false;
}

function inferToolDecision(messages: ModelMessage[]): AgentDecision | null {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUserMessage) return null;

  const text = getMessageText(lastUserMessage).trim();
  if (!text) return null;

  if (/(现在几点|当前时间|几点了|什么时间|time now|current time)/i.test(text)) {
    const zoneMatch = text.match(/(Asia\/Shanghai|America\/New_York|UTC|Europe\/[A-Za-z_]+|Asia\/[A-Za-z_]+)/i);
    return {
      action: 'call_tool',
      tool: 'get_current_time',
      arguments: zoneMatch ? { timeZone: zoneMatch[1] } : {},
    };
  }

  if (/(计算|算一下|表达式|evaluate|calculate)/i.test(text)) {
    const expressionMatch =
      text.match(/`([^`]+)`/) ??
      text.match(/\(([^()]+)\)/) ??
      text.match(/[-+*/().\d\s]{3,}/);

    if (expressionMatch?.[0]) {
      const expression = expressionMatch[1] ?? expressionMatch[0];
      return {
        action: 'call_tool',
        tool: 'calculate_expression',
        arguments: { expression: expression.trim() },
      };
    }
  }

  if (/(请求|访问|抓取|获取网页|fetch|http|url)/i.test(text) && /https?:\/\//i.test(text)) {
    const target = extractQuotedTarget(text) ?? text.match(/https?:\/\/[^\s]+/)?.[0];
    if (target) {
      return {
        action: 'call_tool',
        tool: 'http_request',
        arguments: { url: target },
      };
    }
  }

  if (/(执行命令|运行命令|列出文件|当前目录|读取文件|查看文件|whoami|hostname|node 版本|pnpm 版本|pwd|ls|cat)/i.test(text)) {
    if (/(当前目录|pwd)/i.test(text)) {
      return { action: 'call_tool', tool: 'run_command', arguments: { command: 'pwd' } };
    }

    if (/(列出文件|看看目录|ls)/i.test(text)) {
      const target = extractQuotedTarget(text) ?? undefined;
      return {
        action: 'call_tool',
        tool: 'run_command',
        arguments: target ? { command: 'ls', target } : { command: 'ls' },
      };
    }

    if (/(读取文件|查看文件|cat)/i.test(text)) {
      const target = extractQuotedTarget(text);
      if (target) {
        return {
          action: 'call_tool',
          tool: 'run_command',
          arguments: { command: 'cat', target },
        };
      }
    }

    if (/whoami/i.test(text)) {
      return { action: 'call_tool', tool: 'run_command', arguments: { command: 'whoami' } };
    }

    if (/hostname/i.test(text)) {
      return { action: 'call_tool', tool: 'run_command', arguments: { command: 'hostname' } };
    }

    if (/(node 版本|node_version)/i.test(text)) {
      return { action: 'call_tool', tool: 'run_command', arguments: { command: 'node_version' } };
    }

    if (/(pnpm 版本|pnpm_version)/i.test(text)) {
      return { action: 'call_tool', tool: 'run_command', arguments: { command: 'pnpm_version' } };
    }
  }

  return null;
}

async function collectText(messages: ModelMessage[], system: string): Promise<string> {
  const result = streamText({
    model: provider(config.model.id),
    system,
    messages,
    maxSteps: 1,
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

async function planNextStep(step: number, messages: ModelMessage[]): Promise<AgentDecision | null> {
  if (!hasPostUserAgentContext(messages)) {
    const inferred = inferToolDecision(messages);
    if (inferred) {
      logger.info({ decision: inferred }, '[agent] rule-based tool selection');
      return inferred;
    }
  }

  const text = await collectText(messages, buildPlannerPrompt(getPromptContext(step, messages)));
  const json = extractJsonObject(text);
  if (!json) return null;

  try {
    return normalizeDecision(JSON.parse(json));
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

function formatToolAnswer(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;

  if (toolName === 'get_current_time') {
    const formatted = typeof value.formatted === 'string' ? value.formatted : null;
    const timeZone = typeof value.timeZone === 'string' ? value.timeZone : null;
    if (formatted) {
      return timeZone ? `当前时间（${timeZone}）: ${formatted}` : `当前时间: ${formatted}`;
    }
  }

  if (toolName === 'calculate_expression') {
    const expression = typeof value.expression === 'string' ? value.expression : null;
    const resultValue = value.result;
    if (expression && resultValue != null) {
      return `${expression} = ${String(resultValue)}`;
    }
  }

  if (toolName === 'run_command') {
    const command = typeof value.command === 'string' ? value.command : null;
    const stdout = typeof value.stdout === 'string' ? value.stdout : '';
    const stderr = typeof value.stderr === 'string' ? value.stderr : '';
    const exitCode = typeof value.exitCode === 'number' ? value.exitCode : null;
    const target = typeof value.target === 'string' ? value.target : null;

    if (exitCode !== 0) {
      return stderr || `命令 ${command ?? ''} 执行失败，退出码 ${String(exitCode)}。`;
    }

    if (command === 'pwd') {
      return stdout ? `当前目录:\n${stdout}` : '当前目录为空。';
    }

    if (command === 'ls') {
      return stdout ? `目录内容:\n${stdout}` : '目录为空。';
    }

    if (command === 'cat') {
      return stdout ? `文件${target ? ` ${target}` : ''}内容:\n${stdout}` : `文件${target ? ` ${target}` : ''}为空。`;
    }

    if (stdout) return stdout;
  }

  if (toolName === 'http_request') {
    const status = typeof value.status === 'number' ? value.status : null;
    const body = typeof value.body === 'string' ? value.body : null;
    const url = typeof value.url === 'string' ? value.url : null;
    if (status != null && body != null) {
      return `已请求 ${url ?? '目标地址'}，状态码 ${status}。\n${body}`;
    }
  }

  return null;
}

export async function runAgent(messages: ModelMessage[]): Promise<string> {
  const workingMessages = [...messages];
  const maxSteps = config.agent.maxSteps;

  for (let step = 1; step <= maxSteps; step += 1) {
    let decision: AgentDecision | null;
    try {
      decision = await planNextStep(step, workingMessages);
      logger.info({ decision }, '[agent] planner output');
    } catch (error) {
      logger.error({ err: error, step }, '[agent] failed while planning next step');
      return '模型服务暂时返回了非预期结果，工具已经执行的话你可以稍后重试，或检查模型网关配置。';
    }
    logger.info({ step, decision }, '[agent] planner decision');

    if (!decision) {
      try {
        const fallback = await collectText(workingMessages, buildAnswerPrompt(getPromptContext(step, workingMessages)));
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
      const toolResult = await runner.run(toolDefinition, toolArgs);
      const directAnswer = formatToolAnswer(toolDefinition.name, toolResult);
      if (directAnswer && shouldReturnDirectToolAnswer(workingMessages, toolDefinition.name)) {
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
    );
    logger.warn({ text: fallback, maxSteps }, '[agent] execution stopped at max steps');
    return fallback;
  } catch (error) {
    logger.error({ err: error, maxSteps }, '[agent] final fallback generation failed');
    return '工具已经执行，但模型服务返回了非预期结果，最终答案暂时无法生成。';
  }
}

