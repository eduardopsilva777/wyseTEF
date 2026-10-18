# 0001 — Monólito modular com portas e adaptadores

- **Status:** Aceita
- **Data:** 2026-10-18

## Contexto
O produto precisa evoluir com vários provedores, persistência auditável e, no futuro, um agente local. A equipe é pequena e o domínio ainda está sendo descoberto.

## Decisão
Um monólito modular em monorepositório, com separação hexagonal:
`domain` (puro, sem I/O) → `application` (casos de uso e portas) → adaptadores (`providers/*`, `persistence`, `apps/api`).
Microsserviços não são adotados nesta fase.

## Consequências
- Regras de negócio testáveis sem banco nem rede.
- Fronteiras explícitas permitem extrair serviços depois, se houver motivo medido (escala, isolamento, implantação independente).
- O lint impede imports de I/O no domínio (`eslint.config.js`).
