import { defineConfig, devices } from '@playwright/test';

/**
 * Testes ponta a ponta do painel WyseTEF. Rode com `npm run test:e2e`: o script prepara
 * um banco descartável e credenciais aleatórias e repassa tudo por variáveis de ambiente.
 * Usa o navegador instalado no sistema (Edge por padrão; PW_CHANNEL=chrome para Chrome).
 */
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ausente: rode os testes com "npm run test:e2e"`);
  return value;
};

const API_PORT = 3100;
const WORKER_HEALTH_PORT = 3101;
const WEB_PORT = 5180;
const base = { ...process.env } as Record<string, string>;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    channel: process.env['PW_CHANNEL'] ?? 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Edge'], channel: process.env['PW_CHANNEL'] ?? 'msedge', viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'node apps/api/src/main.ts',
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...base,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
        TEF_PERSISTENCE: 'postgres',
        DATABASE_URL: required('E2E_DATABASE_URL'),
        TEF_PROVIDER: 'simulator',
        TEF_PROVIDER_TIMEOUT_MS: '1500',
        TEF_API_CREDENTIALS: required('E2E_API_CREDENTIALS'),
        TEF_DEV_ADMIN_TOKEN_SHA256: required('E2E_ADMIN_TOKEN_SHA256'),
        TEF_ADMIN_ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
      },
    },
    {
      command: 'node apps/worker/src/main.ts',
      url: `http://127.0.0.1:${WORKER_HEALTH_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...base,
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        DATABASE_URL: required('E2E_DATABASE_URL'),
        TEF_PROVIDER: 'simulator',
        TEF_PROVIDER_TIMEOUT_MS: '1500',
        TEF_WORKER_ID: 'worker-e2e',
        TEF_WORKER_LEASE_MS: '5000',
        TEF_WORKER_POLL_MS: '200',
        TEF_WORKER_HEALTH_HOST: '127.0.0.1',
        TEF_WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
        TEF_SIMULATOR_DELAY_MS: '3000',
      },
    },
    {
      command: `node ../../node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort`,
      cwd: 'apps/web',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...base, TEF_WEB_API_PORT: String(API_PORT) },
    },
  ],
});
