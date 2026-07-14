import { Injectable } from '@nestjs/common';
import { Prisma, StockReason } from '@prisma/client';
import { PrismaService } from '../../lib/prisma.service';
import { OutOfStockError } from '../../lib/errors';
import { withContext } from '../../lib/logger';

@Injectable()
export class StockService {
  private readonly log = withContext({ op: 'stock' });

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Movimenta estoque de forma atômica e auditável.
   *  - delta < 0 (saída): decremento CONDICIONAL — `WHERE stock_on_hand >= |delta|`.
   *    Zero linhas afetadas => venda sem estoque => OutOfStockError (não grava ledger).
   *  - delta > 0 (entrada): incremento simples.
   * Sempre grava um `stock_movement` na MESMA transação. É a camada 2 do anti-oversell;
   * o CHECK (stock_on_hand >= 0) no banco é a camada 1 (defesa final).
   */
  async move(
    variationId: string,
    delta: number,
    reason: StockReason,
    orderId?: string,
  ): Promise<number> {
    if (delta === 0) {
      const v = await this.prisma.variation.findUniqueOrThrow({ where: { id: variationId } });
      return v.stockOnHand;
    }

    return this.prisma.$transaction(async (tx) => {
      let balanceAfter: number;

      if (delta < 0) {
        const need = -delta;
        const updated = await tx.$queryRaw<{ stock_on_hand: number }[]>`
          UPDATE variation
          SET stock_on_hand = stock_on_hand - ${need}, updated_at = now()
          WHERE id = ${variationId}::uuid AND stock_on_hand >= ${need}
          RETURNING stock_on_hand`;
        if (updated.length === 0) {
          // Ou não existe, ou não tinha saldo. Distinguir para erro claro.
          const exists = await tx.variation.findUnique({ where: { id: variationId } });
          if (!exists) throw new Prisma.PrismaClientKnownRequestError('variação inexistente', {
            code: 'P2025',
            clientVersion: Prisma.prismaVersion.client,
          });
          this.log.warn({ variationId, need }, 'venda sem estoque suficiente');
          throw new OutOfStockError(variationId, need);
        }
        balanceAfter = updated[0]!.stock_on_hand;
      } else {
        const updated = await tx.$queryRaw<{ stock_on_hand: number }[]>`
          UPDATE variation
          SET stock_on_hand = stock_on_hand + ${delta}, updated_at = now()
          WHERE id = ${variationId}::uuid
          RETURNING stock_on_hand`;
        if (updated.length === 0) {
          throw new Prisma.PrismaClientKnownRequestError('variação inexistente', {
            code: 'P2025',
            clientVersion: Prisma.prismaVersion.client,
          });
        }
        balanceAfter = updated[0]!.stock_on_hand;
      }

      await tx.stockMovement.create({
        data: { variationId, delta, reason, orderId: orderId ?? null, balanceAfter },
      });
      return balanceAfter;
    });
  }

  /** Ajusta o saldo para um valor absoluto (reconciliação / import inicial). */
  async setAbsolute(variationId: string, target: number, reason: StockReason): Promise<number> {
    const v = await this.prisma.variation.findUniqueOrThrow({ where: { id: variationId } });
    const delta = target - v.stockOnHand;
    if (delta === 0) return v.stockOnHand;
    return this.move(variationId, delta, reason);
  }
}
