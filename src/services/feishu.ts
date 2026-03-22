import { config } from "@/config";
import { FeishuEventPayload, FeishuUrlVerification, FeishuWebhookPayload, TenantAccessTokenResponse } from "@/types/feishu";


type CachedToken = {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

async function feishuRequest<T>(
  path: string,
  init: RequestInit,
  accessToken?: string
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  if (accessToken) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }

  const response = await fetch(`${FEISHU_API_BASE}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Feishu API request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }

  // 	https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");

  const data = await feishuRequest<TenantAccessTokenResponse>(`/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    })
  });

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant access token: ${data.msg}`);
  }

  cachedToken = {
    value: data.tenant_access_token,
    expiresAt: now + (data.expire - 60) * 1000, // 提前1分钟过期
  };

  return cachedToken.value;
}

export function extractTextContent(content: string): string {
  const prop = JSON.parse(content) as {text?: string};
  return prop.text?.trim() || "";
}

export function isResetCommand(content: string): boolean {
  return content.trim() === "/reset" || content.trim() === "重置会话";
}

export function isSummaryDebugCommand(content: string): boolean {
  const value = content.trim().toLowerCase();
  return value === '#summary' || value === '/summary';
}

export function isMemoryDebugCommand(content: string): boolean {
  const value = content.trim().toLowerCase();
  return value === '#memory' || value === '/memory';
}

export async function sendTextMessage(
  chatId: string,
  text: string,
) {
  const tenantAccessToken = await getTenantAccessToken();
  
  await feishuRequest(`/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${tenantAccessToken}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text })
    })
  });
}

export function isFeishuUrlVerification(payload: unknown): payload is FeishuUrlVerification {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const value = payload as Record<string, unknown>;
  return (
    value.type === "url_verification" &&
    typeof value.challenge === "string"
  );
}

export function verifyWebhookToken(token?: string): boolean {
  return !!token && token === config.feishu.verificationToken;
}

export function verifyEncryptKey(payload: unknown): payload is { encrypt: string } {
  if (!payload || typeof payload !== "object") {
    return false;
  }
   return typeof (payload as Record<string, unknown>).encrypt === "string";
}


export function isEventPayload(payload: unknown): payload is FeishuEventPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const value = payload as Record<string, unknown>;
  const header = value.header as Record<string, unknown> | undefined;
  const event = value.event as Record<string, unknown> | undefined;
  const message = event?.message as Record<string, unknown> | undefined;

  return (
    !!header &&
    typeof header.event_id === "string" &&
    typeof header.event_type === "string" &&
    !!event &&
    !!message &&
    typeof message.chat_id === "string" &&
    typeof message.content === "string" &&
    typeof message.message_id === "string" &&
    typeof message.message_type === "string"
  );
}
