import type { ModelMessage } from 'ai';
import { buildTaskPlan } from './task-planner';
import type {
  TaskOrchestrationResult,
  TaskPlan,
  TaskProgressEvent,
  TaskRun,
  TaskStep,
  TaskStepToolCall,
} from './task-types';

export type ExecuteTaskStepInput = {
  step: TaskStep;
  plan: TaskPlan;
  messages: ModelMessage[];
  previousSteps: TaskStep[];
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
  executeStep: ExecuteTaskStep;
  synthesizeAnswer: (input: { messages: ModelMessage[]; taskRun: TaskRun }) => Promise<string>;
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

export async function runTaskOrchestration(
  input: RunTaskOrchestrationInput,
): Promise<TaskOrchestrationResult> {
  const { messages, executeStep, synthesizeAnswer, onProgress } = input;

  const plan = await buildTaskPlan(messages);
  const taskRun = createInitialTaskRun(plan);

  await emitProgress(onProgress, { type: 'planned', plan });

  taskRun.status = 'running';
  taskRun.progressText = `Planned ${taskRun.steps.length} step(s).`;

  for (let index = 0; index < taskRun.steps.length; index += 1) {
    const step = taskRun.steps[index];

    taskRun.currentStepIndex = index;
    updateStep(taskRun, index, { status: 'running', error: undefined });
    taskRun.progressText = `Running step ${index + 1}/${taskRun.steps.length}: ${step.title}`;

    await emitProgress(onProgress, {
      type: 'step_started',
      stepId: step.id,
      index: index + 1,
      total: taskRun.steps.length,
      title: step.title,
    });

    try {
      const execution = await executeStep({
        step: taskRun.steps[index],
        plan,
        messages,
        previousSteps: taskRun.steps.slice(0, index),
      });

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      updateStep(taskRun, index, {
        status: 'failed',
        error: message,
      });
      taskRun.status = 'failed';
      taskRun.error = message;
      taskRun.progressText = `Failed at step ${index + 1}/${taskRun.steps.length}: ${step.title}`;

      await emitProgress(onProgress, {
        type: 'step_failed',
        stepId: step.id,
        index: index + 1,
        total: taskRun.steps.length,
        title: step.title,
        error: message,
      });

      await emitProgress(onProgress, {
        type: 'failed',
        error: message,
      });

      throw error;
    }
  }

  const answer = await synthesizeAnswer({ messages, taskRun });
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
