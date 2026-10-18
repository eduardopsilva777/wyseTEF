# Estratégia de testes

## Camadas

| Camada | Onde | O que prova | Ferramenta |
|---|---|---|---|
| Unitário de domínio | `packages/domain/test` | Money, tabela de transições (comparada à documentação), evidência, capacidades, efeitos das operações, estornos | Vitest |
| Propriedades | `packages/domain/test`, `packages/audit/test` | Nenhuma sequência aleatória de eventos sai das transições documentadas; revertido ≤ aprovado; aritmética monetária; JSON canônico | fast-check |
| Auditoria | `packages/audit/test` | Encadeamento, detecção de alteração/remoção/reordenação, sanitização | Vitest |
| Contrato de provedor | `packages/providers/simulator/test` | Suíte de conformidade + cada cenário do simulador | Vitest |
| Serviço (memória) | `tests/application` | Idempotência, referência protegida, falhas, UNKNOWN, reconciliação, recuperação, estornos, isolamento, auditoria | Vitest |
| Serviço (PostgreSQL) | `tests/integration` | **A mesma suíte do serviço** contra PostgreSQL real, mais restrições do esquema, gatilho de auditoria, SQL parametrizado, isolamento SQL, concorrência com 30 requisições | Vitest + PostgreSQL 18 (Docker) |
| API | `apps/api/test` | Autenticação, autorização por tenant/estabelecimento, validação sem eco, idempotência HTTP, fluxo, sanitização de logs, erros genéricos | Vitest + `fastify.inject` |
| Configuração | `apps/api/test` | Produção recusa simulador/memória; erros não ecoam segredos | Vitest |

A implementação em memória serializa transações; ela **não** prova garantias do PostgreSQL. Garantias transacionais só contam como verificadas quando `npm run test:db` passa.

## Comandos
- `npm test` — tudo; os testes de PostgreSQL aparecem como **skipped** sem `TEST_DATABASE_URL`.
- `npm run test:db` — só integração com PostgreSQL; falha se o banco não estiver configurado.
- `npm run verify` — lint, tipos, testes, varredura de segredos e auditoria de dependências.

## Regras
- Todo bug corrigido ganha um teste que falharia antes da correção.
- Dados de teste são fictícios; números "parecidos com cartão" usados como entrada negativa são montados em tempo de execução (não ficam literais no repositório).
- Nenhum teste chama serviço externo.

## Lacunas (planejado)
- Testes de caos com processo real encerrado à força (hoje a queda é simulada pela recuperação de IN_FLIGHT).
- DAST, testes de carga e pentest externo (antes do piloto).
- Cobertura de código medida no CI.
- Testes de conformidade de adaptadores oficiais em sandbox (F4).
