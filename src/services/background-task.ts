import logger from '@/utils/logger';

type BackgroundTask = () => Promise<void> | void;

export function runBackgroundTask(task: BackgroundTask, label = 'background task'): void {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        logger.warn({ err: error, label }, 'background task failed');
      });
  });
}
