import { Module } from '@nestjs/common';
import { PrismaService } from './lib/prisma.service';
import { MlModule } from './ml/ml.module';
import { WebhookModule } from './ml/webhooks/webhook.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ImportModule } from './modules/import/import.module';
import { PublishingModule } from './modules/publishing/publishing.module';
import { JobsModule } from './jobs/jobs.module';
import { HealthController } from './http/health.controller';
import { AdminController } from './http/admin.controller';

@Module({
  imports: [
    MlModule,
    WebhookModule,
    CatalogModule,
    ImportModule,
    PublishingModule,
    JobsModule,
  ],
  controllers: [HealthController, AdminController],
  providers: [PrismaService],
})
export class AppModule {}
