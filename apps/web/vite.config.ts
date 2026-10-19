import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Painel administrativo LOCAL.
 * - Escuta somente em loopback (127.0.0.1), porta fixa.
 * - Só a rota /admin é encaminhada à API local; o navegador fala com uma única origem,
 *   então o cookie de sessão (HttpOnly, SameSite=Strict) funciona sem CORS.
 * - Nenhuma variável de ambiente é exposta ao bundle: o prefixo abaixo não é usado
 *   por nenhuma variável do projeto (segredos nunca usam VITE_).
 */
export default defineConfig({
  plugins: [react()],
  envPrefix: 'TEF_WEB_PUBLIC_',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/admin': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { sourcemap: false },
});
