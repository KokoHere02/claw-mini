export interface Adapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}
