import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

dotenv.config({
  path: ".env.local"
});

type FeishuConnectionMode = "long-connection" | "webhook";
type FeishuDomain = "feishu" | "lark";

export type AppConfig = {
  host: string;
  port: number;
  systemPrompt: string;
  sessionMaxTurns: number;
  eventDedupeTtlMs: number;
  memory: {
    summaryTriggerMessageCount: number;
    summaryKeepRecentMessageCount: number;
    summaryPrompt?: string;
    summaryPromptFile?: string;
    storageDir: string;
    ttlDays: number;
  };
  agent: {
    maxSteps: number;
    plannerPrompt?: string;
    plannerPromptFile?: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    connectionMode: FeishuConnectionMode;
    domain: FeishuDomain;
    encryptKey?: string;
  };
  model: {
    id: string;
    apiKey: string;
    baseURL: string;
  };
}

function getStrEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable not found: ${name}`);
  }
  return value;
}

function getIntEnv(name: string, defaultValue?: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable not found: ${name}`);
  }
  const intValue = parseInt(value, 10);
  if (isNaN(intValue)) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable ${name} is not a valid integer: ${value}`);
  }

  return intValue;
}

function getOptionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function getOptionalFileContent(name: string): { file?: string; content?: string } {
  const rawPath = process.env[name]?.trim();
  if (!rawPath) return {};

  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  const content = fs.readFileSync(resolvedPath, 'utf8').trim();
  return { file: resolvedPath, content: content || undefined };
}

function getFileContentOrThrow(filePath: string): { file: string; content: string } {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const content = fs.readFileSync(resolvedPath, 'utf8').trim();
  if (!content) {
    throw new Error(`File is empty: ${resolvedPath}`);
  }

  return { file: resolvedPath, content };
}

const defaultAgentPlannerPromptFile = getFileContentOrThrow('prompts/agent-planner.default.txt');
const agentPlannerPromptOverride = getOptionalFileContent('AGENT_PLANNER_PROMPT_FILE');
const defaultSystemPromptFile = getFileContentOrThrow('prompts/system.default.txt');
const systemPromptOverride = getOptionalFileContent('SYSTEM_PROMPT_FILE');
const defaultMemorySummaryPromptFile = getFileContentOrThrow('prompts/memory-summary.default.txt');
const memorySummaryPromptOverride = getOptionalFileContent('MEMORY_SUMMARY_PROMPT_FILE');

function getEnumEnv<T extends string>(name: string, allowedValues: T[], defaultValue?: T): T {
  const value = process.env[name]?.trim() as T | undefined;
  if (value && allowedValues.includes(value)) {
    return value;
  }
  if (defaultValue) {
    return defaultValue;
  }
  throw new Error(`Environment variable ${name} must be one of: ${allowedValues.join(', ')}`);
}

export const config: AppConfig = {
  host: getStrEnv('HOST') || '0.0.0.0',
  port: getIntEnv('PORT', 3000),
  systemPrompt:
    systemPromptOverride.content
    ?? (process.env.SYSTEM_PROMPT?.trim() || undefined)
    ?? defaultSystemPromptFile.content,
  sessionMaxTurns: getIntEnv('SESSION_MAX_TURNS', 20),
  eventDedupeTtlMs: getIntEnv('EXPIRATION_TIME', 10 * 60 * 1000),
  memory: {
    summaryTriggerMessageCount: getIntEnv('MEMORY_SUMMARY_TRIGGER_MESSAGE_COUNT', 10),
    summaryKeepRecentMessageCount: getIntEnv('MEMORY_SUMMARY_KEEP_RECENT_MESSAGE_COUNT', 6),
    summaryPromptFile: memorySummaryPromptOverride.file ?? defaultMemorySummaryPromptFile.file,
    summaryPrompt:
      memorySummaryPromptOverride.content
      ?? (process.env.MEMORY_SUMMARY_PROMPT?.trim() || undefined)
      ?? defaultMemorySummaryPromptFile.content,
    storageDir: getOptionalEnv('MEMORY_STORAGE_DIR', path.join(os.homedir(), '.claw-mini', 'memory')),
    ttlDays: getIntEnv('MEMORY_TTL_DAYS', 30),
  },
  agent: {
    maxSteps: getIntEnv('AGENT_MAX_STEPS', 6),
    plannerPromptFile: agentPlannerPromptOverride.file ?? defaultAgentPlannerPromptFile.file,
    plannerPrompt:
      agentPlannerPromptOverride.content
      ?? (process.env.AGENT_PLANNER_PROMPT?.trim() || undefined)
      ?? defaultAgentPlannerPromptFile.content,
  },
  feishu: {
    appId: getStrEnv('FEISHU_APP_ID'),
    appSecret: getStrEnv('FEISHU_APP_SECRET'),
    verificationToken: getOptionalEnv('FEISHU_VERIFICATION_TOKEN',''),
    encryptKey: getOptionalEnv('FEISHU_ENCRYPT_KEY', ''),
    connectionMode: (getEnumEnv('FEISHU_CONNECTION_MODE', ['long-connection', 'webhook'] as const, 'webhook')),
    domain: (getEnumEnv('FEISHU_DOMAIN', ['feishu', 'lark'] as const, 'feishu')),
  },
  model: {
    id: getStrEnv('MODEL_ID'),
    apiKey: getStrEnv('MODEL_API_KEY'),
    baseURL: getOptionalEnv('MODEL_BASE_URL', 'https://api.openai.com/v1'),
  }

}
