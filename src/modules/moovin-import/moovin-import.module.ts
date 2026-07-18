import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { MoovinModule } from '../../moovin/moovin.module';
import { MoovinImportService } from './moovin-import.service';

@Module({
  imports: [MoovinModule],
  providers: [PrismaService, MoovinImportService],
  exports: [MoovinImportService],
})
export class MoovinImportModule {}
