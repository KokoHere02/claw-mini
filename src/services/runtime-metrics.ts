type DurationStats = {
  count: number;
  sum: number;
  min: number;
  max: number;
};

type TaskTerminalStatus = 'completed' | 'cancelled' | 'timed_out' | 'failed';

type TaskStatusDistribution = {
  total: number;
  completed: number;
  cancelled: number;
  timed_out: number;
  failed: number;
};

type MetricsSnapshot = {
  counters: Record<string, number>;
  durations: Record<string, DurationStats & { avg: number }>;
  recentTaskStatus: TaskStatusDistribution;
};

class RuntimeMetrics {
  private static readonly STATUS_HISTORY_LIMIT = 500;

  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, DurationStats>();
  private readonly terminalTaskStatusHistory: TaskTerminalStatus[] = [];

  increment(name: string, value = 1): void {
    if (!Number.isFinite(value)) return;
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + value);
  }

  observeDurationMs(name: string, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;

    const current = this.durations.get(name) ?? {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
    };

    current.count += 1;
    current.sum += valueMs;
    current.min = Math.min(current.min, valueMs);
    current.max = Math.max(current.max, valueMs);
    this.durations.set(name, current);
  }

  snapshot(): MetricsSnapshot {
    const counters = Object.fromEntries(
      [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );

    const durations = Object.fromEntries(
      [...this.durations.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, stats]) => {
          const avg = stats.count > 0 ? stats.sum / stats.count : 0;
          return [
            name,
            {
              count: stats.count,
              sum: Number(stats.sum.toFixed(2)),
              min: Number(stats.min.toFixed(2)),
              max: Number(stats.max.toFixed(2)),
              avg: Number(avg.toFixed(2)),
            },
          ];
        }),
    );

    return {
      counters,
      durations,
      recentTaskStatus: this.getRecentTaskStatusDistribution(50),
    };
  }

  reset(): void {
    this.counters.clear();
    this.durations.clear();
    this.terminalTaskStatusHistory.length = 0;
  }

  recordTaskTerminalStatus(status: TaskTerminalStatus): void {
    this.terminalTaskStatusHistory.push(status);
    if (this.terminalTaskStatusHistory.length > RuntimeMetrics.STATUS_HISTORY_LIMIT) {
      this.terminalTaskStatusHistory.shift();
    }
  }

  getRecentTaskStatusDistribution(limit: number): TaskStatusDistribution {
    const safeLimit = Math.max(1, Math.floor(limit));
    const recent = this.terminalTaskStatusHistory.slice(-safeLimit);

    const distribution: TaskStatusDistribution = {
      total: recent.length,
      completed: 0,
      cancelled: 0,
      timed_out: 0,
      failed: 0,
    };

    for (const status of recent) {
      distribution[status] += 1;
    }

    return distribution;
  }
}

export const runtimeMetrics = new RuntimeMetrics();

export type { MetricsSnapshot, TaskStatusDistribution, TaskTerminalStatus };
