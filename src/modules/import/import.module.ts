import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { MlModule } from '../../ml/ml.module';
import { ImportService } from './import.service';

@Module({
  imports: [MlModule],
  providers: [PrismaService, ImportService],
  exports: [ImportService],
})
export class ImportModule {}
