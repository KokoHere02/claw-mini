import { describe, expect, it, vi } from 'vitest';
import { createChildAbortSignal, getAbortReasonMessage, isAbortError } from '@/utils/abort';

describe('abort utils', () => {
  it('child signal should abort when parent aborts', () => {
    const parent = new AbortController();
    const child = createChildAbortSignal({ parentSignal: parent.signal });

    parent.abort('parent cancelled');

    expect(child.signal.aborted).toBe(true);
    expect(getAbortReasonMessage(child.signal)).toBe('parent cancelled');
    child.dispose();
  });

  it('child signal should abort on timeout with custom reason', () => {
    vi.useFakeTimers();
    const child = createChildAbortSignal({
      timeoutMs: 100,
      timeoutReason: 'custom timeout reason',
    });

    vi.advanceTimersByTime(100);

    expect(child.signal.aborted).toBe(true);
    expect(getAbortReasonMessage(child.signal)).toBe('custom timeout reason');
    child.dispose();
    vi.useRealTimers();
  });

  it('dispose should clear timeout listener', () => {
    vi.useFakeTimers();
    const child = createChildAbortSignal({ timeoutMs: 100 });

    child.dispose();
    vi.advanceTimersByTime(200);

    expect(child.signal.aborted).toBe(false);
    vi.useRealTimers();
  });

  it('isAbortError should detect AbortError', () => {
    const abortError = new DOMException('aborted', 'AbortError');
    expect(isAbortError(abortError)).toBe(true);
    expect(isAbortError(new Error('normal error'))).toBe(false);
  });
});
