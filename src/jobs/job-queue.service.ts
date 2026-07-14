import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../lib/prisma.service';
import type { EnqueueOptions } from './job.types';

@Injectable()
export class JobQueue {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfileira um job. Com dedupeKey, um segundo enqueue do mesmo trabalho pendente
   * é no-op (ON CONFLICT DO NOTHING sobre o índice unique de dedupe_key).
   */
  async enqueue(type: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}): Promise<void> {
    if (opts.dedupeKey) {
      // Só deduplica contra jobs ainda não terminados; um dedupeKey "livre" pode reenfileirar.
      await this.prisma.$executeRaw`
        INSERT INTO job (id, type, payload, dedupe_key, status, run_at, attempts, max_attempts, created_at, updated_at)
        VALUES (gen_random_uuid(), ${type}, ${JSON.stringify(payload)}::jsonb, ${opts.dedupeKey},
                'pending', ${opts.runAt ?? new Date()}, 0, ${opts.maxAttempts ?? 5}, now(), now())
        ON CONFLICT (dedupe_key) DO NOTHING`;
      return;
    }
    await this.prisma.job.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        runAt: opts.runAt ?? new Date(),
        maxAttempts: opts.maxAttempts ?? 5,
      },
    });
  }
}
