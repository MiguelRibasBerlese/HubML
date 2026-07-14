import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CatalogService, type CreateProductInput } from './catalog.service';
import { StockService } from './stock.service';
import { AdminKeyGuard } from '../../http/admin-key.guard';

// API REST mínima (sem UI) — M3. Protegida por chave admin (operador único).
@UseGuards(AdminKeyGuard)
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly stock: StockService,
  ) {}

  @Post('products')
  create(@Body() body: CreateProductInput) {
    return this.catalog.createProduct(body);
  }

  @Get('products')
  list(@Query('skip') skip?: string, @Query('take') take?: string) {
    return this.catalog.listProducts(skip ? Number(skip) : 0, take ? Number(take) : 50);
  }

  @Get('products/:id')
  get(@Param('id') id: string) {
    return this.catalog.getProduct(id);
  }

  @Post('variations/:id/stock')
  move(@Param('id') id: string, @Body() body: { delta: number; reason?: string }) {
    return this.stock
      .move(id, body.delta, (body.reason as never) ?? 'manual')
      .then((balance) => ({ variationId: id, balance }));
  }
}
