# 0002 — Orquestrador semi-integrado, fora do fluxo de dados de cartão

- **Status:** Aceita
- **Data:** 2026-10-18

## Contexto
Construir uma pilha própria de captura (pinpad, kernel EMV, gestão de chaves, conexão direta com adquirentes) exige certificações e acordos que não existem e levariam anos.

## Decisão
A plataforma orquestra provedores e terminais **já certificados**, por meio de interfaces oficiais e autorizadas. O dado de cartão permanece no terminal ou na biblioteca do provedor. A plataforma só recebe resultados (status, referências, códigos) e nunca recebe PAN completo, CVV, trilha ou PIN.

## Consequências
- Escopo PCI potencialmente reduzido. **A confirmação cabe a um QSA**; nada é declarado conforme.
- O valor do produto está em: API única, idempotência, recuperação de resultados desconhecidos, conciliação, auditoria e gestão.
- Cada provedor exige contrato, documentação oficial e homologação própria antes de qualquer adaptador `OFFICIAL`.
