import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { TokenStore } from './token-store.service';
import { loadEnv } from '../../config/env';
import { withContext } from '../../lib/logger';

// Estado da autorização em memória (fluxo one-time, single-seller). CSRF via `state`;
// se PKCE habilitado, guarda o code_verifier associado ao state.
const pending = new Map<string, { verifier?: string; createdAt: number }>();
const STATE_TTL_MS = 10 * 60_000;

@Controller('auth/ml')
export class AuthController {
  private readonly log = withContext({ op: 'oauth-callback' });

  constructor(private readonly tokens: TokenStore) {}

  /** Redireciona o admin do seller para a tela de autorização do ML. */
  @Get('start')
  start(@Res() res: Response): void {
    const cfg = loadEnv();
    const state = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.ML_APP_ID,
      redirect_uri: cfg.ML_REDIRECT_URI,
      state,
    });

    let verifier: string | undefined;
    if (cfg.ML_PKCE_ENABLED) {
      verifier = base64url(randomBytes(32));
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
    }
    pending.set(state, { verifier, createdAt: Date.now() });
    prune();

    res.redirect(`${cfg.ML_AUTH_BASE_URL}/authorization?${params.toString()}`);
  }

  /** Callback: valida state, troca code por token, persiste. */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
  ): Promise<{ ok: true; mlUserId: string }> {
    if (error) throw new BadRequestException(`ML retornou erro: ${error}`);
    if (!code || !state) throw new BadRequestException('code e state são obrigatórios');

    const entry = pending.get(state);
    if (!entry) throw new BadRequestException('state inválido ou expirado (possível CSRF)');
    pending.delete(state);

    const set = await this.tokens.exchangeAuthCode(code, entry.verifier);
    await this.tokens.save(set);
    this.log.info({ mlUserId: set.mlUserId }, 'credenciais ML persistidas');
    return { ok: true, mlUserId: set.mlUserId };
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function prune(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}
