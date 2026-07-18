import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { MlModule } from '../../ml/ml.module';
import { SizeGridService } from './size-grid.service';

@Module({
  imports: [MlModule],
  providers: [PrismaService, SizeGridService],
  exports: [SizeGridService],
})
export class AttributesModule {}
