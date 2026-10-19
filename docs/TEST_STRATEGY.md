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
| Modelo assíncrono (memória) | `tests/application/async-worker.memory.test.ts` | Criação assíncrona, tarefa duplicada, queda antes e depois do envio, lease e fencing, UNKNOWN sem reenvio, outbox, encerramento gracioso, os 9 cenários do simulador ponta a ponta | Vitest |
| Modelo assíncrono (PostgreSQL) | `tests/integration/postgres-async.test.ts` | A mesma suíte assíncrona no PostgreSQL, 3 workers simultâneos, 2 publicadores simultâneos, tarefa duplicada barrada pelo banco, reinício do worker com livro durável, cadastro com integridade referencial, dashboard, API + worker juntos | Vitest + PostgreSQL |
| Relógio da fila (PostgreSQL) | `tests/integration/postgres-queue-clock.test.ts` | ADR 0019: com relógios de processo divergentes (±1 h, injetados; o relógio do sistema não é alterado), disponibilidade e expiração de lease seguem o relógio do banco; renovação, conclusão e reagendamento só com posse válida; worker que parou de renovar é substituído e a operação vira UNKNOWN sem reenvio; corrida entre recuperação e resposta original com um único envio; consulta expirada recuperada sem nova cobrança | Vitest + PostgreSQL |
| Painel (API administrativa) | `apps/api/test/admin.test.ts` | Sessão local, CSRF, origem, limite de tentativas, cookie, CRUD com isolamento entre clientes, simulador, reconciliação via worker, dashboard, auditoria, ausência de segredos em logs | Vitest |
| Frontend | `tests/security/frontend.test.ts` + `npm run check:web` | Sem variáveis de ambiente/segredos no código do navegador; bundle gerado sem valores do `.env`; todo carregamento de página exibe erro; atualização periódica continua após falha | Vitest + Vite |
| Migrações | `tests/integration/migrations.test.ts` | Banco existente na 0001 com dados legados recebe 0002–0004 sem perda; FK vale para linhas novas; idempotência; checksum | Vitest + PostgreSQL |
| Worker (config) | `apps/worker/test/config.test.ts` | Produção recusa simulador; health só em loopback; lease mínimo | Vitest |
| API | `apps/api/test` | Autenticação, autorização por tenant/estabelecimento, validação sem eco, idempotência HTTP, fluxo, sanitização de logs, erros genéricos | Vitest + `fastify.inject` |
| Configuração | `apps/api/test` | Produção recusa simulador/memória; erros não ecoam segredos | Vitest |

Na suíte assíncrona compartilhada, "fazer o tempo da fila passar" avança o relógio injetado em memória e, no PostgreSQL (relógio do banco), espera de verdade, com leases de centenas de milissegundos; entre testes, `quiesceQueue` encerra tarefas ativas de testes anteriores do mesmo schema.

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
- Testes Playwright versionados e testes de componentes do painel (ver ROADMAP, item 15).
- Testes de caos com processo real encerrado à força (hoje a queda é simulada pela recuperação de IN_FLIGHT).
- DAST, testes de carga e pentest externo (antes do piloto).
- Cobertura de código medida no CI.
- Testes de conformidade de adaptadores oficiais em sandbox (F4).
