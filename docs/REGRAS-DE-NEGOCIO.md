# Regras de negócio — BRL CRM

Fonte de verdade das regras do produto. A API (`crmbrl-api`) é a única camada que as
aplica; o front só as reflete. Cada regra tem um código (`R<n>.<m>`) para ser citada
em testes, commits e chamados. Até a R10 o número é o da seção; as regras da Fase 2
continuam a sequência dos códigos (R11 a R15) nas seções 14 a 18, depois da convenção,
da matriz e dos cenários da Fase 1 (seções 11 a 13, que mantêm o número porque o código
as cita).

Esta versão cobre a **Fase 1 — núcleo do CRM** e a **primeira parte da Fase 2 (Onda
A)**: arquivos, atendimento omnichannel, gateway de WhatsApp próprio, chat do site,
e-mail, Instagram e Messenger, tempo real e chat interno da equipe. As fases seguintes
estão em [ROADMAP.md](ROADMAP.md) e ganham seções aqui quando forem detalhadas.

> Atualizado em 2026-10-26. Regras marcadas com **(proposta)** dependem de validação do
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
  dados pessoais, só pelo Admin, e auditada.
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
