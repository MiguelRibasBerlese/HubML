import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { loadEnv } from '../config/env';
import { withContext } from '../lib/logger';

/**
 * Protege rotas de escrita (admin/catalog) com uma chave no header `x-admin-key`.
 * Fail-closed em produção: sem ADMIN_API_KEY configurada, nega tudo (evita expor
 * um write API público sem querer). Em dev, sem chave, libera.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  private readonly log = withContext({ op: 'admin-guard' });

  canActivate(context: ExecutionContext): boolean {
    const cfg = loadEnv();
    const expected = cfg.ADMIN_API_KEY;

    if (!expected) {
      if (cfg.NODE_ENV === 'production') {
        this.log.error('ADMIN_API_KEY não configurada em produção — negando acesso');
        throw new UnauthorizedException('admin API key não configurada');
      }
      return true; // dev sem chave: libera
    }

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header('x-admin-key');
    if (provided && timingSafeEqual(provided, expected)) return true;
    throw new UnauthorizedException('x-admin-key inválida ou ausente');
  }
}

// Comparação de tempo constante para não vazar o tamanho/prefixo da chave por timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
