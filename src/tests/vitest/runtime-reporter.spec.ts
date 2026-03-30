import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mocked = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  default: {
    info: mocked.loggerInfo,
  },
}));

describe('runtime reporter', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    const { config } = await import('@/config');
    const snapshotFile = path.join(config.memory.storageDir, 'runtime-report-snapshot.json');
    try {
      if (fs.existsSync(snapshotFile)) {
        fs.unlinkSync(snapshotFile);
      }
    } catch {}

    const { runtimeMetrics } = await import('@/services/runtime-metrics');
    runtimeMetrics.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should emit startup report', async () => {
    const { runtimeMetrics } = await import('@/services/runtime-metrics');
    const { emitStartupRuntimeReport } = await import('@/services/runtime-reporter');

    runtimeMetrics.increment('message_received_total');
    runtimeMetrics.recordTaskTerminalStatus('completed');

    emitStartupRuntimeReport();

    expect(mocked.loggerInfo).toHaveBeenCalledTimes(1);
    expect(mocked.loggerInfo.mock.calls[0]?.[1]).toBe('[runtime] startup_report');
    expect(mocked.loggerInfo.mock.calls[0]?.[0]).toMatchObject({
      deltaBaseline: expect.any(String),
      counters: { message_received_total: 1 },
      countersDeltaSinceLastReport: expect.any(Object),
      durationsDeltaSinceLastReport: expect.any(Object),
      strategyFingerprint: {
        modelId: expect.any(String),
        systemPromptHash: expect.any(String),
        plannerPromptHash: expect.any(String),
        memorySummaryPromptHash: expect.any(String),
      },
      recentTaskStatus: {
        total: 1,
        completed: 1,
        cancelled: 0,
        timed_out: 0,
        failed: 0,
      },
    });
  });

  it('should emit daily report by interval', async () => {
    const { scheduleDailyRuntimeReport } = await import('@/services/runtime-reporter');
    const timer = scheduleDailyRuntimeReport();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(mocked.loggerInfo).toHaveBeenCalledTimes(1);
    expect(mocked.loggerInfo.mock.calls[0]?.[1]).toBe('[runtime] daily_report');
    clearInterval(timer);
  });

  it('should include counter delta from previous report', async () => {
    const { runtimeMetrics } = await import('@/services/runtime-metrics');
    const { emitStartupRuntimeReport } = await import('@/services/runtime-reporter');

    runtimeMetrics.increment('message_received_total');
    emitStartupRuntimeReport();

    runtimeMetrics.increment('message_received_total', 2);
    emitStartupRuntimeReport();

    expect(mocked.loggerInfo).toHaveBeenCalledTimes(2);
    expect(mocked.loggerInfo.mock.calls[1]?.[0]).toMatchObject({
      counters: { message_received_total: 3 },
      countersDeltaSinceLastReport: { message_received_total: 2 },
    });
  });

  it('should load persisted snapshot as baseline on startup', async () => {
    const { config } = await import('@/config');
    const snapshotFile = path.join(config.memory.storageDir, 'runtime-report-snapshot.json');
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          snapshot: {
            counters: { message_received_total: 5 },
            durations: {},
            recentTaskStatus: {
              total: 0,
              completed: 0,
              cancelled: 0,
              timed_out: 0,
              failed: 0,
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const { runtimeMetrics } = await import('@/services/runtime-metrics');
    const { emitStartupRuntimeReport } = await import('@/services/runtime-reporter');
    runtimeMetrics.increment('message_received_total', 7);

    emitStartupRuntimeReport();

    expect(mocked.loggerInfo).toHaveBeenCalledTimes(1);
    expect(mocked.loggerInfo.mock.calls[0]?.[0]).toMatchObject({
      deltaBaseline: 'persisted',
      counters: { message_received_total: 7 },
      countersDeltaSinceLastReport: { message_received_total: 2 },
    });
  });
});
