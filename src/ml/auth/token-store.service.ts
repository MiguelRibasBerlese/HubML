import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../lib/prisma.service';
import { loadEnv } from '../../config/env';
import { MlAuthError } from '../../lib/errors';
import { withContext } from '../../lib/logger';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  mlUserId: string;
}

interface MlTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // segundos (21600 = 6h)
  user_id: number | string;
  scope?: string;
}

// Margem de segurança: renova se faltar menos que isto para expirar.
const REFRESH_MARGIN_MS = 60_000;

/**
 * Token store com refresh rotacionado. O refresh token do ML é de USO ÚNICO
 * (rotaciona a cada refresh). Por isso o refresh acontece dentro de uma
 * transação com lock pessimista na linha única (id=1): dois processos jamais
 * renovam em paralelo, e o par novo é persistido ANTES do COMMIT.
 */
@Injectable()
export class TokenStore {
  private readonly log = withContext({ op: 'token-store' });

  constructor(private readonly prisma: PrismaService) {}

  /** Persiste o par inicial (fluxo authorization-code). */
  async save(tokens: TokenSet): Promise<void> {
    await this.prisma.mlCredentials.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        mlUserId: tokens.mlUserId,
      },
      update: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        mlUserId: tokens.mlUserId,
      },
    });
  }

  /**
   * Retorna um access token válido, renovando se necessário. Concorrência
   * segura via SELECT ... FOR UPDATE dentro da transação.
   */
  async getValidAccessToken(now: Date = new Date()): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { access_token: string; refresh_token: string; expires_at: Date }[]
      >`SELECT access_token, refresh_token, expires_at FROM ml_credentials WHERE id = 1 FOR UPDATE`;

      const cred = rows[0];
      if (!cred) {
        throw new MlAuthError('Sem credenciais ML. Rode o fluxo /auth/ml/start.');
      }

      // Outro processo pode ter renovado enquanto esperávamos o lock: revalida aqui.
      if (cred.expires_at.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
        return cred.access_token;
      }

      this.log.info('token expirado; renovando');
      const fresh = await this.exchangeRefreshToken(cred.refresh_token);
      // Persiste o par novo ANTES do COMMIT (dentro da mesma tx).
      await tx.mlCredentials.update({
        where: { id: 1 },
        data: {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken,
          expiresAt: fresh.expiresAt,
          mlUserId: fresh.mlUserId,
        },
      });
      return fresh.accessToken;
    });
  }

  /**
   * Força uma renovação (usado após 401 com token possivelmente revogado).
   * Transacional com lock: se outro processo já renovou, aproveita o par novo.
   */
  async refreshNow(now: Date = new Date()): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { access_token: string; refresh_token: string; expires_at: Date }[]
      >`SELECT access_token, refresh_token, expires_at FROM ml_credentials WHERE id = 1 FOR UPDATE`;
      const cred = rows[0];
      if (!cred) throw new MlAuthError('Sem credenciais ML. Rode /auth/ml/start.');

      // Outro processo renovou há pouco (par novo e ainda válido): reusa.
      if (cred.expires_at.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
        return cred.access_token;
      }
      const fresh = await this.exchangeRefreshToken(cred.refresh_token);
      await tx.mlCredentials.update({
        where: { id: 1 },
        data: {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken,
          expiresAt: fresh.expiresAt,
          mlUserId: fresh.mlUserId,
        },
      });
      return fresh.accessToken;
    });
  }

  /** Troca refresh_token por um novo par (rotação). */
  async exchangeRefreshToken(refreshToken: string): Promise<TokenSet> {
    const cfg = loadEnv();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.ML_APP_ID,
      client_secret: cfg.ML_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    return this.postToken(body);
  }

  /** Troca authorization code por par de tokens (fluxo inicial). */
  async exchangeAuthCode(code: string, codeVerifier?: string): Promise<TokenSet> {
    const cfg = loadEnv();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.ML_APP_ID,
      client_secret: cfg.ML_CLIENT_SECRET,
      code,
      redirect_uri: cfg.ML_REDIRECT_URI,
    });
    if (codeVerifier) body.set('code_verifier', codeVerifier);
    return this.postToken(body);
  }

  private async postToken(body: URLSearchParams): Promise<TokenSet> {
    const cfg = loadEnv();
    const res = await fetch(`${cfg.ML_API_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<MlTokenResponse> & {
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      throw new MlAuthError(
        `Falha no /oauth/token (${res.status}): ${json.error ?? json.message ?? 'desconhecido'}`,
        json,
      );
    }
    if (!json.access_token || !json.refresh_token || !json.expires_in) {
      throw new MlAuthError('Resposta de token incompleta do ML', json);
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      mlUserId: String(json.user_id ?? ''),
    };
  }
}
