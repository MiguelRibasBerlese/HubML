import pino, { Logger } from 'pino';
import { loadEnv } from '../config/env';

// pino JSON estruturado. child loggers carregam contexto por operação (sku, orderId...).
function level(): string {
  try {
    return loadEnv().LOG_LEVEL;
  } catch {
    return 'info';
  }
}

export const logger: Logger = pino({
  level: level(),
  base: { service: 'hubml' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Logger com contexto anexado (ex.: `withContext({ sku })`). */
export function withContext(ctx: Record<string, unknown>): Logger {
  return logger.child(ctx);
}
