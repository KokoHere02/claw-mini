import { config } from '@/config';
import { createChildAbortSignal, getAbortReasonMessage } from '@/utils/abort';
import type { ModelMessage } from 'ai';
import { buildTaskPlan } from './task-planner';
import type {
  TaskOrchestrationResult,
  TaskPlan,
  TaskProgressEvent,
  TaskRun,
  TaskRunStatus,
  TaskStep,
  TaskStepStatus,
  TaskStepToolCall,
} from './task-types';

export type ExecuteTaskStepInput = {
  step: TaskStep;
  plan: TaskPlan;
  messages: ModelMessage[];
  previousSteps: TaskStep[];
  signal?: AbortSignal;
};

export type ExecuteTaskStepResult = {
  result: string;
  toolCalls?: TaskStepToolCall[];
};

export type ExecuteTaskStep = (
  input: ExecuteTaskStepInput,
) => Promise<ExecuteTaskStepResult>;

export type RunTaskOrchestrationInput = {
  messages: ModelMessage[];
  signal?: AbortSignal;
  executeStep: ExecuteTaskStep;
  synthesizeAnswer: (input: {
    messages: ModelMessage[];
    taskRun: TaskRun;
    signal?: AbortSignal;
  }) => Promise<string>;
  onProgress?: (event: TaskProgressEvent) => Promise<void> | void;
};

function buildPendingSteps(plan: TaskPlan): TaskStep[] {
  return plan.steps.map((step) => ({
    ...step,
    status: 'pending',
  }));
}

function createInitialTaskRun(plan: TaskPlan): TaskRun {
  return {
    status: 'planning',
    plan,
    steps: buildPendingSteps(plan),
    currentStepIndex: -1,
  };
}

async function emitProgress(
  onProgress: RunTaskOrchestrationInput['onProgress'],
  event: TaskProgressEvent,
): Promise<void> {
  if (!onProgress) return;
  await onProgress(event);
}

function updateStep(
  taskRun: TaskRun,
  stepIndex: number,
  update: Partial<TaskStep>,
): void {
  const current = taskRun.steps[stepIndex];
  taskRun.steps[stepIndex] = {
    ...current,
    ...update,
  };
}

function getRunnableStepIndexes(taskRun: TaskRun): number[] {
  return taskRun.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === 'pending')
    .filter(({ step }) => {
      const dependencies = step.dependsOn ?? [];
      return dependencies.every((dependencyId) => {
        const dependency = taskRun.steps.find((candidate) => candidate.id === dependencyId);
        return dependency?.status === 'completed';
      });
    })
    .map(({ index }) => index);
}

function findFirstFailedStep(taskRun: TaskRun): TaskStep | undefined {
  return taskRun.steps.find((step) => step.status === 'failed');
}

function hasPendingSteps(taskRun: TaskRun): boolean {
  return taskRun.steps.some((step) => step.status === 'pending');
}

function isTimeoutMessage(message: string): boolean {
  return /\btimed out after \d+ms\b/i.test(message);
}

type StepExecutionOutcome =
  | {
      index: number;
      status: 'completed';
      execution: ExecuteTaskStepResult;
    }
  | {
      index: number;
      status: Extract<TaskStepStatus, 'cancelled' | 'timed_out' | 'failed'>;
      message: string;
    };

function toTaskRunFailureStatus(
  status: Extract<TaskStepStatus, 'cancelled' | 'timed_out' | 'failed'>,
): Extract<TaskRunStatus, 'cancelled' | 'timed_out' | 'failed'> {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'timed_out') return 'timed_out';
  return 'failed';
}

export async function runTaskOrchestration(
  input: RunTaskOrchestrationInput,
): Promise<TaskOrchestrationResult> {
  const { messages, signal, executeStep, synthesizeAnswer, onProgress } = input;

  const plan = await buildTaskPlan(messages, { signal });
  const taskRun = createInitialTaskRun(plan);

  await emitProgress(onProgress, { type: 'planned', plan });

  taskRun.status = 'running';
  taskRun.progressText = `Planned ${taskRun.steps.length} step(s).`;

  while (true) {
    const runnableStepIndexes = getRunnableStepIndexes(taskRun);
    if (!runnableStepIndexes.length) break;

    const previousCompletedSteps = taskRun.steps.filter((step) => step.status === 'completed');

    for (const index of runnableStepIndexes) {
      const step = taskRun.steps[index];
      taskRun.currentStepIndex = Math.max(taskRun.currentStepIndex, index);
      updateStep(taskRun, index, { status: 'running', error: undefined });
      taskRun.progressText = `Running step ${index + 1}/${taskRun.steps.length}: ${step.title}`;

      await emitProgress(onProgress, {
        type: 'step_started',
        stepId: step.id,
        index: index + 1,
        total: taskRun.steps.length,
        title: step.title,
      });
    }

    const executions = await Promise.all(
      runnableStepIndexes.map(async (index) => {
        const step = taskRun.steps[index];
        const stepAbort = createChildAbortSignal({
          parentSignal: signal,
          timeoutMs: config.agent.stepTimeoutMs,
          timeoutReason:
            config.agent.stepTimeoutMs > 0
              ? `Step "${step.title}" timed out after ${config.agent.stepTimeoutMs}ms`
              : undefined,
        });

        try {
          const execution = await executeStep({
            step,
            plan,
            messages,
            previousSteps: previousCompletedSteps,
            signal: stepAbort.signal,
          });

          return {
            index,
            status: 'completed',
            execution,
          } as StepExecutionOutcome;
        } catch (error) {
          const abortReason = stepAbort.signal.aborted
            ? getAbortReasonMessage(stepAbort.signal)
            : undefined;
          const message = error instanceof Error
            ? error.message
            : abortReason ?? String(error);
          const status: Extract<TaskStepStatus, 'cancelled' | 'timed_out' | 'failed'> =
            stepAbort.signal.aborted
              ? isTimeoutMessage(abortReason ?? message)
                ? 'timed_out'
                : 'cancelled'
              : 'failed';

          return {
            index,
            status,
            message,
          } as StepExecutionOutcome;
        } finally {
          stepAbort.dispose();
        }
      }),
    );

    for (const executionResult of executions) {
      if (executionResult.status === 'completed') {
        const { index, execution } = executionResult;
        const step = taskRun.steps[index];

        updateStep(taskRun, index, {
          status: 'completed',
          result: execution.result.trim(),
          error: undefined,
          toolCalls: execution.toolCalls,
        });
        taskRun.progressText = `Completed step ${index + 1}/${taskRun.steps.length}: ${step.title}`;

        await emitProgress(onProgress, {
          type: 'step_completed',
          stepId: step.id,
          index: index + 1,
          total: taskRun.steps.length,
          title: step.title,
          result: execution.result.trim(),
        });
        continue;
      }

      const failedIndex = executionResult.index;
      const failedStep = taskRun.steps[failedIndex];
      const message = executionResult.message;

      updateStep(taskRun, failedIndex, {
        status: executionResult.status,
        error: message,
      });
      taskRun.status = toTaskRunFailureStatus(executionResult.status);
      taskRun.error = message;
      taskRun.progressText = `${executionResult.status} at step ${failedIndex + 1}/${taskRun.steps.length}: ${failedStep.title}`;

      await emitProgress(onProgress, {
        type:
          executionResult.status === 'timed_out'
            ? 'step_timed_out'
            : executionResult.status === 'cancelled'
              ? 'step_cancelled'
              : 'step_failed',
        stepId: failedStep.id,
        index: failedIndex + 1,
        total: taskRun.steps.length,
        title: failedStep.title,
        error: message,
      });
    }

    if (taskRun.status === 'failed' || taskRun.status === 'cancelled' || taskRun.status === 'timed_out') {
      const failedStep = findFirstFailedStep(taskRun);
      const errorMessage = taskRun.error ?? (failedStep ? `Step failed: ${failedStep.title}` : 'Task failed');

      await emitProgress(onProgress, {
        type: taskRun.status,
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }
  }

  if (hasPendingSteps(taskRun)) {
    const message = 'Task plan contains unresolved step dependencies.';
    taskRun.status = 'failed';
    taskRun.error = message;
    taskRun.progressText = message;

    await emitProgress(onProgress, {
      type: 'failed',
      error: message,
    });

    throw new Error(message);
  }

  const answer = await synthesizeAnswer({ messages, taskRun, signal });
  taskRun.status = 'completed';
  taskRun.finalAnswer = answer.trim();
  taskRun.currentStepIndex = taskRun.steps.length - 1;
  taskRun.progressText = 'Task completed.';

  await emitProgress(onProgress, {
    type: 'completed',
    answer: taskRun.finalAnswer,
  });

  return {
    answer: taskRun.finalAnswer,
    taskRun,
  };
}
