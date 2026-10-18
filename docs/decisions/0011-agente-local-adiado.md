# 0011 — Linguagem e estratégia offline do agente local

- **Status:** Pendente
- **Data:** 2026-10-18

## Por que adiar
A escolha depende do SDK oficial do terminal ou provedor (DLL nativa Windows 32/64 bits, SDK Android, API em nuvem), que ainda não foi recebido. Escolher antes seria adivinhar.

## Princípios já aceitos para quando for decidido
- Conexão somente de saída para a nuvem (mTLS); nenhuma porta de entrada exposta na internet.
- Diário local durável. **Operações sem resposta nunca são reenviadas automaticamente**; precisam ser reconciliadas antes de qualquer tentativa conflitante (ver 0007).
- Atualizações assinadas e verificadas.
- O PDV local também se autentica no agente (localhost não é fronteira de confiança).
