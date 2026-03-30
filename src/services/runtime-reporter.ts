import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@/config';
import logger from '@/utils/logger';
import type { MetricsSnapshot } from './runtime-metrics';
import { runtimeMetrics } from './runtime-metrics';

const DAILY_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RECENT_STATUS_WINDOW = 50;
const HASH_LENGTH = 10;
const SNAPSHOT_FILE = path.join(config.memory.storageDir, 'runtime-report-snapshot.json');

let lastReportSnapshot: MetricsSnapshot | null = null;
let persistedSnapshotLoaded = false;

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, HASH_LENGTH);
}

function getStrategyFingerprint() {
  return {
    modelId: config.model.id,
    systemPromptHash: shortHash(config.systemPrompt),
    plannerPromptHash: shortHash(config.agent.plannerPrompt ?? ''),
    memorySummaryPromptHash: shortHash(config.memory.summaryPrompt ?? ''),
  };
}

function buildCounterDelta(current: MetricsSnapshot, previous: MetricsSnapshot | null): Record<string, number> {
  if (!previous) return {};

  const names = new Set([...Object.keys(current.counters), ...Object.keys(previous.counters)]);
  const delta: Record<string, number> = {};

  for (const name of names) {
    const currentValue = current.counters[name] ?? 0;
    const previousValue = previous.counters[name] ?? 0;
    delta[name] = currentValue - previousValue;
  }

  return Object.fromEntries(Object.entries(delta).sort(([a], [b]) => a.localeCompare(b)));
}

function buildDurationDelta(current: MetricsSnapshot, previous: MetricsSnapshot | null): Record<string, {
  countDelta: number;
  sumDelta: number;
  avgDelta: number;
}> {
  if (!previous) return {};

  const names = new Set([...Object.keys(current.durations), ...Object.keys(previous.durations)]);
  const delta: Record<string, {
    countDelta: number;
    sumDelta: number;
    avgDelta: number;
  }> = {};

  for (const name of names) {
    const currentStats = current.durations[name];
    const previousStats = previous.durations[name];
    const countDelta = (currentStats?.count ?? 0) - (previousStats?.count ?? 0);
    const sumDelta = Number((((currentStats?.sum ?? 0) - (previousStats?.sum ?? 0))).toFixed(2));
    const avgDelta = countDelta > 0 ? Number((sumDelta / countDelta).toFixed(2)) : 0;
    delta[name] = { countDelta, sumDelta, avgDelta };
  }

  return Object.fromEntries(Object.entries(delta).sort(([a], [b]) => a.localeCompare(b)));
}

function loadPersistedSnapshot(): MetricsSnapshot | null {
  if (persistedSnapshotLoaded) return lastReportSnapshot;
  persistedSnapshotLoaded = true;

  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return null;
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { snapshot?: MetricsSnapshot };
    if (!parsed.snapshot) return null;
    return parsed.snapshot;
  } catch (error) {
    logger.warn({ err: error, snapshotFile: SNAPSHOT_FILE }, '[runtime] persisted_snapshot_load_failed');
    return null;
  }
}

function savePersistedSnapshot(snapshot: MetricsSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(
      SNAPSHOT_FILE,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          snapshot,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    logger.warn({ err: error, snapshotFile: SNAPSHOT_FILE }, '[runtime] persisted_snapshot_save_failed');
  }
}

function createRuntimeReportPayload() {
  const snapshot = runtimeMetrics.snapshot();
  const previousSnapshot = lastReportSnapshot ?? loadPersistedSnapshot();
  const previousSource =
    lastReportSnapshot ? 'in_memory' : previousSnapshot ? 'persisted' : 'none';

  lastReportSnapshot = snapshot;
  savePersistedSnapshot(snapshot);

  return {
    timestamp: new Date().toISOString(),
    uptimeMs: Math.floor(process.uptime() * 1000),
    deltaBaseline: previousSource,
    snapshotFile: SNAPSHOT_FILE,
    strategyFingerprint: getStrategyFingerprint(),
    counters: snapshot.counters,
    countersDeltaSinceLastReport: buildCounterDelta(snapshot, previousSnapshot),
    durations: snapshot.durations,
    durationsDeltaSinceLastReport: buildDurationDelta(snapshot, previousSnapshot),
    recentTaskStatus: runtimeMetrics.getRecentTaskStatusDistribution(RECENT_STATUS_WINDOW),
  };
}

export function emitStartupRuntimeReport(): void {
  logger.info(createRuntimeReportPayload(), '[runtime] startup_report');
}

export function scheduleDailyRuntimeReport(): NodeJS.Timeout {
  const timer = setInterval(() => {
    logger.info(createRuntimeReportPayload(), '[runtime] daily_report');
  }, DAILY_REPORT_INTERVAL_MS);

  timer.unref();
  return timer;
}
