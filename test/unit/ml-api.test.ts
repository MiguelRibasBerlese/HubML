import { describe, it, expect, vi } from 'vitest';
import { MlApi } from '../../src/ml/api/ml-api.service';
import type { MlClient } from '../../src/ml/client/ml-client.service';

function makeClient(get: ReturnType<typeof vi.fn>): MlClient {
  return { get } as unknown as MlClient;
}

describe('MlApi.suggestDomain', () => {
  it('remove o prefixo MLB- do domain_id (bug §11/M6: charts/search rejeita domain_id prefixado)', async () => {
    const get = vi.fn().mockResolvedValue([
      { domain_id: 'MLB-DRESSES', domain_name: 'Vestidos', category_id: 'MLB448690', category_name: 'Vestidos' },
    ]);
    const api = new MlApi(makeClient(get));

    const out = await api.suggestDomain('vestido farm curto');

    expect(out).toEqual({
      domainId: 'DRESSES',
      domainName: 'Vestidos',
      categoryId: 'MLB448690',
      categoryName: 'Vestidos',
    });
    expect(get).toHaveBeenCalledWith('/sites/MLB/domain_discovery/search', {
      query: { q: 'vestido farm curto' },
    });
  });

  it('devolve undefined quando a busca não acha nada', async () => {
    const api = new MlApi(makeClient(vi.fn().mockResolvedValue([])));
    expect(await api.suggestDomain('xyz')).toBeUndefined();
  });
});
