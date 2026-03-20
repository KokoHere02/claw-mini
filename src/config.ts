import dotenv from 'dotenv';

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
  const value = getStrEnv(name);
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
  systemPrompt: getStrEnv('SYSTEM_PROMPT'),
  sessionMaxTurns: getIntEnv('SESSION_MAX_TURNS', 20),
  eventDedupeTtlMs: getIntEnv('EXPIRATION_TIME', 10 * 60 * 1000),
  feishu: {
    appId: getStrEnv('FEISHU_APP_ID'),
    appSecret: getStrEnv('FEISHU_APP_SECRET'),
    verificationToken: getOptionalEnv('FEISHU_VERIFICATION_TOKEN',''),
    encryptKey: getOptionalEnv('FEISHU_ENCRYPT_KEY', ''),
    // apiBaseUrl: getOptionalEnv('FEISHU_API_BASE_URL', 'https://open.feishu.cn/open-apis'),
    connectionMode: (getEnumEnv('FEISHU_CONNECTION_MODE', ['long-connection', 'webhook'] as const, 'webhook')),
    domain: (getEnumEnv('FEISHU_DOMAIN', ['feishu', 'lark'] as const, 'feishu')),
  },
  model: {
    id: getStrEnv('MODEL_ID'),
    apiKey: getStrEnv('MODEL_API_KEY'),
    baseURL: getOptionalEnv('MODEL_BASE_URL', 'https://api.openai.com/v1'),
  }

}