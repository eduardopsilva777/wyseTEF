import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `npm run dev:setup` (ADR 0020) num diretório temporário: o .env real nunca é lido nem
 * alterado. Valores "legados" são fictícios e montados em tempo de execução.
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'dev-setup.mjs');
const dirs: string[] = [];

function workspace(env?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tef-dev-setup-'));
  dirs.push(dir);
  copyFileSync(join(ROOT, '.env.example'), join(dir, '.env.example'));
  if (env !== undefined) writeFileSync(join(dir, '.env'), env);
  return dir;
}
const run = (dir: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
const read = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(join(dir, '.env'), 'utf8')
      .split(/\r?\n/)
      .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
const user = (url: string | undefined) => decodeURIComponent(new URL(url ?? '').username);
const pass = (url: string | undefined) => decodeURIComponent(new URL(url ?? '').password);

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dev:setup — identidades de banco (ADR 0020)', () => {
  it('cria o .env com tef_owner, tef_app e tef_worker, senhas distintas e nunca impressas', () => {
    const dir = workspace();
    const r = run(dir);
    expect(r.status).toBe(0);
    const env = read(dir);
    expect(env['TEF_ENV']).toBe('dev');
    expect(user(env['TEF_OWNER_DATABASE_URL'])).toBe('tef_owner');
    expect(user(env['DATABASE_URL'])).toBe('tef_app');
    expect(user(env['TEF_WORKER_DATABASE_URL'])).toBe('tef_worker');
    const secrets = [pass(env['TEF_OWNER_DATABASE_URL']), pass(env['DATABASE_URL']), pass(env['TEF_WORKER_DATABASE_URL']), env['POSTGRES_PASSWORD']!];
    expect(new Set(secrets).size).toBe(4);
    for (const s of secrets) {
      expect(s.length).toBeGreaterThanOrEqual(32);
      expect(r.stdout + r.stderr).not.toContain(s);
    }
  });

  it('converte um .env legado (API como superusuário), preserva valores reais e guarda cópia', () => {
    const superPassword = `pw-${'s'.repeat(20)}`;
    const legacyUrl = ['postgres://tef_dev', `${superPassword}@127.0.0.1:55432/tef_dev`].join(':');
    const dir = workspace(
      [`POSTGRES_USER=tef_dev`, `POSTGRES_PASSWORD=${superPassword}`, `POSTGRES_DB=tef_dev`, `POSTGRES_PORT=55432`, `NODE_ENV=development`, `DATABASE_URL=${legacyUrl}`, `PORT=3999`].join('\n'),
    );
    const r = run(dir);
    expect(r.status).toBe(0);
    const env = read(dir);
    expect(user(env['DATABASE_URL'])).toBe('tef_app');
    expect(pass(env['DATABASE_URL'])).not.toBe(superPassword);
    expect(env['POSTGRES_PASSWORD']).toBe(superPassword); // valor real preservado
    expect(env['PORT']).toBe('3999');
    expect(env['TEF_ENV']).toBe('dev'); // coerente com NODE_ENV=development
    expect(readdirSync(dir).some((f) => f.startsWith('.env.backup-'))).toBe(true);
    expect(r.stdout).toMatch(/DATABASE_URL passou a usar a identidade tef_app/);
    expect(r.stdout + r.stderr).not.toContain(superPassword);
  });

  it('é idempotente; --rotate-db-passwords troca só as senhas das identidades', () => {
    const dir = workspace();
    run(dir);
    const first = read(dir);
    run(dir);
    expect(read(dir)).toEqual(first);
    const r = run(dir, '--rotate-db-passwords');
    expect(r.status).toBe(0);
    const rotated = read(dir);
    for (const k of ['TEF_OWNER_DATABASE_URL', 'DATABASE_URL', 'TEF_WORKER_DATABASE_URL']) {
      expect(user(rotated[k])).toBe(user(first[k]));
      expect(pass(rotated[k])).not.toBe(pass(first[k]));
    }
    expect(rotated['POSTGRES_PASSWORD']).toBe(first['POSTGRES_PASSWORD']);
    expect(rotated['TEF_DEV_ADMIN_TOKEN_SHA256']).toBe(first['TEF_DEV_ADMIN_TOKEN_SHA256']);
    expect(r.stdout).toMatch(/db:bootstrap/);
  });
});
