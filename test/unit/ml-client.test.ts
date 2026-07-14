import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';

// Env mínima para o loadEnv() do construtor do cliente.
beforeAll(() => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
  process.env.ML_APP_ID = 'app';
  process.env.ML_CLIENT_SECRET = 'secret';
  process.env.ML_REDIRECT_URI = 'http://localhost:3000/cb';
  process.env.ML_HTTP_MAX_RETRIES = '3';
  process.env.ML_HTTP_TIMEOUT_MS = '2000';
});

import { MlClient } from '../../src/ml/client/ml-client.service';
import { MlApiError, MlAuthError } from '../../src/lib/errors';
import type { TokenStore } from '../../src/ml/auth/token-store.service';

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(token: Partial<TokenStore> = {}): MlClient {
  const store = {
    getValidAccessToken: vi.fn().mockResolvedValue('tok'),
    refreshNow: vi.fn().mockResolvedValue('tok2'),
    ...token,
  } as unknown as TokenStore;
  return new MlClient(store);
}

describe('MlClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it('faz retry em 429 respeitando Retry-After e depois sucede', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(429, { error: 'too_many' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const out = await client.get<{ ok: boolean }>('/x');
    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('faz retry em 500 e depois sucede', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(500, { error: 'boom' }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const out = await client.get<{ ok: boolean }>('/y');
    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15000);

  it('em 401 renova token e faz replay uma vez', async () => {
    const refreshNow = vi.fn().mockResolvedValue('tok2');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient({ refreshNow });
    const out = await client.get<{ ok: boolean }>('/z');
    expect(out.ok).toBe(true);
    expect(refreshNow).toHaveBeenCalledTimes(1);
  });

  it('em 401 persistente lança MlAuthError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(401, { error: 'invalid_token' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await expect(client.get('/z')).rejects.toBeInstanceOf(MlAuthError);
  });

  it('não faz retry em 4xx (exceto 429) e lança MlApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(400, { error: 'bad_request' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await expect(client.get('/w')).rejects.toBeInstanceOf(MlApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('injeta Bearer no header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await client.get('/me');
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});

beforeEach(() => vi.unstubAllGlobals());
