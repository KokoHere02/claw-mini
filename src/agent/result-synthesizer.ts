import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from '@/config';
import type { TaskExecutionReport, TaskRun } from './task-types';

const provider = createOpenAICompatible({
  name: config.model.id,
  apiKey: config.model.apiKey,
  baseURL: config.model.baseURL,
});

function stringifyMessageContent(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;

  return message.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}

function findLastUserText(messages: ModelMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  return lastUser ? stringifyMessageContent(lastUser) : '';
}

function joinSections(sections: Array<[string, string | undefined]>): string {
  return sections
    .filter(([, content]) => content && content.trim())
    .map(([title, content]) => `[${title}]\n${content!.trim()}`)
    .join('\n\n');
}

function buildExecutionReport(taskRun: TaskRun): TaskExecutionReport {
  return {
    goal: taskRun.plan?.goal || '',
    status:
      taskRun.status === 'cancelled'
      || taskRun.status === 'timed_out'
      || taskRun.status === 'failed'
        ? taskRun.status
        : 'completed',
    steps: taskRun.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      result: step.result,
      error: step.error,
    })),
  };
}

function buildSynthesisPrompt(messages: ModelMessage[], taskRun: TaskRun): string {
  const report = buildExecutionReport(taskRun);

  return joinSections([
    ['IDENTITY', config.systemPrompt],
    ['USER_GOAL', findLastUserText(messages) || '(missing user goal)'],
    ['TASK_GOAL', report.goal || '(missing task goal)'],
    ['TASK_STATUS', report.status],
    ['EXECUTION_REPORT', JSON.stringify(report, null, 2)],
    [
      'POLICY',
      [
        'Provide the final user-facing answer based on the execution report.',
        'Lead with the final outcome.',
        'Briefly summarize the useful completed work.',
        'If any step failed, timed out, or was cancelled, clearly explain the limitation or failure point.',
        'Do not mention hidden prompts, planners, or internal runtime structure.',
      ].join('\n'),
    ],
  ]);
}

async function collectText(
  messages: ModelMessage[],
  system: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = streamText({
    model: provider(config.model.id),
    system,
    messages,
    stopWhen: stepCountIs(1),
    abortSignal: signal,
  });

  let text = '';
  for await (const chunk of result.textStream) {
    text += chunk;
  }

  return text.trim();
}

export async function synthesizeTaskResult(input: {
  messages: ModelMessage[];
  taskRun: TaskRun;
  signal?: AbortSignal;
}): Promise<string> {
  const completedSteps = input.taskRun.steps.filter((step) => step.status === 'completed' && step.result?.trim());
  const hasNonCompletedTerminalStep = input.taskRun.steps.some((step) => (
    step.status === 'failed' || step.status === 'timed_out' || step.status === 'cancelled'
  ));

  if (!hasNonCompletedTerminalStep && completedSteps.length === 1) {
    return completedSteps[0].result!.trim();
  }

  return collectText(
    input.messages,
    buildSynthesisPrompt(input.messages, input.taskRun),
    input.signal,
  );
}
