import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { MlModule } from '../../ml/ml.module';
import { PublishingService } from './publishing.service';

@Module({
  imports: [MlModule],
  providers: [PrismaService, PublishingService],
  exports: [PublishingService],
})
export class PublishingModule {}
