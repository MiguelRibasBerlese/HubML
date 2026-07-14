import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Testes de integração compartilham um único Postgres e cada um faz TRUNCATE;
    // rodar arquivos em série evita corrida entre workers. Suite é rápida.
    fileParallelism: false,
    // Integration tests que precisam de Postgres se auto-pulam quando o banco não
    // está alcançável (ver test/integration/db.ts -> dbReachable()).
  },
});
