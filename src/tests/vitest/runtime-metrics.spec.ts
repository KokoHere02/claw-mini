import { beforeEach, describe, expect, it } from 'vitest';
import { runtimeMetrics } from '@/services/runtime-metrics';

describe('runtimeMetrics', () => {
  beforeEach(() => {
    runtimeMetrics.reset();
  });

  it('should aggregate recent terminal task status distribution with limit', () => {
    runtimeMetrics.recordTaskTerminalStatus('completed');
    runtimeMetrics.recordTaskTerminalStatus('failed');
    runtimeMetrics.recordTaskTerminalStatus('completed');

    const distribution = runtimeMetrics.getRecentTaskStatusDistribution(2);
    expect(distribution).toEqual({
      total: 2,
      completed: 1,
      cancelled: 0,
      timed_out: 0,
      failed: 1,
    });
  });

  it('snapshot should include recent task status distribution', () => {
    runtimeMetrics.recordTaskTerminalStatus('cancelled');
    runtimeMetrics.recordTaskTerminalStatus('timed_out');
    runtimeMetrics.recordTaskTerminalStatus('completed');

    const snapshot = runtimeMetrics.snapshot();
    expect(snapshot.recentTaskStatus).toEqual({
      total: 3,
      completed: 1,
      cancelled: 1,
      timed_out: 1,
      failed: 0,
    });
  });

  it('should normalize invalid limit to 1', () => {
    runtimeMetrics.recordTaskTerminalStatus('failed');
    runtimeMetrics.recordTaskTerminalStatus('completed');

    const distribution = runtimeMetrics.getRecentTaskStatusDistribution(0);
    expect(distribution).toEqual({
      total: 1,
      completed: 1,
      cancelled: 0,
      timed_out: 0,
      failed: 0,
    });
  });

  it('should keep only the latest 500 terminal statuses', () => {
    for (let i = 0; i < 550; i += 1) {
      runtimeMetrics.recordTaskTerminalStatus(i % 2 === 0 ? 'completed' : 'failed');
    }

    const distribution = runtimeMetrics.getRecentTaskStatusDistribution(1000);
    expect(distribution.total).toBe(500);
    expect(distribution.completed).toBe(250);
    expect(distribution.failed).toBe(250);
    expect(distribution.cancelled).toBe(0);
    expect(distribution.timed_out).toBe(0);
  });
});
