# Regras de negócio — BRL CRM

Fonte de verdade das regras do produto. A API (`crmbrl-api`) é a única camada que as
aplica; o front só as reflete. Cada regra tem um código (`R<n>.<m>`) para ser citada
em testes, commits e chamados. Até a R10 o número é o da seção; as regras da Fase 2
continuam a sequência dos códigos (R11 a R15) nas seções 14 a 18, depois da convenção,
da matriz e dos cenários da Fase 1 (seções 11 a 13, que mantêm o número porque o código
as cita).

Esta versão cobre a **Fase 1 — núcleo do CRM** e a **primeira parte da Fase 2 (Onda
A)**: arquivos, atendimento omnichannel, gateway de WhatsApp próprio, chat do site,
e-mail, Instagram e Messenger, tempo real e chat interno da equipe; e a **segunda parte
da Fase 2 (Onda B)**: importação de contatos (R16), disparos (R17), chatbot (R18) e
automações (R19), nas seções 21 a 26. As fases seguintes estão em [ROADMAP.md](ROADMAP.md)
e ganham seções aqui quando forem detalhadas.

> Atualizado em 2026-10-30. Regras marcadas com **(proposta)** dependem de validação do
> negócio e podem mudar sem quebrar o resto. Trechos marcados com **Ajuste da
> implementação (2026-10-20)** registram o que a implementação da Fase 1 precisou
> definir ou mudar em relação ao texto original da regra; os marcados só com **Ajuste**
> e a data, mudanças pedidas depois; os marcados com **Ajuste da Onda A
> (2026-10-26)**, o que a Fase 2 mudou nas regras da Fase 1.

---

## 1. Papéis, áreas e hierarquia

| Papel | Área | Nível | Líder obrigatório |
| --- | --- | --- | --- |
| `ADMIN` | Sistema | administrador | não tem |
| `C_LEVEL` | Diretoria | diretoria | não tem |
| `LIDER_COMERCIAL` | Comercial | líder | um `C_LEVEL` ativo |
| `COMERCIAL` | Comercial | membro | um `LIDER_COMERCIAL` ativo |
| `LIDER_MARKETING` | Marketing | líder | um `C_LEVEL` ativo |
| `MARKETING` | Marketing | membro | um `LIDER_MARKETING` ativo |
| `LIDER_CS` | Customer Success | líder | um `C_LEVEL` ativo |
| `CS` | Customer Success | membro | um `LIDER_CS` ativo |

- **R1.1** E-mail único, comparado sem diferença de maiúsculas; gravado aparado e em
  minúsculas.
- **R1.2** O líder de um membro é um líder **da mesma área** e ativo. O líder de um líder é
  um C-level ativo (o "C-level responsável"). Admin e C-level não têm líder.
- **R1.3** Mudar o papel revalida a hierarquia. Um líder com liderados não pode deixar de
  ser líder (nem mudar de área) enquanto houver liderados: o erro lista quem precisa de novo
  líder.
- **R1.4** Sempre existe pelo menos um Admin ativo: o último não pode ser desligado nem
  rebaixado.
- **R1.5** Só o Admin cria, edita, desliga, reativa e redefine senha de usuários. C-level
  vê todos; líder vê a própria equipe; membro vê a si mesmo.

## 2. Autenticação e sessões

- **R2.1** Login por e-mail e senha. Senha com 8 a 128 caracteres. Hash **scrypt** nativo
  do Node (`N=32768, r=8, p=3`, chave de 64 bytes, sal de 16 bytes), gravado como
  `scrypt$N$r$p$sal$hash` para permitir trocar parâmetros no futuro.
- **R2.2** A sessão é um token aleatório de 32 bytes, entregue no cookie `crmbrl_sessao`
  (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` em produção). O banco guarda só o SHA-256
  do token. Expira após 7 dias sem uso e, em qualquer caso, 30 dias após o login. O uso
  renova a validade (gravando no máximo uma vez a cada 5 minutos).
- **R2.3** Credenciais erradas devolvem sempre a mesma mensagem genérica. Usuário
  desligado com senha correta recebe "Acesso desativado. Fale com o administrador."
- **R2.4** A cada requisição, a sessão só vale se o usuário estiver ativo: desligar alguém
  corta o acesso **na hora**, e todas as sessões dele são revogadas.
- **R2.5** Força bruta: 5 falhas para o mesmo e-mail em 15 minutos bloqueiam esse e-mail
  por 15 minutos (HTTP 429), mesmo com a senha certa. Limite adicional de 30 tentativas
  por IP em 15 minutos. Toda tentativa fica registrada.
  **Ajuste da implementação (2026-10-20):** no limite por IP contam só as tentativas
  **sem sucesso** (para não travar um escritório inteiro atrás do mesmo IP); um login
  com sucesso zera as falhas do e-mail; a senha atual errada na troca de senha conta
  como falha.
- **R2.6** Primeiro acesso: se não existe nenhum usuário, a API cria o Admin a partir de
  `ADMIN_EMAIL`, `ADMIN_NOME` e `ADMIN_SENHA_INICIAL`, com troca de senha obrigatória.
- **R2.7** Com troca de senha pendente, só funcionam `auth/eu`, `auth/senha` e
  `auth/sair`.
- **R2.8** O Admin pode definir uma senha temporária (revoga as sessões e exige troca). Com
  SMTP configurado, há também convite e "esqueci minha senha" por e-mail: link com token de
  uso único, válido por 24 horas (só o hash fica no banco).
- **R2.9** Proteção CSRF: requisições que alteram dados precisam vir de uma origem
  permitida (`Origin`/`Referer` em `ORIGENS_PERMITIDAS`). Webhooks de entrada são isentos,
  porque se autenticam pelo token da URL.

## 3. Auditoria e logs técnicos

- **R3.1** Toda alteração de dados gera um **evento de auditoria** na mesma transação da
  alteração, com: ator (usuário, ou `SISTEMA`, `WEBHOOK`, `AUTOMACAO`, `IA`), ação no
  formato `entidade.verbo` (ex.: `negocio.movido`), entidade e id, resumo legível em
  português, campos alterados (antes/depois, nunca senhas, tokens ou segredos), IP, user
  agent, id da requisição e data/hora.
  **Ajuste da implementação (2026-10-20):** não geram auditoria item a item os estados
  pessoais e técnicos — marcar notificação como lida, os marcadores do job de lembretes
  (R6.5) e os registros de recebimento, entrega e tentativa dos webhooks (que já são o
  próprio histórico). São auditadas as ações do Admin sobre eles, a desativação
  automática de destino e a limpeza de dados da LGPD.
  **Ajuste da Onda A (2026-10-26):** também não geram auditoria item a item as
  mensagens — as do Atendimento (a conversa é o próprio histórico, com autor, data e
  status de cada mensagem) e as do chat interno (as diretas são privadas, R15.3: a
  mensagem guarda `editadaEm` e `excluidaEm`, e a auditoria registra só quem iniciou a
  conversa direta) —, o envio de um arquivo (R11; a remoção é auditada), a leitura e o
  silenciar do chat, as marcações técnicas do gateway de WhatsApp (envios do dia,
  verificações de número, chaves da sessão) e o "digitando". São auditadas as ações
  sobre conversas (criar, assumir, transferir, resolver, reabrir, alterar, ligar
  negócio, avaliação, encaminhamento no desligamento), filas, respostas rápidas,
  canais e números de WhatsApp (inclusive conexão, queda, pausa e retomada) e a
  estrutura do chat interno (grupos, membros, administradores, arquivamento).
- **R3.2** Também são auditados: login, logout, falha de login, bloqueio por força bruta,
  troca e redefinição de senha, desligamento, reativação e encaminhamentos.
- **R3.3** A auditoria é **somente inclusão**: não há endpoint de edição ou exclusão, e um
  gatilho no banco recusa `UPDATE` e `DELETE` na tabela.
- **R3.4** Admin e C-level consultam a auditoria com filtros (período, usuário, ação,
  entidade, texto) e paginação por cursor.
- **R3.5** A linha do tempo de um contato, empresa ou negócio junta os eventos de auditoria
  ligados a ele e as atividades.
- **R3.6** Logs técnicos: toda requisição HTTP gera um log JSON estruturado (método, rota,
  status, duração, usuário, IP, id da requisição). Erros 5xx, avisos e falhas de jobs são
  gravados também no banco, para consulta pelo Admin, e apagados após 90 dias por um job
  diário.
  **Ajuste da implementação (2026-10-20):** `GET /api/saude` respondendo 200 fica fora
  do log HTTP — o healthcheck do Docker o chama a cada 10 segundos e seria quase todo o
  volume; uma resposta 503 é registrada.
- **R3.7** Toda resposta traz `X-Request-Id`, recebido do cliente ou gerado na hora.

## 4. Contatos e empresas

- **R4.1** Contato precisa de nome e de pelo menos um meio de contato (e-mail ou telefone).
  E-mail em minúsculas. Telefone normalizado para E.164 só com dígitos: números brasileiros
  com 10 ou 11 dígitos ganham o `55`, e o DDD é validado.
  **Ajuste da Onda A (2026-10-26):** um **identificador de canal** também conta como
  meio de contato (R12.2): quem escreve pelo Instagram, pelo Messenger ou pelo chat do
  site pode não ter e-mail nem telefone. O banco confere no fim da transação (gatilho
  adiável) que todo contato não excluído tem e-mail, telefone ou identificador.
- **R4.2** **Deduplicação:** toda criação (manual, webhook, importação, passagem) procura
  antes um contato ativo com o mesmo e-mail ou o mesmo telefone normalizado. Se achar, não
  cria outro: completa os campos vazios (sem sobrescrever os preenchidos), atualiza a
  "última origem" e registra `contato.reconvertido`. Índices únicos parciais no banco
  garantem isso mesmo sob concorrência.
- **R4.3** A origem tem duas partes: a **primeira** (imutável) e a **última** (muda a cada
  reconversão), cada uma com tipo, detalhe (ex.: nome do webhook) e UTM (`source`,
  `medium`, `campaign`, `term`, `content`).
- **R4.4** Empresa precisa de nome. O CNPJ é opcional, mas se vier é validado pelos dígitos
  verificadores e é único.
- **R4.5** Contato e empresa têm um responsável (usuário ativo); o padrão é quem criou ou o
  responsável do negócio que os originou.
- **R4.6** LGPD: contato com `optOutMarketing` não recebe disparos nem automações de
  marketing; o consentimento guarda origem e data. A exclusão é lógica, com anonimização dos
  dados pessoais, só pelo Admin, e auditada. A anonimização também apaga os identificadores de
  canal, encerra as conversas abertas, troca o texto das mensagens por `[removido — LGPD]`,
  desvincula os arquivos (o conteúdo sai do bucket por job) e limpa visitantes do chat, envios
  da régua e linhas de importação do contato. `GET /contatos/:id/dados-pessoais` (só Admin,
  auditado) entrega em JSON os dados do titular (direito de acesso e portabilidade).
- **R4.7** Etiquetas livres, normalizadas (aparadas, sem duplicatas); campos personalizados
  em JSON.

## 5. Funis, etapas e negócios

- **R5.1** Existem três **funis-base**, um por área, que não podem ser excluídos:
  Marketing, Comercial e Customer Success. Admin e C-level configuram todos os funis; o
  líder configura os da sua área (criar, renomear e reordenar etapas, criar funis extras).
- **R5.2** Etapa tem nome, ordem, tipo (`ABERTA`, `GANHO` ou `PERDIDO`), prazo-alvo em dias
  (para sinalizar negócio parado) e probabilidade opcional. Todo funil tem ao menos uma etapa
  aberta, exatamente uma de ganho e exatamente uma de perda. Etapa com negócios não pode ser
  excluída.

  Etapas iniciais:

  | Funil | Etapas (prazo-alvo) | Ganho | Perda |
  | --- | --- | --- | --- |
  | Marketing | Novo lead (2d) → Em contato (5d) → Nutrição (15d) | Qualificado (MQL) | Descartado |
  | Comercial | Novo (1d) → Qualificação (5d) → Apresentação (7d) → Proposta (7d) → Negociação (10d) | Ganho | Perdido |
  | Customer Success | Boas-vindas (2d) → Onboarding (15d) → Implantação (30d) → Acompanhamento → Renovação (30d) | Renovado | Cancelado (churn) |

- **R5.3** Negócio: título (padrão: nome do contato ou da empresa), contato obrigatório,
  empresa opcional, funil e etapa, responsável, valor em reais (≥ 0, 2 casas), valor
  recorrente mensal opcional, previsão de fechamento, motivo de perda, data de ganho ou de
  perda, desde quando está na etapa, posição no kanban. O **status** (`ABERTO`, `GANHO`,
  `PERDIDO`) deriva do tipo da etapa.
- **R5.4** Toda movimentação grava o histórico (de onde, para onde, quem, quando e quanto
  tempo ficou na etapa anterior), gera auditoria e evento. Não se move um negócio para etapa
  de outro funil: isso é papel das passagens (R5.7).
- **R5.5** Entrar numa etapa de perda exige motivo. Ganhar registra a data de ganho.
  Reabrir um negócio ganho ou perdido é permitido só a líder da área, C-level e Admin.
- **R5.6** Um contato não tem dois negócios **abertos** no mesmo funil vindos de
  automação: se o webhook ou a passagem encontrar um aberto, registra a reconversão nele em
  vez de criar outro. A criação manual é livre.
  **Ajuste da implementação (2026-10-20):** a busca considera qualquer negócio aberto do
  contato no funil, inclusive os criados à mão (usa o mais antigo).
- **R5.7** **Passagens entre funis** (configuráveis pelo Admin), executadas **na mesma
  transação** da movimentação que as dispara:

  | Passagem | Gatilho | Resultado |
  | --- | --- | --- |
  | Marketing → Comercial | negócio de Marketing entra em "Qualificado (MQL)" | cria negócio no Comercial, etapa "Novo", distribuído por rodízio entre o Comercial |
  | Comercial → CS | negócio do Comercial é **ganho** | cria negócio no CS, etapa "Boas-vindas", distribuído por rodízio entre o CS, levando valor e valor recorrente |

  O negócio criado guarda o vínculo com o de origem, herda contato, empresa, valores e
  origem/UTM. Cada passagem roda **uma única vez** por negócio de origem; se ele for reaberto
  e ganho de novo, nada é duplicado. O responsável recebe notificação.
  **Ajuste da implementação (2026-10-20):** a passagem também dispara quando o negócio
  já é criado (à mão ou por webhook) direto na etapa-gatilho, ou reaberto nela; usa o
  mesmo contato do negócio de origem (sem contar nova reconversão) e roda como ator
  `AUTOMACAO`. Passagens encadeadas vão até 5 níveis, sem repetir a mesma passagem.
- **R5.8** **Distribuição por rodízio:** por área, entre os membros ativos (o líder entra
  só se a regra da área disser), em ordem estável e com ponteiro salvo, sob trava no banco
  para não repetir em concorrência. Sem membros disponíveis, vai para o líder da área; sem
  líder, para um C-level.
  **Ajuste (2026-10-22):** o rodízio só inclui quem **já ativou o acesso** — concluiu o
  primeiro login (com a troca da senha temporária) ou definiu a senha do convite. Quem
  ainda não ativou (convite pendente, ou senha temporária ainda não trocada) fica fora da
  fila, mesmo se incluído à mão, e entra sozinho quando ativar; a configuração do rodízio
  lista essas pessoas à parte, com o motivo. O banco marca a ativação
  (`usuarios.acesso_ativado_em`) na primeira vez em que a pessoa fica com senha própria e
  não a desfaz: uma senha temporária definida depois pelo Admin (R2.8) não tira ninguém do
  rodízio.
- **R5.9** **Visibilidade (proposta):** Admin e C-level veem todos os negócios; o líder vê
  todos os da sua área; o membro vê os da sua área em que é responsável e os ainda sem
  responsável (que ele pode assumir). Quem vê pode editar e mover, exceto reabrir (R5.5).
- **R5.10** Métricas base, calculadas do histórico: conversão entre etapas, tempo médio
  por etapa, ciclo médio (criação → ganho) e negócios parados (tempo na etapa maior que o
  prazo-alvo).

## 6. Atividades

- **R6.1** Tipos: tarefa, ligação, reunião, e-mail, WhatsApp e nota. Título obrigatório;
  reunião tem início e fim; as demais podem ter vencimento. Podem se ligar a contato,
  empresa e/ou negócio.
- **R6.2** Responsável é um usuário ativo (padrão: quem criou). Status `PENDENTE`,
  `CONCLUIDA` ou `CANCELADA`; concluir grava quando e quem concluiu. Nota já nasce concluída
  e só aparece na linha do tempo.
- **R6.3** "Atrasada" é a pendente com vencimento no passado (calculado, não gravado).
- **R6.4** Veem a atividade: responsável, criador, líder da área do responsável, C-level e
  Admin.
  **Ajuste da implementação (2026-10-20):** "líder da área do responsável" é o líder
  **direto** do responsável (a "equipe" da matriz §12): com dois líderes na mesma área,
  um não vê a equipe do outro. Quem vê a atividade também a altera, conclui, cancela e
  reabre.
- **R6.5** Lembrete: um job a cada 15 minutos notifica o responsável 1 hora antes do
  vencimento e, depois, uma vez quando a atividade atrasa.

## 7. Desligamento e encaminhamento

Regra central pedida pelo negócio: **quem é desligado perde o acesso, e o que estava com
ele vai para o líder; se for um líder, vai para o C-level responsável.**

- **R7.1** Só o Admin desliga. Antes de confirmar, a API mostra uma prévia: quem vai
  receber e quanto (atividades pendentes, negócios abertos, contatos, empresas, liderados).
- **R7.2** Destinatário:
  - membro → o líder dele;
  - líder → o C-level responsável (o líder dele);
  - se o destinatário calculado estiver inativo, sobe na cadeia; se a cadeia acabar, vai
    para um C-level ativo;
  - C-level desligado → outro C-level ativo, escolhido pelo Admin no pedido;
  - Admin desligado → o Admin que executa.

  **Ajuste da implementação (2026-10-20):** sem nenhum C-level ativo no fim da cadeia,
  os itens vão para o Admin que executa (o desligamento, que corta o acesso, nunca fica
  bloqueado); um C-level não é desligado se não houver outro C-level ativo para
  receber; se o destinatário informado no pedido não for mais o calculado (a situação
  mudou desde a prévia), a resposta é 409.
- **R7.3** Numa única transação: marca o usuário como desligado, revoga todas as sessões,
  transfere atividades **pendentes**, negócios **abertos**, contatos e empresas de que era
  responsável, e tira o usuário dos rodízios. Atividades transferidas guardam de quem vieram
  e quando. Se era líder, os liderados passam a responder ao destinatário até o Admin
  definir um novo líder, e o Admin recebe o alerta "equipe sem líder".
  **Ajuste da implementação (2026-10-20):** também passa ao destinatário o papel de
  responsável fixo em webhooks de entrada e passagens; cada item encaminhado ganha o
  próprio evento de auditoria (aparece na linha do tempo dele), além do
  `usuario.desligado` com as contagens.
  **Ajuste da Onda A (2026-10-26):** logo depois do desligamento (pela outbox), as
  conversas do Atendimento em aberto com a pessoa vão para o mesmo destinatário
  (R12.17) e ela sai dos canais padrão e dos grupos do chat interno (R15.1, R15.2);
  inativa, já não entra na distribuição das filas (R12.4). Os sockets dela caem na hora
  (R2.4).
- **R7.4** O destinatário é notificado ("Você recebeu 12 atividades e 3 negócios de
  Pedro"), a auditoria guarda as contagens e o evento `usuario.desligado` vai para os
  webhooks de saída.
- **R7.5** Reativar exige definir um líder válido e **não** devolve o que foi encaminhado.
- **R7.6** Desligar quem já está desligado devolve conflito (HTTP 409).

## 8. Webhooks de entrada (captação)

- **R8.1** O Admin cria pontos de entrada com: nome, funil e etapa de entrada (padrão:
  Marketing / Novo lead), distribuição (`RODIZIO`, `RESPONSAVEL_FIXO` ou `LIDER_DA_AREA`),
  mapeamento de campos (caminho no JSON → campo do contato/negócio: nome, e-mail, telefone,
  empresa, cargo, valor, UTMs, etiquetas, campos personalizados), etiquetas fixas e segredo
  HMAC opcional. Há modelos de mapeamento prontos: **Genérico** (`name`, `email`, `phone`,
  `utm_*`) e **Disparos BRL** — o formato que o sistema de disparos atual envia ao Clint
  (`name`, `email`, `phone`, `whatsapp`, `faturamento`, `campanha`, `origem` e as colunas
  `planilha_*`, que viram campos personalizados) —, para que ele possa mandar leads ao CRM
  já durante a transição.
- **R8.2** O endereço é `POST /api/v1/webhooks/entrada/{token}`, com um token aleatório de
  32 bytes. O banco guarda só o hash; o endereço completo é mostrado ao criar e ao
  regenerar. Aceita JSON e `application/x-www-form-urlencoded`, até 256 KB.
- **R8.3** Com segredo configurado, exige `X-Assinatura: sha256=<hex>`, o HMAC-SHA256 do
  corpo bruto. Assinatura inválida devolve 401 e o recebimento fica registrado como erro.
- **R8.4** A resposta é imediata (`202` com o id do recebimento); o processamento vai para
  a fila, com até 3 tentativas.
- **R8.5** Processamento: aplica o mapeamento → valida (nome e e-mail ou telefone) →
  deduplica o contato (R4.2) → cria o negócio ou registra reconversão (R5.6) → distribui
  (R5.8) → audita com ator `WEBHOOK` → notifica o responsável → publica os eventos.
- **R8.6** Cada recebimento fica guardado (corpo, status `RECEBIDO`/`PROCESSADO`/`IGNORADO`/
  `ERRO`, mensagem e o que foi criado) e o Admin pode reprocessá-lo. Retenção de 90 dias.
- **R8.7** Token inexistente devolve 404; ponto desativado, 410; mais de 60 chamadas por
  minuto no mesmo ponto, 429.
  **Ajuste da implementação (2026-10-20):** ponto excluído responde 404 (como token
  inexistente); a janela de 60 s conta todo recebimento gravado, inclusive os com erro.

## 9. Webhooks de saída (eventos)

- **R9.1** O Admin cadastra destinos: nome, URL, eventos assinados, cabeçalhos extras e um
  segredo gerado pelo sistema. Em produção a URL precisa ser HTTPS, e endereços de rede
  interna ou localhost são recusados (proteção contra SSRF), salvo se
  `WEBHOOKS_PERMITIR_REDE_INTERNA=true` (para sistemas internos como o TicketHub).
  **Ajuste da implementação (2026-10-20):** com essa liberação, um destino **interno**
  pode usar `http://` também em produção (ex.: TicketHub na rede do Docker); destino
  público continua exigindo HTTPS. Usuário e senha na URL são recusados.
- **R9.2** Eventos disponíveis na Fase 1: `contato.criado`, `contato.atualizado`,
  `negocio.criado`, `negocio.movido`, `negocio.ganho`, `negocio.perdido`,
  `atividade.criada`, `atividade.concluida`, `usuario.desligado` e `webhook.teste`.
- **R9.3** Envelope `{ id, evento, ocorridoEm, dados }`, com os cabeçalhos `X-CRM-Evento`,
  `X-CRM-Entrega`, `X-CRM-Timestamp` e `X-CRM-Assinatura: sha256=<hmac>` (HMAC-SHA256 de
  `timestamp + "." + corpo`). Tempo limite de 10 segundos.
- **R9.4** Entrega pela fila: sucesso é qualquer 2xx. Em caso de falha, novas tentativas em
  1 min, 5 min, 30 min, 2 h, 6 h e 24 h; depois disso, a entrega é marcada como falha e o
  Admin é avisado. Com 20 falhas seguidas, o destino é desativado automaticamente e o Admin
  é notificado.
  **Ajuste da implementação (2026-10-20):** as esperas são intervalos sucessivos (7
  tentativas em cerca de 32 h 36 min); as falhas seguidas contam por tentativa, não por
  entrega; redirecionamento (3xx) não é seguido e conta como falha.
- **R9.5** Cada tentativa fica registrada (status HTTP, duração, até 2 KB da resposta,
  erro). O Admin pode reenviar uma entrega e disparar um evento de teste.
- **R9.6** A ordem de entrega não é garantida; o consumidor deve usar o `id` do envelope
  para não processar o mesmo evento duas vezes.

## 10. Eventos de domínio, fila e notificações

- **R10.1** Efeitos colaterais (webhooks de saída, notificações, e no futuro automações e
  tempo real) usam uma **outbox**: o evento é gravado na mesma transação da alteração e um
  despachante o entrega à fila (pg-boss). Nada se perde se a API cair no meio.
  **Ajuste da Onda A (2026-10-26):** o **tempo real** (Socket.IO) também sai da outbox:
  só é emitido o que foi confirmado no banco, depois do commit, e uma emissão com mais de
  5 minutos de atraso é descartada (quem reconecta recarrega a tela pela API). Só o
  efêmero ("digitando…") é emitido direto. A entrega é "pelo menos uma vez": o front
  ignora repetidos pelo `id` do recurso.
- **R10.2** Notificações internas na Fase 1: lead ou negócio atribuído, passagem recebida,
  itens encaminhados por desligamento, atividade vencendo ou atrasada, falha ou desativação
  de webhook de saída (Admin) e equipe sem líder (Admin). Podem ser listadas, marcadas como
  lidas uma a uma ou todas de uma vez. O tempo real chega na Fase 2.
  **Ajuste da Onda A (2026-10-26):** a notificação nova chega na hora pelo tempo real
  (`notificacao.nova`, com a contagem do sino), e a consulta a cada 60 s fica só de
  reserva. Tipos novos: conversa atribuída, transferida, encaminhada por desligamento,
  mensagem nova do contato (para quem está fora do CRM), nota interna, prazo de
  primeira resposta ou de resolução estourado e avaliação baixa (para o líder), e
  menção no chat interno (R12.14, R15.5).
- **R10.3** Segredos (HMAC de entrada e de saída) ficam cifrados no banco com AES-256-GCM e
  a chave `CHAVE_CRIPTOGRAFIA`; depois de criados, só aparecem mascarados.

## 11. Convenções da API

- Rotas de negócio em `/api/v1/...`; `/api/saude` fica sem versão.
- Entrada validada por DTO (class-validator) com lista branca: campo desconhecido é erro.
- Erro padrão: `{ statusCode, erro, mensagem, detalhes?, requisicaoId }`, com mensagens em
  português.
- Listas paginadas com `pagina` e `porPagina` (máximo 100) e total; auditoria e logs usam
  cursor.
- Documentação OpenAPI em `/api/docs`, aberta em desenvolvimento e restrita ao Admin em
  produção.

## 12. Matriz de acesso (Fase 1)

| Recurso | Admin | C-level | Líder da área | Membro da área |
| --- | --- | --- | --- | --- |
| Gerenciar usuários | ✓ | — | — | — |
| Ver usuários | todos | todos | sua equipe | a si mesmo |
| Configurar funis e etapas | todos | todos | da sua área | — |
| Ver e mover negócios | todos | todos | da sua área | da sua área: os seus e os sem responsável |
| Reabrir negócio | ✓ | ✓ | da sua área | — |
| Ver contatos e empresas | ✓ | ✓ | ✓ | ✓ |
| Editar contato/empresa | ✓ | ✓ | se o responsável é da sua equipe | se é o responsável |
| Anonimizar contato | ✓ | — | — | — |
| Ver atividades | todas | todas | da equipe | as suas (responsável ou criador) |
| Configurar passagens | ✓ | ✓ | — | — |
| Configurar rodízio | ✓ | ✓ | da sua área | — |
| Webhooks de entrada e saída | ✓ | — | — | — |
| Auditoria | ✓ | ✓ | — | — |
| Logs técnicos | ✓ | — | — | — |

## 13. Cenários de aceitação (Fase 1)

Cada cenário vira um teste automatizado contra um Postgres real.

1. Base vazia + variáveis de ambiente → Admin criado; login exige troca de senha (R2.6, R2.7).
2. Hierarquia válida é aceita; membro com líder de outra área, ou líder sem C-level, é
   recusado com mensagem clara (R1.2).
3. Login → cookie → `auth/eu` responde; desligar o usuário → a requisição seguinte dele
   devolve 401 (R2.4).
4. Desligar um membro com 3 atividades pendentes, 1 concluída, 2 negócios abertos e 1
   contato → 3 atividades, 2 negócios e 1 contato vão para o líder; a concluída fica;
   o líder é notificado; a auditoria guarda as contagens (R7).
5. Desligar um líder → os itens vão para o C-level, os liderados passam a responder a ele e
   o Admin recebe "equipe sem líder" (R7.2, R7.3).
6. Membro cujo líder está inativo → os itens sobem direto para o C-level (R7.2).
7. Webhook de entrada com payload mapeado → 202; depois do processamento: contato com
   origem e UTM, negócio em Marketing / Novo lead, responsáveis alternando no rodízio; um
   segundo envio com o mesmo e-mail não duplica o contato e registra reconversão (R4.2, R8).
8. Assinatura HMAC inválida → 401 e recebimento com erro (R8.3).
9. Negócio de Marketing entra em "Qualificado (MQL)" → negócio criado no Comercial, vinculado
   e distribuído; repetir o movimento não cria um segundo (R5.7).
10. Negócio do Comercial ganho → status ganho, data de ganho e negócio no CS em
    "Boas-vindas" com o valor recorrente (R5.7).
11. Mover para perda sem motivo → 400 (R5.5).
12. Webhook de saída: um servidor de teste recebe `negocio.ganho` com assinatura válida;
    uma resposta 500 agenda nova tentativa; o sucesso marca a entrega como entregue (R9).
13. Visibilidade: um comercial não vê o negócio de outro; o líder comercial vê os dois; o
    marketing não vê o funil comercial (R5.9).
14. `UPDATE` direto em `eventos_auditoria` falha (R3.3).
15. 5 senhas erradas → a 6ª tentativa é bloqueada (429), mesmo com a senha certa (R2.5).

---

# Fase 2 — Onda A: atendimento e comunicação

## 14. Arquivos (R11)

- **R11.1** Arquivos (mídia das conversas, anexos do chat interno e das respostas rápidas,
  fotos de perfil, importações) ficam num armazenamento S3 próprio (MinIO no compose),
  nunca no banco nem no disco da API. O banco guarda nome original (limpo), tipo, tamanho,
  SHA-256, contexto (`MENSAGEM`, `CHAT`, `IMPORTACAO`, `AVATAR`, `OUTRO`), quem enviou e
  quando. A chave no armazenamento nunca sai da API.
- **R11.2** Tipos aceitos: imagens comuns (JPEG, PNG, GIF, WebP, AVIF, HEIC, BMP, TIFF),
  áudio (inclusive o gravado no navegador e a voz do WhatsApp), vídeo, PDF, Office e
  OpenDocument, texto (TXT, CSV, TSV, iCal, vCard, RTF) e zip. **Sempre recusados:** SVG,
  HTML, XHTML, XML, JavaScript e executáveis (415). O conteúdo é conferido pelos primeiros
  bytes: o que começa como página, SVG ou script é recusado mesmo com outro tipo declarado,
  e PNG, JPEG, GIF, WebP, PDF e os formatos zip precisam ter a assinatura do formato. Tipo
  genérico (`application/octet-stream`) é resolvido pela extensão do nome.
- **R11.3** Limites (413): 25 MB para imagem, áudio e vídeo; 100 MB para documentos,
  texto e zip; 5 MB para foto de perfil (só JPG, PNG, GIF ou WebP). Arquivo vazio é 400.
  Canais podem ter limites menores (chat do site: 10 MB; mídia do WhatsApp conferida antes
  do download).
- **R11.4** Download **só pela API** (`GET /api/v1/arquivos/:id`), com a mesma permissão do
  item a que o arquivo pertence: quem enviou sempre baixa; mídia de mensagem, quem vê a
  conversa (R12.5); anexo de resposta rápida, quem usa o Atendimento; anexo do chat
  interno, só os membros do canal — **nem o Admin** (R15.3); foto de perfil, qualquer
  pessoa logada; importação e outros, só o Admin. Quem não pode ver recebe 404 (não revela
  que o arquivo existe).
- **R11.5** O download vai com `X-Content-Type-Options: nosniff`, `Content-Disposition`
  seguro (imagens comuns, áudio, vídeo e PDF abrem no navegador; o resto é baixado) e,
  nos que não abrem, `Content-Security-Policy: default-src 'none'; sandbox`. Aceita
  `Range` (206, para o player de áudio e vídeo) e `If-None-Match` (304).
- **R11.6** Fora do CRM, só por link assinado com validade: o visitante do chat do site
  baixa os anexos da própria conversa por 24 horas (R14.3) e a Meta busca os anexos que o
  CRM envia (R14.9).
- **R11.7** Remover um arquivo marca a remoção (o registro fica para o histórico, com
  auditoria) e apaga o conteúdo do armazenamento só depois de a transação confirmar.

## 15. Atendimento omnichannel (R12)

- **R12.1** **Filas** organizam o atendimento: nome, área (**Comercial** ou **CS** — o
  Marketing não usa o Atendimento), prazo de primeira resposta e de resolução (SLA, em
  minutos, opcionais), estratégia de distribuição (`RODIZIO`, `MENOR_CARGA` ou `MANUAL`),
  participantes e se está ativa. Admin e C-level configuram todas; o líder, as da sua área.
  Uma fila com conversas em aberto não pode ser excluída nem mudar de área (422). Cada
  canal tem uma fila padrão, que recebe as conversas novas.
- **R12.2** **Entrada:** cada mensagem que chega por um canal identifica o contato pelo
  identificador do canal (telefone do WhatsApp, e-mail, id do Instagram ou do Messenger,
  visitante do chat do site — único por tipo e valor); sem ele, pelo e-mail ou telefone
  (deduplicação da R4.2); sem nenhum, cria o contato com a origem do canal e grava o
  identificador. Repetir uma mensagem com o mesmo id externo no mesmo canal não a duplica.
- **R12.3** **Uma conversa em aberto por contato e canal** (índice único no banco).
  Status: `ABERTA`, `PENDENTE` (esperando o contato) e `RESOLVIDA`; "em aberto" é aberta
  ou pendente. Mensagem do contato numa conversa pendente a devolve para aberta; numa
  resolvida, abre uma conversa nova (salvo a nota da pesquisa, R12.13).
- **R12.4** **Distribuição** da conversa nova pela fila: participam os membros **ativos**
  da área da fila que **já ativaram o acesso** (o mesmo ajuste da R5.8), menos os retirados
  à mão; com lista definida, só os da lista (que pode incluir o líder). `RODIZIO` segue
  ordem estável com ponteiro salvo na fila, sob trava; `MENOR_CARGA` escolhe quem tem menos
  conversas em aberto (empate pelo rodízio); `MANUAL` não escolhe ninguém. Sem candidato
  (ou em `MANUAL`), a conversa fica **sem responsável** na fila, para alguém assumir. Quem
  recebe é notificado.
- **R12.5** **Visibilidade:** Admin e C-level veem todas as conversas; o líder, as das
  filas da sua área e as que estão com ele; o membro, as que estão com ele e as **sem
  responsável** das filas da sua área. O Marketing não acessa o Atendimento (403). Conversa
  sem fila e sem responsável só aparece para Admin e C-level. O que a pessoa não vê
  responde 404 — inclusive a mídia (R11.4) e a sala de tempo real da conversa (R12.14).
- **R12.6** **Assumir:** quem vê uma conversa sem responsável pode assumi-la (409 se outra
  pessoa assumiu antes). Responder uma conversa sem responsável também a assume. Os
  colegas que deixam de ver a conversa saem da sala de tempo real dela na hora.
- **R12.7** **Transferência** para uma pessoa e/ou outra fila, com nota opcional (vira
  nota interna). Para alguém de outra área, é preciso escolher também uma fila da área
  dessa pessoa; pessoa desligada, do Marketing ou fila desativada são recusadas (422).
  Transferir só para a fila redistribui pela estratégia dela. Fica no histórico de
  atribuições (quem, de quem, para quem, motivo e quando), é auditada e notifica quem
  recebe.
- **R12.8** **Resolver** grava quando e quem resolveu (409 se já está resolvida) e, se o
  canal tem a pesquisa ligada, pergunta a nota (R12.13). **Reabrir** volta a conversa para
  aberta com o responsável anterior (se ainda ativo; senão, com quem reabriu); recusa (409)
  se o contato já tem outra conversa em aberto no mesmo canal.
- **R12.9** **Notas internas** ficam na conversa, só para a equipe — nunca vão ao contato;
  a nota de outra pessoa notifica o responsável. A conversa também tem prioridade,
  assunto, etiquetas (normalizadas como na R4.7) e pode ser ligada a um negócio **do mesmo
  contato**. "Criar negócio" a partir da conversa usa o funil-base da área da fila (ou o
  escolhido), com a origem do canal, e liga o negócio à conversa.
- **R12.10** **Envio:** a mensagem da equipe nasce `PENDENTE` e vai para a fila de envio
  do canal; o status só avança (`ENVIADA` → `ENTREGUE` → `LIDA`), conforme o canal informa.
  Falha definitiva marca `FALHOU` com o motivo em português, visível na bolha, e "tentar
  de novo" a devolve para `PENDENTE`; falha passageira é tentada de novo 3 vezes, com
  espera crescente (15 s, 30 s, 60 s). `FALHOU` só vale antes da entrega. Não se envia em
  conversa resolvida nem por canal desativado (422); na Meta, fora da janela de 24 h
  (R14.8).
- **R12.11** **Horário de atendimento** por canal (fuso e intervalos por dia da semana;
  sem horário = 24 horas). Fora do horário, o canal responde a mensagem automática
  configurada **uma vez por conversa em cada período fechado**.
- **R12.12** **SLA:** a fila define o prazo da **primeira resposta** (até a primeira
  mensagem da equipe) e o de **resolução**, em minutos corridos contados da chegada — ou da
  abertura seguinte do canal, quando a conversa chega fora do horário. Um job a cada
  minuto avisa o líder (o líder direto de quem atende, se for da área da fila; senão, os
  líderes da área) **uma vez por prazo** estourado. Conversa começada pela equipe
  (R12.16) só tem o prazo de resolução. A lista mostra o selo de prazo estourado.
- **R12.13** **Pesquisa de satisfação:** com a pesquisa ligada no canal, resolver envia a
  pergunta (nota de 1 a 5; texto configurável). A resposta vale por **24 horas**: a nota
  chega como a próxima mensagem do contato ("5", "nota 4", "3 - demorou", estrelas) ou por
  botões do canal; fica na conversa resolvida (que não reabre), com o comentário, e o
  contato recebe um agradecimento. Nota **1 ou 2** avisa o líder de quem atendeu. Depois
  das 24 horas, ou com um texto que não é nota, a mensagem abre conversa nova.
- **R12.14** **Tempo real e avisos:** conversas e mensagens chegam na hora a quem as vê
  (salas por área, por pessoa e por conversa, com verificação da R12.5); o menu mostra
  quantas conversas com mensagens não lidas a pessoa atende. O responsável que está fora
  do CRM é notificado na primeira mensagem não lida de uma sequência.
- **R12.15** **Respostas rápidas:** atalho (até 40 caracteres, sem espaço nem `/`; único
  no mesmo alcance), título, texto e anexo opcional. Globais (Admin e C-level) ou de uma
  área (também o líder dela). O texto aceita variáveis da lista (`{{contato.nome}}`,
  `{{contato.primeiroNome}}`, `{{usuario.primeiroNome}}`, `{{saudacao}}`…), validadas ao
  salvar e aplicadas à conversa antes de enviar, para a pessoa revisar.
- **R12.16** **Conversa começada pela equipe:** quem usa o Atendimento pode começar uma
  conversa com um contato num canal que permite (WhatsApp, e-mail) e ela fica com quem
  começou. Se o contato já tem uma em aberto no canal, continua por ela (409 se a pessoa
  não a vê).
- **R12.17** **Desligamento (R7):** as conversas em aberto de quem sai vão para o mesmo
  destinatário dos outros itens, com o histórico, um aviso em cada conversa e uma
  notificação com o total.
- **R12.18** **Métricas para o BI:** por período (padrão 30 dias, máximo 1 ano), geral,
  por fila, por canal e por pessoa — conversas novas, tempo da primeira resposta, tempo de
  resolução, cumprimento do SLA, satisfação (média e respostas), mensagens enviadas e
  situação atual. Admin e C-level veem tudo; o líder, a sua área; o membro não (403).

## 16. WhatsApp (R13)

- **R13.1** **Gateway próprio** (Baileys, conexão direta por WebSocket, sem navegador e sem
  serviço de terceiros), num processo separado da API (mesma imagem). Vários números, cada
  um ligado a um canal `WHATSAPP` do Atendimento. Só o Admin cadastra, conecta, desconecta,
  pausa e exclui números.
- **R13.2** **Conexão por QR:** conectar gera o QR (o primeiro vale 60 s, os seguintes
  20 s, renovados sozinhos) e o mostra ao vivo a quem gerencia os canais. Status:
  `DESCONECTADO`, `AGUARDANDO_QR`, `CONECTANDO`, `CONECTADO`, `ERRO` e `BANIDO`, sempre com
  o motivo em português. O mesmo celular não pode ficar conectado em dois canais. QR não
  lido volta para desconectado. Cada mudança de status é auditada em nome de quem pediu.
- **R13.3** A **sessão** (chaves do WhatsApp) fica no Postgres, **cifrada** com a
  `CHAVE_CRIPTOGRAFIA` — nada em disco. Ao subir, o gateway reconecta os números que
  estavam conectados; uma queda comum reconecta com espera crescente (de 2 s a 5 min);
  "desconectar" pelo CRM ou pelo celular apaga as chaves e marca desconectado.
- **R13.4** **Recebimento:** mensagens de grupos, status e canais do WhatsApp são
  ignoradas. A mídia recebida é conferida (tipo e tamanho, R11) antes do download e salva
  antes de a mensagem entrar no Atendimento; se o download falhar, a mensagem entra sem a
  mídia. "Digitando…" vai nos dois sentidos.
- **R13.5** **Envio** pela fila durável de cada número, uma mensagem por vez; o gateway
  não envia duas vezes a mesma mensagem. Áudio gravado no navegador vira mensagem de voz
  (ogg/opus, convertido com ffmpeg); imagem e vídeo levam miniatura.
- **R13.6** **Proteções anti-banimento** (configuráveis por número): espera aleatória
  entre dois envios (padrão de 2 a 6 s); "digitando…" (ou "gravando…") antes de cada
  envio, proporcional ao texto (até 4 s); limite diário (padrão 1.000) com **aquecimento**
  do número novo (nos primeiros 14 dias o limite cresce aos poucos, a partir de 20 por dia
  — o excedente fica para o dia seguinte); verificação de que o telefone tem WhatsApp
  antes de uma mensagem ativa, com cache de 7 dias; pausa automática depois de 5 falhas
  seguidas, de um limite imposto pelo WhatsApp, de erro grave ou de banimento (reconectar
  pelo CRM tira a pausa automática); pausa manual, que adia os envios (a cada 5 min, por
  até 24 h, depois falham).
- **R13.7** **Opt-out (R4.6):** mensagem **ativa** — a que não é resposta a uma conversa
  aberta pelo contato — para quem pediu para não receber falha sem sair. O limite diário
  vale para as ativas; as respostas contam no total, mas só são barradas se o número for
  configurado para isso.
- **R13.8** **Modo simulado** (`WHATSAPP_SIMULADO=true`): mesmo fluxo com um transporte
  falso (QR de mentira, conexão em segundos, status enviada → entregue → lida, telefones
  terminados em `0000` sem WhatsApp, injeção de mensagens recebidas). Para
  desenvolvimento, testes e demonstração — nunca com número real.

## 17. Canais: chat do site, e-mail, Instagram e Messenger (R14)

- **R14.1** **Chat do site:** o Admin cria o canal com os domínios onde o widget roda
  (`https://*.site.com.br` vale para os subdomínios), a aparência (cores, título, tema
  claro/escuro/automático, posição), o meio de contato pedido (e-mail, telefone ou um dos
  dois), o texto do consentimento e se aceita anexos; a tela mostra o trecho de
  instalação. O widget é um script único, sem dependências, com menos de 40 KB.
- **R14.2** As rotas do widget são públicas, com **CORS só para os domínios do canal** (e
  o próprio CRM) e limites por IP (120 por minuto) e por visitante (20 mensagens por
  minuto, 10 anexos a cada 10 minutos, 10 cadastros por IP a cada 10 minutos). O
  formulário inicial exige nome, o meio de contato do canal e o **consentimento LGPD**;
  o contato é encontrado ou criado (R4.2) com o consentimento e as UTMs da página. O
  visitante recebe um token (vale 90 dias), sempre enviado no corpo, nunca na URL.
- **R14.3** **Privacidade do visitante:** cada navegador é um visitante; ele vê só as
  próprias mensagens e as respostas dirigidas a ele, a partir de quando entrou — outro
  navegador com o mesmo e-mail cai na mesma conversa (R12.3), mas não lê o que o primeiro
  escreveu. A equipe responde a quem escreveu por último. Anexos até 10 MB, baixados pelo
  visitante por link assinado de 24 h.
- **R14.4** No chat do site a mensagem fica `ENTREGUE` quando o widget confirma e `LIDA`
  quando ela aparece com o painel aberto e a aba visível. Fora do horário, o widget mostra
  o aviso e quando o atendimento volta.
- **R14.5** **E-mail:** o canal lê uma caixa por IMAP (varredura a cada minuto, só
  mensagens que chegaram **depois** de o canal ser criado) e responde por SMTP; a senha
  fica cifrada e há teste de conexão. O corpo é mostrado **só como texto** (a parte texto,
  ou o texto extraído do HTML), sem a citação da mensagem anterior — nunca HTML. Os
  anexos vão para o armazenamento de arquivos (R11).
- **R14.6** **Encadeamento:** a resposta sai com `In-Reply-To` e `References`, assunto
  "Re: …" e a assinatura do canal; a volta do cliente entra na mesma conversa pelo
  `Message-ID`/`In-Reply-To`/`References`. O contato é o endereço do `Reply-To` (ou, sem
  ele, o remetente) — o mesmo para onde a resposta vai. Reimportar o mesmo e-mail não
  duplica mensagem nem anexo.
- **R14.7** **Instagram e Messenger (Graph API da Meta):** credenciais por canal (app id,
  app secret, id da página, token da página, id da conta do Instagram), com os segredos
  cifrados e mascarados, e um token de verificação gerado pelo CRM. O webhook público
  responde ao desafio de verificação só com esse token (403 com outro) e **exige a
  assinatura** `X-Hub-Signature-256` do corpo com o app secret (401 sem ela ou errada:
  nada entra). Os eventos são processados por fila; ecos das próprias mensagens são
  ignorados; o nome do contato vem do perfil.
- **R14.8** **Janela de 24 horas** da Meta: a resposta comum só é aceita até 24 horas
  depois da última mensagem do contato. Fora dela a tela avisa e o envio é recusado (422);
  a recusa da Meta também vira falha definitiva com o motivo.
- **R14.9** Anexos recebidos da Meta são baixados só por HTTPS (conferido em cada
  redirecionamento), com limite de tamanho, e não são baixados de novo numa nova
  tentativa; os enviados vão por link assinado da API. Numa mensagem com anexo e texto, a
  parte que já chegou ao contato não é reenviada.

## 18. Chat interno da equipe (R15)

- **R15.1** **Canais padrão:** o "Geral" reúne todas as pessoas ativas; cada área
  (Comercial, Marketing, CS) tem o seu canal, com as pessoas da área e o C-level (o Admin
  fica só no Geral). Os membros acompanham o papel automaticamente (ao subir a API, a cada
  minuto, no desligamento e sempre que a pessoa usa o chat). Não dá para sair, renomear
  nem arquivar um canal padrão — só silenciar.
- **R15.2** **Grupos:** qualquer pessoa cria e vira administradora. Quem administra
  renomeia, muda a descrição, adiciona pessoas ativas (até 200), tira pessoas, dá ou tira
  a administração (sempre fica alguém administrando) e arquiva ou desarquiva; grupo
  arquivado fica só para leitura. Quem sai passa a administração ao membro mais antigo; o
  grupo que fica vazio é arquivado. Quem é desligado sai dos grupos, com um aviso. Cada
  mudança gera um aviso no grupo e é auditada.
- **R15.3** **Conversas diretas:** uma por par de pessoas, criada sob demanda, e
  **privadas** — nem o Admin vê a conversa, as mensagens, os anexos, a busca ou o tempo
  real dela; a auditoria guarda só quem iniciou. Com a outra pessoa desligada, a conversa
  fica só para leitura.
- **R15.4** **Mensagens:** texto de até 4.000 caracteres e/ou um anexo (do contexto do
  chat, enviado por quem escreve, usado uma vez só), resposta a outra mensagem; só o autor
  edita ou exclui as próprias — a exclusão apaga o texto e remove o anexo (R11.7).
- **R15.5** **Menções** (`@nome`, gravadas como `<@id>`, até 20 por mensagem) só de membros
  do canal; notificam a pessoa mencionada com o link da mensagem, mesmo com o canal
  silenciado. Na edição, só as menções novas notificam.
- **R15.6** **Referências** a negócio, contato e empresa (até 10 por mensagem) viram links;
  negócio só se quem escreve o vê (R5.9). Item excluído aparece como "item indisponível".
- **R15.7** **Não lidas e busca:** contam as mensagens de outras pessoas depois da última
  leitura; o total do menu soma os canais não silenciados e não arquivados, mais as
  menções nos silenciados. A busca ignora acentos e maiúsculas, só nos canais da pessoa,
  sem mensagens excluídas.

## 19. Tempo real e matriz de acesso (Fase 2 — Onda A)

- O tempo real (Socket.IO) aceita só quem tem sessão válida (cookie) vinda de uma origem
  permitida (R2.9); com troca de senha pendente (R2.7) a conexão é recusada. Sair,
  desligamento ou sessão expirada derrubam os sockets da sessão na hora (R2.4). Entrar na
  sala de uma conversa ou de um canal do chat confere a permissão (R12.5, R15).

| Recurso | Admin | C-level | Líder (Comercial, CS) | Membro (Comercial, CS) | Marketing |
| --- | --- | --- | --- | --- | --- |
| Ver e atender conversas | todas | todas | filas da área + as suas | as suas + sem responsável da área | — |
| Assumir, transferir, resolver, reabrir | ✓ | ✓ | nas que vê | nas que vê | — |
| Configurar filas | todas | todas | da área | — | — |
| Respostas rápidas (gerenciar) | todas | todas | da área | — | — |
| Horário, fila padrão e satisfação do canal | ✓ | ✓ | — | — | — |
| Canais (WhatsApp, chat do site, e-mail, Meta) | ✓ | — | — | — | — |
| Métricas do Atendimento | todas | todas | da área | — | — |
| Chat interno | ✓ (sem ler diretas alheias) | ✓ | ✓ | ✓ | ✓ |

## 20. Cenários de aceitação (Fase 2 — Onda A)

Continuam a numeração da seção 13; cada um tem teste automatizado contra um Postgres
real ("cenário N" no nome do teste).

16. Arquivo SVG ou HTML, inclusive com outro tipo declarado, é recusado (415); acima do
    limite do contexto, 413 (R11.2, R11.3).
17. Mídia de uma mensagem: quem vê a conversa baixa com `nosniff` e `Content-Disposition`;
    quem não vê recebe 404. Anexo do chat interno: só os membros do canal, nem o Admin
    (R11.4, R11.5).
18. Mensagem recebida por um canal cria contato, identificador, conversa na fila padrão e
    mensagem; repetir o mesmo id externo não duplica, e a mensagem seguinte entra na mesma
    conversa (R12.2, R12.3).
19. Conversas novas numa fila em rodízio alternam entre os membros ativos da área que já
    ativaram o acesso; quem tem convite pendente fica fora até ativar — também no rodízio
    de leads (R12.4, ajuste da R5.8).
20. Visibilidade: Admin e C-level veem tudo; o líder, as filas da área; o membro, as suas
    e as sem responsável da área; o Marketing não acessa (R12.5).
21. Transferir para uma pessoa com nota grava o histórico, a nota interna, a notificação e
    a auditoria (R12.7).
22. Fora do horário, a resposta automática sai uma vez por período, e o SLA conta da
    abertura seguinte (R12.11, R12.12).
23. SLA de primeira resposta estourado: o job avisa o líder uma vez; responder antes do
    prazo evita o aviso (R12.12).
24. Resolver com a pesquisa ligada: "5" em até 24 horas grava a nota sem reabrir; depois
    disso, a mensagem abre conversa nova; nota 1 ou 2 avisa o líder (R12.13).
25. Envio com falha definitiva fica `FALHOU` com o motivo; "tentar de novo" volta a
    `PENDENTE` e envia (R12.10).
26. WhatsApp no gateway simulado (processo de verdade): conectar mostra o QR e chega a
    `CONECTADO`; a mensagem do simulador vira conversa; o envio vai até `LIDA` (R13.2,
    R13.5, R13.8).
27. Proteções: mensagem ativa para quem pediu opt-out falha e a resposta ao contato sai;
    passado o limite diário (com aquecimento), a ativa fica para o dia seguinte (R13.6,
    R13.7).
28. Chat do site: sem consentimento o visitante não entra; outro navegador com o mesmo
    e-mail não lê o que o primeiro escreveu (R14.2, R14.3).
29. E-mail: só mensagens novas, corpo em texto sem HTML nem citação, resposta com
    `In-Reply-To`/`References` e a volta na mesma conversa (R14.5, R14.6).
30. Meta: webhook sem assinatura ou com assinatura errada é 401 e nada entra; fora da
    janela de 24 horas o envio é recusado (R14.7, R14.8).
31. Chat interno: o Geral e o canal da área nascem pelo papel; a menção notifica com link;
    a conversa direta é privada até para o Admin (R15.1, R15.3, R15.5).
32. Tempo real: sem sessão a conexão é recusada; sair derruba o socket; entrar na sala de
    uma conversa que a pessoa não vê é recusado (seção 19, R12.5).
33. Jornada do atendimento: mensagem pelo WhatsApp simulado → conversa distribuída e
    avisada em tempo real → resposta com resposta rápida até `LIDA` → negócio criado da
    conversa e citado no chat interno → resolução com nota 5 → métricas da fila
    (R12, R13, R15).

---

## 21. Importação de contatos e empresas (R16)

- **R16.1** **Quem importa:** Admin, C-level e líderes (permissão `importarContatos`);
  membro recebe 403. Cada pessoa vê e baixa só as próprias importações; Admin e C-level
  veem todas (R16.9).
- **R16.2** **Arquivo e prévia:** CSV ou XLSX enviado como arquivo do contexto
  `IMPORTACAO` (R11), até **50 mil linhas** (acima disso, 422). O servidor detecta
  codificação (UTF-8 ou Windows-1252) e separador (`,` `;` tabulação `|`), lê o cabeçalho
  e devolve as colunas, a prévia das primeiras linhas e um mapeamento sugerido pelo nome
  da coluna. Arquivo que não é planilha, planilha sem linhas ou arquivo de outra pessoa
  são recusados. Planilha XLSX usa a primeira aba (ou a escolhida em `leitura`); é lida
  em fluxo, recusada ao passar de 50 mil linhas ou de 200 colunas no cabeçalho, e o
  contexto `IMPORTACAO` aceita até 10 MB.
- **R16.3** **Mapeamento:** coluna → campo (nome, e-mail, telefone, empresa, cargo,
  origem, etiquetas, UTM e `campos.<chave>` para campos personalizados; para empresas,
  nome, CNPJ, UF etc.). Cada campo recebe no máximo uma coluna; para contatos, o início
  exige **nome** e e-mail ou telefone mapeados. Mapeamentos podem ser salvos como
  **modelo** (auditado) e aplicados a outra planilha pelos nomes das colunas.
- **R16.4** **Processamento:** em fila, em lotes de 100 linhas, **linha a linha pelos
  mesmos serviços da criação manual** (normalização R4.1 e deduplicação R4.2, origem
  `IMPORTACAO` com o detalhe informado, etiquetas e campos personalizados). A linha
  inválida (sem nome, e-mail ou telefone inválido, CNPJ inválido) não derruba as outras:
  vira "erro" com o motivo e o número da linha; telefone inválido com e-mail válido
  importa e avisa. O progresso vai ao vivo (`importacao.progresso`) a cada lote.
- **R16.5** **Duplicados** (já existe contato com o e-mail ou telefone, ou empresa com o
  mesmo CNPJ ou nome): *atualizar só os vazios* (padrão), *ignorar* (não toca no
  existente) ou *sobrescrever* (troca pelos valores da planilha).
- **R16.6** **Responsável:** quem importou (R4.5), uma pessoa fixa ao alcance de quem
  importa, ou rodízio da área (R5.8); só vale para contatos criados, nunca troca o
  responsável de quem já existe.
- **R16.7** **Cancelar e retomar:** cancelar antes de processar não importa nada; depois
  de concluída, não cancela. Se o processo cair, a retomada continua depois da última
  linha gravada e os contadores somam tudo.
- **R16.8** **Auditoria e relatório:** o resumo da importação é auditado (`criada`,
  `iniciada`, `concluida`, `cancelada`, `falhou`, com as contagens) **e** cada contato ou
  empresa criado ou reconvertido tem o seu próprio evento de auditoria
  (`contato.criado`, `contato.reconvertido`…), com ator = quem importou. No fim, a API
  gera o **relatório XLSX** (resumo, problemas com número da linha e motivo, resultado de
  cada linha) e publica o evento de domínio `importacao.concluida`. Se quem importou foi
  desligado antes de processar, a importação falha sem importar nada.
- **R16.9** **Download:** a planilha enviada e o relatório só são baixados por quem
  importou, Admin e C-level.

## 22. Disparos (R17)

Campanhas de WhatsApp e e-mail para um público de contatos, com ritmo anti-banimento.

- **R17.1** **Permissões:** Admin, C-level, líderes e membros de Marketing, Comercial e
  CS usam. Membro vê e gerencia só as **próprias** campanhas; líder, as da área (e as
  próprias); Admin e C-level, todas. A diretoria escolhe a área da campanha (ou nenhuma).
- **R17.2** **Público:** um **segmento** (filtros em JSON sobre contatos: etiquetas,
  origem, responsável, funil/etapa, datas, campos personalizados…) ou uma **lista
  importada** (quem a importação R16 criou ou atualizou). Sempre **excluídos**: quem fez
  opt-out (R4.6), quem não tem o canal (telefone para WhatsApp, e-mail para e-mail) e
  duplicados. O número que o gateway diz não ter WhatsApp vira `INVALIDO` (com cache) e
  **não consome o ritmo**. Opt-out depois da montagem do público também não recebe.
- **R17.3** **Mensagem:** texto com variáveis (`{{contato.primeiro_nome}}`…), valor
  padrão e variações (`{a|b|c}`, sorteadas de forma reprodutível por destinatário);
  variável desconhecida, ritmo invertido, janela ou canal inválidos são recusados. Mídia
  só do contexto `CAMPANHA`. Há prévia por contato, **envio de teste** ao próprio número,
  modelos salvos (por área; edita quem criou, o líder da área e a diretoria), duplicar
  campanha e uma configuração padrão com a estimativa de duração.
- **R17.4** **Envio:** **um destinatário por vez**, com intervalo aleatório entre o
  mínimo e o máximo da campanha — nunca menor que o do número (R13) —, lote com pausa e
  "digitando…". O **limite diário e o aquecimento** do número (R13.7) valem: atingido o
  limite, a campanha espera o dia seguinte. Com vários números, o rodízio alterna a cada
  envio. Pausar e retomar (ou "Reenviar falhas") **não antecipa** o próximo envio: vale o
  que o ritmo e a pausa do lote já tinham marcado. A mensagem é criada **na conversa do contato** pelo mesmo caminho do
  Atendimento (fila de envio → adaptador do canal → gateway), com autor `AUTOMACAO`
  (ator = a campanha). **Conversa:** a em aberto do contato no canal; senão a última que
  nunca recebeu mensagem do contato; senão uma nova **já `RESOLVIDA`**, para não encher a
  caixa de entrada com conversas sem resposta — quando o contato responde, o Atendimento
  abre uma conversa nova e a distribui pela fila (R12).
- **R17.5** **Pausa automática:** número desconectado faz a campanha esperar; ao atingir
  as falhas seguidas configuradas (`pausarAposFalhas`) ela **pausa sozinha** e avisa o
  criador (`campanha.pausada`). "Reenviar falhas" devolve os destinatários que falharam
  à fila.
- **R17.6** **Janela de envio:** dias e horas permitidos (fuso `America/Sao_Paulo`, mesmo
  formato do horário de atendimento): fora dela nada sai e a campanha espera a abertura.
- **R17.7** **Ciclo de vida:** rascunho → (aguardando aprovação) → agendada → em
  andamento ⇄ pausada → concluída ou cancelada. Transições inválidas dão 422. A
  **agendada** começa na hora marcada (varredura a cada minuto). Depois de um reinício, a
  varredura religa a campanha que perdeu o job de envio, sem duplicar o ritmo. A
  conclusão avisa o criador e publica `campanha.concluida`.
- **R17.8** **E-mail:** o assunto (com variáveis) vai na conversa do contato. O primeiro
  contato de uma campanha sai com o assunto **sem o prefixo "Re:"**; respostas depois que
  o contato escreveu voltam a usar "Re:" (R14.6).
- **R17.9** **Respostas e saída:** a mensagem do contato **até 7 dias depois do envio**
  marca o destinatário como "respondeu" (uma vez) e publica `campanha.respondida`; ela já
  está no Atendimento, como qualquer outra. A **palavra de saída** (`SAIR`, `PARAR`,
  `CANCELAR`, configuráveis; a mensagem inteira, sem acento nem caixa — "não quero
  cancelar" não conta) **até 30 dias depois do envio** aplica o opt-out (R4.6), auditado
  com ator `AUTOMACAO` (descrição = a campanha), tira os envios pendentes do contato de
  todas as campanhas e responde a confirmação (configurável) uma única vez.
- **R17.10** **Aprovação (opcional):** com `aprovacaoDoLider` ligada, a campanha de membro
  espera o líder da área, o C-level ou o Admin; reprovar volta a rascunho; aprovar a
  inicia. Líder e diretoria começam sem aprovação. Cada passo notifica (`campanha.aprovacao_pedida`,
  `aprovada`, `reprovada`).
- **R17.11** **Relatório e exportação:** enviados, entregues, lidos, respondidos, falhas,
  inválidos, excluídos e opt-outs, taxas, por número, ao longo do tempo e motivos de
  falha. Exporta em **XLSX** ou **CSV** (separador `;`, com BOM para o Excel e proteção
  contra fórmulas); baixa quem enviou, quem vê a campanha (líder) e a diretoria. O
  progresso ao vivo vai pelo evento `campanha.progresso`.

## 23. Chatbot (R18)

Fluxos em passos que atendem a conversa antes (ou no lugar) do atendimento humano, sobre
o executor de passos compartilhado.

- **R18.1** **Gatilhos:** `NOVA_CONVERSA`, `PALAVRA_CHAVE` (palavra ou expressão inteira,
  sem acento nem caixa), `FORA_DO_HORARIO` (só com o canal fechado) e `SEMPRE` — os três
  sem palavra-chave só começam quando **nenhum fluxo rodou ainda** na conversa. O fluxo
  pode restringir canais. Vários fluxos: vence a **prioridade**; no empate, o gatilho mais
  específico e depois o mais antigo. Uma execução por conversa.
- **R18.2** **Passos:** mensagem, pergunta com opções (numeradas no WhatsApp e e-mail,
  botões no chat do site), pergunta aberta (validação de e-mail, telefone, número, data;
  salva em variável ou campo do contato), condição (variável, campo, horário, etiqueta,
  canal → ramos e "senão"), ações (etiquetar, definir campo, mover de fila, atribuir,
  criar negócio, criar atividade, chamar webhook de saída), aguardar, transferir e
  encerrar. O rascunho aceita configuração incompleta; a **publicação** aponta cada
  problema (até 150 passos por fluxo).
- **R18.3** **Perguntas:** resposta inválida repete a pergunta até o limite de tentativas
  (3 por padrão, até 10); estourado o limite, o fluxo encerra (`respostas_invalidas`).
- **R18.4** **Ações e transferência:** as ações passam pelos **mesmos serviços** das
  ações humanas (R4, R5, R6, R12) e são auditadas com ator `AUTOMACAO` (descrição = o
  fluxo). Webhook para rede interna é bloqueado como nos webhooks de saída (R9) e o fluxo
  segue. **Transferir** deixa o **resumo das respostas como nota interna**, move a
  conversa de fila, atribui pela mesma distribuição do Atendimento, notifica o responsável
  e publica `chatbot.transferida`. As mensagens do bot têm autor `BOT`.
- **R18.5** **Tempo sem resposta:** por pergunta, um lembrete após X minutos e/ou o
  encerramento (ramo `sem_resposta`), até 7 dias.
- **R18.6** **Permissões:** Admin e C-level gerenciam todos os fluxos; o líder cria e
  gerencia os da própria área e vê, só para leitura, os das outras e os sem área; membro
  não acessa (403). O líder só liga o fluxo a canais cuja fila padrão é da área dele
  (nunca "todos os canais", 400); Admin e C-level escolhem livremente. Os seletores de
  canais e filas vêm de `GET /disparos/canais`, `/chatbot/opcoes` e `/automacoes/opcoes`
  (permissão de cada módulo, sem passar pelo Atendimento). O construtor de segmentos
  só aceita funis, etapas e área de negócio que a pessoa vê (R5.9, 400).
- **R18.7** **Versões:** publicar cria uma **versão imutável**; editar muda só o
  rascunho; a conversa em andamento termina na versão em que começou e a nova usa a
  publicada. Restaurar copia uma versão antiga para o rascunho; também há duplicar,
  ativar/desativar e excluir (cancela as execuções em andamento).
- **R18.8** **Humano assume, bot sai:** o atendente que responde, assume, transfere ou
  resolve a conversa **cancela** o fluxo em andamento; conversa em que o atendente já
  atuou não inicia fluxo; a resposta do contato depois já não é lida pelo bot.
- **R18.9** **Simulador:** roda o rascunho no editor sem efeitos reais (transcrição,
  opções, silêncio, resumo da transferência, "fora do horário"); recusa fluxo com
  problemas; encerrar a simulação a cancela.
- **R18.10** **Chat do site:** as opções de uma pergunta chegam ao widget como `botoes`
  na mensagem pública e aparecem como botões (só na última mensagem da conversa); o
  clique envia o texto da opção como resposta do visitante.
- **Comportamento conhecido (2026-10-30):** a conversa nova é **distribuída pela fila
  antes de o bot entrar** (R12.4), então um atendente pode ser notificado e ter a
  conversa atribuída enquanto o bot ainda conversa; assim que o atendente responde ou
  assume, o bot sai (R18.8). Fazer o bot atender sem responsável e distribuir só na
  transferência exige saber, na chegada, se algum fluxo vai atender (senão a conversa
  fica sem dono): ficou para a próxima fase.

## 24. Automações e cadências (R19)

- **R19.1** **Permissões:** Admin e C-level veem e gerenciam todas (inclusive as sem
  área); o líder, as da própria área; membro não usa (403).
- **R19.2** **Gatilhos:** eventos de domínio — contato criado/atualizado, negócio
  criado/movido para a etapa (com filtro de funil e etapa)/ganho/perdido, atividade
  criada, conversa nova/resolvida, mensagem recebida contendo palavra, satisfação
  recebida, campanha respondida — e gatilhos de **agenda**: *data relativa* ("N dias
  antes/depois" de um campo de data do contato, negócio ou personalizado), *recorrência*
  (dispara para o público a cada ocorrência), *negócio parado* na etapa acima do prazo e
  *atividade atrasada* (varredura a cada 5 minutos, uma vez por permanência/atraso).
  Gatilho, filtro e passo inválidos são recusados (400).
- **R19.3** **Condições:** segmento (R17.2) sobre a entidade do gatilho e horário
  permitido (fora dele, as ações esperam a próxima abertura).
- **R19.4** **Ações:** WhatsApp por modelo, e-mail, atividade, mover etapa, atribuir
  (rodízio), etiquetar, criar negócio em outro funil, notificar usuário, chamar webhook
  de saída (`automacao.acionada`, uma entrega por execução), iniciar fluxo do chatbot e
  condição; **aguardar** X tempo entre ações forma a *cadência*. Toda ação passa pelos
  mesmos serviços e regras das ações humanas e é **auditada com ator `AUTOMACAO`**
  (descrição = nome da automação).
- **R19.5** **Parada:** critérios por automação — *respondeu* (mensagem recebida ou
  campanha respondida), *ganhou*, *perdeu* e *saiu do segmento* (conferido ao acordar). A
  execução em espera é cancelada.
- **R19.6** **Limite por entidade:** *uma vez*, *uma vez por período* (N dias) ou
  *sempre*; vale por entidade (contato, negócio…), não global. A reentrega do mesmo
  evento nunca duplica a execução.
- **R19.7** **Laços:** o evento gerado por uma automação pode disparar outras, mas a
  cadeia tem profundidade máxima de **5** e a mesma automação aparece no máximo **3**
  vezes; além disso a execução não inicia (registrado no log técnico). Uma execução faz no
  máximo 1.000 passos (proteção contra laço interno).
- **R19.8** **Histórico, erro e teste:** cada execução guarda o resultado de cada passo.
  Passo com erro **falha a execução**; reexecutar o passo conclui. Dá para cancelar uma
  execução em espera. O **modo teste** roda a automação sobre uma entidade escolhida,
  **sem efeitos externos** (mensagens e webhooks simulados, esperas puladas) e não conta
  como execução real nem no limite R19.6; informa quando a entidade não atenderia às
  condições. A lista mostra a **"última vez"** de qualquer execução real (nas de
  varredura, o marco da janela).
- **R19.9** **Marketing e opt-out:** automação marcada como de marketing deixa de fora
  quem tem opt-out (R4.6), inclusive no meio de uma cadência; as demais atendem também
  quem fez opt-out.
- **R19.10** **Ciclo de vida:** nasce **pausada**; ativar sem ações dá 422 com as
  pendências. Editar muda a versão, e a execução em andamento segue na versão em que
  começou. Pausar impede novas execuções e suspende as em andamento até reativar;
  duplicar cria cópia pausada; excluir cancela as execuções em andamento. Há quatro
  **modelos prontos** (boas-vindas ao lead, follow-up de proposta, lembrete de renovação,
  reativação), sempre criados pausados. Criação, ativação e exclusão são auditadas.

## 25. Matriz de acesso (Fase 2 — Onda B)

| Recurso | Admin | C-level | Líder | Membro |
| --- | --- | --- | --- | --- |
| Importar contatos e empresas (R16) | ✓ | ✓ | ✓ | — |
| Ver o histórico e baixar importações | todas | todas | as próprias | — |
| Campanhas (R17) | todas | todas | as da área e as suas | as suas |
| Aprovar campanha | ✓ | ✓ | da área | — |
| Configuração dos disparos (aprovação, palavras de saída) | ✓ | ✓ | — | — |
| Chatbot (R18) | todos | todos | os da área (lê os demais) | — |
| Automações (R19) | todas | todas | as da área | — |

Marketing usa Disparos, mas não o Atendimento (R12); o líder de Marketing importa,
cria campanhas e automações da própria área.

## 26. Cenários de aceitação (Fase 2 — Onda B)

Continuam a numeração da seção 20; cada um tem teste automatizado ("cenário N" no nome
do teste) contra um Postgres real.

34. Só Admin, C-level e líderes importam; membro recebe 403 (R16.1).
35. O rascunho traz colunas, prévia e mapeamento sugerido; o mapeamento é conferido e
    modelos salvos se aplicam a outro arquivo (R16.2, R16.3).
36. Importar contatos: deduplicação, normalização, origem `IMPORTACAO`, etiquetas,
    progresso ao vivo, relatório XLSX, auditoria do resumo e de cada contato (R16.4, R16.8).
37. Duplicados: ignorar não toca no existente, sobrescrever troca os valores, atualizar
    vazios só completa (R16.5).
38. Responsável fixo, rodízio da área ou quem importou (R16.6).
39. Cancelar antes de processar não importa nada (R16.7).
40. A planilha e o relatório só são baixados por quem importou, Admin e C-level (R16.9).
41. Visibilidade das campanhas: membro as suas, líder as da área, diretoria todas (R17.1).
42. A prévia do público exclui opt-out e conta quem não tem telefone (R17.2).
43. Envio um a um no ritmo, na conversa do contato, com autor `AUTOMACAO`; conversa nova
    nasce `RESOLVIDA` (R17.4).
44. Fora da janela de envio nada sai; a campanha espera a abertura (R17.6).
45. Limite diário do número atingido: espera o dia seguinte (R17.4, R13.7).
46. Falhas seguidas pausam a campanha; reenviar falhas devolve à fila (R17.5).
47. A resposta cai no Atendimento e marca "respondeu" uma única vez (R17.9).
48. "SAIR" aplica o opt-out, tira os pendentes, confirma e audita como `AUTOMACAO` (R17.9).
49. Resposta depois de 7 dias do envio não conta (R17.9).
50. A saída vale até 30 dias; depois disso não é aplicada (R17.9).
51. Com aprovação ligada, a campanha do membro espera o líder; reprovar volta a rascunho
    (R17.10).
52. Exportação em XLSX e CSV (`;`, BOM, sem fórmulas); só quem vê baixa (R17.11).
53. Gatilho por palavra-chave, prioridade e canal restrito escolhem o fluxo (R18.1).
54. O rascunho aceita configuração incompleta; a publicação aponta cada problema (R18.2).
55. Pergunta, resposta inválida, ação e transferência com resumo em nota interna; mensagens
    `BOT`; auditoria `AUTOMACAO` (R18.2 a R18.4).
56. Sem resposta: lembrete e depois encerramento (R18.5).
57. Membro não acessa o chatbot; líder só gerencia a própria área (R18.6).
58. Publicar cria versões imutáveis; editar não muda a conversa em andamento (R18.7).
59. O atendente que responde cancela o fluxo (R18.8).
60. O simulador roda o rascunho sem efeitos reais (R18.9).
61. Membro não usa automações; líder só as da área (R19.1).
62. Contato novo dispara a automação; ação com ator `AUTOMACAO`; "última vez" na lista
    (R19.2, R19.4, R19.8).
63. Cadência: ações intercaladas por esperas (R19.4).
64. A resposta do contato cancela a execução em espera (R19.5).
65. Limite "uma vez por período" volta a valer depois do período (R19.6).
66. Automação que dispara a si mesma para na terceira vez (R19.7).
67. Modo teste simula as ações sem efeito e não conta como execução (R19.8).
68. Opt-out fica de fora das automações de marketing, também no meio da cadência (R19.9).
69. Data relativa dispara na hora marcada, uma vez (R19.2).
70. As opções do chatbot chegam ao chat do site como botões (R18.10).

## 27. BI e métricas (R20)

- **R20.1** **Painéis e acesso:** `marketing`, `comercial`, `cs`, `atendimento` e `financeiro`
  (`GET /bi/paineis` devolve as abas do papel; `GET /bi/:painel` os números). Admin e C-level
  veem todos; as pessoas de área veem o painel da própria área e o do Atendimento (exceto
  Marketing, que não usa o Atendimento, R12). O painel Financeiro é de Admin, C-level e CS
  (R22.1). Painel que o papel não vê dá 403; painel desconhecido, 400.
- **R20.2** **Visibilidade (R1):** nenhum número revela o que a pessoa não veria na lista
  correspondente. Os recortes de SQL espelham as funções das listas — negócios como no
  kanban (R5.9), atividades, conversas (R12.2), campanhas, contratos e parcelas (R22.1) — e
  cada teste confere o número do BI contra a lista. Membro: só o que é dele (e o sem
  responsável, como no kanban); líder: a área; diretoria: tudo.
- **R20.3** **Filtros comuns:** período (`de` e `ate`; padrão, os últimos 30 dias; máximo de
  366), `area`, `equipeId`, `pessoaId`, `funilId`, `canalId` e `filaId` (cada painel aceita os
  que fazem sentido). Filtro fora do alcance do usuário (área de outro, equipe de outra área,
  pessoa de outra área) é recusado e funil de outra área dá 404 — o filtro nunca amplia a
  visibilidade. Agrupamentos por dia e por hora usam o fuso de São Paulo.
- **R20.4** **Comparação:** os cartões trazem o valor do período, o valor do **período anterior
  de mesma duração** e a variação. Indicadores "de agora" (carteira, renovações próximas, MRR
  atual, abertos) não têm comparação.
- **R20.5** **Conteúdo dos painéis:** *Marketing* — leads por origem, UTM e dia, passagens
  para o Comercial (taxa e tempo até a passagem) e campanhas (enviados, entregues, lidos,
  respondidos e opt-outs, pela data de cada evento). *Comercial* — funil por etapa
  (quantidade e valor), valor em aberto e ponderado (valor × probabilidade da etapa), taxa de
  ganho, ciclo médio, motivos de perda, ranking por vendedor e atividades feitas e atrasadas.
  *CS* — carteira, recorrente, onboarding por etapa, renovações por faixa, renovados e
  cancelados, satisfação (só das filas de CS) e risco de churn (R23.4). *Atendimento* — volume
  por canal e por hora, primeira resposta, tempo de atendimento, SLA cumprido, CSAT, por
  atendente e por fila. *Financeiro* — MRR, inadimplência por faixa e previsto × realizado
  (R23).
- **R20.6** **Cache:** resposta guardada por **30 segundos** por pessoa e filtro (no máximo
  300 entradas); `Cache-Control: no-cache` recalcula. Não há invalidação por evento: o número
  pode atrasar até 30 s.
- **R20.7** **Exportação:** `POST /bi/:painel/exportar` com os mesmos filtros devolve CSV
  (`;`, BOM, sem fórmulas) ou XLSX (uma aba por tabela) com os mesmos números do painel, de
  quem exporta. Tabela desconhecida, formato inválido ou painel proibido são recusados. A
  exportação é auditada (`bi.exportado`).
- **R20.8** **Cliques (front):** o clique num gráfico abre a lista filtrada que sustenta o
  número — etapa leva a `/funis/<área>?etapaId=…` (o quadro mostra só aquela etapa), canal e fila
  levam a `/atendimento?canalId=…`/`?filaId=…` (a caixa de entrada abre filtrada), pessoa
  filtra o próprio painel, negócio e contato abrem o detalhe.

## 28. Análise do BI por IA (R21)

- **R21.1** **Quem usa:** só o **Admin**; os demais papéis recebem 403 e o front nem mostra
  o botão. Sem sessão, 401.
- **R21.2** **Entrada:** apenas os **números agregados** do painel e dos filtros atuais — as
  mesmas tabelas do BI, com no máximo 60 linhas cada. Nenhum dado pessoal de contato (nome,
  e-mail, telefone) vai ao modelo: listas nominais (risco de churn, renovações) são agregadas
  antes. A análise respeita os filtros validados como no R20.3 (filtro inválido é 400
  antes de abrir o fluxo).
- **R21.3** **Resposta:** em streaming (`text/event-stream`, eventos `inicio`, `fase`,
  `parcial`, `nova_tentativa`, `concluido` e `erro`), estruturada por JSON Schema — resumo,
  destaques, riscos e ações recomendadas. Cada ação traz um link para a lista filtrada que a
  sustenta; links inventados pelo modelo viram o painel correspondente (só rotas do catálogo
  valem).
- **R21.4** **Modelo e robustez:** `claude-opus-5-5` pela SDK oficial, raciocínio adaptativo,
  prompt de sistema com cache, tempo máximo de 120 s por tentativa e **uma nova tentativa**
  (o parcial da primeira é descartado). Erro ou tempo esgotado na segunda: evento `erro`,
  análise `FALHOU`, auditada, e **não conta** no limite diário.
- **R21.5** **Perguntas de acompanhamento:** até **5** por análise, de até 1.000 caracteres,
  que continuam a mesma conversa (aproveitando o cache) e somam os tokens.
- **R21.6** **Limite diário:** padrão de 20 análises por dia (fuso de São Paulo, somando os
  Admins), configurável de 0 a 1.000 pelo Admin (0 desliga; mudança auditada em
  `bi.analise_ia_configurada`). Passou do limite: 429 com `Retry-After`.
- **R21.7** **Chave:** `ANTHROPIC_API_KEY` só no servidor — nunca devolvida nem registrada
  em log. Sem chave, `GET /bi/analise/estado` explica como configurar e a análise é 503, sem
  chamar a Anthropic. `ANTHROPIC_BASE_URL` existe para testes (API falsa).
- **R21.8** **Histórico e auditoria:** cada análise e pergunta guarda quem pediu, filtros, a
  entrada enviada, o resultado e os tokens; o Admin consulta o histórico
  (`GET /bi/analise/historico`). Auditoria: `bi.analise_ia_concluida`, `bi.analise_ia_falhou`,
  `bi.analise_ia_pergunta_respondida` e `bi.analise_ia_pergunta_falhou`.

## 29. Contratos e parcelas (R22)

- **R22.1** **Acesso:** Admin, C-level e Líder de CS gerenciam tudo; membro de CS vê e atua
  nos clientes da **própria carteira** (responsável de CS) e nos sem responsável; Comercial
  vê, **só leitura**, os contratos dos negócios que ganhou; Marketing não acessa (403). O BI
  não mostra contrato nem título que a lista não mostra.
- **R22.2** **Contrato:** cliente (empresa e/ou contato), negócio ganho de origem (negócio
  aberto é recusado), produto, valor, periodicidade (mensal, anual, cobrança única…), início,
  fim, renovação automática, responsável de CS e status (`ATIVO`, `SUSPENSO`, `CANCELADO`,
  `ENCERRADO`). Criar gera as parcelas (no máximo 120 de uma vez) e o movimento **novo** do
  MRR. O contrato anual rende 1/12 do valor ao mês; a cobrança única não entra no MRR.
  Suspender, reativar e cancelar são auditados; cancelar cancela as parcelas que ainda não
  venceram. Contrato ativo com o fim passado é **encerrado** (churn) ou, com renovação
  automática, estendido com novas parcelas.
- **R22.3** **Parcela (título):** número único, vencimento, valor, status (`ABERTO`, `PAGO`,
  `ATRASADO`, `CANCELADO`, `RENEGOCIADO`), link do boleto, link de pagamento, Pix, data e
  forma de pagamento. Pode ser manual (exige cliente: contrato, contato ou empresa). Depois de
  paga, não se edita. **Renegociar** marca a parcela como `RENEGOCIADO` e cria outra, com a
  régua do zero. Mudar o vencimento reinicia a régua (R24.3).
- **R22.4** **Baixa manual:** marca como paga com data e forma de pagamento, audita
  (`parcela.baixada`), publica o evento `parcela.paga` e encerra a régua do título (R24.6). A
  segunda baixa é recusada.
- **R22.5** **Importação de parcelas** (tipo `PARCELAS`, a importação da Onda B): colunas
  sugeridas pelo nome; cria clientes que não existem; **reimportar atualiza pelo número**, dá
  baixa nos pagos e reinicia a régua de quem teve o vencimento alterado; coluna ausente ou
  célula vazia **não apaga** dado; "ignorar duplicados" não toca nos existentes; erros por
  linha vão ao relatório. Só quem gerencia o Financeiro importa.
- **R22.6** **Sugestão ao ganhar:** quando um negócio é ganho, o responsável recebe uma
  notificação (`contrato.sugerido`) e a tela de contrato abre pré-preenchida com cliente,
  produto e valor do negócio.
- **R22.7** **Atraso:** a parcela aberta vencida antes de hoje aparece como `ATRASADO` na
  hora da consulta; o job diário grava o status, audita (`parcela.atrasada`) e publica o evento
  `parcela.atrasada`.
- **R22.8** **Eventos de saída:** `contrato.criado`, `contrato.atualizado`,
  `contrato.cancelado`, `contrato.encerrado`, `contrato.reativado`, `parcela.paga` e
  `parcela.atrasada`.

## 30. MRR e inadimplência (R23)

- **R23.1** **MRR por mês:** receita recorrente mensal dos contratos ativos e suspensos, com
  os movimentos do mês — **novo** (contratos criados), **expansão** e **contração** (mudança
  de valor) e **churn** (cancelamento ou encerramento, em valor positivo) — e o MRR no fim de
  cada mês. Datas no fuso de São Paulo.
- **R23.2** **Inadimplência:** parcelas vencidas e não pagas por faixa de dias de atraso —
  0–30, 31–60, 61–90 e 90+ —, com valor, parcelas e clientes; a **taxa de inadimplência** é o
  valor em atraso sobre o valor a receber vencido ou a vencer.
- **R23.3** **Previsto × realizado:** por mês, o previsto (vencimentos do mês), o realizado
  (pago), o que segue em aberto e a taxa de realização.
- **R23.4** **Risco de churn:** pontuação por cliente (limitada a 100) somando **atraso**
  (1–30 dias: 20; 31–60: 35; mais de 60: 50), **satisfação baixa** (nota até 2: 30; nota 3:
  15) e **silêncio** (mais de 30 dias sem interação: 10; mais de 60: 20). Níveis: alto a partir
  de 60, médio a partir de 30, baixo abaixo disso. Aparece no painel de CS, no contato e no
  negócio de CS, respeitando a visibilidade (R22.1).
- **R23.5** Os indicadores respeitam a visibilidade do usuário (R22.1) e alimentam o painel
  Financeiro do BI (R20) e os cartões da tela inicial. São **agregados no banco** (`$queryRaw`
  com `GROUP BY`, sem carregar as linhas), com o mesmo filtro de visibilidade das listas
  escrito em SQL (`permissoes-financeiro-sql.ts`); o índice parcial `parcelas(pago_em) WHERE
  status = 'PAGO'` atende os recebimentos por data de pagamento.

## 31. Régua de cobrança (R24)

- **R24.1** **Etapas:** por marco em dias a partir do vencimento. Padrão: D-7, D-3, D0, D+3,
  D+5, D+7, D+15, D+30, D+45 e D+60, cada uma com canais (WhatsApp, e-mail, ligação), textos
  e roteiro de ligação **editáveis**. Variáveis do título aceitas: `titulo.numero`, `.valor`,
  `.vencimento`, `.dias_atraso`, `.descricao`, `.link_boleto`, `.link_pagamento`, `.pix`,
  `.promessa` e `contrato.produto`, além das do contato (R17). Marco repetido, variável
  inválida e membro de CS (que só vê) são recusados.
- **R24.2** **Execução:** diária, depois do horário configurado (padrão 09:00,
  America/Sao_Paulo; um cron confere a cada 15 minutos e roda uma vez por dia, respeitando
  "ativa") e sob demanda por **"Executar agora"** (só a gestão). Cada título recebe a etapa do
  dia no máximo uma vez. As ações usam o ator `AUTOMACAO` com descrição "Régua de cobrança".
- **R24.3** **Entrada atrasada e reinício:** quem entra na régua depois do marco recebe **só a
  etapa mais recente**; etapas além da **tolerância** (padrão 3 dias) são puladas
  (`regua.etapa_pulada`). Alterar o vencimento (manual ou por importação) reinicia a régua do
  título.
- **R24.4** **Envio:** WhatsApp pelo gateway (R13), com **fila própria** em paralelo às
  campanhas, número do financeiro opcional e intervalo entre mensagens configurável (padrão 20
  s); e-mail pelo SMTP (sem SMTP o envio falha e "Reenviar falhas" tenta de novo). A mensagem
  é registrada na conversa do contato. Pausar a régua segura os envios.
- **R24.5** **Ligação:** a etapa com ligação vira uma **atividade** (tipo ligação) para o
  responsável de CS e **segura as mensagens** da etapa até o resultado: *promessa de
  pagamento* com data (suspende a régua do título e envia a confirmação; se a data vence sem
  pagamento, avisa o responsável e a régua continua), *sem acordo* ou *não atendeu* (liberam a
  mensagem e o e-mail da etapa) e *já pagou* (dá baixa e encerra a régua). Ligação sem
  registro até o horário limite libera a mensagem (`regua.ligacao_expirada`).
- **R24.6** **Pagamento encerra a régua:** a baixa (manual, por importação ou "já pagou")
  cancela as mensagens, e-mails e ligações que ainda não saíram. Quando há algo a cancelar, a
  linha do tempo do título ganha uma entrada própria (`parcela.regua_encerrada`) além da baixa.
- **R24.7** **Opt-out e "não contatar":** o opt-out de marketing (R4.6) **não** bloqueia a
  cobrança, que é uma relação contratual; a marca **"não contatar por WhatsApp"** do contato
  (etiqueta `nao-contatar-whatsapp` ou campo personalizado `nao_contatar_whatsapp`) **é
  respeitada**: a régua não envia WhatsApp e segue por e-mail e ligação. No detalhe do contato,
  o bloco de privacidade tem o controle "Não contatar por WhatsApp", que liga e desliga a
  marca (desligar remove a etiqueta e o campo).
- **R24.8** **Respostas** do cliente caem no Atendimento, na mesma conversa.
- **R24.9** **Histórico e exportação:** linha do tempo por título (etapas, envios, ligações e
  alterações), envios do dia, execuções e exportação; cada etapa executada, pulada, reenviada,
  ligação registrada e promessa é auditada (`regua.*`).

## 32. Matriz de acesso (Fase 3 e 4 — Onda C)

| Recurso | Admin | C-level | Líder | Membro |
| --- | --- | --- | --- | --- |
| Painéis do BI (R20) | todos | todos | o da área e o Atendimento (Marketing: não) | o da área e o Atendimento (Marketing: não), só o que é dele |
| Painel Financeiro do BI | ✓ | ✓ | só CS | só CS, a própria carteira |
| Exportar painel do BI | ✓ | ✓ | do que vê | do que vê |
| Análise por IA (R21) e histórico | ✓ | — | — | — |
| Contratos e parcelas (R22) | todos | todos | CS: todos; Comercial: só leitura dos que ganhou | CS: a própria carteira; Comercial: só leitura dos que ganhou |
| Importar parcelas | ✓ | ✓ | CS | — |
| Indicadores MRR e inadimplência (R23) | ✓ | ✓ | CS | CS (a própria carteira) |
| Régua de cobrança: configurar e "Executar agora" (R24) | ✓ | ✓ | CS | — (vê) |
| Registrar resultado de ligação | ✓ | ✓ | CS | CS (os próprios clientes) |

Marketing não acessa o Financeiro, mas usa o BI do próprio painel.

## 33. Cenários de aceitação (Fase 3 e 4 — Onda C)

Continuam a numeração da seção 26; cada um tem teste automatizado ("cenário N" no nome do
teste) contra um Postgres real, e os de tela têm spec no front.

71. Cada papel vê só os painéis da sua área; os outros são 403 (R20.1).
72. O membro vê no BI só os números dos negócios e atividades dele, como na lista (R20.2).
73. Filtro de área, equipe ou pessoa fora do alcance é recusado (R20.3).
74. Painel desconhecido, datas inválidas e período grande demais são recusados (R20.3).
75. Ganhos, perdidos, taxa de ganho e ciclo médio trazem a comparação com o período anterior
    (R20.4).
76. O cache curto devolve a mesma resposta e `no-cache` recalcula (R20.6).
77. Exportação CSV e XLSX com os mesmos números do painel, auditada e respeitando a
    visibilidade (R20.7).
78. O clique no gráfico do BI leva à lista filtrada (R20.8).
79. A caixa de entrada do Atendimento aplica `?canalId` e `?filaId` e o quadro de funis
    aplica `?etapaId` (R20.8).
80. Só o Admin usa a análise por IA; os demais recebem 403 (R21.1).
81. A análise chega em streaming, só com números agregados, e grava histórico e auditoria
    (R21.2, R21.3, R21.8).
82. Link inventado pelo modelo vira o painel; filtro inválido é 400 antes do streaming
    (R21.3).
83. Pergunta de acompanhamento continua a conversa e soma os tokens, até o limite de 5 (R21.5).
84. Erro da Anthropic ou tempo esgotado: erro, análise `FALHOU`, auditada, sem contar no
    limite (R21.4).
85. O limite diário é configurável (auditado), dá 429 com `Retry-After` e zero desliga
    (R21.6).
86. Sem chave, o estado explica como configurar e a análise é 503, sem chamar a Anthropic
    (R21.7).
87. Marketing não acessa o Financeiro; CS vê só a carteira, Comercial só lê, líder de CS vê
    tudo (R22.1).
88. Contrato de negócio ganho gera parcelas e o MRR "novo"; negócio aberto é recusado
    (R22.2).
89. Contrato anual rende 1/12 ao mês; cobrança única não entra no MRR (R22.2).
90. Contrato vencido é encerrado ou, com renovação automática, estendido (R22.2).
91. Ao ganhar um negócio, o CRM sugere o contrato com os dados pré-preenchidos (R22.6).
92. A baixa manual marca como pago, audita e publica `parcela.paga`; a segunda é recusada
    (R22.4).
93. Parcela manual tem número único; paga não se edita; renegociar cria outra (R22.3).
94. A parcela vencida aparece como atrasada e o job grava o status e publica o evento
    (R22.7).
95. Importar títulos cria clientes, dá baixa nos pagos e relata erros; só a gestão importa
    (R22.5).
96. Reimportar atualiza pelo número, dá baixa, reinicia a régua de quem mudou o vencimento e
    não apaga colunas ausentes (R22.5).
97. O MRR por mês traz novo, expansão, contração e churn; cancelar cancela as parcelas a
    vencer (R23.1).
98. A inadimplência é separada nas faixas 0–30, 31–60, 61–90 e 90+, só do que o usuário vê
    (R23.2).
99. A receita prevista × realizada sai por mês (R23.3).
100. O risco de churn soma atraso, satisfação baixa e silêncio e aparece no painel de CS
     (R23.4).
101. As etapas padrão vêm editáveis; marco repetido, variável inválida e membro de CS são
     recusados (R24.1).
102. "Executar agora" envia a etapa do dia por WhatsApp com as variáveis do título, como
     automação, sem repetir (R24.2).
103. O cron executa só depois do horário configurado, uma vez por dia, e respeita "ativa"
     (R24.2).
104. Quem entra atrasado recebe só a etapa mais recente; além da tolerância a etapa é pulada
     (R24.3).
105. Alterar o vencimento reinicia a régua do título (R24.3).
106. O e-mail sai pelo SMTP; sem SMTP falha e "Reenviar falhas" tenta de novo (R24.4).
107. O número do financeiro tem fila própria, o intervalo é configurável e pausar segura os
     envios (R24.4).
108. A etapa com ligação vira atividade e segura as mensagens até o resultado (R24.5).
109. "Não atendeu" e "sem acordo" liberam a mensagem e o e-mail da etapa (R24.5).
110. Promessa com data suspende a régua e confirma; vencida sem pagamento, avisa e a régua
     continua (R24.5).
111. "Já pagou" dá baixa e encerra a régua; ligação sem registro libera a mensagem (R24.5).
112. O pagamento encerra a régua e cancela o que não saiu (R24.6).
113. O opt-out de marketing não bloqueia a cobrança, mas "não contatar por WhatsApp" é
     respeitado (R24.7).
114. No detalhe do contato, o controle "Não contatar por WhatsApp" liga e desliga a marca
     (R24.7).
115. Linha do tempo por título, envios do dia e exportação (R24.9).
116. Baixa e "Executar agora" em paralelo não deixam pendência de régua num título pago
     (R24.6).
117. Baixa manual e "já pagou" da ligação ao mesmo tempo dão uma só baixa (R24.3).
118. O envio de um ciclo anterior (vencimento alterado) é cancelado e não sai (R24.3).
119. Os indicadores do Financeiro e o risco de churn, agregados no banco, enxergam os mesmos
     contratos e títulos que as listas, papel a papel (R22.1, R23).

## 34. Assistente de IA e chamados (R25)

- **R25.1** **Quem usa:** todos os papéis, por um botão **Ajuda** na barra superior de qualquer
  tela, que abre um painel de conversa. O painel avisa que as perguntas e as respostas ficam
  registradas e podem ser lidas pelo Admin, e pede para não escrever dados de clientes.
  Só o Admin vê o histórico (R25.7) e configura (R25.4, R25.5). O assistente fica desligado
  enquanto não houver chave da Anthropic (`ANTHROPIC_API_KEY`) ou o limite diário for zero; o
  estado do painel explica o motivo.
- **R25.2** **Pergunta e resposta:** a base de conhecimento são os artigos curtos de
  `docs/ajuda/*.md` (um por área e tarefa), lidos ao iniciar e entregues ao modelo
  `claude-opus-5-5` com *prompt caching*. A API manda também o papel da pessoa e a tela de
  onde ela perguntou; o assistente **não ensina o que o papel não pode fazer**, diz quem pode.
  A resposta chega em streaming (SSE: `inicio`, `fase`, `parcial`, `concluido`, `erro`) e é
  uma saída estruturada `{resposta, resolvido, categoria, resumoDoPedido}`, com `categoria` em
  `duvida_de_uso`, `funcionalidade_inexistente_no_escopo`, `fora_do_escopo` ou
  `erro_do_sistema`. Nenhum dado de cliente vai para a IA além do que a pessoa escreveu. As
  perguntas têm de 2 a 2.000 caracteres; uma conversa guarda até 30 perguntas e reenvia as 10
  últimas ao modelo; conversa de outra pessoa é 404. Se a IA falha, há uma nova tentativa;
  falhando de novo, a pergunta fica `FALHOU` e não conta no limite — **a não ser que já tenha gastado tokens** (entrada, cache ou saída): a falha com gasto e a pergunta **cancelada** depois do início da resposta contam no limite diário. No cancelamento o uso final não chega, então a saída é estimada pelo texto recebido.
- **R25.3** **Chamado:** quando a categoria é `funcionalidade_inexistente_no_escopo` ou
  `erro_do_sistema`, o painel oferece **Abrir chamado**. **Só com a confirmação da pessoa**, e
  uma vez por resposta, o CRM envia título, descrição, usuário, tela e a conversa ao destino
  configurado pelo Admin: o conector **TicketHub** (conta de serviço: login + `POST
  /api/chamados`; credenciais em `TICKETHUB_*` ou na configuração, cifradas e nunca devolvidas)
  ou um **webhook** (R25.4). O envio é feito pela fila `assistente.enviar-chamado`, com até 6
  tentativas (1 min, 5 min, 15 min, 1 h e 3 h); esgotadas, o chamado fica `FALHOU`, o Admin é
  avisado e pode reenviar. A pessoa vê o número do chamado e o link (o identificador do
  TicketHub, um UUID, aparece abreviado, com o completo no título e na cópia) e recebe uma
  notificação quando ele é aberto.
- **R25.4** **Destino configurável (Admin):** TicketHub (URL, e-mail e senha da conta de
  serviço, URL pública para o link) ou webhook genérico (URL, cabeçalhos, assinatura HMAC
  `X-CRM-Assinatura: sha256=…` sobre `timestamp.corpo`, modelo do corpo com variáveis). Segredos
  cifrados e mascarados; as credenciais `TICKETHUB_*` do servidor só valem para a URL do servidor (com outra URL, o Admin informa e-mail e senha gravados, senão o destino fica não configurado); há "Testar conexão" e a opção de nenhum destino (desliga o chamado).
  Tudo auditado.
- **R25.5** **Limites:** perguntas por pessoa por dia (padrão 30, máximo 1.000, fuso de São
  Paulo; **0 desliga**) e orçamento mensal de tokens (padrão 20 milhões, somando entrada,
  saída e cache de todos, mais uma reserva — base de conhecimento e saída máxima — para cada pergunta em andamento, de modo que perguntas simultâneas não passem do teto). Passado o limite a API responde 429 com o motivo
  (`limite_diario` ou `orcamento_mensal`) e o painel explica. Mudar os limites é do Admin e é
  auditado.
- **R25.6** **Segurança contra injeção:** a pergunta e os artigos vão delimitados e tratados
  como dados (os marcadores que fechariam um delimitador são removidos); o prompt de sistema
  não é revelado; a base nunca muda as instruções; o modelo **não abre chamado sozinho**
  (`podeAbrirChamado` vem da API, não do texto). A tela da resposta é sanitizada (markdown
  simples, links seguros).
- **R25.7** **Avaliação e histórico do Admin:** cada resposta pode ser marcada *útil* ou *não
  útil*. O histórico (só Admin) lista todas as conversas com filtros por categoria, área,
  pessoa e período, os **temas mais pedidos sem resposta**, os chamados abertos e a
  exportação (CSV/XLSX, auditada).
- **R25.8** **Auditoria:** `assistente.configurado`, `assistente.resposta_avaliada`,
  `assistente.chamado_solicitado`, `assistente.chamado_enviado`, `assistente.chamado_falhou`,
  `assistente.chamado_reenviado` e `assistente.historico_exportado`. Nunca registram o texto
  das perguntas, só ids, categoria e contagens.

## 35. PWA e notificações push (R26)

- **R26.1** **Aparelhos inscritos:** com a chave pública VAPID (`GET /push/chave-publica`,
  exige sessão) o front inscreve o aparelho (`POST /push/inscricoes`, idempotente por
  *endpoint*; o mesmo aparelho passa para quem entrou por último). Cada pessoa guarda no
  máximo **20** aparelhos (o mais antigo sai), lista e remove só os seus (404 para os de
  outras pessoas). As chaves da inscrição ficam **cifradas**; endereços inválidos ou de rede
  interna são recusados. Sem `VAPID_*` no ambiente, chave pública e inscrição dão 503
  (`nao_configurado`) e a tela explica. **Saída dos aparelhos:** sair do CRM remove a inscrição
  **deste aparelho** (o front pede `DELETE /push/inscricoes/:id` antes de encerrar a sessão; os
  outros aparelhos da pessoa ficam) e **desligar o usuário (R7) remove todos os aparelhos dele**
  na mesma transação, com `push.inscricao_removida` (motivo `desligamento`) por aparelho. Trocar
  ou redefinir a senha encerra as sessões (R2.4), mas não mexe nos aparelhos: eles são da pessoa.
- **R26.2** **Preferências por tipo:** conversa atribuída, menção, atividade vencendo, SLA
  estourado, negócio atribuído e parcela atrasada da carteira. Tudo ligado por padrão;
  `PUT /push/preferencias` altera só os tipos enviados; tipo desconhecido, valor que não é
  booleano e corpo vazio são recusados.
- **R26.3** **Envio:** sai das **notificações internas** que já existem (cada tipo mapeado
  vira push; os demais não) e só depois que a transação da regra de negócio confirma (o job
  entra na fila `push.enviar` na mesma transação). Um job por aparelho; a carga leva título,
  corpo, `url` do front, `tag` e `notificacaoId` (sem link, abre a lista de notificações);
  vai a todos os aparelhos da pessoa e a ninguém mais; desligar o tipo antes do envio vale.
- **R26.4** **Falhas:** 404 e 410 do serviço de push removem a inscrição (auditado, tipo
  expirado); falha passageira (5xx, rede) é tentada de novo pela fila e a inscrição guarda o
  erro; recusa definitiva (401/403) não é repetida e não remove a inscrição.
- **R26.5** **Teste:** `POST /push/teste` envia um push aos meus aparelhos e conta o resultado.
- **R26.6** **Auditoria:** `push.inscricao_criada`, `push.inscricao_removida`,
  `push.inscricao_expirada`, `push.preferencias_alteradas` (só quando algo muda) e
  `push.teste_enviado`, sem endereço nem chaves.
- **R26.7** **App instalável:** manifesto (nome BRL CRM, ícones do símbolo, cores do tema) e
  `@angular/service-worker` com o *app shell* em cache. **Os dados da API nunca ficam em cache**
  (`/api/**` fora do service worker). Sem conexão aparece uma faixa "sem conexão" e as
  ações que dependem da rede avisam; quando uma versão nova está pronta, a faixa oferece
  **Atualizar** (recarrega no momento que a pessoa escolhe). Há uma dica de instalação para
  Android (pedido de instalação do navegador) e iOS (Compartilhar → Adicionar à Tela de
  Início). Em desenvolvimento (sem service worker) nada disso liga.
- **R26.8** **Uso em campo:** em telas pequenas, navegação inferior (Início, Atendimento,
  Atividades, Funis, Notificações), ações rápidas (responder, registrar atividade, mover
  negócio) e alvos de toque grandes. O clique na notificação abre a tela certa.
- **R26.9** **Preferências de push no Meu perfil:** ativar neste aparelho (pede a permissão do
  navegador), desativar, ver a permissão bloqueada e ligar/desligar cada tipo.

## 36. Operação: backups, monitoramento e produção (R27)

- **R27.1** **Filas:** a tela mostra, por fila do pg-boss, pendentes, ativas e falhas
  recentes. Uma fila está **travada** quando o job pronto mais antigo espera há mais de 10
  minutos ou um job está ativo há mais de 1 hora.
- **R27.2** **Gateway e números:** estado do gateway de WhatsApp e de cada número. Um número
  que cai tem 2 minutos de carência para a reconexão automática; passado isso vira alerta
  **crítico** (com o caminho para reconectar).
- **R27.3** **Backups:** o serviço `backup` do compose (`postgres:17-alpine`) faz `pg_dump` diário
  (`BACKUP_HORARIO`, `BACKUP_FUSO`), valida o arquivo, aplica a retenção (`BACKUP_RETENCAO_DIAS`)
  e grava `ultimo.json` no volume de backups, que a API lê (somente leitura, `BACKUP_DIR`). A
  tela mostra o último backup. **Sem `ultimo.json`: aviso "nenhum backup registrado"; com
  `ok=false`: crítico; sem backup concluído há mais de 36 horas: atrasado.** A restauração
  tem script e passo a passo testados em `docs/DEPLOY.md`.
- **R27.4** **Banco e disco:** tamanho do banco e espaço livre; abaixo de 15% livre é aviso e
  de 5% é crítico.
- **R27.5** **Canais e erros:** canais com erro recente e os últimos erros técnicos.
- **R27.6** **Revisão de produção:** cabeçalhos de segurança em toda resposta
  (`X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`, sem
  `X-Powered-By`; `Strict-Transport-Security` só em produção), limites de requisição nas
  rotas públicas de senha (R2.8: pedido de link 3 por e-mail e consulta de token 30 por IP
  em 15 minutos, resposta 429 com `Retry-After`), variáveis obrigatórias em produção
  (a API não sobe sem elas) e HTTPS pelo Caddy (`docker-compose.producao.yml`). O passo a
  passo está em `docs/DEPLOY.md`.
- **R27.7** **Alertas por e-mail:** a cada 5 minutos o job `saude.monitorar` avalia os fatos e
  avisa **todos os Admins ativos** por e-mail quando um número desconecta, uma fila trava ou
  o backup falha, agrupando num só e-mail. **Cada ocorrência avisa uma vez**; se persistir,
  um lembrete só depois de 6 horas; resolvida e voltando a ocorrer, avisa de novo. Sem SMTP
  nada é enviado nem registrado (volta a tentar depois) e a tela avisa que os alertas ficam
  só na tela. Alertas de tela (aviso de disco, por exemplo) não geram e-mail.
- **R27.8** **Acesso:** a tela **Saúde do sistema** (`GET /administracao/saude-do-sistema`) é
  **só do Admin** (401 sem sessão, 403 aos demais) e se atualiza sozinha.

## 37. Matriz de acesso (Fase 5 e 6 e produção — Onda D)

| Recurso | Admin | C-level | Líder | Membro |
| --- | --- | --- | --- | --- |
| Perguntar ao assistente de ajuda (R25.1) | ✓ | ✓ | ✓ | ✓ |
| Abrir chamado a partir da resposta (R25.3) | ✓ | ✓ | ✓ | ✓ (com confirmação) |
| Histórico de dúvidas, temas e chamados (R25.7) | ✓ | — | — | — |
| Configurar assistente, limites e destino do chamado (R25.4, R25.5) | ✓ | — | — | — |
| Reenviar chamado que falhou | ✓ | — | — | — |
| Inscrever aparelhos e escolher tipos de push (R26) | ✓ | ✓ | ✓ | ✓ (os próprios) |
| Saúde do sistema e alertas por e-mail (R27) | ✓ | — | — | — |
| Guia do usuário e ajuda das telas | ✓ | ✓ | ✓ | ✓ |

## 38. Cenários de aceitação (Fase 5 e 6 e produção — Onda D)

Continuam a numeração da seção 33; cada um tem teste automatizado ("cenário N" no nome do
teste) contra um Postgres real, e os de tela têm spec no front.

120. Todos os papéis usam o assistente; só o Admin vê o histórico (os demais 403); o aviso de
     registro aparece (R25.1).
121. A pergunta chega em streaming, com modelo, saída estruturada, base em cache, papel e
     tela, e sem dados de cliente (R25.2).
122. Continuar a conversa reenvia o histórico; conversa de outra pessoa é 404 (R25.2).
123. O limite de perguntas por pessoa por dia e o orçamento mensal de tokens valem e são
     configurados pelo Admin, com auditoria (R25.5).
124. A pergunta não fecha o delimitador, o prompt não vaza e o modelo não abre chamado
     (R25.6).
125. O chamado no TicketHub só sai com confirmação, mostra número e link, notifica e acontece
     uma vez por resposta (R25.3).
126. Falhas do destino: novas tentativas pela fila; a falha final avisa e o Admin reenvia
     (R25.3).
127. Webhook genérico: cabeçalhos, HMAC e modelo do corpo; segredos cifrados e mascarados
     (R25.4).
128. TicketHub configurado pelo Admin: senha cifrada e nunca devolvida; teste de login;
     "nenhum" desliga (R25.3, R25.4).
129. Avaliação e histórico do Admin: filtros, temas sem resposta, chamados e exportação
     (R25.7).
130. Falha da IA: nova tentativa, evento de erro e pergunta `FALHOU` que não conta no
     limite (R25.2).
131. A chave pública VAPID exige sessão e, sem VAPID, dá 503 `nao_configurado` (R26.1).
132. A inscrição é idempotente por *endpoint*, lista só os meus aparelhos, passa para quem
     entrou por último, guarda no máximo 20 e remove só o meu (R26.1).
133. As chaves ficam cifradas; dados inválidos e endereços de rede interna são recusados
     (R26.1).
134. As preferências vêm todas ligadas, mudam só os tipos enviados, recusam o inválido e são
     auditadas só quando algo muda (R26.2, R26.6).
135. Cada tipo mapeado vira push com a `url` certa, só para os aparelhos da pessoa e
     respeitando as preferências, inclusive as desligadas antes do envio (R26.3).
136. O job de push só existe se a transação da regra de negócio confirma; o fluxo real
     (lembrete de atividade) dispara o push (R26.3).
137. 404/410 removem a inscrição; falha passageira é tentada de novo; recusa definitiva não
     é repetida e não remove (R26.4).
138. O push de teste conta o resultado e a auditoria não guarda endereço nem chaves (R26.5,
     R26.6).
139. O app instalável mostra a faixa sem conexão e o aviso de versão nova, pede a instalação
     só quando a pessoa pede e liga o push nas preferências (R26.7, R26.9; specs do front).
140. Só o Admin vê a Saúde do sistema: 401 sem sessão e 403 aos demais (R27.8).
141. Sistema saudável: situação ok, gateway no ar, banco e disco medidos (R27.4).
142. Sem `ultimo.json` o aviso é "nenhum backup registrado"; com `ok=false` é crítico (R27.3).
143. Um número desconectado vira alerta crítico e aparece na lista (R27.2).
144. Um job pronto parado há mais de 10 minutos trava a fila (R27.1).
145. Canal com erro recente e erros técnicos aparecem no painel (R27.5).
146. O backup que falhou avisa todos os Admins por e-mail uma só vez; resolvido e de novo com
     problema, avisa outra vez; o lembrete só vem depois de 6 horas; número e fila saem
     juntos num e-mail; sem SMTP nada é enviado; alertas só de tela não geram e-mail
     (R27.2, R27.7).
147. O pedido de link e a consulta de token de senha têm limite (429 com `Retry-After`) e toda
     resposta leva os cabeçalhos de segurança (R27.6).
148. Inadimplência por faixa, previsto × realizado, MRR e recebimentos, agregados no banco,
     respeitam a carteira de cada pessoa (R23.1–R23.3, R22.1).
149. O risco de churn, agregado no banco, pontua atraso e silêncio e respeita a carteira
     (R23.4).
150. O índice parcial das parcelas pagas por data de pagamento existe (R23.3).
151. A baixa que encerra a régua e cancela envios pendentes tem uma entrada própria na
     linha do tempo do título (R24.6, R24.9).
152. Desligar o usuário remove todos os aparelhos de push dele, auditando
     `push.inscricao_removida` (motivo `desligamento`) sem endereço nem chaves, e não toca nos de
     outras pessoas (R26.1, R7).
153. Sair remove a inscrição deste aparelho e mantém os outros da mesma pessoa (R26.1).

## 39. Canal WhatsApp oficial (R28)

Onda E (fatia E1). O WhatsApp pela **Cloud API da Meta** é um canal novo (`WHATSAPP_OFICIAL`), ao
lado do WhatsApp pelo Baileys (R13), que segue igual. Os disparos (R17) continuam só pelo
Baileys. Nada aqui chama a Meta real nos testes nem no ambiente dos agentes: usa-se uma Graph
falsa (`META_GRAPH_URL`). Formatos conferidos na referência `whatsapp-cloud-chamadas.md` (§6);
o que ela marca como não confirmado fica isolado em `canais/whatsapp-oficial/formato-meta.ts`
e `eventos-oficial.ts`, com comentário.

- **R28.1** **Configuração (só o Admin, como os outros canais):** `phoneNumberId` (vira o
  `idExterno` do canal: o mesmo número não tem dois canais, 409), id da conta (WABA), número
  exibido, token de usuário do sistema e app secret. **Token, app secret e verify token ficam
  cifrados** (R10.3) e nunca saem inteiros (a tela vê `••••••••abcd`); o verify token é gerado
  pelo CRM, e a tela mostra a **URL do webhook** (a mesma do Instagram e do Messenger) e os
  campos a assinar para o Admin copiar. "Testar conexão" lê o número na Graph
  (`display_phone_number`, `verified_name`, `quality_rating`): sucesso mostra o estado
  *conectado* e guarda o que a Meta informou; falha mostra o motivo em português e grava o erro
  do canal (estado *erro*, que também vem de falha de envio ou de sincronização). Criar, alterar
  e excluir são auditados (`canal.*`) sem os segredos.
- **R28.2** **Webhook:** `GET` e `POST /publico/meta/webhook`. A verificação aceita o verify token
  de qualquer canal da Meta ou do WhatsApp oficial. No `POST`, `object: whatsapp_business_account`
  vai para o canal oficial, achado por `entry[].changes[].value.metadata.phone_number_id`; a
  assinatura `X-Hub-Signature-256` é conferida com o app secret **do canal** (401 se faltar ou
  não conferir). O roteamento é **por campo** (`changes[].field`): `messages` é tratado aqui; o
  campo `calls` é tratado pelas ligações (R29, tratador registrado); campo
  desconhecido é ignorado com log em nível debug. Número sem canal (ou desligado) é ignorado
  com 200. O processamento é por fila (`whatsapp-oficial.webhook`), fora da requisição.
- **R28.3** **Mesmas regras dos outros canais:** a mensagem recebida entra pelo Atendimento
  (R12): contato pelo telefone em **E.164 só com dígitos** (o mesmo identificador `WHATSAPP` do
  Baileys, então a mesma pessoa fala pelos dois canais e cai no mesmo contato), fila padrão do
  canal, distribuição, SLA, horário de atendimento, resposta fora do horário, chatbot (R18),
  gatilhos de automação de mensagem recebida (R19) e notificações. **Idempotência pelo id da
  mensagem na Meta** (`wamid`): a reentrega do webhook (até 7 dias) não duplica.
- **R28.4** **Envio e janela de 24 h:** a mensagem do contato abre a janela por 24 horas
  (`conversa.janelaAte`). **Dentro dela** valem texto, mídia, mensagem de voz e citação; **fora
  dela só templates aprovados**: texto livre é recusado com 422 (`regra: R28`,
  `apenasTemplate: true`, motivo em português) e a conversa traz `podeResponder.apenasTemplate`
  e `acoes.enviarTemplate`. Se a janela fecha entre o envio e o job, a mensagem falha com o
  mesmo motivo, sem chamar a Meta. O envio é síncrono pela fila de envio do Atendimento: o
  `wamid` devolvido vira o `idExterno` (gravado já, para o status que chegar cedo achar a
  mensagem) e a mensagem fica `ENVIADA`. Falha passageira da Meta (500, limite de velocidade) é
  tentada de novo; falha definitiva vira `FALHOU` com o motivo em português e "tentar de novo".
  Começar conversa pela equipe num contato sem janela exige template. O destino é o telefone do
  contato; sem telefone, o BSUID (campo `recipient`).
- **R28.5** **Recebimento por tipo:** texto; mídia (imagem, áudio, vídeo, documento, figurinha),
  baixada em dois passos (`GET /{media_id}` e `GET url` com o token) e guardada no MinIO como nos
  outros canais (mídia expirada ou recusada vira "[Mídia não disponível]"; falha passageira da
  Meta repete o job); localização (`latitude`, `longitude`, nome, endereço); contatos
  compartilhados (nome, telefones e vCard); respostas de **botão e de lista** (texto = título, com
  `metadados.interativo`); **reações** (`REACAO`, emoji vazio = reação removida); tipos que o CRM
  não conhece viram "(mensagem não suportada pelo CRM)". Resposta/citação (`context.id`) liga à
  mensagem citada.
- **R28.6** **BSUID:** quando a Meta omite o telefone (usuário com nome de usuário), o contato é
  identificado pelo BSUID (`from_user_id` / `contacts[].user_id`), num identificador
  `WHATSAPP_BSUID`. Se o telefone aparecer depois (ou já vier junto), os dois identificadores
  ficam **no mesmo contato**, que ganha o telefone; se telefone e BSUID já pertencem a contatos
  diferentes, nada é fundido sozinho (log de aviso; a deduplicação de contatos resolve).
- **R28.7** **Status de cada mensagem:** `sent` → `ENVIADA`, `delivered` → `ENTREGUE`, `read` →
  `LIDA`, `failed` → `FALHOU` com o **motivo em português** (tabela de códigos de erro da Cloud
  API; o que não está na tabela mostra o título da Meta). O status só avança (um "entregue"
  atrasado não desfaz o "lida"). Status de mensagem ainda não gravada, recém-chegado, é tentado de
  novo (o envio pode estar gravando o id); o antigo e desconhecido é ignorado.
- **R28.8** **Templates:** a lista vem de `GET /{waba_id}/message_templates` (com paginação) e é
  guardada por canal (nome, idioma, categoria, situação, componentes e quando foi sincronizada).
  A sincronização é **manual** (botão) e **diária** (03:00, pela fila `whatsapp-oficial.templates`;
  o erro de um canal não para os outros); o que sumiu da Meta sai do cache; cada sincronização é
  auditada (`canal.templates_sincronizados`). Falha da Meta na sincronização manual é 503 com o
  motivo, o cache fica como estava e o canal registra o erro. Só os **aprovados** enviam; o
  compositor lista os da conversa com cabeçalho, corpo, rodapé, botões e as **variáveis** de cada
  um (`{{1}}`, `{{2}}`…). Enviar template confere: aprovado, **todas as variáveis preenchidas**
  (400 se faltar), e **arquivo no cabeçalho** quando ele pede imagem, vídeo ou documento. A
  mensagem grava o texto como o contato o vê (`texto`) e o template usado e as variáveis em
  `metadados.template`. Template vale dentro e fora da janela e na "tentativa de novo".
  Templates com localização no cabeçalho não são suportados.
- **R28.9** **Não contatar e opt-out (R4.6, R24.7):** a marca **"não contatar por WhatsApp"** do
  contato (etiqueta `nao-contatar-whatsapp` ou campo `nao_contatar_whatsapp`) vale para os **dois**
  canais de WhatsApp: bloqueia a mensagem **ativa** (fora da janela de 24 h, ou seja, template para
  quem não escreveu há menos de um dia), mas não a resposta a quem acabou de escrever. Template de
  categoria **marketing** também respeita o opt-out de marketing do contato. A mensagem bloqueada
  fica `FALHOU` com o motivo.
- **Endpoints (Admin):** `GET|POST /whatsapp-oficial/canais`, `GET|PATCH|DELETE
  /whatsapp-oficial/canais/:id`, `POST …/:id/testar`, `POST …/:id/token-verificacao`,
  `GET …/:id/templates`, `POST …/:id/templates/sincronizar`. **Atendimento (quem usa o
  Atendimento e vê a conversa):** `GET /atendimento/conversas/:id/templates`; o envio é
  `POST /atendimento/conversas/:id/mensagens` (e `POST /atendimento/conversas`) com `template`.

### Cenários de aceitação (Onda E, canal WhatsApp oficial)

Continuam a numeração da seção 38; cada um tem teste automatizado ("cenário N" no nome, em
`test/onda-e-whatsapp-oficial.e2e-spec.ts` e nos specs de `canais/whatsapp-oficial`) contra um
Postgres real e uma Graph falsa em processo.

154. Cria com segredos cifrados e mascarados, gera o verify token e mostra a URL do webhook
     (R28.1).
155. Só o Admin configura (403); o mesmo número em dois canais é 409; ids inválidos 400 (R28.1).
156. "Testar conexão": lê o número na Graph; token vencido vira estado ERRO com o motivo
     (R28.1).
157. Gera outro verify token (o antigo deixa de valer) e exclui o canal (R28.1).
158. A verificação GET aceita o verify token do canal oficial e recusa o errado (R28.2).
159. Exige a assinatura do app secret DO canal (401 sem ela ou com a de outro) (R28.2).
160. Número desconhecido e campos sem tratador (account_update) são ignorados com 200 (R28.2).
161. Cada número usa o seu app secret: uma mudança assinada com o segredo errado de outro canal
     não entra (R28.2).
162. Texto: contato pelo telefone (E.164), conversa na fila do canal, janela de 24 h e
     idempotência (R28.3).
163. Contato novo: nome do perfil, origem WhatsApp, telefone só com dígitos (R28.3).
164. Mídia: baixada com o token (2 passos) e guardada; mídia expirada vira aviso (R28.5).
165. Localização, contatos, resposta de botão e de lista e reação (R28.5).
166. Entra pelas mesmas regras: SLA da fila, notificação e evento de mensagem recebida (R28.3).
167. Sem telefone, o contato é identificado pelo BSUID; quando o telefone aparece, é o mesmo
     contato (R28.6).
168. Telefone e BSUID desde a primeira mensagem ficam no mesmo contato (R28.6).
169. Envia para o BSUID quando o contato não tem telefone (R28.6).
170. Enviada → entregue → lida pelos webhooks; um status atrasado não desfaz (R28.7).
171. Falhou: o motivo do erro em português vai para a mensagem (R28.7).
172. Status de mensagem ainda não gravada tenta de novo; o antigo é ignorado (R28.7).
173. Dentro da janela: texto pela Cloud API com o token, ENVIADA com o wamid (R28.4).
174. Resposta citada leva o wamid da mensagem citada (R28.4).
175. Fora da janela: texto livre é 422 com o motivo em português e a indicação de só template
     (R28.4).
176. A janela fecha entre o envio e o job: a mensagem falha com o motivo (sem chamar a Meta)
     (R28.4).
177. A Meta recusa por janela (131047): FALHOU com o motivo; token inválido: FALHOU e o canal
     fica com erro (R28.4).
178. Falha passageira da Meta (500) é tentada de novo sem duplicar (R28.4).
179. Mídia: upload em /media e envio por id, com a legenda; documento leva o nome (R28.4).
180. Áudio gravado no navegador (webm/opus) é convertido para ogg/opus e vai como áudio (R28.4).
181. Áudio que não dá para converter (sem ffmpeg e não é ogg) falha com motivo em português
     (R28.4).
182. Sincronização manual: troca o cache, segue a paginação e mostra o que não está aprovado
     (R28.8).
183. Falha da Meta na sincronização: 503 com o motivo, o cache fica e o canal registra o erro
     (R28.8).
184. Sincronização diária pela fila: todos os canais ativos, um erro não para os outros (R28.8).
185. O compositor lista os templates aprovados da conversa e o aviso da janela fechada (R28.4).
186. Template com variáveis fora da janela: grava o texto preenchido e envia os components
     (R28.4).
187. Variável faltando, template pendente, texto junto e canal sem templates são recusados
     (R28.4).
188. Template com mídia no cabeçalho exige o arquivo e o envia como cabeçalho (R28.4).
189. Começar a conversa pela equipe exige template (não há janela); com template envia (R28.4).
190. "tentar de novo" de um template funciona fora da janela (R28.4).
191. A marca bloqueia a mensagem ativa (template fora da janela), mas não a resposta dentro dela
     (R28.9).
192. Template de marketing respeita o opt-out de marketing do contato (R28.9).
193. A mesma pessoa pode falar pelos dois canais (identificador WHATSAPP compartilhado) (R28.9).
194. O `wa_id` sem o nono dígito casa com o contato cadastrado com ele (e vice-versa) (R28.3).

## 40. Ligações pelo WhatsApp (R29)

Onda E (fatia E2, API). O atendente atende e liga **pelo navegador**: o áudio vai direto entre o
navegador e a Meta (WebRTC nativo, sem TURN; STUN opcional em `LIGACOES_STUN_URLS`, vazio por
padrão) e a API **só sinaliza** (SDP, pela Calling API da Meta e pelo tempo real). Não há trickle
ICE pela Graph: o navegador espera o fim da coleta de candidatos (com tempo limite) antes de
mandar o SDP. Nada chama a Meta real nos testes nem no ambiente dos agentes (`META_GRAPH_URL`
aponta para uma Graph/Calling API falsa). O que a referência `whatsapp-cloud-chamadas.md` marca
como não confirmado (as "Lacunas") fica isolado em `ligacoes/formato-chamadas.ts` e
`ligacoes/graph-ligacoes.ts`, cada ponto com `LACUNA n` citando a referência: ajustar depois do
primeiro teste com a Meta real começa por esses dois arquivos.

- **R29.1** **Máquina de estados** (`ligacoes/maquina-de-estados.ts`, funções puras, testada):
  *recebida* `TOCANDO → EM_ANDAMENTO → ENCERRADA` ou `PERDIDA` (tempo de toque, cliente
  desligou, fora do horário, sem atendente, ligação atrasada) ou `FALHOU`; *feita*
  `CHAMANDO → TOCANDO → EM_ANDAMENTO → ENCERRADA` ou `RECUSADA`, `SEM_RESPOSTA` (o cliente não
  atendeu, ou o atendente cancelou) e `FALHOU`. Estado terminal **nunca muda**; os estados ativos
  só avançam; evento que não faz sentido para o estado (ou para a direção) é ignorado, nunca
  erro. Cada transição é serializada por ligação (trava consultiva) e o estado só muda se a
  máquina deixar: webhooks **repetidos, fora de ordem ou atrasados** não quebram nem regridem
  nada (um `terminate` atrasado só completa a duração).
- **R29.1a** **Corrida cancelar × atender (feita).** Um `terminate` com duração que chega depois de o CRM
  já ter fechado a ligação como `SEM_RESPOSTA`, `PERDIDA`, `RECUSADA` ou `FALHOU` (o atendente cancelou no
  instante em que o cliente atendeu) **não dá duração** a ela: só `ENCERRADA` completa a duração depois de
  fechada. Um desfecho "não atendida" nunca tem duração. O `RINGING` ou a resposta SDP que chegam antes de o
  `POST /ligacoes` gravar o id da Meta esperam 0,3, 0,7 e 1,5 s antes de voltar ao job.
- **R29.2** **Ligação recebida.** O webhook `calls` (`connect` com a oferta SDP) cria a ligação
  `TOCANDO` na transação do webhook, junto com a **chave de dedupe** (a Meta reentrega por até 7
  dias; a chave vale 7 dias e uma limpeza diária remove as vencidas; se o evento falhar, a chave
  volta junto e o job tenta de novo). O contato e a conversa em aberto do canal são os do
  Atendimento (R12; criados e distribuídos pela fila se for um contato novo) e **a ligação, atendida
  ou não, abre a janela de 24 h do canal (R28.4)**.
  - **Quem toca:** primeiro o responsável pela conversa ou pelo contato, se estiver **online e
    livre**; senão todos os atendentes online e livres da **fila de ligações** (a escolhida na
    configuração ou a fila padrão do canal). "Livre" = sem ligação em andamento (chamando, tocando
    ou em andamento). Cada um recebe `ligacao.tocando` (com a oferta SDP) no tempo real e uma
    notificação interna (`ligacao.tocando`) que também vira **push** com a ação "Abrir ligação"
    (preferência de push `ligacao_recebida`, R26).
  - **Quem atende:** o primeiro `POST /ligacoes/:id/atender` com a resposta SDP leva a ligação (a
    trava é a linha no banco); os outros recebem **409 `atendida_por_outro`** e o evento
    `ligacao.deixou_de_tocar`. A API manda `pre_accept` e `accept` com o **mesmo SDP** (com uma
    espera curta entre os dois, `LIGACOES_ESPERA_PRE_ACEITE_MS`) e só então a ligação entra em
    andamento. Se a Meta recusar, a ligação vira `FALHOU` e o atendente recebe o motivo (409
    `meta_recusou`). Só atende quem foi chamado (403 `nao_chamado`) e quem não está em outra ligação
    (409 `ja_em_ligacao`: **uma ligação por atendente**, garantida por índice único parcial).
  - **Perdida:** passado o **tempo de toque** (padrão 25 s, de 10 a 40 s: sempre abaixo do prazo
    de 30 a 60 s da Meta; job do pg-boss agendado na chegada), **fora do horário de ligações**,
    **sem ninguém disponível**, ligações desativadas no canal ou `connect` que chegou depois de a
    Meta desistir: a ligação vira `PERDIDA` e a API manda `reject` à Meta (menos no caso do
    `connect` atrasado). O CRM cria a atividade **"Retornar ligação"** (pendente, prioridade alta,
    prazo de 4 h) para o responsável da conversa ou do contato (senão o líder da área da fila,
    senão o Admin), **avisa por notificação** o responsável ou a fila e manda a **mensagem
    automática** do canal, se estiver ligada (a janela de 24 h acabou de abrir). A recebida que
    falha antes de atender (a Meta recusa o `accept`) também gera o retorno.
  - **Recusar:** `POST /ligacoes/:id/recusar` tira a ligação só de quem recusou
    (`ligacao.deixou_de_tocar` com `recusada_por_voce`; a coluna `recusada_por` guarda quem). Se **todos os
    chamados recusam**, a API rejeita na Meta **na hora** (sem esperar o tempo de toque) e a ligação vira
    `PERDIDA` com o motivo `recusada_pelos_atendentes` (retorno, aviso e mensagem automática como em toda
    perdida; os últimos a ouvir recebem `recusada_por_todos`). Repetir é inofensivo; quem não foi chamado
    recebe 403 e uma ligação já atendida ou terminada, 409.
  - O `terminate` que a Meta manda no fim fecha a ligação com a **duração e o motivo**; o
    atendente que encerra manda `terminate` à Meta **sempre** (afeta a cobrança) e o webhook fecha
    (um job fecha sozinho, com o que o CRM sabe, se o webhook não vier em 20 s).
  - **Navegador que cai** durante a ligação: tolerância de 15 s para o socket reconectar; passado
    esse prazo sem nenhum socket do atendente, a API manda `terminate` e encerra (`conexao_perdida`).
- **R29.3** **Ligação feita.** `POST /ligacoes` com a oferta SDP do navegador. A API confere, nesta
  ordem: ligações ativas e botão visível no canal (422), contato com telefone (ou BSUID), uma
  ligação por atendente e por cliente (409), e **a permissão e os limites na Meta**
  (`GET call_permissions`: a Meta não avisa quando a permissão expira, então confere antes de
  **cada** ligação; sem resposta da Meta, 503: não liga sem conferir). Sem permissão: 422
  `sem_permissao` com o que o front precisa para oferecer o pedido (`situacao`, `podePedir`,
  `liberaPedidoEm`, `janelaAberta`, `temTemplateDePermissao`). Limite diário de ligações feitas:
  lido da Meta (o valor documentado é contraditório, 100 ou 5) e tratado também pelo erro
  (`limite_diario`, com quando libera). Depois, `CHAMANDO` + `connect`; a **resposta SDP** chega
  pelo webhook e vai ao navegador por `ligacao.resposta_sdp`; os estados vêm dos webhooks de status
  (`RINGING` → `TOCANDO`, `ACCEPTED` → `EM_ANDAMENTO`, `REJECTED` → `RECUSADA`) e do `terminate`
  (sem atender: `SEM_RESPOSTA`). Cancelar enquanto chama manda `terminate` e fecha na hora. Uma
  vigia fecha a ligação presa em `CHAMANDO`/`TOCANDO` por 2 minutos. Se a ligação nasce de uma
  atividade de ligação (inclusive a etapa de ligação da régua), `atividadeId` a liga: a atividade
  é concluída quando o cliente atende. O cliente que atende uma ligação nossa **abre a janela de
  24 h**.
- **R29.4** **Permissão do cliente** (`permissoes_de_ligacao`, uma por canal e contato): situação
  `NENHUMA`, `PEDIDA`, `CONCEDIDA` (temporária, 7 dias, ou permanente), `NEGADA` ou `REVOGADA`
  (a temporária vencida aparece como `EXPIRADA`). **Pedido:** mensagem interativa
  `call_permission_request` dentro da janela de 24 h; fora dela, um **template aprovado com o
  componente de permissão** (sincronizado na E1; sem ele, 422 `sem_template_de_permissao`). Os
  limites da Meta valem **antes** de enviar: **1 pedido por 24 h e 2 por 7 dias por cliente**
  (422 `limite_de_pedidos` com `liberaEm`; a conferência na Meta também vale e traz `origem:
  meta`); permissão que já existe é 409 `permissao_ja_existe`. Qualquer ligação conectada com o
  cliente zera os pedidos. **A resposta do cliente** (campo `messages`, interativo
  `call_permission_reply`) atualiza o registro (aceitar: temporária até a data da Meta, ou
  permanente; recusar: `NEGADA`), vira aviso na conversa (não vira mensagem do cliente), abre a
  janela de 24 h e emite `ligacao.permissao`; repetida, não duplica. **4 ligações feitas seguidas
  sem resposta** (recusadas ou não atendidas; o cancelamento do atendente não conta) **revogam**
  a permissão: o registro passa a `REVOGADA` (a Meta faz o mesmo); atender zera a contagem.
- **R29.5** **Erros da Calling API em português** (tabela de códigos da referência §5.1:
  `138006` sem permissão, `138012`/`138005` limites, `138001` cliente sem WhatsApp, `138003`
  duplicada, `138009` pedidos, `138015` limite de mensagens baixo…): viram 422 com
  `detalhes.motivo` estável e `detalhes.codigoDaMeta`; falha passageira da Meta (rede, 5xx) é 503.
  Erros `138019` a `138023` do `terminate` (mídia) viram o motivo `falha_de_midia`.
- **R29.6** **Configuração (aba "Ligações" do canal, só o Admin):** ativa (liga e desliga as
  chamadas no número por `POST /{phone_number_id}/settings`; **se a Meta recusar, nada é gravado**
  e o motivo vem em português), botão "Ligar" visível, horário (formato do horário de
  atendimento; padrão: o do canal; as ligações fora dele não chegam ao CRM como "fora do horário"
  porque o CRM **não** manda `call_hours` à Meta: a perdida precisa chegar para gerar o retorno),
  fila que atende, gravar (padrão sim; usado pela E3), tempo de toque (padrão 25 s) e mensagem
  automática de perdida (desligada por padrão). O Admin assina o campo `calls` no app da Meta
  (vem em `webhook.campos` do canal). Tudo é auditado (`canal.ligacoes_ativadas`,
  `canal.ligacoes_desativadas`, `canal.ligacoes_configuradas`).
- **R29.7** **Ao encerrar:** a ligação registra duração e motivo; cria ou conclui a **atividade
  `LIGACAO`** do contato (direção, resultado, duração, quem e a anotação na descrição): a atendida
  nasce concluída em nome de quem atendeu ou ligou (e conclui os "Retornar ligação" pendentes do
  contato), a perdida gera o retorno pendente, a feita sem resposta, recusada ou com falha registra
  a tentativa concluída (se veio de uma atividade pendente, ela fica pendente com a tentativa na
  descrição); e registra um **evento do sistema na conversa do Atendimento** (a ligação como
  cartão: `metadados.ligacao`). A anotação rápida (`PATCH /ligacoes/:id`) vale durante e depois da
  ligação e atualiza a atividade. O fim da ligação limpa as SDPs (a oferta e a resposta só ficam
  enquanto necessárias) e marca como lidas as notificações de "tocando".
- **R29.8** **Acesso:** atende, liga, pede permissão, anota e vê o histórico quem pode usar o
  Atendimento (R12; Marketing, não: 403). O histórico respeita a visibilidade das conversas
  (quem atendeu, quem foi chamado, quem vê a conversa e quem tem o contato no alcance, o responsável e o
  líder dele; Admin e C-level veem todas; os demais, 404). É o mesmo critério da lista, do detalhe, da
  busca, da linha do tempo, do BI e do player (R30.9).
  Só quem atendeu ou ligou encerra e anota. Configurar o canal é só do Admin. A **anonimização do
  contato (R4.6)** limpa o telefone, o BSUID, a anotação e as SDPs das ligações dele e apaga as
  permissões; o registro (direção, estado, duração e motivo) fica. **Auditoria** de
  configuração (`canal.ligacoes_*`) e de cada ligação (`ligacao.recebida`, `ligacao.atendida`,
  `ligacao.iniciada`, `ligacao.encerramento_pedido`, `ligacao.anotada`, `ligacao.encerrada`, `.perdida`,
  `.recusada`, `.sem_resposta`, `.falhou`) e da
  permissão (`ligacao.permissao_pedida`, `_concedida`, `_negada`, `_revogada`).
- **R29.9** **Histórico (lista, busca, linha do tempo e BI) segue o mesmo recorte do detalhe.** Uma ligação
  entra em qualquer um deles para quem a vê: o atendente, quem foi chamado a atender e quem vê a conversa
  (R12); Admin e C-level veem todas; Marketing recebe 403. `GET /ligacoes` filtra por `de`/`ate` (hora em que
  a ligação começou), `direcao`, `situacao` (lista: `ENCERRADA` = atendida, `PERDIDA`, `RECUSADA`,
  `SEM_RESPOSTA`, `FALHOU`, `EM_ANDAMENTO`…), `atendenteId` (ou `sem`, as perdidas), `filaId` (a da conversa),
  `canalId`, `contatoId`, `conversaId` e `busca` (R30.16); devolve `total` (com o filtro e a visibilidade) e
  pagina por cursor, da mais recente para a mais antiga. **Linha do tempo** (`GET /contatos/:id/linha-do-tempo`,
  também a da empresa): item de `tipo: "ligacao"` com direção, resultado (`atendida`, `perdida`, `recusada`,
  `sem_resposta`, `falhou`), duração, atendente, canal, assunto e trecho do resumo (quando pronto), se há
  gravação e transcrição, e o `conversaId`; `incluir=ligacoes` traz só elas. Para não aparecer duas vezes, o
  evento de fechamento da auditoria (`ligacao.encerrada`, `.perdida`, `.recusada`, `.sem_resposta`,
  `.falhou`) e a atividade `LIGACAO` já concluída da própria ligação saem da lista; a atividade "Retornar
  ligação" pendente continua. O painel completo abre em `/atendimento/ligacoes/:id`.
- **R29.10** **BI, painel Atendimento (R20).** Cartões: `ligacoesRecebidas`, `ligacoesFeitas`,
  `ligacoesAtendidas`, `ligacoesPerdidas`, `ligacoesTaxaAtendimento` (recebidas atendidas ÷ recebidas),
  `ligacoesEspera` (segundos entre começar a tocar e ser atendida, nas recebidas atendidas) e
  `ligacoesDuracao` (média das atendidas), com comparação com o período anterior. Contam só ligações
  **terminadas** que **começaram** no período. Tabelas: `ligacoesPorAtendente` (recebidas, feitas, atendidas,
  perdidas, espera, duração; as perdidas ficam em "Sem atendente") e `ligacoesPorHora` (24 linhas, fuso de
  Brasília). Valem os filtros do painel (área, pessoa = atendente, canal, fila) e a visibilidade acima.
- **R29.11** **Evento e gatilhos.** Ao chegar a um estado terminal, a ligação publica na outbox
  `ligacao.perdida` (só recebida perdida) e `ligacao.encerrada` (todo desfecho). Dados: `ligacaoId`,
  `canalId`, `canalTipo`, `contatoId`, `contato {id, nome}`, `conversaId`, `atividadeId`, `direcao`, `estado`,
  `resultado`, `motivo`, `duracaoSegundos`, `esperaSegundos`, `atendenteId`, `atendente {id, nome}`,
  `iniciadaEm`, `atendidaEm`, `encerradaEm`. **Gatilhos de automação** (entidade contato): "Ligação perdida"
  (filtro `canalId`) e "Ligação encerrada" (`canalId`, `direcao`, `resultado`). **Webhook de saída:**
  `ligacao.encerrada` pode ser assinado como qualquer outro (R9); o corpo nunca leva áudio nem transcrição, e o
  resumo só quando o Admin marca "Incluir o resumo no webhook" no canal (`webhookIncluiResumo`, R30.17).
  Dados do titular saem do `payload` na anonimização como nos outros eventos (R4.6).
- **Endpoints:** `GET /ligacoes/configuracao-webrtc`, `GET /ligacoes/canais`, `GET /ligacoes/ativas`,
  `GET /ligacoes/permissoes`, `POST /ligacoes/permissoes/pedir`, `GET /ligacoes`, `POST /ligacoes`,
  `GET /ligacoes/:id`, `POST /ligacoes/:id/atender`, `POST /ligacoes/:id/recusar`, `POST /ligacoes/:id/encerrar`, `PATCH
  /ligacoes/:id`; Admin: `GET|PATCH /whatsapp-oficial/canais/:id/ligacoes`. Tempo real (namespace
  `/tempo-real`): `ligacao.tocando`, `ligacao.deixou_de_tocar`, `ligacao.resposta_sdp`,
  `ligacao.estado`, `ligacao.encerrada` e `ligacao.permissao`.

### Cenários de aceitação (Onda E, ligações)

Continuam a numeração dos cenários do canal oficial (até o 194); cada um tem teste automatizado
("cenário N" no nome, em `test/onda-e-ligacoes.e2e-spec.ts`) contra um Postgres real e uma Graph e
Calling API falsa em processo; a máquina de estados, o formato do webhook e as regras de permissão
têm testes de unidade em `src/ligacoes/*.spec.ts`.

195. O Admin liga as chamadas: `settings` na Meta (sem `call_hours`, SIP desligado), padrões do
     canal e auditoria (R29.6).
196. Só o Admin configura (403); Marketing não usa as ligações (403) (R29.6, R29.8).
197. A Meta recusa ativar: nada é gravado e o motivo vem em português (R29.6).
198. Tempo de toque, horário e mensagem de perdida são validados (R29.6).
199. Recebida atendida: toca só para o responsável, `pre_accept` e `accept` com o mesmo SDP,
     termina com a duração, atividade concluída, evento na conversa e janela de 24 h aberta
     (R29.2, R29.7).
200. Contato novo: cria contato e conversa na fila e toca para todos os livres da fila (R29.2).
201. Disputa de dois atendentes: só um leva (409 `atendida_por_outro` para o outro, que recebe
     `deixou_de_tocar`) (R29.2).
202. Perdida por tempo de toque: `reject` na Meta, "Retornar ligação", notificação e mensagem
     automática (R29.2).
203. Fora do horário de ligações e sem atendente online: `PERDIDA` na hora, com `reject` e retorno
     (R29.2).
204. Quem está em ligação não é "livre": a ligação seguinte vai para a fila (R29.2).
205. Uma ligação por atendente: atender outra com uma em andamento é 409 (R29.2).
206. A Meta recusa o `accept`: `FALHOU`, motivo ao atendente e retorno para o cliente (R29.2).
207. O cliente desliga antes de alguém atender: `PERDIDA` e os outros param de tocar (R29.2).
208. Encerrar manda `terminate`; o webhook fecha com a duração; sem webhook, o job fecha (R29.2).
209. Anotação rápida vai para a atividade; só quem atendeu anota (R29.7).
210. Queda do navegador: tolerância curta e depois encerra com `terminate` (R29.2).
211. Ligar sem permissão: 422 com o que o front precisa e nada vai à Meta (R29.3).
212. Ligar com permissão: `connect`, resposta SDP pelo tempo real, `RINGING`, `ACCEPTED`, encerrar e
     atividade (R29.3).
213. A permissão expirou na Meta: o CRM confere antes de ligar e atualiza o registro (R29.3).
214. Limite de ligações feitas lido da Meta: 422 com quando libera (R29.3).
215. A Meta recusa o `connect`; cliente recusa; cliente não atende (R29.3, R29.5).
216. Cancelar enquanto chama; botão desligado bloqueia (R29.3).
217. Uma ligação por atendente e por cliente (R29.3).
218. Ligação feita a partir de uma atividade de ligação: concluída se atendida (R29.3).
219. Pedido de permissão dentro da janela (interativo); a resposta do cliente atualiza o registro
     (R29.4).
220. Pedido fora da janela: template com o componente de permissão; sem template, 422 (R29.4).
221. Limites de pedido: 1 por 24 h e 2 por 7 dias, e o que a Meta informar (R29.4).
222. 4 ligações seguidas sem resposta revogam a permissão; atender zera a contagem (R29.4).
223. Vigia: ligação feita presa em `CHAMANDO` é fechada (R29.3).
224. `connect` repetido não duplica a ligação nem o toque (R29.2).
225. `terminate` e status repetidos, `RINGING` depois do `ACCEPTED` e eventos depois do fim não
     regridem nada (R29.1, R29.2).
226. `terminate` que chega antes do `connect` espera a ligação existir (R29.2).
227. `connect` atrasado: `PERDIDA` "atrasada", sem toque e sem `reject` (R29.2).
228. O webhook só vale assinado com o app secret do canal; as chaves de dedupe vencem em 7 dias
     (R29.2).
229. O histórico respeita a visibilidade do Atendimento (R29.8).
230. O processamento completo termina sem erro nos logs técnicos (R29).
231. A anonimização do contato (R4.6) limpa o telefone, a anotação e a permissão das ligações e
     mantém o registro (duração, motivo) (R29.8).
232. Os status (enviada, entregue, lida) do pedido de permissão são reconhecidos, sem job em erro
     (R29.4).

## 41. Gravação, transcrição e resumo das ligações (R30)

Onda E (fatia E3, API). A gravação é feita **no navegador do atendente** (a API não toca no áudio da
chamada), enviada em partes, juntada e processada pela fila: versão para ouvir, transcrição por canal e
resumo. Código em `src/ligacoes/gravacao/` (partes, junção, leitura, privacidade, guarda, sugestões) e
`src/transcricao/` (ffmpeg, whisper.cpp, Claude). Nada chama a Anthropic real nem a Meta real nos testes
e no ambiente dos agentes (Anthropic falsa do serviço de apoio; whisper falso em processo nos testes).

- **R30.1** **Partes da gravação.** O canal grava quando `canais_ligacoes.gravar` é verdadeiro (a ligação
  nasce com `gravar`). O gravador manda **webm/opus estéreo** (atendente no canal esquerdo, cliente no
  direito; `MediaRecorder` com fatias de ~5 s): `POST /ligacoes/:id/gravacao/partes/:sequencia`, corpo cru
  `audio/webm` de até 4 MB, sequência de 0 a 20 000 (a parte 0 traz o cabeçalho webm e é conferida).
  **Idempotente por sequência:** reenviar a mesma parte devolve `duplicada: true`; outra parte com o mesmo
  número é 409 `parte_diferente`. Só o **atendente da ligação** (os outros recebem 404) e só com a ligação
  **EM_ANDAMENTO** ou **encerrada há menos de 2 minutos**; canal sem gravação, gravação já finalizada ou
  apagada e ligação fora de andamento são 409 (`detalhes.motivo`). Limites: tamanho total
  (`LIGACOES_GRAVACAO_MAX_MB`) e duração (`LIGACOES_GRAVACAO_MAX_MIN`) por ligação, 413. As partes ficam no
  armazenamento de arquivos (`ligacoes/<id>/partes/<n>`) e numa tabela de controle; a gravação passa a
  `enviando`.
- **R30.2** **Finalizar.** `POST /ligacoes/:id/gravacao/finalizar` (corpo `{totalPartes}` ou
  `?totalPartes=N`, para o `navigator.sendBeacon`): trava a ligação, **junta as partes na ordem** (webm de
  um mesmo `MediaRecorder` concatena direto), guarda o arquivo original (contexto `LIGACAO`), apaga as
  partes e enfileira o processamento, tudo na mesma transação; **idempotente** (a segunda chamada devolve
  `jaFinalizada: true`). Sem partes, nada é gravado (`sem`); sem a parte 0, a gravação `falhou` com
  mensagem. Se a aba fechar sem finalizar, ao encerrar a ligação a API agenda um job
  (`ligacoes.gravacao.finalizar`, 90 s depois) que junta **o que subiu**.
- **R30.3** **Processamento** (fila `transcricao.processar`, **uma por vez**, 3 retentativas): o **ffmpeg**
  gera a versão para ouvir (mono, ogg/opus 32 kbps) e um WAV 16 kHz mono por canal; o **whisper.cpp**
  (`TRANSCRICAO_URL`, `POST /inference`, `verbose_json`, português) transcreve cada canal com marcações de
  tempo (o serviço usa detecção de voz Silero; sem ela os tempos do canal calado saem errados) e os trechos são **intercalados por tempo** como `atendente` e `cliente` (trechos seguidos do
  mesmo falante com pausa até 1,5 s viram um; "[BLANK_AUDIO]", música e as alucinações conhecidas do
  Whisper em silêncio são descartados). Gravação mono (sem separação de canais): um canal só, falante
  `participante`. A duração vem da versão ogg (o webm do navegador não traz a duração). Prazo total em
  `TRANSCRICAO_TEMPO_LIMITE_S`. Ao terminar, o tempo real emite `ligacao.processada`.
- **R30.4** **Resumo** (fila `transcricao.resumir`): o Claude (`@anthropic-ai/sdk`, o mesmo cliente do BI e
  do assistente, modelo `LIGACOES_RESUMO_MODELO`, padrão `claude-sonnet-5-5`, saída estruturada em JSON)
  recebe a conversa entre marcas `<transcricao>` — texto de terceiros: o sistema manda **nunca seguir
  instruções escritas nela**, e a própria conversa não consegue fechar a marca — e devolve **assunto,
  pontos principais, combinados, próximos passos, sentimento (com o motivo) e até 5 sugestões de
  atividade**. A resposta é conferida de novo (tipos, valores conhecidos, tamanhos). **Sem
  `ANTHROPIC_API_KEY`** (ou com conversa curta, menos de 15 palavras) o resumo fica `desativado` com o
  motivo em `resumo.erro`, e a transcrição segue valendo. A auditoria guarda o modelo e os tokens, nunca o
  texto.
- **R30.5** **Estados por ligação** (`GET /ligacoes/:id`): *gravação* `sem`, `enviando`, `pronta` ou
  `falhou` (+ `disponivel`, `duracaoSegundos`, `removidaEm`, `podeBaixar`); *transcrição* `pendente`,
  `processando`, `pronta`, `falhou` ou `desativada` (nulo = não foi gravada); *resumo* `pendente`,
  `processando`, `pronto`, `falhou` ou `desativado`. Falha transitória (rede, 5xx, tempo, sobrecarga)
  repete pela fila; ao esgotar, o estado vira `falhou` com a mensagem em português (nunca o texto do erro
  técnico). Se o ffmpeg não consegue ler o arquivo, a gravação `falhou` na hora, sem repetir. **Sem
  `TRANSCRICAO_URL`** a gravação fica `pronta` (dá para ouvir) e a transcrição e o resumo `desativada` e
  `desativado`.
- **R30.6** **Reprocessar.** `POST /ligacoes/:id/reprocessar` `{etapa: 'completo' | 'resumo'}` refaz a
  conversão, a transcrição e o resumo (ou só o resumo, que exige a transcrição pronta). Só o atendente da
  ligação, o Admin e os líderes (403 aos demais que a veem); 409 se já está processando, se não tem
  gravação ou se a guarda já a apagou. O ogg anterior é substituído.
- **R30.7** **Sugestões de atividade só viram atividade com a confirmação do usuário.**
  `POST /ligacoes/:id/resumo/sugestoes/:sugestaoId/confirmar` (corpo opcional: título, descrição, tipo,
  `venceEm`, `fimEm`, `responsavelId`) cria a atividade do contato pelo `AtividadesService` (regras e
  auditoria de sempre; vencimento padrão às 18h de Brasília daqui a `prazoEmDias`; reunião ganha início =
  vencimento e fim 1 h depois) e marca a sugestão; `…/descartar` só marca. **Cada sugestão vale uma vez**
  (409 `sugestao_ja_tratada`), mesmo com cliques simultâneos (a ligação é travada e a sugestão reservada).
  Falha ao criar libera a sugestão. Quem não vê a ligação recebe 404.
- **R30.8** **Ouvir.** `GET /ligacoes/:id/audio` entrega o ogg mono por streaming **com `Range`** (206/416,
  `ETag`, `Accept-Ranges`, `Cache-Control: private, no-store`, `nosniff`), para o player avançar e voltar;
  `?versao=original` entrega o webm estéreo.
- **R30.9** **Privacidade (LGPD).** Ouve e lê (áudio, transcrição, resumo) **quem vê a ligação**: o
  atendente, quem foi chamado, Admin e C-level, quem vê a conversa (R12) e quem tem o **contato** no
  alcance (responsável, ou líder da equipe do responsável); os demais recebem 404 (não revela que existe).
  **Baixar** (`GET /ligacoes/:id/audio/baixar`, anexo) é só do **Admin e dos líderes** (403 aos demais).
  **Auditoria:** reprodução (`ligacao.gravacao-reproduzida`: a que começa no byte 0 e, para um `Range` que
  começa adiante, a primeira de cada janela de 5 minutos por usuário, ligação e versão; não cada `Range` do
  player), download (`ligacao.gravacao-baixada`, todo pedido) e leitura da transcrição (`ligacao.transcricao-lida`), com quem e quando;
  mais finalização, conclusão e falha do processamento, reprocessamento e sugestões.
- **R30.10** **Sem gravação ainda:** áudio e transcrição inexistentes são 404 com `detalhes.motivo`
  (`sem_gravacao`, `gravacao_removida`).
- **R30.11** **Prazo de guarda.** `canais_ligacoes.retencaoDias` (1 a 3650, padrão **365**, configurável
  pelo Admin em `PATCH /whatsapp-oficial/canais/:id/ligacoes`). **Todo dia às 03:30** (fila
  `ligacoes.gravacao.remover-vencidas`), a gravação (original e ogg) e a transcrição das ligações mais
  antigas que o prazo são **apagadas**; **o registro, a duração e o resumo ficam**. A ligação ganha
  `gravacaoRemovidaEm`. Quem grava o resultado do processamento (ogg, transcrição, resumo) trava a
  ligação e só grava se `gravacaoRemovidaEm` continua vazio: a guarda ou a anonimização no meio do
  processamento não deixam o dado voltar. A mesma rodada apaga partes abandonadas (aba fechada e ninguém finalizou, 2 dias).
- **R30.12** **Dados pessoais.** A exportação do titular (`GET /contatos/:id/dados-pessoais`, só Admin)
  inclui as **ligações** (registro, telefone, anotação, transcrição e resumo; o áudio não vai no JSON). A
  **anonimização** (R4.6) apaga gravações (os arquivos saem do armazenamento), transcrições **e resumos**
  das ligações do contato, além do telefone e da anotação (R29.8); a auditoria registra só a contagem.
- **R30.13** **Áudio de aviso do canal.** O Admin sobe um áudio (até 5 MB) em
  `POST /arquivos?contexto=LIGACAO` e o liga em `PATCH /whatsapp-oficial/canais/:id/ligacoes`
  `{avisoArquivoId}` (só áudio do contexto `LIGACAO`, senão 400; `null` remove; trocar apaga o anterior).
  Quem usa o Atendimento baixa em `GET /ligacoes/canais/:canalId/aviso` (com `Range`; 404 se não houver);
  **o navegador o toca para o cliente ao atender**, misturado na saída — a API só guarda e entrega.
- **R30.14** **Serviço de transcrição.** O serviço `transcricao` do compose (usuário, agentes e produção)
  roda a imagem oficial `ghcr.io/ggml-org/whisper.cpp` **fixada por digest**: o entrypoint baixa o modelo
  `WHISPER_MODELO` para um volume na primeira subida e roda o `whisper-server` **só na rede do compose**,
  com healthcheck, `TRANSCRICAO_CPUS` e `WHISPER_THREADS`. A tela **Saúde do sistema** mostra o serviço
  (`ok`, `fora_do_ar` ou `desativada`), o modelo e a fila (pendentes, em processamento, falhas em 24 h);
  serviço ligado e fora do ar gera o alerta `transcricao_fora_do_ar` (aviso).
- **R30.15** **Permissões e rotas** (todas em `/api/v1`, cookie de sessão): ver a matriz acima (R30.1, R30.9
  e R30.11). Tempo real: `ligacao.processada` `{ligacaoId, etapa: gravacao|transcricao|resumo, gravacao,
  transcricao, resumo}` para `usuario:<atendente>` e `conversa:<id>`.
- **R30.16** **Busca no texto das transcrições.** `GET /ligacoes?busca=…` (até 200 caracteres) usa
  **full text em português com índice**: o texto da transcrição é guardado como `tsvector` (`portuguese`,
  sem acento nem maiúscula: "renovacao" acha "renovação"; "descontos" acha "desconto"), mantido por um
  **gatilho do banco** sempre que `transcricao` muda — transcrição, reprocessamento, guarda vencida e
  anonimização (R30.11, R30.12) tiram ou põem a ligação na busca sem código extra. Sintaxe: palavras
  juntas (E), `"frase exata"`, `-palavra` (exclui) e `or`. Palavras muito comuns ("isso", "de") são
  ignoradas pelo idioma. Só entram ligações visíveis ao usuário (R29.9): o texto de uma ligação alheia não
  vaza nem como contagem. Considera as 5000 mais recentes que casam. Cada item volta com
  `trechosEncontrados` (até 3 falas: `falante`, `inicio` em segundos, `texto`), para o clique tocar a
  gravação naquele ponto (a frase que atravessa duas falas acha a ligação, mas não mostra trecho).
- **R30.17** **Resumo no webhook (opcional).** `PATCH /whatsapp-oficial/canais/:id/ligacoes`
  `{webhookIncluiResumo}` (Admin; padrão desligado, porque o resumo cita o cliente). Ligado, o
  `ligacao.encerrada` das ligações atendidas **e gravadas** leva `resumo {assunto, pontosPrincipais,
  combinados, proximosPassos, sentimento}` (sem as sugestões de atividade). Para isso o evento **espera o
  resumo terminar** (pronto, falhou ou desativado; confere a cada 20 s, no máximo 20 min, depois sai sem
  ele); por isso, com o resumo ligado, o gatilho "Ligação encerrada" dessas ligações também espera. "Ligação
  perdida" nunca espera. A transcrição e o áudio **nunca** saem.

### Cenários de aceitação (Onda E, gravação, transcrição e resumo)

Continuam a numeração das ligações (até o 232); cada um tem teste automatizado ("cenário N" no nome, em
`test/onda-e-gravacao.e2e-spec.ts`) contra um Postgres real, um whisper falso em processo e a Anthropic
falsa dos testes; a intercalação, o resumo, o cliente do whisper, as variáveis e o vencimento das sugestões
têm testes de unidade em `src/transcricao/*.spec.ts`, `src/ligacoes/gravacao/*.spec.ts` e
`src/config/ambiente.spec.ts`. O ffmpeg real e o whisper real foram conferidos à parte (veja o progresso).

233. As partes são guardadas, idempotentes por sequência; a mesma sequência com outro conteúdo é 409
     (R30.1).
234. Recusas: outro atendente (404), vazia, grande demais, sem cabeçalho webm, sequência inválida, canal sem
     gravação, ligação fora de andamento ou encerrada há mais de 2 minutos (R30.1).
235. Tamanho máximo da gravação (413) (R30.1).
236. Finalizar junta as partes na ordem, guarda o webm, apaga as partes, é idempotente e recusa parte nova
     (R30.2).
237. Finalizar sem partes não grava nada; só o atendente finaliza (R30.2).
238. Sem a primeira parte a gravação falha com mensagem clara (R30.2).
239. Aba fechada: a fila finaliza sozinha com o que subiu (R30.2).
240. Converte, transcreve cada canal, intercala por tempo, resume e avisa em tempo real; nenhuma atividade
     nasce sozinha (R30.3, R30.4).
241. Gravação mono: um canal só, falante `participante` (R30.3).
242. Sem chave da Anthropic fica só a transcrição (R30.4).
243. Falha transitória do whisper repete; ao esgotar, `falhou`; "Reprocessar" refaz (R30.5, R30.6).
244. ffmpeg não lê a gravação: `falhou` sem repetir à toa (R30.5).
245. O resumo repete e vira `falhou`; "Reprocessar resumo" refaz só ele (R30.5, R30.6).
246. "Reprocessar": só atendente, Admin e líderes; recusa o que está processando ou sem gravação (R30.6).
247. Transcrição desligada: só a versão para ouvir (R30.5).
248. Áudio com `Range` (206/416), cabeçalhos seguros e auditoria só da reprodução inteira (R30.8, R30.9).
249. Quem vê a conversa ou o contato ouve e lê; os outros, 404; baixar só Admin e líderes, auditado (R30.9).
250. Áudio e transcrição inexistentes: 404 claro (R30.10).
251. A guarda vencida apaga gravação e transcrição e mantém registro, duração e resumo (R30.11).
252. O prazo é do canal e partes abandonadas somem (R30.11).
253. Exportar os dados do titular inclui ligações e transcrições; anonimizar apaga gravações, transcrições e
     resumos (R30.12).
254. A atividade só nasce na confirmação; cada sugestão vale uma vez, mesmo com cliques juntos (R30.7).
255. O corpo ajusta tipo e vencimento; data inválida é 400 e libera a sugestão (R30.7).
256. Áudio de aviso do canal: sobe, liga, toca, só áudio, trocar apaga o antigo (R30.13).
257. A Saúde do sistema mostra o serviço de transcrição e a fila, e alerta quando cai (R30.14).
258. Saúde com a transcrição desligada: `desativada`, sem alerta (R30.14).

## 42. Matriz de acesso e cenários — Onda E (WhatsApp oficial, ligações, gravação e histórico)

Resumo de quem pode o quê (detalhes nas regras R28 a R30). "Vê" = a ligação ou conversa está no recorte do
Atendimento (R12): atendente, quem foi chamado, quem vê a conversa; Admin e C-level veem todas.

| Recurso | Admin | C-level | Líder | Membro | Marketing |
| --- | --- | --- | --- | --- | --- |
| Cadastrar canal WhatsApp oficial, templates (R28) | ✓ | — | — | — | — |
| Configurar ligações do canal: ativar, horário, fila, gravar, guarda, aviso, resumo no webhook (R29.6, R30.17) | ✓ | — | — | — | — |
| Atender, recusar, ligar, pedir permissão (R29.2–R29.4) | ✓ | ✓ | ✓ | ✓ (as que lhe tocam) | — (403) |
| Encerrar e anotar | ✓ | ✓ | só as suas | só as suas | — |
| Lista, busca no texto e detalhe das ligações (R29.9, R30.16) | todas | todas | as que vê | as que vê | — (403) |
| Entrada da ligação na linha do tempo do contato (R29.9) | todas | todas | as que vê | as que vê | nenhuma |
| Ouvir gravação, ler transcrição e resumo (R30.9) | ✓ | ✓ | as que vê, mais as do alcance do contato | idem | — |
| Baixar o áudio (R30.9) | ✓ | — | ✓ | — | — |
| Reprocessar, confirmar ou descartar sugestões (R30.6, R30.7) | ✓ | ✓ | ✓ | só as suas | — |
| BI Atendimento: ligações (R29.10) | todas | todas | as que vê | as que vê | — (403) |
| Webhook de saída `ligacao.encerrada` e gatilhos de automação (R29.11) | ✓ | ✓ (automações) | ✓ (automações) | — | — |
| Preferência de push `ligacao_recebida` (R26) | ✓ | ✓ | ✓ | ✓ (a própria) | ✓ |

### Cenários de aceitação (Onda E, histórico e integrações)
259. Lista de ligações filtra por período, direção, situação, atendente (ou `sem`), fila, canal e contato, com
     `total` e cursor; filtros inválidos são 400 (R29.9).
260. Cada um vê só as ligações que pode ver (atendente, chamado, conversa); Marketing recebe 403 (R29.9).
261. Busca no texto sem distinguir acento, maiúscula ou flexão; frase, exclusão e `or`; devolve os trechos que
     casaram (R30.16).
262. A busca não revela o texto de ligação que o usuário não vê (R30.16, R29.9).
263. O índice acompanha a transcrição: apagar (guarda, LGPD) tira da busca; reprocessar põe de novo (R30.16).
264. Linha do tempo do contato: entrada da ligação com resultado, duração e resumo, só a quem a vê, sem
     duplicar o evento nem a atividade concluída (R29.9).
265. BI Atendimento: cartões e tabelas de ligações, por atendente e por hora, com a visibilidade do R12 (R29.10).
266. Webhook `ligacao.encerrada`: ids, direção, resultado, duração, atendente e contato; sem áudio,
     transcrição nem resumo por padrão; assinatura de sempre (R29.11).
267. Com o resumo marcado no canal, o webhook espera o resumo e o leva, sem sugestões nem transcrição (R30.17).
268. Gatilhos "ligação perdida" e "ligação encerrada" com filtros de canal, direção e resultado (R29.11).
269. Só o Admin configura "resumo no webhook" (R30.17).
270. A preferência de push `ligacao_recebida` aparece e muda em `/push/preferencias` (R26).
271. Recusar: some só para quem recusou; quando todos recusam, `reject` na Meta na hora e `PERDIDA` (R29.2).
272. Corrida cancelar × atender: o `terminate` com duração depois do cancelamento não dá duração à
     `SEM_RESPOSTA` (R29.1a).
273. Status `RINGING` antes de o `POST` gravar o id da Meta espera um instante e é aplicado (R29.1a).
