// Contrato dos handlers: recebem (type, payload) e NÃO conhecem o transporte.
// Trocar a fila (Postgres -> BullMQ) não toca em handler (D7).
export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export interface EnqueueOptions {
  dedupeKey?: string; // idempotência de enfileiramento (ex.: 'sync-stock:{variationId}')
  runAt?: Date;
  maxAttempts?: number;
}
