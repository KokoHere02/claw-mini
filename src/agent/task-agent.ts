import type { ModelMessage } from 'ai';
import { synthesizeTaskResult } from './result-synthesizer';
import { executeTaskStepWithAgentLoop } from './step-executor';
import { runTaskOrchestration } from './task-orchestrator';
import type { TaskOrchestrationResult, TaskProgressEvent } from './task-types';

export type RunTaskAgentInput = {
  messages: ModelMessage[];
  onProgress?: (event: TaskProgressEvent) => Promise<void> | void;
};

export async function runTaskAgent(
  input: RunTaskAgentInput,
): Promise<TaskOrchestrationResult> {
  const { messages, onProgress } = input;

  return runTaskOrchestration({
    messages,
    onProgress,
    executeStep: executeTaskStepWithAgentLoop,
    synthesizeAnswer: synthesizeTaskResult,
  });
}
