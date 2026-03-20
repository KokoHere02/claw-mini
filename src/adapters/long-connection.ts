import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import { config } from '@/config';
import { isEventPayload } from '@/services/feishu';
import { handleMessage } from '@/services/handle-message';
import type { Adapter } from './types';

// ---- Protobuf schema ----
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
            SeqID:           { id: 1, type: 'uint64' },
            LogID:           { id: 2, type: 'uint64' },
            service:         { id: 3, type: 'int32'  },
            method:          { id: 4, type: 'int32'  },
            headers:         { id: 5, type: 'pbbp2.Header', rule: 'repeated' },
            payloadEncoding: { id: 6, type: 'string' },
            payloadType:     { id: 7, type: 'string' },
            payload:         { id: 8, type: 'bytes'  },
            LogIDNew:        { id: 9, type: 'string' },
          },
        },
      },
    },
  },
});

const FrameType = pbRoot.lookupType('pbbp2.Frame');
const FrameMethod = { control: 0, data: 1 };
const MsgType = { ping: 'ping', pong: 'pong', event: 'event' };

const ENDPOINT_URL = `${
  config.feishu.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}/callback/ws/endpoint`;

export class LongConnectionAdapter implements Adapter {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private serviceId = 0;
  private pingInterval = 120_000;
  private stopped = false;

  // chunk cache
  private chunkCache = new Map<string, { buf: (Uint8Array | undefined)[], ts: number }>();

  async start(): Promise<void> {
    this.stopped = false;
    setInterval(() => this.clearExpiredChunks(), 10_000);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
    this.ws = null;
  }

  private clearExpiredChunks() {
    const now = Date.now();
    for (const [id, v] of this.chunkCache) {
      if (now - v.ts > 10_000) this.chunkCache.delete(id);
    }
  }

  private async getConnectConfig() {
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

  private encodeFrame(frame: object): Buffer {
    return Buffer.from(FrameType.encode(FrameType.create(frame)).finish());
  }

  private sendFrame(frame: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.encodeFrame(frame));
    }
  }

  private startPing() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    const loop = () => {
      this.sendFrame({
        SeqID: 0, LogID: 0,
        service: this.serviceId,
        method: FrameMethod.control,
        headers: [{ key: 'type', value: MsgType.ping }],
      });
      this.pingTimer = setTimeout(loop, this.pingInterval);
    };
    this.pingTimer = setTimeout(loop, this.pingInterval);
  }

  private mergeChunks(messageId: string, sum: number, seq: number, data: Uint8Array): object | null {
    let entry = this.chunkCache.get(messageId);
    if (!entry) {
      entry = { buf: new Array(sum).fill(undefined), ts: Date.now() };
      this.chunkCache.set(messageId, entry);
    }
    entry.buf[seq] = data;
    if (entry.buf.every(Boolean)) {
      const merged = Buffer.concat(entry.buf as Uint8Array[]);
      this.chunkCache.delete(messageId);
      return JSON.parse(merged.toString('utf-8'));
    }
    return null;
  }

  private handleControl(frame: any) {
    const type = frame.headers.find((h: any) => h.key === 'type')?.value;
    if (type === MsgType.pong && frame.payload?.length) {
      const cfg = JSON.parse(Buffer.from(frame.payload).toString('utf-8'));
      if (cfg.PingInterval) this.pingInterval = cfg.PingInterval * 1000;
    }
  }

  private handleEvent(frame: any) {
    const headers: Record<string, string> = {};
    for (const h of frame.headers) headers[h.key] = h.value;
    const { type, message_id, sum, seq, trace_id } = headers;
    if (type !== MsgType.event) return;

    const merged = this.mergeChunks(message_id, Number(sum), Number(seq), frame.payload);
    if (!merged) return;

    if (isEventPayload(merged)) {
      handleMessage(merged).catch(console.error);
    } else {
      console.warn('[ws] unknown event shape:', JSON.stringify(merged));
    }

    this.sendFrame({
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
      payload: Buffer.from(JSON.stringify({ code: 200 })),
    });
  }

  private async connect() {
    try {
      const cfg = await this.getConnectConfig();
      this.serviceId = cfg.serviceId;
      this.pingInterval = cfg.pingInterval;

      this.ws = new WebSocket(cfg.url);

      this.ws.on('open', () => {
        console.log('[ws] connected');
        this.startPing();
      });

      this.ws.on('message', (buf: Buffer) => {
        const frame = FrameType.decode(buf) as any;
        if (frame.method === FrameMethod.control) this.handleControl(frame);
        else if (frame.method === FrameMethod.data) this.handleEvent(frame);
      });

      this.ws.on('close', () => {
        console.log('[ws] closed, reconnecting...');
        if (this.pingTimer) clearTimeout(this.pingTimer);
        this.scheduleReconnect();
      });

      this.ws.on('error', (e) => console.error('[ws] error:', e.message));
    } catch (e: any) {
      console.error('[ws] connect failed:', e.message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 5_000);
  }
}
