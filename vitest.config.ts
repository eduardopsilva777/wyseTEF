import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Testes de integração com PostgreSQL abrem conexões; evita paralelismo excessivo entre arquivos.
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
