import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { MlModule } from '../../ml/ml.module';
import { CategoryResolverService } from './category-resolver.service';

@Module({
  imports: [MlModule],
  providers: [PrismaService, CategoryResolverService],
  exports: [CategoryResolverService],
})
export class CategoryResolverModule {}
