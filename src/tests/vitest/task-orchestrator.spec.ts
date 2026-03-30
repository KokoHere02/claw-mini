import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import type { TaskPlan, TaskProgressEvent } from '@/agent/task-types';
import { runTaskOrchestration } from '@/agent/task-orchestrator';
import { buildTaskPlan } from '@/agent/task-planner';

vi.mock('@/config', () => ({
  config: {
    agent: {
      stepTimeoutMs: 20,
    },
  },
}));

vi.mock('@/agent/task-planner', () => ({
  buildTaskPlan: vi.fn(),
}));

function makeMessages(text: string): ModelMessage[] {
  return [{ role: 'user', content: text }];
}

describe('runTaskOrchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should complete a single-step plan', async () => {
    const plan: TaskPlan = {
      goal: 'do one thing',
      steps: [
        {
          id: 'step_1',
          title: 'collect result',
          goal: 'collect result',
          expectedOutput: 'one line result',
        },
      ],
    };
    vi.mocked(buildTaskPlan).mockResolvedValue(plan);

    const events: TaskProgressEvent[] = [];
    const result = await runTaskOrchestration({
      messages: makeMessages('hello'),
      executeStep: vi.fn(async () => ({ result: 'step done' })),
      synthesizeAnswer: vi.fn(async () => 'final answer'),
      onProgress(event) {
        events.push(event);
      },
    });

    expect(result.answer).toBe('final answer');
    expect(result.taskRun.status).toBe('completed');
    expect(result.taskRun.steps[0].status).toBe('completed');
    expect(result.taskRun.steps[0].result).toBe('step done');
    expect(events.map((event) => event.type)).toEqual([
      'planned',
      'step_started',
      'step_completed',
      'completed',
    ]);
  });

  it('should fail when step execution throws', async () => {
    const plan: TaskPlan = {
      goal: 'fail step',
      steps: [
        {
          id: 'step_1',
          title: 'explode',
          goal: 'explode',
          expectedOutput: 'error',
        },
      ],
    };
    vi.mocked(buildTaskPlan).mockResolvedValue(plan);

    const events: TaskProgressEvent[] = [];
    await expect(
      runTaskOrchestration({
        messages: makeMessages('fail'),
        executeStep: vi.fn(async () => {
          throw new Error('step exploded');
        }),
        synthesizeAnswer: vi.fn(async () => 'should not happen'),
        onProgress(event) {
          events.push(event);
        },
      }),
    ).rejects.toThrow('step exploded');

    expect(events.map((event) => event.type)).toEqual([
      'planned',
      'step_started',
      'step_failed',
      'failed',
    ]);
  });

  it('should fail when plan contains unresolved dependencies', async () => {
    const plan: TaskPlan = {
      goal: 'broken plan',
      steps: [
        {
          id: 'step_1',
          title: 'never runnable',
          goal: 'depends on missing step',
          expectedOutput: 'none',
          dependsOn: ['missing_step'],
        },
      ],
    };
    vi.mocked(buildTaskPlan).mockResolvedValue(plan);

    await expect(
      runTaskOrchestration({
        messages: makeMessages('dependency error'),
        executeStep: vi.fn(async () => ({ result: 'irrelevant' })),
        synthesizeAnswer: vi.fn(async () => 'irrelevant'),
      }),
    ).rejects.toThrow('Task plan contains unresolved step dependencies.');
  });

  it('should mark timed_out when step exceeds step timeout', async () => {
    const plan: TaskPlan = {
      goal: 'timeout flow',
      steps: [
        {
          id: 'step_1',
          title: 'slow step',
          goal: 'wait forever',
          expectedOutput: 'none',
        },
      ],
    };
    vi.mocked(buildTaskPlan).mockResolvedValue(plan);

    const events: TaskProgressEvent[] = [];
    await expect(
      runTaskOrchestration({
        messages: makeMessages('timeout test'),
        executeStep: vi.fn(({ signal }) => (
          new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason ?? new Error('aborted'));
              return;
            }
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason ?? new Error('aborted')),
              { once: true },
            );
          })
        )),
        synthesizeAnswer: vi.fn(async () => 'irrelevant'),
        onProgress(event) {
          events.push(event);
        },
      }),
    ).rejects.toThrow(/timed out/i);

    expect(events.map((event) => event.type)).toEqual([
      'planned',
      'step_started',
      'step_timed_out',
      'timed_out',
    ]);
  });

  it('should mark cancelled when parent signal aborts', async () => {
    const plan: TaskPlan = {
      goal: 'cancel flow',
      steps: [
        {
          id: 'step_1',
          title: 'cancelled step',
          goal: 'stop by parent abort',
          expectedOutput: 'none',
        },
      ],
    };
    vi.mocked(buildTaskPlan).mockResolvedValue(plan);

    const controller = new AbortController();
    const events: TaskProgressEvent[] = [];

    const task = runTaskOrchestration({
      messages: makeMessages('cancel test'),
      signal: controller.signal,
      executeStep: vi.fn(({ signal }) => (
        new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('aborted')),
            { once: true },
          );
        })
      )),
      synthesizeAnswer: vi.fn(async () => 'irrelevant'),
      onProgress(event) {
        events.push(event);
      },
    });

    controller.abort('manual cancel');

    await expect(task).rejects.toThrow(/manual cancel/i);
    expect(events.map((event) => event.type)).toEqual([
      'planned',
      'step_started',
      'step_cancelled',
      'cancelled',
    ]);
  });
});
