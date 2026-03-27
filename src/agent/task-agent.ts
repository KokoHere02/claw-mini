import type { ModelMessage } from 'ai';
import { synthesizeTaskResult } from './result-synthesizer';
import { executeTaskStepWithAgentLoop } from './step-executor';
import { runTaskOrchestration } from './task-orchestrator';
import type { TaskOrchestrationResult, TaskProgressEvent } from './task-types';

export type RunTaskAgentInput = {
  messages: ModelMessage[];
  onProgress?: (event: TaskProgressEvent) => Promise<void> | void;
  signal?: AbortSignal;
};

export async function runTaskAgent(
  input: RunTaskAgentInput,
): Promise<TaskOrchestrationResult> {
  const { messages, onProgress, signal } = input;

  return runTaskOrchestration({
    messages,
    signal,
    onProgress,
    executeStep: executeTaskStepWithAgentLoop,
    synthesizeAnswer: synthesizeTaskResult,
  });
}
