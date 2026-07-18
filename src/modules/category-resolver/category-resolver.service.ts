import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { MlApi } from '../../ml/api/ml-api.service';
import { withContext } from '../../lib/logger';

export interface CategoryResolveReport {
  scanned: number;
  resolved: number;
  unresolved: { productId: string; title: string }[];
}

/**
 * Backfill de mlCategoryId/mlDomainId nos produtos que ainda não têm (import Moovin
 * não seta categoria — só o import M4 setava). Sem category_id não há POST /items.
 * Resolve via domain_discovery (MlApi.suggestDomain, que já devolve categoryId+domainId
 * sem prefixo MLB-). Resumível: só toca produtos com mlCategoryId null, então retry
 * continua de onde parou. Não publica nada — só persiste a categoria resolvida.
 */
@Injectable()
export class CategoryResolverService {
  private readonly log = withContext({ op: 'category-resolver' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly mlApi: MlApi,
  ) {}

  async resolvePending(): Promise<CategoryResolveReport> {
    const pending = await this.prisma.product.findMany({
      where: { mlCategoryId: null },
      select: { id: true, title: true },
    });

    const report: CategoryResolveReport = { scanned: pending.length, resolved: 0, unresolved: [] };
    // ponytail: cache por título exato — títulos iguais resolvem o mesmo domínio, evita rechamar.
    const cache = new Map<string, { domainId: string; categoryId: string } | null>();

    for (const p of pending) {
      try {
        let hit = cache.get(p.title);
        if (hit === undefined) {
          const s = await this.mlApi.suggestDomain(p.title);
          hit = s ? { domainId: s.domainId, categoryId: s.categoryId } : null;
          cache.set(p.title, hit);
        }
        if (!hit) {
          report.unresolved.push({ productId: p.id, title: p.title });
          continue;
        }
        await this.prisma.product.update({
          where: { id: p.id },
          data: { mlCategoryId: hit.categoryId, mlDomainId: hit.domainId },
        });
        report.resolved++;
      } catch (err) {
        // Um título ruim não aborta o lote (mesma régua do MoovinImportService).
        report.unresolved.push({ productId: p.id, title: p.title });
        this.log.warn({ productId: p.id, err: (err as Error).message }, 'falha ao resolver categoria');
      }
    }
    this.log.info({ ...report, unresolved: report.unresolved.length }, 'resolução de categoria concluída');
    return report;
  }
}
