# Product Brief — TEF Platform

> Situação em 2026-10-18: **Fase 2A (MVP local)**. Nenhuma integração real, nenhum pagamento real, nenhuma homologação.
> Este documento descreve objetivos, não funcionalidades existentes.

## Objetivo
Plataforma própria de orquestração de pagamentos (TEF), para licenciamento à AMLABS VENTURES e futura integração aos sistemas TouchPay. O produto oferece uma API padronizada sobre provedores e terminais já certificados (ver ADR 0002); ele não substitui a certificação desses provedores.

## Usuários
| Usuário | Necessidade |
|---|---|
| Integradores de automação comercial (PDV, autoatendimento) | Uma API estável para cobrar, consultar, cancelar e estornar, sem conhecer cada provedor |
| Operação/suporte da AMLABS | Visão de transações, resolução de resultados desconhecidos, conciliação, auditoria |
| Estabelecimentos (indiretamente) | Não ser cobrado em duplicidade; ter estornos rastreáveis |
| Parceiros terceiros (futuro) | SDK e documentação para integrar |

## Proposta de valor
1. API única com idempotência e prevenção de cobrança duplicada.
2. Tratamento explícito de resultados desconhecidos (sem repetição automática de cobrança).
3. Arquitetura de adaptadores por provedor, com capacidades declaradas.
4. Auditoria, conciliação e isolamento entre clientes e estabelecimentos.

## Escopo atual — implementado
- Núcleo transacional (domínio, máquina de estados, idempotência, persistência PostgreSQL, auditoria, outbox).
- API de integração assíncrona (202) com autenticação provisória; worker com fila durável.
- Cadastro de clientes, estabelecimentos e terminais simulados.
- Painel web local (dashboard, cadastro, transações, simulador, auditoria) com acesso de desenvolvimento.
- Adaptador **SIMULATOR** (dados fictícios).

## Fora de escopo nesta fase
Conexão com adquirentes ou provedores reais; pinpads; agente local; autenticação de produção (usuários, MFA, RBAC); emissão fiscal; Pix; SDK público; hospedagem fora da máquina local.

## Dependências comerciais em aberto
- Quais provedores/adquirentes têm contrato e sandbox disponíveis para a AMLABS/TouchPay.
- Modelo de licenciamento (SaaS, on-premise ou híbrido) e hierarquia de clientes.
- Propriedade intelectual e responsabilidades contratuais.
- Avaliação regulatória (PCI DSS / PCI Secure Software com QSA; LGPD; enquadramento junto ao Banco Central caso a plataforma venha a tocar fluxo de fundos — não é o desenho atual).
