import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { StockService } from './stock.service';
import { ValidationError } from '../../lib/errors';
import { isValidGtin } from '../../lib/gtin';

export interface CreateVariationInput {
  sku: string;
  priceCents: number;
  stockOnHand?: number;
  color?: string;
  size?: string;
  gtin?: string;
  gtinExemptReason?: string;
  attributes?: Record<string, unknown>;
}

export interface CreateProductInput {
  title: string;
  description?: string;
  brand?: string;
  mlCategoryId?: string;
  gender?: string;
  variations?: CreateVariationInput[];
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  /**
   * Cria produto. Regra §5: todo produto tem >=1 variação. Sem variações no input,
   * gera uma variação "default" (SKU derivado) para eliminar o if/else com/sem variação.
   */
  async createProduct(input: CreateProductInput): Promise<{ id: string }> {
    if (!input.title.trim()) throw new ValidationError('título é obrigatório', 'title');

    const variations = input.variations?.length
      ? input.variations
      : [{ sku: defaultSku(input.title), priceCents: 0, stockOnHand: 0 }];

    for (const v of variations) this.validateVariation(v);

    const product = await this.prisma.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          title: input.title,
          description: input.description ?? '',
          brand: input.brand ?? null,
          mlCategoryId: input.mlCategoryId ?? null,
          gender: input.gender ?? null,
        },
      });
      for (const v of variations) {
        await tx.variation.create({
          data: {
            productId: p.id,
            sku: v.sku,
            priceCents: v.priceCents,
            stockOnHand: 0, // saldo entra pelo ledger abaixo (movimento inicial auditável)
            color: v.color ?? null,
            size: v.size ?? null,
            gtin: v.gtin ?? null,
            gtinExemptReason: v.gtinExemptReason ?? null,
            attributes: (v.attributes ?? {}) as object,
          },
        });
      }
      return p;
    });

    // Movimentos iniciais fora da tx de criação (cada um é atômico e auditável).
    for (const v of variations) {
      if ((v.stockOnHand ?? 0) > 0) {
        const created = await this.prisma.variation.findUniqueOrThrow({ where: { sku: v.sku } });
        await this.stock.move(created.id, v.stockOnHand!, 'initial');
      }
    }
    return { id: product.id };
  }

  private validateVariation(v: CreateVariationInput): void {
    if (!v.sku.trim()) throw new ValidationError('SKU é obrigatório', 'sku');
    if (v.priceCents < 0) throw new ValidationError('preço não pode ser negativo', 'priceCents');
    if ((v.stockOnHand ?? 0) < 0) throw new ValidationError('estoque não pode ser negativo', 'stockOnHand');
    if (v.gtin && !isValidGtin(v.gtin)) {
      throw new ValidationError(`GTIN inválido: ${v.gtin}`, 'gtin');
    }
  }

  getProduct(id: string) {
    return this.prisma.product.findUnique({
      where: { id },
      include: { variations: true, listings: true },
    });
  }

  listProducts(skip = 0, take = 50) {
    return this.prisma.product.findMany({
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { variations: true },
    });
  }
}

function defaultSku(title: string): string {
  const base = title.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 20);
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}
