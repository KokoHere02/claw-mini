import { stepCountIs, streamText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from '@/config';
import { createChildAbortSignal, getAbortReasonMessage, isAbortError } from '@/utils/abort';
import logger from '@/utils/logger';
import { runAgent } from './index';
import { registry } from './tool-registry';
import { runner } from './tool-runner';
import type { ToolDefinition } from './tool-types';
import type { ExecuteTaskStepInput, ExecuteTaskStepResult } from './task-orchestrator';
import type { TaskStepToolCall } from './task-types';

const provider = createOpenAICompatible({
  name: config.model.id,
  apiKey: config.model.apiKey,
  baseURL: config.model.baseURL,
});

type PlannedReadonlyToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
};

type ReadonlyToolCacheEntry = {
  result: unknown;
  sourceStepId: string;
  sourceStepTitle: string;
};

function buildToolCallKey(toolCall: PlannedReadonlyToolCall): string {
  return JSON.stringify({
    tool: toolCall.tool,
    arguments: toolCall.arguments,
  });
}

function buildReadonlyToolCache(
  previousSteps: ExecuteTaskStepInput['previousSteps'],
): Map<string, ReadonlyToolCacheEntry> {
  const cache = new Map<string, ReadonlyToolCacheEntry>();

  for (const step of previousSteps) {
    for (const toolCall of step.toolCalls ?? []) {
      if (toolCall.error || toolCall.result === undefined) continue;

      const toolDefinition = registry.get(toolCall.tool);
      if (!toolDefinition || toolDefinition.readonly !== true) continue;

      const key = buildToolCallKey({
        tool: toolCall.tool,
        arguments: toolCall.arguments,
      });
      cache.set(key, {
        result: toolCall.result,
        sourceStepId: step.id,
        sourceStepTitle: step.title,
      });
    }
  }

  return cache;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stringifyMessageContent(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;

  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

function summarizePreviousSteps(input: ExecuteTaskStepInput['previousSteps']): string {
  if (!input.length) return '(none)';

  return input
    .map((step, index) => {
      const lines = [
        `${index + 1}. ${step.title}`,
        `status: ${step.status}`,
      ];

      if (step.result) lines.push(`result: ${step.result}`);
      if (step.error) lines.push(`error: ${step.error}`);

      return lines.join('\n');
    })
    .join('\n\n');
}

function buildStepExecutionMessages(input: ExecuteTaskStepInput): ModelMessage[] {
  const lastUserMessage = [...input.messages].reverse().find((message) => message.role === 'user');
  const originalUserGoal = lastUserMessage
    ? stringifyMessageContent(lastUserMessage)
    : '(missing user goal)';

  const stepContext: ModelMessage = {
    role: 'system',
    content: [
      '[TASK_EXECUTION_CONTEXT]',
      `plan_goal: ${input.plan.goal}`,
      `current_step_id: ${input.step.id}`,
      `current_step_title: ${input.step.title}`,
      `current_step_goal: ${input.step.goal}`,
      `current_step_expected_output: ${input.step.expectedOutput}`,
      '',
      '[PREVIOUS_STEPS]',
      summarizePreviousSteps(input.previousSteps),
      '',
      'Execute only the current step.',
      'Use tools only when they materially improve correctness for this step.',
      'Prefer answering directly when the required information is already present in the existing conversation or previous step results.',
      'Do not read files, list directories, or call other tools unless the current step actually requires fresh evidence.',
      'Use previous step results as context, and do not redo completed steps unless necessary.',
      'Return the concrete result for the current step.',
    ].join('\n'),
  };

  const stepInstruction: ModelMessage = {
    role: 'user',
    content: [
      `Original task: ${originalUserGoal}`,
      `Current step: ${input.step.title}`,
      `Step goal: ${input.step.goal}`,
      `Expected output: ${input.step.expectedOutput}`,
      'Please execute this step now and return only the result for this step.',
    ].join('\n'),
  };

  return [...input.messages, stepContext, stepInstruction];
}

function getReadonlyTools(): ToolDefinition[] {
  return registry.list().filter((tool) => tool.readonly === true);
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

async function planParallelReadonlyTools(
  input: ExecuteTaskStepInput,
): Promise<PlannedReadonlyToolCall[]> {
  const readonlyTools = getReadonlyTools();
  if (!readonlyTools.length) return [];

  const availableToolNames = readonlyTools.map((tool) => tool.name);
  const toolCallSchema = z.object({
    toolCalls: z.array(
      z.object({
        tool: z.enum(availableToolNames as [string, ...string[]]),
        arguments: z.record(z.string(), z.unknown()).optional(),
      }),
    ).max(config.agent.maxParallelReadonlyTools),
  });

  const prompt = [
    '[step]',
    `id: ${input.step.id}`,
    `title: ${input.step.title}`,
    `goal: ${input.step.goal}`,
    `expected_output: ${input.step.expectedOutput}`,
    '',
    '[previous_steps]',
    summarizePreviousSteps(input.previousSteps),
    '',
    '[available_readonly_tools]',
    JSON.stringify(
      readonlyTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    ),
    '',
    '[task]',
    [
      `Choose zero to ${config.agent.maxParallelReadonlyTools} read-only tools that can be executed independently in parallel for the current step.`,
      'Only choose tools if they are materially useful for this step.',
      'Do not choose tools that depend on each other.',
      'Do not choose tools when the answer can be produced directly from existing context.',
      'Do not repeat the same evidence lookup with the same tool and arguments.',
      'Return JSON only.',
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({ toolCalls: [{ tool: availableToolNames[0], arguments: {} }] }),
    ].join('\n'),
  ].join('\n');

  const rawText = await collectPromptText(
    'You plan read-only parallel tool calls for one task step.',
    prompt,
    input.signal,
  );

  const parsed = toolCallSchema.parse(parseJsonLikeText(rawText));
  const dedupedToolCalls: PlannedReadonlyToolCall[] = [];
  const seenToolCalls = new Set<string>();

  for (const toolCall of parsed.toolCalls) {
    const normalizedToolCall: PlannedReadonlyToolCall = {
      tool: toolCall.tool,
      arguments:
        toolCall.arguments && typeof toolCall.arguments === 'object' && !Array.isArray(toolCall.arguments)
          ? toolCall.arguments
          : {},
    };
    const key = buildToolCallKey(normalizedToolCall);
    if (seenToolCalls.has(key)) continue;

    seenToolCalls.add(key);
    dedupedToolCalls.push(normalizedToolCall);
  }

  return dedupedToolCalls;
}

function makeToolContextMessage(
  toolName: string,
  description: string,
  input: Record<string, unknown>,
  result: unknown,
  cacheSource?: ReadonlyToolCacheEntry,
): ModelMessage {
  return {
    role: 'system',
    content: [
      '[tool_result]',
      `name: ${toolName}`,
      `description: ${description}`,
      `input: ${JSON.stringify(input)}`,
      `result: ${JSON.stringify(result)}`,
      ...(cacheSource
        ? [
            'cache: hit',
            `source_step_id: ${cacheSource.sourceStepId}`,
            `source_step_title: ${cacheSource.sourceStepTitle}`,
          ]
        : ['cache: miss']),
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

async function executeParallelReadonlyTools(
  toolCalls: PlannedReadonlyToolCall[],
  cache: Map<string, ReadonlyToolCacheEntry>,
  signal?: AbortSignal,
): Promise<{
  messages: ModelMessage[];
  toolCalls: TaskStepToolCall[];
  cacheHits: number;
}> {
  const executions = await Promise.allSettled(
    toolCalls.map(async (toolCall) => {
      const toolDefinition = registry.get(toolCall.tool);
      if (!toolDefinition || toolDefinition.readonly !== true) {
        throw new Error(`Readonly tool "${toolCall.tool}" is unavailable`);
      }

      const cacheKey = buildToolCallKey(toolCall);
      const cached = cache.get(cacheKey);
      if (cached) {
        return {
          toolDefinition,
          arguments: toolCall.arguments,
          result: cached.result,
          cacheHit: true,
          cacheSource: cached,
        };
      }

      const result = await runner.run(toolDefinition, toolCall.arguments, {
        signal,
      });
      cache.set(cacheKey, {
        result,
        sourceStepId: '__current_step__',
        sourceStepTitle: 'current step',
      });
      return {
        toolDefinition,
        arguments: toolCall.arguments,
        result,
        cacheHit: false,
        cacheSource: undefined,
      };
    }),
  );

  const messages: ModelMessage[] = [];
  const executedToolCalls: TaskStepToolCall[] = [];
  let cacheHits = 0;

  for (const [index, execution] of executions.entries()) {
    const planned = toolCalls[index];

    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        action: 'call_tool',
        tool: planned.tool,
        arguments: planned.arguments,
      }),
    });

    if (execution.status === 'fulfilled') {
      if (execution.value.cacheHit) {
        cacheHits += 1;
      }

      messages.push(
        makeToolContextMessage(
          execution.value.toolDefinition.name,
          execution.value.toolDefinition.description,
          execution.value.arguments,
          execution.value.result,
          execution.value.cacheSource,
        ),
      );
      executedToolCalls.push({
        tool: execution.value.toolDefinition.name,
        arguments: execution.value.arguments,
        result: execution.value.result,
      });
      continue;
    }

    messages.push(makeToolErrorMessage(planned.tool, execution.reason));
    executedToolCalls.push({
      tool: planned.tool,
      arguments: planned.arguments,
      error: execution.reason instanceof Error ? execution.reason.message : String(execution.reason),
    });
  }

  return {
    messages,
    toolCalls: executedToolCalls,
    cacheHits,
  };
}

export async function executeTaskStepWithAgentLoop(
  input: ExecuteTaskStepInput,
): Promise<ExecuteTaskStepResult> {
  const baseMessages = buildStepExecutionMessages(input);
  const readonlyToolCache = buildReadonlyToolCache(input.previousSteps);

  let parallelToolCalls: TaskStepToolCall[] = [];
  let messages = baseMessages;
  let planningAbortReason: string | undefined;

  try {
    const planningAbort = createChildAbortSignal({
      parentSignal: input.signal,
      timeoutMs: config.agent.parallelReadonlyPlanTimeoutMs,
      timeoutReason: `Parallel readonly planning for ${input.step.id} timed out after ${config.agent.parallelReadonlyPlanTimeoutMs}ms`,
    });

    const plannedToolCalls = await planParallelReadonlyTools({
      ...input,
      signal: planningAbort.signal,
    }).finally(() => {
      if (planningAbort.signal.aborted) {
        planningAbortReason = getAbortReasonMessage(planningAbort.signal);
      }
      planningAbort.dispose();
    });
    logger.info(
      {
        stepId: input.step.id,
        plannedReadonlyTools: plannedToolCalls.map((toolCall) => ({
          tool: toolCall.tool,
          arguments: toolCall.arguments,
        })),
      },
      '[task-step] planned parallel readonly tools',
    );

    if (plannedToolCalls.length) {
      const parallelExecution = await withTimeout(
        executeParallelReadonlyTools(plannedToolCalls, readonlyToolCache, input.signal),
        config.agent.parallelReadonlyExecutionBudgetMs,
        `parallel readonly execution for ${input.step.id}`,
      );
      parallelToolCalls = parallelExecution.toolCalls;
      messages = [...baseMessages, ...parallelExecution.messages];
      logger.info(
        {
          stepId: input.step.id,
          executedReadonlyTools: parallelToolCalls.map((toolCall) => ({
            tool: toolCall.tool,
            ok: !toolCall.error,
          })),
          cacheHits: parallelExecution.cacheHits,
        },
        '[task-step] executed parallel readonly tools',
      );
    }
  } catch (error) {
    const timeoutMessage =
      planningAbortReason || isAbortError(error) || input.signal?.aborted
        ? planningAbortReason ?? getAbortReasonMessage(input.signal)
        : undefined;
    logger.warn(
      {
        stepId: input.step.id,
        err: error,
        aborted: input.signal?.aborted === true,
        abortReason: timeoutMessage,
        planningTimeoutMs: config.agent.parallelReadonlyPlanTimeoutMs,
        executionBudgetMs: config.agent.parallelReadonlyExecutionBudgetMs,
      },
      '[task-step] failed to plan or execute parallel readonly tools',
    );
    messages = baseMessages;
  }

  const result = await runAgent(messages, { signal: input.signal });

  return {
    result: result.trim(),
    toolCalls: parallelToolCalls.length ? parallelToolCalls : undefined,
  };
}
