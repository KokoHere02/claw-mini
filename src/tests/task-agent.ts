import type { ModelMessage } from 'ai';
import { config } from '@/config';
import { runTaskAgent } from '@/agent/task-agent';
import type { TaskProgressEvent } from '@/agent/task-types';
import logger  from '@/utils/logger';

function buildTestMessages(userInput: string): ModelMessage[] {
  return [
    {
      role: 'user',
      content: userInput,
    },
  ];
}

function formatProgressEvent(event: TaskProgressEvent): string {
  switch (event.type) {
    case 'planned':
      return [
        '[progress] planned',
        `goal: ${event.plan.goal}`,
        ...event.plan.steps.map((step, index) => `${index + 1}. ${step.title} | ${step.goal}`),
      ].join('\n');
    case 'step_started':
      return `[progress] step_started ${event.index}/${event.total} ${event.title}`;
    case 'step_completed':
      return [
        `[progress] step_completed ${event.index}/${event.total} ${event.title}`,
        event.result,
      ].join('\n');
    case 'step_failed':
      return `[progress] step_failed ${event.index}/${event.total} ${event.title}\n${event.error}`;
    case 'completed':
      return `[progress] completed\n${event.answer}`;
    case 'failed':
      return `[progress] failed\n${event.error}`;
    default:
      return '[progress] unknown';
  }
}

async function main() {
  logger.info('中文测试');
  console.log('中文测试');
  // const cliInput = process.argv.slice(2).join(' ').trim();
  // const userInput =
  //   cliInput
  //   || 'Read the current working directory, then tell me which scripts are defined in package.json.';

  // console.log('[task-agent test] user input');
  // console.log(userInput);
  // console.log('');
  // console.log('[task-agent test] starting orchestration');
  // console.log('');

  // const result = await runTaskAgent({
  //   messages: buildTestMessages(userInput),
  //   onProgress(event) {
  //     console.log(formatProgressEvent(event));
  //     console.log('');
  //   },
  // });

  // console.log('[task-agent test] final answer');
  // console.log(result.answer);
  // console.log('');

  // console.log('[task-agent test] task run snapshot');
  // console.log(JSON.stringify(result.taskRun, null, 2));
}

main().catch((error) => {
  console.error('[task-agent test] failed');
  console.error(error);
  process.exit(1);
});
