---
titulo: Criar, testar e ligar uma automação
area: automacoes
telas: [/automacoes, /automacoes/nova, /automacoes/:id]
papeis: Admin e C-level (todas); líder (as da área). Membros não acessam.
palavras-chave: [automação, gatilho, condição, passos, espera, cadência, modo teste, ativar, pausar, modelos prontos, histórico de execuções]
---
# Criar, testar e ligar uma automação

1. Abra **Automações** e clique em **Nova automação**. Ou, em **Modelos prontos**, clique em **Usar** (boas-vindas ao lead, follow-up de proposta, lembrete de renovação, reativação): cria uma cópia pausada e pede só o que falta.
2. Defina nome e área; o **gatilho** (um evento, com filtros como a etapa, ou uma agenda); as **condições** (segmento e horário permitido); os **passos** (ações, esperas, "se… senão"); **quando parar** (respondeu, ganhou, perdeu, saiu do segmento) e o limite por entidade.
3. **Salvar** nunca liga a automação.
4. Use o **modo teste**: escolha um registro e rode tudo sem efeitos externos. Mensagens, atividades e webhooks aparecem como "simulado" e as esperas são puladas.
5. Para ligar, ative; só funciona com tudo preenchido (o CRM lista as pendências).

Na lista você ativa, pausa, duplica e exclui, e vê "Última vez". A aba **Histórico** mostra o passo a passo de cada execução, com **Tentar de novo** nos passos que falharam e cancelar nas que esperam.

## Gatilho do SDR com IA
**Lead qualificado pela IA** dispara quando o SDR com IA qualifica um lead e abre o negócio no Comercial; a automação roda para o **negócio**. Filtros opcionais: **temperatura do lead** (quente, morno ou frio; marque uma ou mais), **tipo de canal** e **canal**. Exemplo: lead **quente** mais um passo de atividade "Ligar agora" para o vendedor. Use o **modo teste** antes de ligar.

## Gatilhos de ligação
No gatilho **O que acontece** há dois eventos de ligação do WhatsApp oficial, que rodam para o **contato**:
- **Ligação perdida:** dispara quando uma ligação **recebida** termina perdida (ninguém atendeu, todos recusaram ou foi fora do horário). Filtro opcional: o **canal**.
- **Ligação encerrada:** dispara em **todo** desfecho. Filtros opcionais: o **canal**, **quem ligou** (recebidas, feitas ou as duas) e **como a ligação terminou** (atendida, perdida, recusada, sem resposta, falhou; marque um ou mais).
Um exemplo: "ligação perdida" mais um passo de mensagem ou de atividade para retornar o contato. Use o **modo teste** antes de ligar.
