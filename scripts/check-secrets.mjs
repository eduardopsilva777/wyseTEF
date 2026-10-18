// Varredura simples de segredos e de dados de cartão nos arquivos do repositório
// (rastreados ou não ignorados pelo Git). Não substitui uma ferramenta dedicada
// (ex.: gitleaks no CI), mas impede os erros mais comuns antes do commit.
// Linha com o marcador "secret-scan:allow" é ignorada (use com justificativa).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: 'credential-assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"]([^'"\s]{8,})['"]/i,
    allowValue: (v) => /^(?:<.*>|\$\{.*\}|defina-.*|changeme|placeholder|\[REDACTED\])$/i.test(v),
  },
  {
    id: 'connection-string-password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:([^@\s]+)@/i,
    allowValue: (v) => /^(?:<.*>|\$\{.*\}|defina-uma-senha-local|\$\{?[A-Z_]+\}?)$/.test(v),
  },
];

/** Sequências de 13 a 19 dígitos que passam no algoritmo de Luhn (possível PAN). */
function luhnCandidates(line) {
  const found = [];
  for (const match of line.matchAll(/(?<![\d])\d{13,19}(?![\d])/g)) {
    const digits = match[0];
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) found.push(digits);
  }
  return found;
}

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !/(^|\/)(package-lock\.json|node_modules\/)/.test(f));

const findings = [];

const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' }).split('\0');
for (const forbidden of ['.env']) {
  if (tracked.includes(forbidden) || files.includes(forbidden)) {
    findings.push(`${forbidden}: arquivo de segredos não está ignorado pelo Git`);
  }
}

for (const file of files) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue; // removido no working tree
  }
  if (!stat.isFile() || stat.size > 1_000_000) continue;
  const content = readFileSync(file, 'utf8');
  if (content.includes('\u0000')) continue; // binário
  content.split(/\r?\n/).forEach((line, index) => {
    if (line.includes('secret-scan:allow')) return;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m && !(rule.allowValue && m[1] !== undefined && rule.allowValue(m[1]))) {
        findings.push(`${file}:${index + 1}: ${rule.id}`);
      }
    }
    if (luhnCandidates(line).length > 0) findings.push(`${file}:${index + 1}: possible-card-number`);
  });
}

if (findings.length > 0) {
  console.error(`check-secrets: ${findings.length} achado(s) (valores omitidos):`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-secrets: ${files.length} arquivos verificados, nenhum achado.`);
