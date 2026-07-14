import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadEnv } from '../config/env';
import { logger } from '../lib/logger';
import { Worker } from './worker.service';

// Entrypoint opcional: roda SÓ o worker (sem servidor HTTP), para escalar
// processamento separado da API. A API em main.ts também sobe um worker por padrão.
async function bootstrap(): Promise<void> {
  loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  app.get(Worker).start();
  logger.info('worker dedicado iniciado');
}

bootstrap().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'falha no worker');
  process.exit(1);
});
