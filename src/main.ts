import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { logger } from './lib/logger';
import { Worker } from './jobs/worker.service';

async function bootstrap(): Promise<void> {
  const cfg = loadEnv(); // valida env — falha cedo com mensagem clara
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  // CORS para o frontend (Vercel). '*' + header x-admin-key: a chave é a defesa real.
  app.enableCors({
    origin: cfg.CORS_ORIGIN === '*' ? true : cfg.CORS_ORIGIN.split(','),
    allowedHeaders: ['Content-Type', 'x-admin-key'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  // API e worker no mesmo processo por padrão (single-seller, volume baixo).
  // Para separar, rode `npm run worker` (worker.main.ts) e desabilite aqui.
  app.get(Worker).start();

  // Bind explícito em 0.0.0.0 — em container (Railway/Docker) o default pode não
  // aceitar conexões externas e o healthcheck falha com "service unavailable".
  await app.listen(cfg.PORT, '0.0.0.0');
  logger.info({ port: cfg.PORT }, 'HubML no ar');
}

bootstrap().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'falha no bootstrap');
  process.exit(1);
});
