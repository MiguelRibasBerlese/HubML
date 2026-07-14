// Base da API: injetada no build (VITE_API_URL) com fallback para o backend no Railway.
export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ??
  'https://hubml-api-production.up.railway.app';

const KEY_STORAGE = 'hubml_admin_key';

export function getAdminKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}
export function setAdminKey(k: string): void {
  localStorage.setItem(KEY_STORAGE, k);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': getAdminKey(),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = body?.message ?? res.statusText;
    throw new Error(`${res.status}: ${Array.isArray(msg) ? msg.join(', ') : msg}`);
  }
  return body as T;
}

// ─── Tipos mínimos (espelham o backend) ──────────────────────────────────────
export interface Variation {
  id: string;
  sku: string;
  priceCents: number;
  stockOnHand: number;
  gtin: string | null;
}
export interface Listing {
  id: string;
  status: string;
  mlItemId: string | null;
  lastError: unknown;
}
export interface Product {
  id: string;
  title: string;
  mlCategoryId: string | null;
  variations: Variation[];
  listings?: Listing[];
}

export interface Health {
  status: string;
  db: 'up' | 'down';
}

// ─── Chamadas ────────────────────────────────────────────────────────────────
export const api = {
  health: () => req<Health>('/health'),
  listProducts: () => req<Product[]>('/catalog/products'),
  getProduct: (id: string) => req<Product>(`/catalog/products/${id}`),
  createProduct: (input: {
    title: string;
    mlCategoryId?: string;
    variations: { sku: string; priceCents: number; stockOnHand: number; gtin?: string; gtinExemptReason?: string }[];
  }) => req<{ id: string }>('/catalog/products', { method: 'POST', body: JSON.stringify(input) }),
  importAccount: () => req<{ enqueued: string }>('/admin/import', { method: 'POST' }),
  publish: (productId: string) =>
    req<{ enqueued: string }>('/admin/publish', { method: 'POST', body: JSON.stringify({ productId }) }),
};
