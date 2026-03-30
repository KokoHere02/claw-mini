import { config } from '@/config';
import type {
  FeishuEventPayload,
  FeishuUrlVerification,
  FeishuWebhookPayload,
  TenantAccessTokenResponse,
} from '@/types/feishu';

type CachedToken = {
  value: string;
  expiresAt: number;
};

let cachedToken: CachedToken | null = null;

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

async function feishuRequest<T>(
  path: string,
  init: RequestInit,
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');

  if (accessToken) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(`${FEISHU_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Feishu API request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

async function feishuBinaryRequest(
  path: string,
  init: RequestInit,
  accessToken?: string,
): Promise<{ data: Uint8Array; mediaType?: string }> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');

  if (accessToken) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(`${FEISHU_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Feishu API request failed (${response.status}): ${body}`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  const mediaType = response.headers.get('content-type') || undefined;
  return { data, mediaType };
}

async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }

  const data = await feishuRequest<TenantAccessTokenResponse>('/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant access token: ${data.msg}`);
  }

  cachedToken = {
    value: data.tenant_access_token,
    expiresAt: now + (data.expire - 60) * 1000,
  };

  return cachedToken.value;
}

export function extractTextContent(content: string): string {
  const prop = JSON.parse(content) as { text?: string };
  return prop.text?.trim() || '';
}

export function isResetCommand(content: string): boolean {
  const value = content.trim();
  return value === '/reset' || value === '重置会话';
}

export function isSummaryDebugCommand(content: string): boolean {
  const value = content.trim().toLowerCase();
  return value === '#summary' || value === '/summary';
}

export function isMemoryDebugCommand(content: string): boolean {
  const value = content.trim().toLowerCase();
  return value === '#memory' || value === '/memory';
}

export function isMetricsDebugCommand(content: string): boolean {
  const value = content.trim().toLowerCase();
  return value === '#metrics' || value === '/metrics';
}

export async function downloadMessageImage(
  messageId: string,
  imageKey: string,
): Promise<{ data: Uint8Array; mediaType?: string }> {
  const tenantAccessToken = await getTenantAccessToken();
  return feishuBinaryRequest(
    `/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tenantAccessToken}`,
      },
    },
  );
}

export async function downloadMessageFile(
  messageId: string,
  fileKey: string,
): Promise<{ data: Uint8Array; mediaType?: string }> {
  const tenantAccessToken = await getTenantAccessToken();

  return feishuBinaryRequest(
    `/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tenantAccessToken}`,
      },
    },
  );
}

export async function sendTextMessage(chatId: string, text: string): Promise<void> {
  const tenantAccessToken = await getTenantAccessToken();

  await feishuRequest('/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tenantAccessToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
}

export function isFeishuUrlVerification(payload: unknown): payload is FeishuUrlVerification {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const value = payload as Record<string, unknown>;
  return value.type === 'url_verification' && typeof value.challenge === 'string';
}

export function verifyWebhookToken(token?: string): boolean {
  return !!token && token === config.feishu.verificationToken;
}

export function verifyEncryptKey(payload: unknown): payload is { encrypt: string } {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  return typeof (payload as Record<string, unknown>).encrypt === 'string';
}

export function isEventPayload(payload: unknown): payload is FeishuEventPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const value = payload as Record<string, unknown>;
  const header = value.header as Record<string, unknown> | undefined;
  const event = value.event as Record<string, unknown> | undefined;
  const message = event?.message as Record<string, unknown> | undefined;

  return (
    !!header &&
    typeof header.event_id === 'string' &&
    typeof header.event_type === 'string' &&
    !!event &&
    !!message &&
    typeof message.chat_id === 'string' &&
    typeof message.content === 'string' &&
    typeof message.message_id === 'string' &&
    typeof message.message_type === 'string'
  );
}


