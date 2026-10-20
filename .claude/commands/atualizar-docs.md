---
description: Atualiza a documentação de código e arquitetura da crmbrl-api, registrando o que foi feito
argument-hint: "[resumo do que foi feito]"
allowed-tools: Bash(bun run docs:*), Bash(node tools/doc-updater/index.mjs:*), Bash(git:*), Read, Edit, Glob, Grep
---

# Atualizar documentação — crmbrl-api

Argumentos recebidos: `$ARGUMENTS`

Você vai atualizar a documentação deste projeto (API NestJS do CRM BRL), combinando
duas coisas: o inventário técnico, que a ferramenta gera sozinha, e a parte
narrativa, que é você quem escreve.

## 1. Rodar a ferramenta

```
bun run docs --nota "<resumo>"
```

Este projeto usa **bun**, então as flags vão direto, sem `--`. Sem nota, é só
`bun run docs`. Equivale a `node tools/doc-updater/index.mjs`.

Tudo que veio em `$ARGUMENTS` vira a nota — é o campo **"o que foi feito"** do
histórico. Se nada foi passado, rode sem `--nota` e deixe o diff dos commits contar
a história; não invente um resumo.

A ferramenta grava `docs/ARQUITETURA.md` (miolo entre os marcadores
`doc-updater:inicio`/`:fim`), `docs/HISTORICO.md` (entrada nova no topo) e
`docs/.estado-docs.json`.

## 2. Conferir o que mudou de verdade

Leia a entrada nova do `docs/HISTORICO.md`. Se o inventário acusar mudanças
estruturais que a nota não explica — endpoint novo, provider removido, dependência
trocada, variável de ambiente nova —, abra o código correspondente antes de escrever
qualquer coisa.

**Endpoint novo é mudança de contrato.** Sempre que a tabela de endpoints mudar,
descreva no Contexto o que o endpoint faz, o que ele espera e o que devolve — o
front-end `crmbrl` depende disso e não compartilha tipos com esta API.

## 3. Escrever a parte que a ferramenta não escreve

Só as seções **fora** dos marcadores são suas; nunca edite o miolo gerado, ele é
sobrescrito na próxima execução. Atualize, quando houver o que dizer:

- **Contexto**: o fluxo real — bootstrap, módulo raiz, o que cada módulo de domínio
  resolve, camada de persistência, middlewares e pipes globais. Não repita a
  estrutura de pastas, a tabela já mostra.
- **Decisões de arquitetura**: padrão adotado, alternativa descartada e o porquê.
  Uma decisão por item, com a data. Mantenha a lista de pendências em dia: o que foi
  resolvido sai de "pendente" e vira decisão registrada.

Pontos que valem registro neste projeto quando aparecerem: banco e camada de acesso
a dados, validação de entrada e formato padrão de erro, autenticação/autorização,
CORS, versionamento de rota, e qualquer segredo que precise sair do código para
variável de ambiente.

Escreva em português do Brasil, no mesmo tom direto do resto da documentação. Só
afirme o que você consegue sustentar lendo o código ou o histórico.

## 4. Fechar

Responda com um resumo curto: arquivos de documentação tocados, mudanças estruturais
detectadas e o que ficou pendente de descrição humana. Não faça commit — a menos que
o usuário tenha pedido.
