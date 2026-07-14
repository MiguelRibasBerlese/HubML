import { Injectable } from '@nestjs/common';
import { TokenStore } from '../auth/token-store.service';
import { loadEnv, type Env } from '../../config/env';
import { MlApiError, MlAuthError } from '../../lib/errors';
import { withContext } from '../../lib/logger';
import { ConcurrencyLimiter } from './concurrency';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Não injeta Bearer (ex.: endpoints públicos). */
  noAuth?: boolean;
}

/**
 * Único caminho instrumentado para o ML. Responsabilidades:
 *  - injeta Bearer válido (via TokenStore, que renova sozinho);
 *  - retry com backoff exponencial + jitter em 5xx/timeout; respeita Retry-After em 429;
 *  - 4xx (exceto 429) NÃO faz retry;
 *  - 401 → uma tentativa de refresh + replay; falhou de novo → MlAuthError;
 *  - erros tipados (MlApiError com body legível);
 *  - limitador de concorrência.
 */
@Injectable()
export class MlClient {
  private readonly log = withContext({ op: 'ml-client' });
  private readonly cfg: Env;
  private readonly limiter: ConcurrencyLimiter;

  constructor(private readonly tokens: TokenStore) {
    this.cfg = loadEnv();
    this.limiter = new ConcurrencyLimiter(this.cfg.ML_HTTP_MAX_CONCURRENCY);
  }

  get<T>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: 'GET' });
  }
  post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: 'POST', body });
  }
  put<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: 'PUT', body });
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.limiter.run(() => this.execute<T>(path, opts, false));
  }

  private async execute<T>(path: string, opts: RequestOptions, isRetryAfter401: boolean): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const maxRetries = this.cfg.ML_HTTP_MAX_RETRIES;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.ML_HTTP_TIMEOUT_MS);
      const started = Date.now();
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (!opts.noAuth) {
          headers.Authorization = `Bearer ${await this.tokens.getValidAccessToken()}`;
        }
        let payload: string | undefined;
        if (opts.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          payload = JSON.stringify(opts.body);
        }

        const res = await fetch(url, {
          method: opts.method ?? 'GET',
          headers,
          body: payload,
          signal: controller.signal,
        });
        const latency = Date.now() - started;

        // 401 → refresh + replay (uma vez).
        if (res.status === 401 && !opts.noAuth && !isRetryAfter401) {
          this.log.warn({ path }, '401 — tentando refresh + replay');
          await this.tokens.refreshNow();
          return this.execute<T>(path, opts, true);
        }
        if (res.status === 401) {
          throw new MlAuthError(`401 persistente em ${path} — re-autorização necessária`);
        }

        // 429 → respeita Retry-After.
        if (res.status === 429 && attempt < maxRetries) {
          const wait = this.retryAfterMs(res) ?? this.backoffMs(attempt);
          this.log.warn({ path, wait }, '429 — aguardando');
          await sleep(wait);
          continue;
        }

        // 5xx → retry com backoff.
        if (res.status >= 500 && attempt < maxRetries) {
          const wait = this.backoffMs(attempt);
          this.log.warn({ path, status: res.status, wait }, '5xx — retry');
          await sleep(wait);
          continue;
        }

        const bodyOut = await parseBody(res);
        if (!res.ok) {
          throw new MlApiError(res.status, bodyOut, path);
        }
        this.log.debug({ path, status: res.status, latency }, 'ml ok');
        return bodyOut as T;
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const isNetwork = err instanceof TypeError; // fetch network error
        if ((isTimeout || isNetwork) && attempt < maxRetries) {
          const wait = this.backoffMs(attempt);
          this.log.warn({ path, wait, err: (err as Error).message }, 'timeout/rede — retry');
          await sleep(wait);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = path.startsWith('http') ? path : `${this.cfg.ML_API_BASE_URL}${path}`;
    if (!query) return base;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const sep = base.includes('?') ? '&' : '?';
    return qs.toString() ? `${base}${sep}${qs}` : base;
  }

  private retryAfterMs(res: Response): number | undefined {
    const h = res.headers.get('retry-after');
    if (!h) return undefined;
    const secs = Number(h);
    return Number.isFinite(secs) ? secs * 1000 : undefined;
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(1000 * 2 ** attempt, 30_000);
    return base + Math.floor(Math.random() * 250); // jitter
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
