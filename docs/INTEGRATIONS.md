# Integrações e adaptadores

## Estratégia
Cada provedor é um adaptador que implementa `PaymentProvider` (`packages/providers/contract`). O adaptador **traduz** requisições e respostas; não decide estado. Ele declara `ProviderCapabilities` a partir da **documentação oficial**. Na dúvida, a capacidade fica `false`.

| Capacidade | Efeito no domínio |
|---|---|
| `twoPhaseConfirmation` | Permite AUTHORIZED, confirmação |
| `undo` | Permite desfazimento de AUTHORIZED |
| `cancellation` | Permite cancelamento total de APPROVED |
| `refund.full` / `refund.partial` | Permite estorno total / parcial |
| `query` | Permite reconciliação por consulta |
| `queryNotFoundIsDefinitive` | "Não encontrado" encerra a operação como NOT_SENT |
| `guaranteesNotSentOnPreSendFailure` | O adaptador pode afirmar NOT_SENT |

## Regras para qualquer adaptador
1. Só existe adaptador `OFFICIAL` com contrato, credenciais de **ambiente de testes** e documentação oficial do provedor. Nada de engenharia reversa ou tentativa e erro com pinpads.
2. Nunca receber, registrar ou devolver PAN completo, CVV, trilha ou PIN.
3. Enviar `clientReference` (ID da operação) ao provedor quando ele suportar referência do cliente, para consulta e deduplicação.
4. Em dúvida após possível envio: UNKNOWN (ou lançar erro).
5. Respeitar `AbortSignal`.
6. Passar na suíte `runProviderConformanceSuite` (`@tef/provider-contract/conformance`).
7. Códigos de resultado e referências devem ser tokens curtos (`[A-Za-z0-9_.:-]`, até 64 caracteres; referência também aceita `/`, até 128). A aplicação substitui códigos fora do padrão por `PROVIDER_CODE_INVALID` e descarta referências fora do padrão ou com número que passe no Luhn.
8. Notificações (webhooks) devem ser autenticadas pelo adaptador conforme o mecanismo oficial antes de chegar a `handleProviderNotification`.

## SIMULATOR (implementado)
`packages/providers/simulator`. **Não é adquirente nem provedor real**, não reproduz nenhum provedor específico e não simula homologação. Referências `SIM-########`, códigos `SIM_*`; respostas da API trazem `provider.simulated: true`. É recusado com `NODE_ENV=production`.

Cenários: aprovação (com ou sem confirmação), recusa, abandono no terminal, timeout antes do envio, timeout após envio, resposta atrasada (com notificação), falha de comunicação, resposta duplicada, desconhecido esclarecido por consulta.

No painel local, o cenário é uma **diretiva de teste** gravada com o pagamento (`provider_test_directives`, aceita só para `SIMULATOR`); o worker a lê ao executar a autorização. O que o simulador "processou" fica no **livro durável** `simulator_ledger` (ADR 0016), para que consultas de qualquer processo, inclusive após reinício, vejam o mesmo resultado.

Convenção para testes manuais (somente simulador, centavos finais do valor da autorização): `,51` recusa · `,52` abandono · `,53` timeout antes do envio · `,54` timeout após envio · `,55` resposta atrasada · `,56` falha de comunicação · `,57` resposta duplicada · `,58` desconhecido esclarecido por consulta · demais: aprovação.

## Informações necessárias (TouchPay e provedores)
| Tema | Pergunta | Bloqueia |
|---|---|---|
| TouchPay | Tipo de sistema (PDV, autoatendimento, totem), SO, linguagem, como recebe pagamentos hoje | Agente local, SDK, contrato da API |
| Provedores | Quais têm contrato/sandbox; documentação de API/SDK | Primeiro adaptador oficial |
| Provedores | Duas fases? Desfazimento? Consulta? "Não encontrado" é definitivo? Estorno parcial? Notificações e como são autenticadas? | Capacidades declaradas |
| Provedores | Arquivos de conciliação (formato, frequência) | Conciliação por arquivo |
| Provedores | Roteiro e prazo de homologação | Planejamento da F4 |
| Operação | Necessidade e tolerância offline | Estratégia do agente (ADR 0011) |
| Fiscal | Documentos emitidos (ex.: NFC-e), dados de pagamento exigidos, quem emite | Modelo fiscal separado |
| Negócio | Hierarquia de clientes, volume, SLAs, nuvem preferida | Multi-tenant, capacidade, implantação |
