import { describe, expect, it } from 'vitest';
import { calculateExpressionTool } from '@/agent/tools/calculate-expression';
import { getCurrentTimeTool } from '@/agent/tools/get-current-time';
import { runCommandTool } from '@/agent/tools/run-command';

describe('agent tools', () => {
  it('run_command should allow readonly command', async () => {
    const result = await runCommandTool.execute({
      params: { command: 'Get-Location' },
    }) as {
      command: string;
      exitCode: number | null;
      stdout: string;
      displayText: string;
    };

    expect(result.command).toBe('Get-Location');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.displayText).toBe(result.stdout);
  });

  it('run_command should reject dangerous command', async () => {
    await expect(
      runCommandTool.execute({
        params: { command: 'Remove-Item test.txt' },
      }),
    ).rejects.toThrow(/not allowed/i);
  });

  it('run_command should reject unknown prefix', async () => {
    await expect(
      runCommandTool.execute({
        params: { command: 'Get-Process' },
      }),
    ).rejects.toThrow(/prefix is not allowed/i);
  });

  it('calculate_expression should return display text', async () => {
    const result = await calculateExpressionTool.execute({
      params: { expression: '(2 + 3) * 4' },
    }) as {
      result: number;
      displayText: string;
    };

    expect(result.result).toBe(20);
    expect(result.displayText).toBe('(2 + 3) * 4 = 20');
  });

  it('get_current_time should include timezone in display text', async () => {
    const result = await getCurrentTimeTool.execute({
      params: { timeZone: 'Asia/Shanghai' },
    }) as {
      timeZone: string;
      displayText: string;
    };

    expect(result.timeZone).toBe('Asia/Shanghai');
    expect(result.displayText).toMatch(/当前时间（Asia\/Shanghai）:/);
  });
});
