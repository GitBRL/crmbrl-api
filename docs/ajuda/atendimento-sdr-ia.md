---
titulo: Atendimento com o SDR com IA (selo, assumir, devolver, sugestão e qualificação)
area: atendimento
telas: [/atendimento, /atendimento/:conversaId, /contatos/:id, /funis/:area, /funis/:area/:negocioId]
papeis: Quem vê a conversa (Admin, C-level, líder e membro de Comercial ou CS) usa tudo isto. A qualificação aparece no contato e no negócio para quem os vê. Quem liga e desliga a IA é só o Admin, em Configurações.
palavras-chave: [sdr, ia, ia atendendo, assumir, devolver para a ia, modo sugestão, resposta sugerida, qualificação, temperatura, quente, morno, frio, nota, critérios, passou para humano, resumo]
---
# Atendimento com o SDR com IA

O SDR com IA é uma assistente virtual que atende o lead novo nos canais em que o Admin a ligou, descobre os critérios de qualificação, dá uma nota e uma temperatura e, quando o lead está qualificado, passa o negócio para o Comercial com um resumo. Quem liga e configura é o Admin (veja `configuracoes-sdr-ia.md`). Aqui está o que você vê e faz no dia a dia.

## Como reconhecer uma conversa atendida pela IA
- Na **lista**, a conversa tem o selo **IA atendendo** (ou **IA sugerindo**, no modo sugestão). O leitor de tela também ouve o modo.
- No **cabeçalho da conversa**, o mesmo selo aparece embaixo do nome. Logo abaixo fica a **faixa da IA**, que explica o que está acontecendo: se a IA responde sozinha, se espera a sua aprovação, se uma pessoa assumiu ou por que ela passou a conversa para a equipe.
- As mensagens da IA aparecem com a marca **IA** ao lado da hora.
- Para ver só essas conversas, abra **Filtros**, em **Só as que**, e escolha **Atendidas pela IA**. O filtro olha as conversas já carregadas na lista; ela busca mais páginas sozinha até mostrar pelo menos 10.

## Decisões da IA na conversa
A conversa mostra, em linhas discretas no meio das mensagens, o que a IA decidiu:
- **A IA descobriu: Curso de interesse, Cidade (nota 40).** Cada vez que o lead dá um critério.
- **Qualificou o lead (nota 100) e passou para <vendedor> no Comercial.** O negócio vai para o funil Comercial pelo rodízio.
- **Passou para a equipe: <motivo>.** Com o **resumo** do que o lead disse, para quem continua não precisar perguntar de novo. O mesmo resumo fica na faixa, em **Resumo da IA para quem continua**.
- **Desqualificou o lead** (com o motivo), **devolveu a conversa para a IA** e os avisos de que algo impediu a IA (limite, orçamento, falha).

## Assumir e devolver para a IA
1. Com a IA atendendo, clique em **Assumir** na faixa. O CRM pede uma confirmação curta: a IA para de responder e a conversa fica com você.
2. Com a conversa com uma pessoa, passada para a equipe ou desqualificada, a faixa mostra **Devolver para a IA**. Confirme: a IA volta a atender e responde o que ficou sem resposta.
3. Se você responder o lead sem clicar em Assumir, a IA também para. Ela só volta quando alguém usar **Devolver para a IA**.
**Devolver** só aparece se o canal ainda tem o SDR ligado e a IA está configurada no servidor.

## Modo sugestão: aprovar, editar ou descartar
Nos canais em modo sugestão a IA não envia nada sozinha. Acima do campo de mensagem aparece o painel **Resposta sugerida pela IA**:
- **Enviar** manda o texto ao lead como se fosse você e aplica o que a IA propôs (por exemplo, gravar os critérios descobertos).
- **Editar e enviar** abre o texto para você mudar; **Enviar editada** manda a sua versão.
- **Descartar** não manda nada.
O painel se atualiza sozinho quando o lead escreve de novo (a sugestão antiga perde a vez e chega outra). Quando a sugestão também propõe qualificar, desqualificar ou passar para a equipe, o painel avisa o que acontece ao enviar.

## Qualificação no contato e no negócio
O cartão **Qualificação** aparece no detalhe do contato e no detalhe do negócio (Marketing e Comercial). Mostra:
- a **situação** (IA atendendo, passada para a equipe, qualificada, desqualificada);
- a **temperatura**, sempre escrita: **Quente**, **Morno** ou **Frio**, e a **nota** de 0 a 100 (com a nota mínima para qualificar);
- cada **critério**: o valor descoberto, **quem descobriu** (IA ou Pessoa) e a **confiança**; os que faltam dizem "Ainda não descoberto" ou "Falta descobrir" (obrigatórios);
- o **motivo** e o **resumo da IA**, e o link **Abrir a conversa**.
Se a IA nunca conversou com o lead, o cartão diz isso. No **quadro do funil**, o cartão do negócio mostra a temperatura (ícone, cor e texto) e a nota, por exemplo "Quente 100/100".

## Se algo não aparece
- Sem o selo e sem a faixa: a IA nunca atendeu a conversa (canal desligado, cliente que já tem negócio aberto no Comercial ou no CS, ou e-mail).
- "Devolver para a IA" some ou dá erro: o canal está desligado em Configurações > SDR com IA, ou o orçamento de tokens acabou. Fale com o Admin.
