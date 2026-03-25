import type { ModelMessage } from 'ai';
import { runAgent } from './index';
import type { ExecuteTaskStepInput, ExecuteTaskStepResult } from './task-orchestrator';

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

export async function executeTaskStepWithAgentLoop(
  input: ExecuteTaskStepInput,
): Promise<ExecuteTaskStepResult> {
  const messages = buildStepExecutionMessages(input);
  const result = await runAgent(messages);

  return {
    result: result.trim(),
  };
}
