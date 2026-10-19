// Sobe o ambiente LOCAL completo: PostgreSQL (Docker), migrações, API, worker e painel.
// Tudo escuta somente em 127.0.0.1. Ctrl+C encerra os processos filhos.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('.env')) {
  console.error('Falta o .env. Rode primeiro: npm run dev:setup');
  process.exit(1);
}
process.loadEnvFile('.env'); // não sobrescreve variáveis já definidas no ambiente

const step = (label, cmd, args) => {
  console.log(`[dev] ${label}`);
  // Sem shell: argumentos não são concatenados nem interpretados.
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[dev] falhou: ${label}`);
    process.exit(r.status ?? 1);
  }
};

step('PostgreSQL local (docker compose)', 'docker', ['compose', '-f', 'infra/dev/docker-compose.yml', '--env-file', '.env', 'up', '-d', '--wait']);
step('migrações', process.execPath, ['packages/persistence/src/cli/migrate.ts']);

const children = [];
const start = (name, args, cwd = process.cwd()) => {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${name}]`.padEnd(9);
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) out.write(`${prefix} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix} encerrado (código ${code ?? 'sinal'})`);
    if (!stopping) shutdown(1);
  });
  children.push(child);
};

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', ['apps/api/src/main.ts']);
start('worker', ['apps/worker/src/main.ts']);
start('web', ['../../node_modules/vite/bin/vite.js'], 'apps/web');

console.log(`
[dev] Painel:      http://127.0.0.1:5173
[dev] API:         http://127.0.0.1:${process.env.PORT ?? '3000'}  (health: /health)
[dev] Worker:      http://127.0.0.1:${process.env.TEF_WORKER_HEALTH_PORT ?? '3001'}/health
[dev] Dados de demonstração (opcional, em outro terminal): npm run db:seed
`);
