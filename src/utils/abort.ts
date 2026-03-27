type CreateChildAbortSignalOptions = {
  parentSignal?: AbortSignal;
  timeoutMs?: number;
  timeoutReason?: string;
};

export type AbortSignalController = {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  dispose: () => void;
};

function abortWithReason(controller: AbortController, reason?: unknown): void {
  if (controller.signal.aborted) return;
  controller.abort(reason);
}

export function createChildAbortSignal(
  options: CreateChildAbortSignalOptions = {},
): AbortSignalController {
  const { parentSignal, timeoutMs, timeoutReason } = options;
  const controller = new AbortController();

  let timeoutHandle: NodeJS.Timeout | undefined;
  let removeParentAbortListener: (() => void) | undefined;

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortWithReason(controller, parentSignal.reason);
    } else {
      const onParentAbort = () => {
        abortWithReason(controller, parentSignal.reason);
      };
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
      removeParentAbortListener = () => {
        parentSignal.removeEventListener('abort', onParentAbort);
      };
    }
  }

  if ((timeoutMs ?? 0) > 0 && !controller.signal.aborted) {
    timeoutHandle = setTimeout(() => {
      abortWithReason(
        controller,
        new Error(timeoutReason ?? `Operation timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    abort(reason?: unknown) {
      abortWithReason(controller, reason);
    },
    dispose() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      removeParentAbortListener?.();
    },
  };
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError';
}

export function getAbortReasonMessage(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }

  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }

  return 'Operation aborted';
}
