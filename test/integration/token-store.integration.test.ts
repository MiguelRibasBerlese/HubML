import { describe, it, expect, beforeEach, afterAll, vi, afterEach } from 'vitest';
import { prisma, dbConfigured, resetDb } from './db';
import { TokenStore } from '../../src/ml/auth/token-store.service';

 const d = dbConfigured() ? describe : describe.skip;

function tokenResponse(access: string, refresh: string) {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 21600, user_id: 123 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

d('TokenStore (integração) — refresh concorrente', () => {
  const store = new TokenStore(prisma as never);

  beforeEach(async () => {
    await resetDb();
    // Credencial já EXPIRADA para forçar refresh.
    await prisma.mlCredentials.create({
      data: {
        id: 1,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: new Date(Date.now() - 60_000),
        mlUserId: '123',
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('dois getValidAccessToken concorrentes disparam apenas 1 refresh HTTP', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      // pequena latência para garantir sobreposição real das duas chamadas
      await new Promise((r) => setTimeout(r, 30));
      return tokenResponse('new-access', 'new-refresh');
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([store.getValidAccessToken(), store.getValidAccessToken()]);

    // Só um refresh HTTP (o lock FOR UPDATE serializa; o 2º vê o token já novo).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual(['new-access', 'new-access']);

    const cred = await prisma.mlCredentials.findUniqueOrThrow({ where: { id: 1 } });
    expect(cred.refreshToken).toBe('new-refresh'); // par rotacionado persistido
  });

  it('não renova se o token ainda é válido', async () => {
    await prisma.mlCredentials.update({
      where: { id: 1 },
      data: { accessToken: 'valid', expiresAt: new Date(Date.now() + 3600_000) },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const t = await store.getValidAccessToken();
    expect(t).toBe('valid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
