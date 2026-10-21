# Regras de negócio — BRL CRM

Fonte de verdade das regras do produto. A API (`crmbrl-api`) é a única camada que as
aplica; o front só as reflete. Cada regra tem um código (`R<seção>.<n>`) para ser citada
em testes, commits e chamados.

Esta versão cobre a **Fase 1 — núcleo do CRM**. As fases seguintes estão em
[ROADMAP.md](ROADMAP.md) e ganham seções aqui quando forem detalhadas.

> Atualizado em 2026-10-21. Regras marcadas com **(proposta)** dependem de validação do
> negócio e podem mudar sem quebrar o resto. Trechos marcados com **Ajuste da
> implementação (2026-10-20)** registram o que a implementação da Fase 1 precisou
> definir ou mudar em relação ao texto original da regra.

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
- **R10.2** Notificações internas na Fase 1: lead ou negócio atribuído, passagem recebida,
  itens encaminhados por desligamento, atividade vencendo ou atrasada, falha ou desativação
  de webhook de saída (Admin) e equipe sem líder (Admin). Podem ser listadas, marcadas como
  lidas uma a uma ou todas de uma vez. O tempo real chega na Fase 2.
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
