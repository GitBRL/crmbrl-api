---
titulo: Configurar o SDR com IA (canais, persona, base, critérios, limites e simulador)
area: configuracoes
telas: [/configuracoes/sdr, /configuracoes/sdr/canais, /configuracoes/sdr/persona, /configuracoes/sdr/conhecimento, /configuracoes/sdr/criterios, /configuracoes/sdr/regras, /configuracoes/sdr/simulador]
papeis: Só o Admin configura. Os outros papéis veem o resultado nas conversas, nos contatos e nos negócios.
palavras-chave: [sdr, ia, assistente virtual, qualificação, critérios, temperatura, nota, base de conhecimento, persona, simulador, orçamento, tokens, modo automático, modo sugestão, passar para humano, boas-vindas]
---
# Configurar o SDR com IA

O SDR com IA é uma assistente virtual que responde o lead novo, descobre o que o Comercial precisa saber (curso, modalidade, quando quer começar, cidade, forma de pagamento, quem decide), dá uma nota e uma temperatura e, quando o lead está qualificado, passa o negócio para o Comercial pelo rodízio, com um resumo. Tudo fica em **Configurações > SDR com IA** (só o Admin). A barra de partes tem seis abas.

## 1. Canais: onde a IA atua
Cada canal (WhatsApp, WhatsApp oficial, chat do site, Instagram e Messenger; o e-mail fica de fora) tem um modo, que vale na hora:
- **Desligado**: a IA não participa; a conversa segue o atendimento normal.
- **Automático**: a IA responde sozinha o lead novo até qualificar ou passar para uma pessoa.
- **Sugestão**: a IA só propõe a resposta; o atendente aprova, edita ou descarta antes de enviar.

**Aviso de automação:** se houver uma automação ligada que manda mensagem a todo lead novo (por exemplo "Boas-vindas ao lead"), a tela mostra um aviso com o link dela. Essa mensagem sai **antes** da resposta da IA e pode confundir a conversa: pause ou ajuste a automação.

## 2. Persona
Nome da assistente, tom da conversa, **apresentação** (ela sempre se apresenta como assistente virtual, por exemplo "Sou a Bia, assistente virtual da BRL") e a **mensagem de passagem** que o lead lê quando a conversa vai para uma pessoa.

## 3. Base de conhecimento
Artigos curtos em texto: cursos, valores, formas de pagamento, início das turmas, endereço, perguntas frequentes e o que a instituição não oferece. A IA **só afirma preço, prazo ou condição que esteja num artigo publicado**; fora da base, ela diz que vai confirmar com a equipe.
- **Novo artigo**, escreva título e texto e escolha **Publicar** (a IA passa a usar) ou **Salvar como rascunho** (fica guardado, sem uso).
- Cada mudança de texto cria uma **versão**. Em **Versões anteriores** dá para **Restaurar** uma delas (isso cria uma versão nova).
- **Excluir** pede uma confirmação; o histórico de versões fica guardado.

## 4. Critérios de qualificação
O que a IA procura na conversa. Cada critério tem:
- **O que descobrir** e a **instrução para a IA** (como perceber e registrar);
- o **tipo** da resposta: texto livre, opção da lista, número, data ou sim/não;
- **onde gravar**: só na qualificação, num campo do contato ou num campo do negócio (inclusive os campos personalizados que já existem);
- o **peso** na nota (1 a 100) e se é **obrigatório** para qualificar.

Arraste pela alça (ou use os botões Subir e Descer, que funcionam pelo teclado) para mudar a ordem em que a IA pergunta. **Restaurar modelo de captação de alunos** acrescenta os critérios do modelo que estiverem faltando, sem mexer nos que você já ajustou.

## 5. Temperatura e limites
- **Temperatura:** notas mínimas para o lead ser **quente** e **morno** (abaixo disso é frio) e a **nota mínima para qualificar**. Qualificado = todos os critérios obrigatórios descobertos e a nota mínima atingida.
- **Quando passar para uma pessoa:** o lead pede um humano, assunto sensível ou fora do escopo, reclamação, a IA sem confiança (com a confiança mínima de 0 a 1) e muitas mensagens sem avanço. Em todos os casos a conversa vai para a equipe com um resumo.
- **Limites:** orçamento mensal de tokens (em branco, sem limite) com o consumo do mês, mensagens da IA por conversa, mensagens sem avanço, espera para agrupar mensagens seguidas do lead (padrão 8 segundos) e o modelo da IA. Se o orçamento acaba, os leads novos vão para a equipe e o Admin é avisado.

## 6. Simulador
Teste sem risco. Escreva como o lead escreveria; a IA responde com a configuração **salva** agora. Nada é enviado a ninguém e nada é gravado em contato ou negócio. A cada resposta aparecem os **critérios descobertos** (com a confiança), a **nota**, a **temperatura** e a **ação**: continuar, qualificado, desqualificado ou passar para uma pessoa. **Recomeçar** limpa a conversa. Os tokens do simulador contam no orçamento do mês.

Dicas:
- Depois de mudar critérios ou a base, teste no simulador antes de ligar um canal em modo automático.
- Comece um canal novo em **Sugestão** e passe para **Automático** quando as respostas estiverem boas.
- Se a tela avisar que a chave da IA não está configurada, peça a quem cuida do servidor; os modos e critérios ficam salvos.
