# 0004 — PostgreSQL como fonte da verdade e estratégia de concorrência

- **Status:** Aceita
- **Data:** 2026-10-18

## Decisão
- PostgreSQL é a única fonte da verdade do estado transacional. Migrações SQL versionadas e imutáveis (checksum verificado; advisory lock impede migradores simultâneos).
- Transações READ COMMITTED com:
  1. `SELECT … FOR UPDATE` no pagamento antes de qualquer mudança nele ou em suas operações. As operações não são bloqueadas individualmente; elas só mudam sob o bloqueio do pagamento. A cabeça da cadeia de auditoria do tenant é sempre o último bloqueio adquirido na transação, o que evita ciclos de espera;
  2. controle otimista de versão em todo `UPDATE`;
  3. índices únicos parciais como última barreira: referência comercial protegida, uma operação aberta por pagamento, uma autorização por pagamento;
  4. `CHECK`s de consistência (evidência obrigatória em resultado final, saldo revertido ≤ valor, REVERSED ⇒ saldo integralmente revertido).
- Todas as consultas são parametrizadas.

## Evidência
Testes de integração em `tests/integration/postgres.test.ts` (PostgreSQL 18 via Docker), incluindo 30 requisições concorrentes de criação e de autorização, com verificação posterior da cadeia de auditoria e do outbox, e criações concorrentes em dois tenants.

## Consequências
- A cabeça da cadeia de auditoria por tenant serializa as gravações de auditoria do mesmo tenant. Aceitável na F1; medir antes do piloto.
- A implementação em memória serve apenas para testes unitários e **não** prova garantias transacionais.
