import { spawn } from 'node:child_process';
import type { ToolDefinition } from '../tool-types';

const MAX_OUTPUT_CHARS = 4000;

type AllowedCommand = {
  args: (target?: string) => string[];
  requiresTarget?: boolean;
};

const ALLOWED_COMMANDS: Record<string, AllowedCommand> = {
  pwd: {
    args: () => ['-NoProfile', '-Command', 'Get-Location | Select-Object -ExpandProperty Path'],
  },
  ls: {
    args: (target) => [
      '-NoProfile',
      '-Command',
      target
        ? `Get-ChildItem -Force -Name -- '${target.replace(/'/g, "''")}'`
        : 'Get-ChildItem -Force -Name',
    ],
  },
  cat: {
    args: (target) => [
      '-NoProfile',
      '-Command',
      `Get-Content -- '${(target ?? '').replace(/'/g, "''")}'`,
    ],
    requiresTarget: true,
  },
  whoami: {
    args: () => ['-NoProfile', '-Command', 'whoami'],
  },
  hostname: {
    args: () => ['-NoProfile', '-Command', 'hostname'],
  },
  node_version: {
    args: () => ['-NoProfile', '-Command', 'node -v'],
  },
  pnpm_version: {
    args: () => ['-NoProfile', '-Command', 'pnpm.cmd -v'],
  },
};

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function runPowershell(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: 'Runs a small allowlisted read-only command. Supported command ids: pwd, ls, cat, whoami, hostname, node_version, pnpm_version.',
  parameters: {
    command: {
      type: 'string',
      description: 'The allowlisted command id to run: pwd, ls, cat, whoami, hostname, node_version, pnpm_version.',
    },
    target: {
      type: 'string',
      description: 'Optional path argument used by ls and required by cat.',
      optional: true,
    },
  },
  timeoutMs: 8000,
  execute: async ({ command, target }) => {
    const commandId = String(command ?? '').trim();
    const definition = ALLOWED_COMMANDS[commandId];

    if (!definition) {
      throw new Error(`Unsupported command "${commandId}"`);
    }

    const targetValue = typeof target === 'string' && target.trim() ? target.trim() : undefined;
    if (definition.requiresTarget && !targetValue) {
      throw new Error(`Command "${commandId}" requires a target`);
    }

    const result = await runPowershell(definition.args(targetValue));

    return {
      command: commandId,
      target: targetValue ?? null,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout.trim(), MAX_OUTPUT_CHARS),
      stderr: truncate(result.stderr.trim(), MAX_OUTPUT_CHARS),
    };
  },
};
