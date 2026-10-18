# 0008 — Auditoria encadeada por hash e outbox transacional

- **Status:** Aceita (ancoragem externa pendente)
- **Data:** 2026-10-18

## Decisão
- Cada mudança relevante gera um evento de auditoria na mesma transação, encadeado por SHA-256 por tenant (`seq`, `prev_hash`, `hash`).
- Os dados de auditoria passam por uma **lista de campos permitidos**; o resto é descartado.
- Um gatilho rejeita UPDATE/DELETE/TRUNCATE em `audit_events`.
- Eventos de integração vão para `outbox_events` na mesma transação. O publicador ainda não existe.

## O que isto NÃO garante
O encadeamento **detecta** alteração, remoção ou reordenação; ele **não impede** que alguém com privilégio de dono da tabela ou de superusuário desative o gatilho e reescreva a cadeia inteira.

Controles complementares necessários (pendentes):
- papel de aplicação sem privilégios de DDL nem de dono das tabelas;
- ancoragem periódica do hash da cabeça em armazenamento externo imutável (WORM);
- verificação agendada da cadeia, com alertas.

Ver `docs/THREAT_MODEL.md`.
