export type TaskRunStatus =
  | 'planning'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'failed';

export type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'failed'
  | 'skipped';

export type TaskStepToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type TaskStep = {
  id: string;
  title: string;
  goal: string;
  expectedOutput: string;
  dependsOn?: string[];
  status: TaskStepStatus;
  result?: string;
  error?: string;
  toolCalls?: TaskStepToolCall[];
};

export type TaskPlanStep = Pick<TaskStep, 'id' | 'title' | 'goal' | 'expectedOutput' | 'dependsOn'>;

export type TaskPlan = {
  goal: string;
  steps: TaskPlanStep[];
};

export type TaskRun = {
  status: TaskRunStatus;
  plan: TaskPlan | null;
  steps: TaskStep[];
  currentStepIndex: number;
  progressText?: string;
  finalAnswer?: string;
  error?: string;
};

export type TaskExecutionReport = {
  goal: string;
  status: Extract<TaskRunStatus, 'completed' | 'cancelled' | 'timed_out' | 'failed'>;
  steps: Array<{
    id: string;
    title: string;
    status: TaskStepStatus;
    result?: string;
    error?: string;
  }>;
};

export type TaskProgressEvent =
  | { type: 'planned'; plan: TaskPlan }
  | {
      type: 'step_started';
      stepId: string;
      index: number;
      total: number;
      title: string;
    }
  | {
      type: 'step_completed';
      stepId: string;
      index: number;
      total: number;
      title: string;
      result: string;
    }
  | {
      type: 'step_failed';
      stepId: string;
      index: number;
      total: number;
      title: string;
      error: string;
    }
  | {
      type: 'step_cancelled';
      stepId: string;
      index: number;
      total: number;
      title: string;
      error: string;
    }
  | {
      type: 'step_timed_out';
      stepId: string;
      index: number;
      total: number;
      title: string;
      error: string;
    }
  | { type: 'completed'; answer: string }
  | { type: 'cancelled'; error: string }
  | { type: 'timed_out'; error: string }
  | { type: 'failed'; error: string };

export type TaskOrchestrationResult = {
  answer: string;
  taskRun: TaskRun;
};
