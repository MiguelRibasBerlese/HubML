import { z } from 'zod';

// Parsing + validação de env com zod. Env inválida derruba o boot com mensagem clara.
const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  ML_APP_ID: z.string().min(1, 'ML_APP_ID é obrigatório'),
  ML_CLIENT_SECRET: z.string().min(1, 'ML_CLIENT_SECRET é obrigatório'),
  ML_REDIRECT_URI: z.string().url(),
  ML_PKCE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  ML_API_BASE_URL: z.string().url().default('https://api.mercadolibre.com'),
  ML_AUTH_BASE_URL: z.string().url().default('https://auth.mercadolivre.com.br'),

  ML_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  ML_HTTP_MAX_RETRIES: z.coerce.number().int().nonnegative().default(4),
  ML_HTTP_MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),

  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  JOB_BATCH_SIZE: z.coerce.number().int().positive().default(5),

  RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),

  FOCUS_NFE_TOKEN: z.string().default(''),
  FOCUS_NFE_BASE_URL: z.string().url().default('https://api.focusnfe.com.br'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${issues}`);
  }
  return parsed.data;
}

// Singleton lazy: só valida quando alguém pede (facilita testes).
let cached: Env | undefined;
export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export const ENV = Symbol('ENV');
