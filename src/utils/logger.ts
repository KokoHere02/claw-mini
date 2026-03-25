import pino from 'pino';
import pretty from 'pino-pretty';

const prettyStream = process.env.NODE_ENV !== 'production'
  ? pretty({
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname',
      sync: true,
    })
  : undefined;

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
}, prettyStream);

export default logger;
