import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../lib/prisma.service';
import { ImportModule } from '../modules/import/import.module';
import { PublishingModule } from '../modules/publishing/publishing.module';
import { ImportService } from '../modules/import/import.service';
import { PublishingService } from '../modules/publishing/publishing.service';
import { JobQueue } from './job-queue.service';
import { Worker } from './worker.service';

// Registra os handlers de job por tipo. Handlers recebem (payload) e não conhecem o transporte.
@Module({
  imports: [ImportModule, PublishingModule],
  providers: [PrismaService, JobQueue, Worker],
  exports: [JobQueue, Worker],
})
export class JobsModule implements OnModuleInit {
  constructor(
    private readonly worker: Worker,
    private readonly importSvc: ImportService,
    private readonly publishing: PublishingService,
  ) {}

  onModuleInit(): void {
    this.worker.register('import-account', async () => {
      await this.importSvc.importAccount();
    });
    this.worker.register('publish-product', async (payload) => {
      await this.publishing.publishProduct(String(payload.productId));
    });
    // sync-stock / order-pipeline entram em M8/M9.
  }
}
