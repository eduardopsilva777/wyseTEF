// Prepara o .env LOCAL de desenvolvimento.
// - Se .env não existe: cria a partir de .env.example com segredos aleatórios.
// - Se existe: só acrescenta variáveis ausentes e preenche marcadores de exemplo
//   ("<...>" ou "defina-..."); nunca altera um valor real já definido.
// - Segredos em texto puro (token do painel, chave de API) são exibidos UMA vez
//   neste terminal e não são gravados em disco; o .env guarda apenas o SHA-256.
// - Identidades de banco (ADR 0020): gera senhas aleatórias para tef_owner (migrações),
//   tef_app (API) e tef_worker (worker) e grava as URLs no .env. As senhas NUNCA são
//   exibidas. Um .env antigo, cuja DATABASE_URL usa o superusuário do contêiner, é
//   convertido (com cópia de segurança .env.backup-*, também ignorada pelo Git).
// Uso: npm run dev:setup            (cria/completa)
//      npm run dev:setup -- --rotate-admin-token   (gera novo token do painel)
//      npm run dev:setup -- --rotate-api-key       (gera nova chave de integração)
//      npm run dev:setup -- --rotate-db-passwords  (novas senhas locais; depois: npm run db:bootstrap)
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const rotate = process.argv.includes('--rotate-admin-token');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const isPlaceholder = (v) => v === '' || /<[^>]+>|defina-/.test(v);

const example = readFileSync('.env.example', 'utf8');
const exists = existsSync('.env');
const lines = (exists ? readFileSync('.env', 'utf8') : example).split(/\r?\n/);
const index = new Map();
lines.forEach((l, i) => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
  if (m) index.set(m[1], i);
});
const get = (k) => (index.has(k) ? lines[index.get(k)].slice(k.length + 1) : undefined);
const set = (k, v) => {
  if (index.has(k)) lines[index.get(k)] = `${k}=${v}`;
  else {
    lines.push(`${k}=${v}`);
    index.set(k, lines.length - 1);
  }
};

// Variáveis do exemplo que faltam no .env existente.
for (const l of example.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
  if (m && !index.has(m[1])) set(m[1], m[2]);
}

const shown = [];
const notes = [];
const password = get('POSTGRES_PASSWORD');
if (password === undefined || isPlaceholder(password)) set('POSTGRES_PASSWORD', randomBytes(24).toString('hex'));

// Identidades de banco: URL com o papel certo e senha própria (nunca a do superusuário).
const userOf = (url) => {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
};
const rotateDb = process.argv.includes('--rotate-db-passwords');
const dbHost = `127.0.0.1:${get('POSTGRES_PORT') || '55432'}`;
const dbName = encodeURIComponent(get('POSTGRES_DB') || 'tef_dev');
let backupNeeded = false;
for (const [variable, role] of [['TEF_OWNER_DATABASE_URL', 'tef_owner'], ['DATABASE_URL', 'tef_app'], ['TEF_WORKER_DATABASE_URL', 'tef_worker']]) {
  const current = get(variable);
  const legacy = current !== undefined && !isPlaceholder(current) && userOf(current) !== role;
  if (rotateDb || current === undefined || isPlaceholder(current) || legacy) {
    if (legacy) {
      backupNeeded = true;
      notes.push(`${variable} passou a usar a identidade ${role} (antes: outro usuário).`);
    }
    set(variable, `postgres://${role}:${randomBytes(24).toString('hex')}@${dbHost}/${dbName}`);
    if (rotateDb) notes.push(`${variable}: nova senha local para ${role}.`);
  }
}
if (backupNeeded && exists) {
  const backup = `.env.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync('.env', backup);
  notes.push(`Cópia do .env anterior: ${backup} (ignorada pelo Git; apague quando não precisar mais).`);
}

const creds = get('TEF_API_CREDENTIALS');
if (process.argv.includes('--rotate-api-key') || creds === undefined || isPlaceholder(creds)) {
  const key = randomBytes(32).toString('base64url');
  set('TEF_API_CREDENTIALS', JSON.stringify([{ keyId: 'dev-local', keySha256: sha(key), tenantId: 'demo-mercado', merchantIds: ['loja-centro'] }]));
  shown.push(['Chave de API de integração (Bearer) para o cliente demo-mercado', key]);
}

const admin = get('TEF_DEV_ADMIN_TOKEN_SHA256');
if (rotate || admin === undefined || isPlaceholder(admin)) {
  const token = randomBytes(32).toString('base64url');
  set('TEF_DEV_ADMIN_TOKEN_SHA256', sha(token));
  shown.push(['Token do painel administrativo local', token]);
}

writeFileSync('.env', lines.join('\n').replace(/\n*$/, '\n'));
console.log(exists ? '.env atualizado (apenas variáveis ausentes, marcadores de exemplo ou identidades de banco antigas).' : '.env criado.');
for (const note of notes) console.log(`- ${note}`);
if (notes.length) console.log('Aplique as identidades de banco: npm run db:up && npm run db:bootstrap (o npm run dev já faz isso).');
if (shown.length === 0) {
  console.log('Nada novo para exibir. Para gerar outro token do painel: npm run dev:setup -- --rotate-admin-token');
} else {
  console.log('\nGuarde agora (não ficam gravados em lugar nenhum; o .env só tem o SHA-256):');
  for (const [label, value] of shown) console.log(`  ${label}:\n    ${value}`);
  console.log('\nSe a API já estiver rodando, reinicie-a para ler o novo hash.');
}
