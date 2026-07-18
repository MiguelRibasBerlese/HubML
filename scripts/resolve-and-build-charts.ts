// ponytail: script de uso único — resolve domain/gender pros 4 grupos seguros via ML real
// e dispara /admin/build-size-grid (caminho de produção testado) pra criar os charts de verdade.
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env';

const prisma = new PrismaClient();

interface Group {
  label: string;
  tipoWord: string; // 1ª palavra do title — mesma heurística do dry run original
  brand: string;
  gender: string; // valor exato salvo em Product.gender
}

const GROUPS: Group[] = [
  { label: 'POLO/CALVIN KLEIN', tipoWord: 'POLO', brand: 'CALVIN KLEIN', gender: 'Masculino' },
  { label: 'CAMISA/CALVIN KLEIN', tipoWord: 'CAMISA', brand: 'CALVIN KLEIN', gender: 'Masculino' },
  { label: 'CAMISETA/RICHARDS', tipoWord: 'CAMISETA', brand: 'RICHARDS', gender: 'Masculino' },
  { label: 'POLO/LACOSTE', tipoWord: 'POLO', brand: 'LACOSTE', gender: 'Masculino' },
];

async function mlFetch(token: string, path: string, opts: RequestInit = {}) {
  const res = await fetch(`https://api.mercadolibre.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const DRY_RUN = process.env.DRY_RUN !== '0';
const ONLY_LABEL = process.env.ONLY_LABEL; // ponytail: filtro pra teste controlado de 1 grupo

async function main() {
  if (DRY_RUN) console.log('*** DRY RUN — nenhuma chamada mutation (build-size-grid) será feita ***');
  const env = loadEnv();
  const creds = await prisma.mlCredentials.findUniqueOrThrow({ where: { id: 1 } });
  const token = creds.accessToken;

  const groups = ONLY_LABEL ? GROUPS.filter((g) => g.label === ONLY_LABEL) : GROUPS;
  for (const g of groups) {
    const sample = await prisma.product.findFirst({
      where: {
        brand: g.brand,
        gender: g.gender,
        moovinUrn: { not: null },
        title: { startsWith: g.tipoWord, mode: 'insensitive' },
      },
      orderBy: { title: 'asc' },
    });
    if (!sample) {
      console.log(`\n[${g.label}] SEM produto de amostra (tipo=${g.tipoWord} brand=${g.brand} gender=${g.gender}) — pulei`);
      continue;
    }

    const discovery = await mlFetch(
      token,
      `/sites/MLB/domain_discovery/search?q=${encodeURIComponent(sample.title)}`,
    );
    const top = discovery[0];
    if (!top) {
      console.log(`\n[${g.label}] domain_discovery não achou nada pra "${sample.title}" — pulei`);
      continue;
    }
    const domainId = String(top.domain_id).replace(/^MLB-/, '');
    console.log(`\n[${g.label}] amostra="${sample.title}" -> domain=${domainId} category=${top.category_id}`);

    const attrs = await mlFetch(token, `/categories/${top.category_id}/attributes`);
    const genderAttr = attrs.find((a: { id: string }) => a.id === 'GENDER');
    const genderValue = genderAttr?.values?.find(
      (v: { name: string }) => v.name.toLowerCase() === g.gender.toLowerCase(),
    );
    if (!genderValue) {
      console.log(`  GENDER "${g.gender}" não encontrado nos values da categoria — valores disponíveis:`, genderAttr?.values);
      continue;
    }
    console.log(`  GENDER resolvido: ${genderValue.name} (${genderValue.id})`);

    const body = {
      domainId,
      brand: g.brand,
      genderValueId: genderValue.id,
      genderName: genderValue.name,
      names: { MLB: `Guia ${g.label}` },
      rows: [{ size: 'PP' }, { size: 'P' }, { size: 'M' }, { size: 'G' }, { size: 'GG' }],
    };

    if (DRY_RUN) {
      console.log(`  [dry run] body que seria enviado:`, JSON.stringify(body));
      continue;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.ADMIN_API_KEY) headers['x-admin-key'] = env.ADMIN_API_KEY;

    const enqueueRes = await fetch('http://localhost:3000/admin/build-size-grid', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const enqueueBody = await enqueueRes.json();
    console.log(`  POST /admin/build-size-grid ->`, enqueueRes.status, JSON.stringify(enqueueBody));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
