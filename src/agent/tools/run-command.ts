import { spawn } from 'node:child_process';
import type { ToolDefinition } from '../tool-types';

const MAX_OUTPUT_CHARS = 4000;

const DISALLOWED_PATTERNS: RegExp[] = [
  /[|;&><]/,
  /\b(?:rm|del|erase|move|mv|copy|cp|rename|ren)\b/i,
  /\b(?:set-content|add-content|out-file|sc|ac|ni|new-item|remove-item|ri)\b/i,
  /\b(?:invoke-webrequest|curl|wget|start-process|powershell|pwsh|cmd)\b/i,
  /\b(?:git\s+reset|git\s+checkout|git\s+clean|git\s+restore)\b/i,
];

const ALLOWED_PREFIXES = [
  'Get-Location',
  'Get-ChildItem',
  'Get-Content',
  'whoami',
  'hostname',
  'node -v',
  'pnpm.cmd -v',
  'git status',
  'git diff --stat',
  'npm',
];

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function isAllowedPrefix(command: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => command.startsWith(prefix));
}

function assertSafeCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  if (!command) throw new Error('Command must not be empty');

  for (const pattern of DISALLOWED_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Command is not allowed: "${command}"`);
    }
  }

  if (!isAllowedPrefix(command)) {
    throw new Error(`Command prefix is not allowed: "${command}"`);
  }

  return command;
}

function runPowershell(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Command execution aborted'));
      return;
    }

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal,
      },
    );

    let stdout = '';
    let stderr = '';
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      child.kill();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted || signal?.aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Command execution aborted'));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: 'Runs a read-only PowerShell command after safety validation. Allowed prefixes include Get-Location, Get-ChildItem, Get-Content, whoami, hostname, node -v, pnpm.cmd -v, git status, and git diff --stat.',
  readonly: true,
  parameters: {
    command: {
      type: 'string',
      description: 'A read-only PowerShell command string. Command chaining, redirection, networking, and write operations are blocked.',
    },
  },
  timeoutMs: 8000,
  execute: async ({ params, signal }) => {
    const safeCommand = assertSafeCommand(String(params.command ?? ''));
    const result = await runPowershell(safeCommand, signal);
    const stdout = truncate(result.stdout.trim(), MAX_OUTPUT_CHARS);
    const stderr = truncate(result.stderr.trim(), MAX_OUTPUT_CHARS);
    const displayText =
      result.exitCode !== 0
        ? stderr || `Command failed with exit code ${String(result.exitCode)}.`
        : stdout || '(no output)';

    return {
      command: safeCommand,
      exitCode: result.exitCode,
      stdout,
      stderr,
      displayText,
    };
  },
};
