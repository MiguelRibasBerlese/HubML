import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JobQueue } from '../jobs/job-queue.service';
import { PublishingService } from '../modules/publishing/publishing.service';
import type { ChartPayloadParams } from '../modules/attributes/size-grid-payload';
import { AdminKeyGuard } from './admin-key.guard';

// Rotas administrativas mínimas: disparam jobs. Sem UI (M3/M4/M5). Protegidas por chave.
@UseGuards(AdminKeyGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly jobs: JobQueue,
    private readonly publishing: PublishingService,
  ) {}

  /** Enfileira o import da conta ML (idempotente via dedupe). */
  @Post('import')
  async import(): Promise<{ enqueued: 'import-account' }> {
    await this.jobs.enqueue('import-account', {}, { dedupeKey: 'import-account' });
    return { enqueued: 'import-account' };
  }

  /** Enfileira o import do catálogo Moovin (idempotente via dedupe). */
  @Post('import-moovin')
  async importMoovin(): Promise<{ enqueued: 'import-moovin' }> {
    await this.jobs.enqueue('import-moovin', {}, { dedupeKey: 'import-moovin' });
    return { enqueued: 'import-moovin' };
  }

  /** Dry-run: constrói e devolve o payload de POST /items sem enviar nada. */
  @Post('publish-preview')
  async publishPreview(@Body() body: { productId: string }): Promise<Record<string, unknown>> {
    return this.publishing.previewPublish(body.productId);
  }

  /** Enfileira a publicação de um produto (dedupe por produto). `catalogProductId` opcional
   *  liga o caminho catalog_listing (marca registrada sem GTIN) — de-para decidido por humano. */
  @Post('publish')
  async publish(@Body() body: { productId: string; catalogProductId?: string }): Promise<{ enqueued: string }> {
    await this.jobs.enqueue('publish-product', { productId: body.productId, catalogProductId: body.catalogProductId }, {
      dedupeKey: `publish-product:${body.productId}`,
    });
    return { enqueued: `publish-product:${body.productId}` };
  }

  /** Enfileira publicação de vestuário (items irmãos por SKU — M7-vestidos). */
  @Post('publish-apparel')
  async publishApparel(@Body() body: { productId: string }): Promise<{ enqueued: string }> {
    await this.jobs.enqueue('publish-apparel', { productId: body.productId }, {
      dedupeKey: `publish-apparel:${body.productId}`,
    });
    return { enqueued: `publish-apparel:${body.productId}` };
  }

  /** Enfileira a criação de um guia de tamanho (dedupe por domain_id+brand+gender). */
  @Post('build-size-grid')
  async buildSizeGrid(@Body() body: ChartPayloadParams): Promise<{ enqueued: string }> {
    const dedupeKey = `build-size-grid:${body.domainId}:${body.brand}:${body.genderName}`;
    await this.jobs.enqueue('build-size-grid', body as unknown as Record<string, unknown>, { dedupeKey });
    return { enqueued: dedupeKey };
  }

  /** Enfileira o backfill de mlCategoryId/mlDomainId (resolve via domain_discovery). */
  @Post('resolve-categories')
  async resolveCategories(): Promise<{ enqueued: 'resolve-categories' }> {
    await this.jobs.enqueue('resolve-categories', {}, { dedupeKey: 'resolve-categories' });
    return { enqueued: 'resolve-categories' };
  }
}
