import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import { config } from '@/config';
import { isEventPayload } from '@/services/feishu';
import { handleMessage } from '@/services/message-handler';
import logger from '@/utils/logger';
import type { Adapter } from './types';

const pbRoot = protobuf.Root.fromJSON({
  nested: {
    pbbp2: {
      nested: {
        Header: {
          fields: {
            key: { id: 1, type: 'string' },
            value: { id: 2, type: 'string' },
          },
        },
        Frame: {
          fields: {
            SeqID: { id: 1, type: 'uint64' },
            LogID: { id: 2, type: 'uint64' },
            service: { id: 3, type: 'int32' },
            method: { id: 4, type: 'int32' },
            headers: { id: 5, type: 'pbbp2.Header', rule: 'repeated' },
            payloadEncoding: { id: 6, type: 'string' },
            payloadType: { id: 7, type: 'string' },
            payload: { id: 8, type: 'bytes' },
            LogIDNew: { id: 9, type: 'string' },
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

  private chunkCache = new Map<string, { buf: (Uint8Array | undefined)[]; ts: number }>();

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

  private clearExpiredChunks(): void {
    const now = Date.now();
    for (const [id, value] of this.chunkCache) {
      if (now - value.ts > 10_000) this.chunkCache.delete(id);
    }
  }

  private async getConnectConfig(): Promise<{ url: string; serviceId: number; pingInterval: number }> {
    const res = await fetch(ENDPOINT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', locale: 'zh' },
      body: JSON.stringify({ AppID: config.feishu.appId, AppSecret: config.feishu.appSecret }),
    });
    const json = (await res.json()) as {
      code: number;
      msg?: string;
      data: {
        URL: string;
        ClientConfig?: { PingInterval?: number };
      };
    };
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

  private sendFrame(frame: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.encodeFrame(frame));
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    const loop = () => {
      this.sendFrame({
        SeqID: 0,
        LogID: 0,
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

  private handleControl(frame: { headers: Array<{ key: string; value: string }>; payload?: Uint8Array }): void {
    const type = frame.headers.find((h) => h.key === 'type')?.value;
    if (type === MsgType.pong && frame.payload?.length) {
      const cfg = JSON.parse(Buffer.from(frame.payload).toString('utf-8')) as { PingInterval?: number };
      if (cfg.PingInterval) this.pingInterval = cfg.PingInterval * 1000;
    }
  }

  private handleEvent(frame: {
    headers: Array<{ key: string; value: string }>;
    payload: Uint8Array;
    [key: string]: unknown;
  }): void {
    const headers: Record<string, string> = {};
    for (const h of frame.headers) headers[h.key] = h.value;
    const { type, message_id, sum, seq } = headers;
    if (type !== MsgType.event) return;

    const merged = this.mergeChunks(message_id, Number(sum), Number(seq), frame.payload);
    if (!merged) return;

    if (isEventPayload(merged)) {
      handleMessage(merged).catch((error) => {
        logger.error({ err: error }, '[ws] handle_message_failed');
      });
    } else {
      logger.warn({ payload: merged }, '[ws] unknown_event_shape');
    }

    this.sendFrame({
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
      payload: Buffer.from(JSON.stringify({ code: 200 })),
    });
  }

  private async connect(): Promise<void> {
    try {
      const cfg = await this.getConnectConfig();
      this.serviceId = cfg.serviceId;
      this.pingInterval = cfg.pingInterval;

      this.ws = new WebSocket(cfg.url);

      this.ws.on('open', () => {
        logger.info('[ws] connected');
        this.startPing();
      });

      this.ws.on('message', (buf: Buffer) => {
        const frame = FrameType.decode(buf) as {
          method: number;
          headers: Array<{ key: string; value: string }>;
          payload: Uint8Array;
          [key: string]: unknown;
        };
        if (frame.method === FrameMethod.control) this.handleControl(frame);
        else if (frame.method === FrameMethod.data) this.handleEvent(frame);
      });

      this.ws.on('close', () => {
        logger.info('[ws] closed_reconnecting');
        if (this.pingTimer) clearTimeout(this.pingTimer);
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        logger.error({ err: error }, '[ws] connection_error');
      });
    } catch (error) {
      logger.error({ err: error }, '[ws] connect_failed');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 5_000);
  }
}
