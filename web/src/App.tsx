import { useEffect, useState, type FormEvent } from 'react';
import { api, getAdminKey, setAdminKey, API_URL, type Product, type Health } from './api';

export function App() {
  const [key, setKey] = useState(getAdminKey());
  const [health, setHealth] = useState<Health | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [log, setLog] = useState<{ ok: boolean; msg: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const note = (ok: boolean, msg: string) => setLog((l) => [{ ok, msg }, ...l].slice(0, 12));

  async function refresh() {
    setLoading(true);
    try {
      setHealth(await api.health());
      setProducts(await api.listProducts());
    } catch (e) {
      note(false, `Falha ao carregar: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ status: 'offline', db: 'down' }));
  }, []);

  function saveKey() {
    setAdminKey(key.trim());
    note(true, 'Chave salva. Recarregando dados…');
    refresh();
  }

  async function doImport() {
    try {
      const r = await api.importAccount();
      note(true, `Import enfileirado (${r.enqueued}). O worker processa em segundo plano.`);
    } catch (e) {
      note(false, `Import: ${(e as Error).message}`);
    }
  }

  async function doPublish(id: string) {
    try {
      const r = await api.publish(id);
      note(true, `Publicação enfileirada (${r.enqueued}).`);
    } catch (e) {
      note(false, `Publicar: ${(e as Error).message}`);
    }
  }

  return (
    <div className="wrap">
      <header>
        <h1>HubML — Painel</h1>
        <span className={`badge ${health?.db === 'up' ? 'up' : 'down'}`}>
          {health ? `${health.status} · db ${health.db}` : '…'}
        </span>
      </header>
      <p className="api">Backend: <code>{API_URL}</code></p>

      <section className="card">
        <h2>Acesso</h2>
        <p className="hint">
          A chave admin (<code>ADMIN_API_KEY</code> do Railway) fica só no seu navegador — nunca no site.
        </p>
        <div className="row">
          <input
            type="password"
            value={key}
            placeholder="cole a ADMIN_API_KEY"
            onChange={(e) => setKey(e.target.value)}
          />
          <button onClick={saveKey}>Salvar</button>
        </div>
      </section>

      <section className="card">
        <h2>Ações</h2>
        <div className="row">
          <button onClick={doImport}>Importar da conta ML</button>
          <button onClick={refresh} disabled={loading}>
            {loading ? 'Carregando…' : 'Recarregar catálogo'}
          </button>
        </div>
      </section>

      <CreateProduct onCreated={(msg, ok) => { note(ok, msg); refresh(); }} />

      <section className="card">
        <h2>Catálogo ({products.length})</h2>
        {products.length === 0 && <p className="hint">Nenhum produto. Importe da conta ou crie um acima.</p>}
        {products.map((p) => (
          <div key={p.id} className="product">
            <div className="prow">
              <strong>{p.title}</strong>
              <button onClick={() => doPublish(p.id)}>Publicar</button>
            </div>
            <div className="meta">categoria: {p.mlCategoryId ?? '—'} · {p.variations.length} variação(ões)</div>
            <ul>
              {p.variations.map((v) => (
                <li key={v.id}>
                  <code>{v.sku}</code> — R$ {(v.priceCents / 100).toFixed(2)} · estoque {v.stockOnHand}
                  {v.gtin ? ` · GTIN ${v.gtin}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Registro</h2>
        {log.length === 0 && <p className="hint">Ações e erros aparecem aqui.</p>}
        <ul className="log">
          {log.map((l, i) => (
            <li key={i} className={l.ok ? 'ok' : 'err'}>{l.msg}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CreateProduct({ onCreated }: { onCreated: (msg: string, ok: boolean) => void }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [gtin, setGtin] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.createProduct({
        title,
        mlCategoryId: category || undefined,
        variations: [
          {
            sku,
            priceCents: Math.round(Number(price) * 100),
            stockOnHand: Number(stock) || 0,
            gtin: gtin || undefined,
            gtinExemptReason: gtin ? undefined : 'Produto artesanal',
          },
        ],
      });
      onCreated(`Produto criado (${r.id.slice(0, 8)}…).`, true);
      setTitle(''); setCategory(''); setSku(''); setPrice(''); setStock(''); setGtin('');
    } catch (err) {
      onCreated(`Criar produto: ${(err as Error).message}`, false);
    }
  }

  return (
    <section className="card">
      <h2>Novo produto</h2>
      <form onSubmit={submit} className="grid">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título (≤60)" required />
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Categoria ML (ex MLB31447)" />
        <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" required />
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Preço (R$)" type="number" step="0.01" required />
        <input value={stock} onChange={(e) => setStock(e.target.value)} placeholder="Estoque" type="number" />
        <input value={gtin} onChange={(e) => setGtin(e.target.value)} placeholder="GTIN (vazio = isento)" />
        <button type="submit">Criar</button>
      </form>
    </section>
  );
}
