import { readFileSync } from 'node:fs';
import * as XLSX from '@e965/xlsx';
import type { MoovinSource, MoovinProductRow, MoovinVariationRow } from './source.interface';

// Linhas cruas das abas PRODUTOS/VARIACOES do catálogo "preparado para o ML"
// que a MAGNI entrega hoje (não o export bruto da Moovin — o de-para e o
// agrupamento por URN já vêm prontos nessas duas abas).
interface ProdutoRow {
  URN: string;
  NOME: string;
  MARCA: string | null;
  GENERO: string | null;
  IMAGEM: string | null;
  TIPO: string | null;
  CATEGORIA_MOOVIN: string | null;
}

interface VariacaoRow {
  URN: string;
  SKU: string;
  COR: string | null;
  TAMANHO: string | null;
  ESTOQUE: number | null;
  PRECO_LISTA: number | null;
}

function toCents(price: number | null): number {
  return Math.round((price ?? 0) * 100);
}

export class MoovinXlsxSource implements MoovinSource {
  constructor(private readonly filePath: string) {}

  async fetchProducts(): Promise<MoovinProductRow[]> {
    const buffer = readFileSync(this.filePath);
    const wb = XLSX.read(buffer, { type: 'buffer' });

    const produtos = XLSX.utils.sheet_to_json<ProdutoRow>(wb.Sheets['PRODUTOS']!, { defval: null });
    const variacoes = XLSX.utils.sheet_to_json<VariacaoRow>(wb.Sheets['VARIACOES']!, { defval: null });

    const variationsByUrn = new Map<string, MoovinVariationRow[]>();
    for (const v of variacoes) {
      const list = variationsByUrn.get(v.URN) ?? [];
      list.push({
        sku: v.SKU,
        color: v.COR,
        size: v.TAMANHO,
        stock: v.ESTOQUE ?? 0,
        priceListCents: toCents(v.PRECO_LISTA),
      });
      variationsByUrn.set(v.URN, list);
    }

    return produtos.map((p) => ({
      urn: p.URN,
      name: p.NOME,
      brand: p.MARCA,
      gender: p.GENERO,
      image: p.IMAGEM,
      type: p.TIPO,
      categoria: p.CATEGORIA_MOOVIN,
      variations: variationsByUrn.get(p.URN) ?? [],
    }));
  }
}
