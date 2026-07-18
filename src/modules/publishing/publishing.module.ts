import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { MlModule } from '../../ml/ml.module';
import { AttributesModule } from '../attributes/attributes.module';
import { PublishingService } from './publishing.service';

@Module({
  imports: [MlModule, AttributesModule],
  providers: [PrismaService, PublishingService],
  exports: [PublishingService],
})
export class PublishingModule {}
