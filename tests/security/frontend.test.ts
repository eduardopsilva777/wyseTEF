import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Verificações estáticas do painel: nada de segredos nem variáveis VITE_ no código do navegador. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|css|html)$/.test(name) ? [p] : [];
  });
}

const WEB = 'apps/web';
const files = [...sources(join(WEB, 'src')), join(WEB, 'index.html')];

describe('painel web: ausência de segredos e exposição local', () => {
  it('não usa variáveis de ambiente no código do navegador', () => {
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      expect(content, f).not.toMatch(/import\.meta\.env\.(?!DEV\b|PROD\b|MODE\b)/);
      expect(content, f).not.toMatch(/\bVITE_[A-Z0-9_]+/);
      expect(content, f).not.toMatch(/process\.env/);
    }
  });

  it('não referencia credenciais nem variáveis sensíveis do servidor', () => {
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      expect(content, f).not.toMatch(/TEF_DEV_ADMIN_TOKEN_SHA256|TEF_API_CREDENTIALS|DATABASE_URL|TEF_DB_ADMIN_URL|POSTGRES_PASSWORD|keySha256/);
      expect(content, f).not.toMatch(/sessionStorage|document\.cookie|indexedDB/);
      // Único uso permitido de armazenamento local: a preferência de tema (sem dados de negócio).
      if (!f.endsWith('theme.ts')) expect(content, f).not.toMatch(/localStorage/);
    }
    const theme = readFileSync(join(WEB, 'src', 'theme.ts'), 'utf8');
    expect([...theme.matchAll(/localStorage\.(\w+)\(([^,)]+)/g)].map((m) => m[2])).toEqual(['THEME_KEY', 'THEME_KEY']);
    expect(theme).toMatch(/const THEME_KEY = 'wysetef-theme';/);
  });

  it('só chama a API administrativa relativa (mesma origem, via proxy local)', () => {
    const api = readFileSync(join(WEB, 'src', 'api.ts'), 'utf8');
    expect(api).toMatch(/fetch\(withQuery\(`\/admin\/api/);
    expect(api).toMatch(/credentials: 'same-origin'/);
    // O namespace XML do SVG (www.w3.org/2000/svg) é um identificador, não uma requisição.
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org\/2000\/svg)[a-z0-9.-]+\.[a-z]{2,}/i);
    }
  });

  it('servidor de desenvolvimento e preview escutam somente em loopback e sem expor variáveis', () => {
    const config = readFileSync(join(WEB, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/server:\s*{[^}]*host: '127\.0\.0\.1'/s);
    expect(config).toMatch(/preview:\s*{[^}]*host: '127\.0\.0\.1'/s);
    expect(config).toMatch(/envPrefix: 'TEF_WEB_PUBLIC_'/);
    const envExample = readFileSync('.env.example', 'utf8');
    expect(envExample).not.toMatch(/^TEF_WEB_PUBLIC_/m);
  });
});

describe('painel web: falhas de carregamento sempre comunicadas', () => {
  it('toda chamada useApi de página exibe o próprio erro', () => {
    const pages = sources(join(WEB, 'src', 'pages'));
    const missing: string[] = [];
    for (const f of pages) {
      const content = readFileSync(f, 'utf8');
      for (const m of content.matchAll(/const (\w+) = useApi\(/g)) {
        if (!content.includes(`${m[1]}.error`)) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('toda carga de dados tenta de novo após uma falha transitória (com ou sem atualização periódica)', () => {
    const ui = readFileSync(join(WEB, 'src', 'components', 'ui.tsx'), 'utf8');
    // A nova tentativa não pode depender de `pollMs`: telas sem atualização periódica também se recuperam.
    expect(ui).toMatch(/setError\(e\);[\s\S]{0,200}\n\s*timer = setTimeout\(\(\) => run\(false\), options\.pollMs \?\? RETRY_MS\);/);
    expect(ui).toMatch(/const RETRY_MS = \d+_?\d*;/);
  });
});
