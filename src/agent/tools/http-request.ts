import dns from 'node:dns/promises';
import net from 'node:net';
import type { ToolDefinition } from '../tool-types';

const MAX_RESPONSE_CHARS = 4000;
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;

  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

function isBlockedIp(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateIPv4(address);
  if (net.isIPv6(address)) {
    return address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80');
  }
  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('HTTP request aborted');
  }
}

async function assertSafeUrl(rawUrl: string, signal?: AbortSignal): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed');
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error('Localhost addresses are not allowed');
  }

  throwIfAborted(signal);
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length) {
    throw new Error('Unable to resolve target host');
  }

  throwIfAborted(signal);
  for (const record of addresses) {
    if (isBlockedIp(record.address)) {
      throw new Error('Private or loopback network addresses are not allowed');
    }
  }

  return url;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export const httpRequestTool: ToolDefinition = {
  name: 'http_request',
  description: 'Fetches a public HTTPS URL with a safe GET request and returns a truncated response body.',
  readonly: true,
  parameters: {
    url: {
      type: 'string',
      description: 'A public HTTPS URL to fetch. Private, localhost, and non-HTTPS URLs are blocked.',
    },
  },
  timeoutMs: 8000,
  execute: async ({ params, signal }) => {
    const rawUrl = String(params.url ?? '').trim();
    if (!rawUrl) throw new Error('URL must not be empty');

    const safeUrl = await assertSafeUrl(rawUrl, signal);
    throwIfAborted(signal);
    const response = await fetch(safeUrl, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: {
        'user-agent': 'claw-mini-agent/1.0',
        accept: 'application/json,text/plain,text/html;q=0.9,*/*;q=0.8',
      },
    });

    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const truncatedBody = truncate(body, MAX_RESPONSE_CHARS);

    return {
      url: safeUrl.toString(),
      status: response.status,
      ok: response.ok,
      contentType,
      body: truncatedBody,
      displayText: `已请求 ${safeUrl.toString()}，状态码 ${response.status}。\n${truncatedBody}`,
    };
  },
};
