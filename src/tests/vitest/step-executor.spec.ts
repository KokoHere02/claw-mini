import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import type { ToolDefinition } from '@/agent/tool-types';
import type { ExecuteTaskStepInput } from '@/agent/task-orchestrator';

const mocked = vi.hoisted(() => ({
  plannerResponses: [] as string[],
  runnerRun: vi.fn(),
  registryList: vi.fn(),
  registryGet: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock('@/config', () => ({
  config: {
    model: {
      id: 'test-model',
      apiKey: 'test-key',
      baseURL: 'https://example.com',
    },
    agent: {
      maxParallelReadonlyTools: 3,
      parallelReadonlyPlanTimeoutMs: 100,
      parallelReadonlyExecutionBudgetMs: 20,
      maxSteps: 3,
      stepTimeoutMs: 0,
    },
  },
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => () => ({}),
}));

vi.mock('ai', () => ({
  stepCountIs: () => () => true,
  streamText: (input: { abortSignal?: AbortSignal }) => {
    const response = mocked.plannerResponses.shift() ?? '{"toolCalls": []}';
    return {
      textStream: (async function* stream() {
        if (response === '__WAIT_FOR_ABORT__') {
          await new Promise<void>((_resolve, reject) => {
            if (input.abortSignal?.aborted) {
              reject(input.abortSignal.reason ?? new Error('aborted'));
              return;
            }
            input.abortSignal?.addEventListener(
              'abort',
              () => reject(input.abortSignal?.reason ?? new Error('aborted')),
              { once: true },
            );
          });
          return;
        }
        yield response;
      })(),
    };
  },
}));

vi.mock('@/agent/tool-runner', () => ({
  runner: {
    run: mocked.runnerRun,
  },
}));

vi.mock('@/agent/tool-registry', () => ({
  registry: {
    list: mocked.registryList,
    get: mocked.registryGet,
  },
}));

vi.mock('@/agent/index', () => ({
  runAgent: mocked.runAgent,
}));

const readonlyTool: ToolDefinition = {
  name: 'calculate_expression',
  description: 'calc',
  readonly: true,
  parameters: {
    expression: {
      type: 'string',
      description: 'expr',
    },
  },
  execute: async () => ({}),
};

function makeInput(overrides: Partial<ExecuteTaskStepInput> = {}): ExecuteTaskStepInput {
  const messages: ModelMessage[] = [
    { role: 'user', content: '387 + 654 - 120 = ?' },
  ];

  return {
    step: {
      id: 'step_1',
      title: 'solve expression',
      goal: 'compute expression',
      expectedOutput: 'result',
      status: 'pending' as const,
    },
    plan: {
      goal: 'math',
      steps: [
        {
          id: 'step_1',
          title: 'solve expression',
          goal: 'compute expression',
          expectedOutput: 'result',
        },
      ],
    },
    messages,
    previousSteps: [],
    signal: undefined,
    ...overrides,
  };
}

describe('executeTaskStepWithAgentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.plannerResponses.length = 0;
    mocked.registryList.mockReturnValue([readonlyTool]);
    mocked.registryGet.mockReturnValue(readonlyTool);
    mocked.runAgent.mockResolvedValue('agent fallback answer');
  });

  it('should execute planned readonly tools and return toolCalls', async () => {
    mocked.plannerResponses.push(
      JSON.stringify({
        toolCalls: [
          {
            tool: 'calculate_expression',
            arguments: { expression: '387 + 654 - 120' },
          },
        ],
      }),
    );
    mocked.runnerRun.mockResolvedValueOnce({ result: 921 });

    const { executeTaskStepWithAgentLoop } = await import('@/agent/step-executor');
    const result = await executeTaskStepWithAgentLoop(makeInput());

    expect(mocked.runnerRun).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toEqual([
      {
        tool: 'calculate_expression',
        arguments: { expression: '387 + 654 - 120' },
        result: { result: 921 },
      },
    ]);
    expect(result.result).toBe('agent fallback answer');
  });

  it('should reuse readonly cache and skip runner when same call exists', async () => {
    mocked.plannerResponses.push(
      JSON.stringify({
        toolCalls: [
          {
            tool: 'calculate_expression',
            arguments: { expression: '387 + 654 - 120' },
          },
        ],
      }),
    );

    const { executeTaskStepWithAgentLoop } = await import('@/agent/step-executor');
    const result = await executeTaskStepWithAgentLoop(makeInput({
      previousSteps: [
        {
          id: 'step_prev',
          title: 'old calc',
          goal: 'old calc',
          expectedOutput: 'old result',
          status: 'completed',
          toolCalls: [
            {
              tool: 'calculate_expression',
              arguments: { expression: '387 + 654 - 120' },
              result: { result: 921 },
            },
          ],
        },
      ],
    }));

    expect(mocked.runnerRun).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([
      {
        tool: 'calculate_expression',
        arguments: { expression: '387 + 654 - 120' },
        result: { result: 921 },
      },
    ]);
  });

  it('should abort parallel readonly execution on budget timeout and surface tool error call', async () => {
    vi.useFakeTimers();
    mocked.plannerResponses.push(
      JSON.stringify({
        toolCalls: [
          {
            tool: 'calculate_expression',
            arguments: { expression: '387 + 654 - 120' },
          },
        ],
      }),
    );

    let observedSignal: AbortSignal | undefined;
    mocked.runnerRun.mockImplementationOnce((_tool, _args, options: { signal?: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        observedSignal = options.signal;
        if (options.signal?.aborted) {
          reject(options.signal.reason ?? new Error('aborted'));
          return;
        }
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason ?? new Error('aborted')),
          { once: true },
        );
      })
    ));

    const { executeTaskStepWithAgentLoop } = await import('@/agent/step-executor');
    const taskPromise = executeTaskStepWithAgentLoop(makeInput());

    await vi.advanceTimersByTimeAsync(30);
    const result = await taskPromise;

    expect(mocked.runnerRun).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(result.toolCalls).toEqual([
      {
        tool: 'calculate_expression',
        arguments: { expression: '387 + 654 - 120' },
        error: 'Parallel readonly execution for step_1 timed out after 20ms',
      },
    ]);
    expect(result.result).toBe('agent fallback answer');

    vi.useRealTimers();
  });

  it('should fallback to base messages when readonly planning times out', async () => {
    vi.useFakeTimers();
    mocked.plannerResponses.push('__WAIT_FOR_ABORT__');

    const { executeTaskStepWithAgentLoop } = await import('@/agent/step-executor');
    const taskPromise = executeTaskStepWithAgentLoop(makeInput());

    await vi.advanceTimersByTimeAsync(150);
    const result = await taskPromise;

    expect(mocked.runnerRun).not.toHaveBeenCalled();
    expect(result.toolCalls).toBeUndefined();
    expect(result.result).toBe('agent fallback answer');

    vi.useRealTimers();
  });

  it('should fallback to base messages when readonly planning returns empty JSON text', async () => {
    mocked.plannerResponses.push('');

    const { executeTaskStepWithAgentLoop } = await import('@/agent/step-executor');
    const result = await executeTaskStepWithAgentLoop(makeInput());

    expect(mocked.runnerRun).not.toHaveBeenCalled();
    expect(result.toolCalls).toBeUndefined();
    expect(result.result).toBe('agent fallback answer');
  });
});
