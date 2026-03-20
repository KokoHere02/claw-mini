import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import { config } from '@/config';
import { isEventPayload } from '@/services/feishu';
import { handleMessage } from '@/services/handle-message';

// ---- Protobuf schema (mirrors pbbp2.Frame from the SDK) ----
const pbRoot = protobuf.Root.fromJSON({
  nested: {
    pbbp2: {
      nested: {
        Header: {
          fields: {
            key:   { id: 1, type: 'string' },
            value: { id: 2, type: 'string' },
          },
        },
        Frame: {
          fields: {
            SeqID:           { id: 1,  type: 'uint64' },
            LogID:           { id: 2,  type: 'uint64' },
            service:         { id: 3,  type: 'int32'  },
            method:          { id: 4,  type: 'int32'  },
            headers:         { id: 5,  type: 'pbbp2.Header', rule: 'repeated' },
            payloadEncoding: { id: 6,  type: 'string' },
            payloadType:     { id: 7,  type: 'string' },
            payload:         { id: 8,  type: 'bytes'  },
            LogIDNew:        { id: 9,  type: 'string' },
          },
        },
      },
    },
  },
});

const FrameType = pbRoot.lookupType('pbbp2.Frame');

function encodeFrame(frame: object): Buffer {
  const msg = FrameType.create(frame);
  return Buffer.from(FrameType.encode(msg).finish());
}

function decodeFrame(buf: Buffer) {
  return FrameType.decode(buf) as any;
}

// ---- Constants ----
const ENDPOINT_URL = `${config.feishu.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'}/callback/ws/endpoint`;

const FrameMethod = { control: 0, data: 1 };
const MsgType    = { ping: 'ping', pong: 'pong', event: 'event' };

// ---- Chunked message reassembly ----
const chunkCache = new Map<string, { buf: (Uint8Array | undefined)[], traceId: string, ts: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, v] of chunkCache) {
    if (now - v.ts > 10_000) chunkCache.delete(id);
  }
}, 10_000);

function mergeChunks(messageId: string, sum: number, seq: number, traceId: string, data: Uint8Array): object | null {
  let entry = chunkCache.get(messageId);
  if (!entry) {
    entry = { buf: new Array(sum).fill(undefined), traceId, ts: Date.now() };
    chunkCache.set(messageId, entry);
  }
  entry.buf[seq] = data;
  if (entry.buf.every(Boolean)) {
    const merged = Buffer.concat(entry.buf as Uint8Array[]);
    chunkCache.delete(messageId);
    return JSON.parse(merged.toString('utf-8'));
  }
  return null;
}

// ---- Main client ----
let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let serviceId = 0;
let pingInterval = 120_000;

async function getConnectConfig(): Promise<{ url: string; serviceId: number; pingInterval: number }> {
  const res = await fetch(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', locale: 'zh' },
    body: JSON.stringify({ AppID: config.feishu.appId, AppSecret: config.feishu.appSecret }),
  });
  const json = await res.json() as any;
  if (json.code !== 0) throw new Error(`get ws endpoint failed: ${json.msg}`);

  const urlObj = new URL(json.data.URL);
  return {
    url: json.data.URL,
    serviceId: Number(urlObj.searchParams.get('service_id') ?? 0),
    pingInterval: (json.data.ClientConfig?.PingInterval ?? 120) * 1000,
  };
}

function sendFrame(frame: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(encodeFrame(frame));
  }
}

function sendPing() {
  sendFrame({
    SeqID: 0, LogID: 0,
    service: serviceId,
    method: FrameMethod.control,
    headers: [{ key: 'type', value: MsgType.ping }],
  });
}

function startPing() {
  if (pingTimer) clearTimeout(pingTimer);
  pingTimer = setTimeout(function loop() {
    sendPing();
    pingTimer = setTimeout(loop, pingInterval);
  }, pingInterval);
}

function handleEvent(frame: any) {
  const headers: Record<string, string> = {};
  for (const h of frame.headers) headers[h.key] = h.value;

  const { type, message_id, sum, seq, trace_id } = headers;
  if (type !== MsgType.event) return;

  const merged = mergeChunks(message_id, Number(sum), Number(seq), trace_id, frame.payload);
  if (!merged) return;

  if (isEventPayload(merged)) {
    handleMessage(merged).catch(console.error);
  } else {
    console.warn('[ws] received unknown event shape:', JSON.stringify(merged));
  }

  // ack
  sendFrame({
    ...frame,
    headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
    payload: Buffer.from(JSON.stringify({ code: 200 })),
  });
}

function handleControl(frame: any) {
  const type = frame.headers.find((h: any) => h.key === 'type')?.value;
  if (type === MsgType.pong && frame.payload?.length) {
    const cfg = JSON.parse(Buffer.from(frame.payload).toString('utf-8'));
    if (cfg.PingInterval) pingInterval = cfg.PingInterval * 1000;
  }
}

export async function connect() {
  try {
    const cfg = await getConnectConfig();
    serviceId = cfg.serviceId;
    pingInterval = cfg.pingInterval;

    ws = new WebSocket(cfg.url);
    ws.on('open', () => {
      console.log('[ws] connected');
      startPing();
    });

    ws.on('message', (buf: Buffer) => {
      const frame = decodeFrame(buf);
      if (frame.method === FrameMethod.control) handleControl(frame);
      else if (frame.method === FrameMethod.data) handleEvent(frame);
    });

    ws.on('close', () => {
      console.log('[ws] closed, reconnecting...');
      if (pingTimer) clearTimeout(pingTimer);
      scheduleReconnect();
    });

    ws.on('error', (e) => {
      console.error('[ws] error:', e.message);
    });
  } catch (e: any) {
    console.error('[ws] connect failed:', e.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5_000);
}