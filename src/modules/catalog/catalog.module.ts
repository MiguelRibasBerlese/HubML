import { Module } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { CatalogService } from './catalog.service';
import { StockService } from './stock.service';
import { CatalogController } from './catalog.controller';

@Module({
  controllers: [CatalogController],
  providers: [PrismaService, CatalogService, StockService],
  exports: [CatalogService, StockService],
})
export class CatalogModule {}
