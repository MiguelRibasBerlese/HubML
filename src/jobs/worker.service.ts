import { Injectable } from '@nestjs/common';
import { PrismaService } from '../lib/prisma.service';
import { loadEnv } from '../config/env';
import { withContext } from '../lib/logger';
import type { JobHandler } from './job.types';

interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * Worker de polling. Reserva jobs com FOR UPDATE SKIP LOCKED (dois workers nunca
 * pegam o mesmo). Falha reagenda com backoff exponencial em run_at até max_attempts,
 * depois marca `failed`. Handlers registrados por tipo.
 */
@Injectable()
export class Worker {
  private readonly log = withContext({ op: 'job-worker' });
  private readonly handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    const cfg = loadEnv();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), cfg.JOB_POLL_INTERVAL_MS);
    this.log.info('worker iniciado');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Um ciclo: reserva um lote, processa cada job. Público para testes determinísticos. */
  async tick(): Promise<void> {
    if (this.running) return; // evita sobreposição de ticks
    this.running = true;
    try {
      const cfg = loadEnv();
      const jobs = await this.claim(cfg.JOB_BATCH_SIZE);
      for (const job of jobs) await this.process(job);
    } finally {
      this.running = false;
    }
  }

  private async claim(batch: number): Promise<ClaimedJob[]> {
    // Reserva atômica: seleciona pendentes prontos e marca 'running' na mesma tx.
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedJob[]>`
        SELECT id, type, payload, attempts, max_attempts
        FROM job
        WHERE status = 'pending' AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${batch}`;
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        await tx.$executeRaw`UPDATE job SET status = 'running', updated_at = now() WHERE id = ANY(${ids}::uuid[])`;
      }
      return rows;
    });
  }

  private async process(job: ClaimedJob): Promise<void> {
    const log = this.log.child({ jobId: job.id, type: job.type });
    const handler = this.handlers.get(job.type);
    if (!handler) {
      log.error('sem handler registrado — marcando failed');
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'failed', lastError: { message: `sem handler para ${job.type}` } },
      });
      return;
    }
    try {
      await handler(job.payload);
      await this.prisma.job.update({ where: { id: job.id }, data: { status: 'done' } });
      log.debug('job concluído');
    } catch (err) {
      const attempts = job.attempts + 1;
      const failed = attempts >= job.max_attempts;
      const backoffSec = Math.min(2 ** attempts, 3600);
      await this.prisma.job.update({
        where: { id: job.id },
        data: {
          status: failed ? 'failed' : 'pending',
          attempts,
          runAt: new Date(Date.now() + backoffSec * 1000),
          lastError: { message: (err as Error).message },
        },
      });
      log.warn({ attempts, failed, err: (err as Error).message }, 'job falhou');
    }
  }
}
