// Erros tipados do domínio ML. Nunca engolir exceções silenciosamente.

export class MlApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly endpoint: string,
  ) {
    super(`ML API ${status} em ${endpoint}: ${summarize(body)}`);
    this.name = 'MlApiError';
  }
}

/** Falha de autenticação irrecuperável — sinaliza re-autorização manual do OAuth. */
export class MlAuthError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MlAuthError';
  }
}

/** Erro de validação de payload antes de chamar o ML (motor de atributos, GTIN, título). */
export class ValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Venda sem estoque suficiente — dispara alerta + pausa de anúncio. */
export class OutOfStockError extends Error {
  constructor(readonly variationId: string, readonly requested: number) {
    super(`Estoque insuficiente para variação ${variationId} (pedido ${requested})`);
    this.name = 'OutOfStockError';
  }
}

function summarize(body: unknown): string {
  if (body == null) return '(sem corpo)';
  if (typeof body === 'string') return body.slice(0, 500);
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return String(body);
  }
}
