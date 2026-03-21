import type { ToolDefinition, ToolParameters } from './tool-types';

const DEFAULT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isPlainJsonValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isPlainJsonValue);
  }

  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isPlainJsonValue);
  }

  return false;
}

export class ToolRunner {
  validateParams(
    definitions: ToolParameters,
    params: Record<string, unknown>,
  ): { ok: boolean; reason?: string } {
    for (const [name, meta] of Object.entries(definitions)) {
      const value = params[name];

      if (value == null) {
        if (!meta.optional) return { ok: false, reason: `Missing required parameter "${name}"` };
        continue;
      }

      if (meta.type === 'string' && typeof value !== 'string') {
        return { ok: false, reason: `Parameter "${name}" must be a string` };
      }

      if (meta.type === 'number' && typeof value !== 'number') {
        return { ok: false, reason: `Parameter "${name}" must be a number` };
      }

      if (meta.type === 'boolean' && typeof value !== 'boolean') {
        return { ok: false, reason: `Parameter "${name}" must be a boolean` };
      }
    }

    return { ok: true };
  }

  async run(tool: ToolDefinition, params: Record<string, unknown>): Promise<unknown> {
    const validation = this.validateParams(tool.parameters, params);
    if (!validation.ok) {
      throw new Error(`Invalid tool input: ${validation.reason}`);
    }

    const timeoutMs = tool.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const result = await withTimeout(tool.execute({ ...params }), timeoutMs);

    if (!isPlainJsonValue(result)) {
      throw new Error(`Tool "${tool.name}" returned a non-serializable result`);
    }

    return result;
  }
}

export const runner = new ToolRunner();
