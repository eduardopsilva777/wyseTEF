// Gera o bundle do painel e verifica que nenhum segredo foi parar no JavaScript
// entregue ao navegador: valores reais do .env (se existir), nomes de variáveis
// sensíveis e padrões genéricos de credenciais.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const build = spawnSync(process.execPath, ['../../node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'], {
  cwd: 'apps/web',
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk('apps/web/dist');

const secretValues = [];
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.+)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (/PASSWORD|DATABASE_URL|SHA256|CREDENTIALS/.test(key) && value.length >= 8) secretValues.push([key, value]);
    for (const h of value.matchAll(/[0-9a-f]{64}/g)) secretValues.push([`${key} (hash)`, h[0]]);
  }
}

const SENSITIVE_NAMES = /\b(TEF_DEV_ADMIN_TOKEN_SHA256|TEF_API_CREDENTIALS|DATABASE_URL|POSTGRES_PASSWORD|VITE_[A-Z0-9_]+)\b/;
const GENERIC = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/i];

const findings = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const [key, value] of secretValues) if (content.includes(value)) findings.push(`${file}: contém o valor de ${key}`);
  if (SENSITIVE_NAMES.test(content)) findings.push(`${file}: referência a variável sensível (${SENSITIVE_NAMES.exec(content)?.[1]})`);
  for (const re of GENERIC) if (re.test(content)) findings.push(`${file}: padrão de credencial (${re.source.slice(0, 24)}…)`);
}

if (findings.length > 0) {
  console.error(`check-web: ${findings.length} achado(s) (valores omitidos):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-web: bundle com ${files.length} arquivo(s) verificado(s), nenhum segredo encontrado (${secretValues.length} valores do .env comparados).`);
