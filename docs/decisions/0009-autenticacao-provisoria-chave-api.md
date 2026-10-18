# 0009 — Autenticação provisória por chave de API

- **Status:** Provisória (revisar antes de qualquer piloto)
- **Data:** 2026-10-18 (revisada na auditoria pré-commit da F1)

## Decisão
- `Authorization: Bearer <chave>`. A autenticação ocorre no `onRequest`, **antes** da leitura do corpo e da validação de parâmetros: sem credencial válida, toda rota `/v1/*` responde 401 com corpo idêntico para credencial ausente ou inválida.
- **Geração:** fora da aplicação, com 32 bytes aleatórios (`crypto.randomBytes`), conforme o README. A aplicação não gera chaves.
- **Armazenamento:** só o SHA-256 da chave é configurado (`TEF_API_CREDENTIALS`). Hash sem sal é adequado apenas porque as chaves são aleatórias de alta entropia; senhas escolhidas por pessoas exigiriam KDF lenta.
- **Comparação:** SHA-256 da chave apresentada × hash configurado, com `timingSafeEqual`, percorrendo todas as credenciais.
- **Revogação:** remover a entrada da configuração e reiniciar. Não há expiração nem revogação em tempo real.
- Tenant e estabelecimentos permitidos vêm da credencial, nunca do corpo. Pagamento de outro tenant ou de estabelecimento não autorizado responde 404.
- Não há HMAC com segredo embutido em aplicativo cliente como fronteira de autenticação.
- **Exposição:** sem autenticação definitiva e sem limite de taxa, a configuração recusa `HOST` fora de loopback nesta fase.

## Pendências (F2)
- Credenciais por cliente com rotação, expiração e revogação sem reinício, guardadas em cofre (por exemplo, OAuth2 client credentials e/ou mTLS).
- Limite de taxa por credencial e por origem; proteção de borda.
- Papéis administrativos com MFA; registro de uso por credencial.
- Garantia de entropia mínima das chaves no processo de emissão.
