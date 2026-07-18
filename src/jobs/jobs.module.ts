import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../lib/prisma.service';
import { ImportModule } from '../modules/import/import.module';
import { PublishingModule } from '../modules/publishing/publishing.module';
import { MoovinImportModule } from '../modules/moovin-import/moovin-import.module';
import { AttributesModule } from '../modules/attributes/attributes.module';
import { CategoryResolverModule } from '../modules/category-resolver/category-resolver.module';
import { ImportService } from '../modules/import/import.service';
import { PublishingService } from '../modules/publishing/publishing.service';
import { MoovinImportService } from '../modules/moovin-import/moovin-import.service';
import { SizeGridService } from '../modules/attributes/size-grid.service';
import { CategoryResolverService } from '../modules/category-resolver/category-resolver.service';
import type { ChartPayloadParams } from '../modules/attributes/size-grid-payload';
import { JobQueue } from './job-queue.service';
import { Worker } from './worker.service';

// Registra os handlers de job por tipo. Handlers recebem (payload) e não conhecem o transporte.
@Module({
  imports: [ImportModule, PublishingModule, MoovinImportModule, AttributesModule, CategoryResolverModule],
  providers: [PrismaService, JobQueue, Worker],
  exports: [JobQueue, Worker],
})
export class JobsModule implements OnModuleInit {
  constructor(
    private readonly worker: Worker,
    private readonly importSvc: ImportService,
    private readonly publishing: PublishingService,
    private readonly moovinImportSvc: MoovinImportService,
    private readonly sizeGrid: SizeGridService,
    private readonly categoryResolver: CategoryResolverService,
  ) {}

  onModuleInit(): void {
    this.worker.register('import-account', async () => {
      await this.importSvc.importAccount();
    });
    this.worker.register('import-moovin', async () => {
      await this.moovinImportSvc.importCatalog();
    });
    this.worker.register('publish-product', async (payload) => {
      await this.publishing.publishProduct(
        String(payload.productId),
        payload.catalogProductId ? String(payload.catalogProductId) : undefined,
      );
    });
    this.worker.register('build-size-grid', async (payload) => {
      await this.sizeGrid.ensureChart(payload as unknown as ChartPayloadParams);
    });
    this.worker.register('resolve-categories', async () => {
      await this.categoryResolver.resolvePending();
    });
    // sync-stock / order-pipeline entram em M8/M9.
  }
}
