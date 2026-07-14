import { Body, Controller, Post } from '@nestjs/common';
import { JobQueue } from '../jobs/job-queue.service';

// Rotas administrativas mínimas: disparam jobs. Sem UI (M3/M4/M5).
@Controller('admin')
export class AdminController {
  constructor(private readonly jobs: JobQueue) {}

  /** Enfileira o import da conta ML (idempotente via dedupe). */
  @Post('import')
  async import(): Promise<{ enqueued: 'import-account' }> {
    await this.jobs.enqueue('import-account', {}, { dedupeKey: 'import-account' });
    return { enqueued: 'import-account' };
  }

  /** Enfileira a publicação de um produto (dedupe por produto). */
  @Post('publish')
  async publish(@Body() body: { productId: string }): Promise<{ enqueued: string }> {
    await this.jobs.enqueue('publish-product', { productId: body.productId }, {
      dedupeKey: `publish-product:${body.productId}`,
    });
    return { enqueued: `publish-product:${body.productId}` };
  }
}
