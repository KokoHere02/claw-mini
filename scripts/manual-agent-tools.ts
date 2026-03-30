import assert from 'node:assert/strict';
import { runCommandTool } from '@/agent/tools/run-command';
import { calculateExpressionTool } from '@/agent/tools/calculate-expression';
import { getCurrentTimeTool } from '@/agent/tools/get-current-time';

async function testRunCommandAllowsReadOnlyCommand() {
  const result = await runCommandTool.execute({ params: { command: 'Get-Location' } }) as {
    command: string;
    exitCode: number | null;
    stdout: string;
    displayText: string;
  };

  assert.equal(result.command, 'Get-Location');
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length > 0);
  assert.equal(result.displayText, result.stdout);
}

async function testRunCommandRejectsDangerousCommand() {
  await assert.rejects(
    () => runCommandTool.execute({ params: { command: 'Remove-Item test.txt' } }),
    /not allowed/i,
  );
}

async function testRunCommandRejectsUnknownReadPatterns() {
  await assert.rejects(
    () => runCommandTool.execute({ params: { command: 'Get-Process' } }),
    /prefix is not allowed/i,
  );
}

async function testCalculateExpressionDisplayText() {
  const result = await calculateExpressionTool.execute({ params: { expression: '(2 + 3) * 4' } }) as {
    result: number;
    displayText: string;
  };

  assert.equal(result.result, 20);
  assert.equal(result.displayText, '(2 + 3) * 4 = 20');
}

async function testGetCurrentTimeDisplayText() {
  const result = await getCurrentTimeTool.execute({ params: { timeZone: 'Asia/Shanghai' } }) as {
    timeZone: string;
    displayText: string;
  };

  assert.equal(result.timeZone, 'Asia/Shanghai');
  assert.match(result.displayText, /当前时间（Asia\/Shanghai）:/);
}

async function main() {
  await testRunCommandAllowsReadOnlyCommand();
  await testRunCommandRejectsDangerousCommand();
  await testRunCommandRejectsUnknownReadPatterns();
  await testCalculateExpressionDisplayText();
  await testGetCurrentTimeDisplayText();
  console.log('agent tool tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
