# Roadmap — BRL CRM

CRM completo da BRL, no nível do CRM Clint, para os fluxos de **Marketing, Comercial e
Customer Success (CS)**: o lead chega por webhook, Marketing e Comercial trabalham a
oportunidade e o negócio ganho entra automaticamente no pipeline de CS. Tudo com
atendimento ao cliente dentro do CRM, sem ferramenta externa, e telas que se explicam
sozinhas para qualquer pessoa conseguir usar.

As regras de cada fase ficam em [REGRAS-DE-NEGOCIO.md](REGRAS-DE-NEGOCIO.md); as decisões
técnicas, em [ARQUITETURA.md](ARQUITETURA.md).

> Atualizado em 2026-11-02.

## Tecnologias aprovadas

| Uso | Escolha |
| --- | --- |
| Banco e migrations | PostgreSQL 17 · Prisma 7 (adapter-pg) |
| API | NestJS 12 · class-validator/class-transformer · @nestjs/swagger |
| Filas, agendamentos e outbox | pg-boss (no próprio Postgres) |
| Tempo real | @nestjs/websockets + Socket.IO |
| Login | sessões no Postgres, cookie httpOnly, scrypt nativo |
| WhatsApp | **gateway próprio** com Baileys, serviço separado (`crmbrl-whatsapp`) no repo da API — sem UazAPI nem serviço de terceiros |
| Arquivos | MinIO (compatível com S3) |
| E-mail | SMTP via nodemailer |
| IA | Claude (Anthropic) |
| Logs e monitoramento | logger JSON nativo do Nest, logs técnicos no Postgres, @nestjs/observe |
| Front | Angular 22 · SCSS com tokens (visual Sugar CRM) · Lucide · @angular/cdk · ECharts 6 |
| Mobile | PWA: 2º app Angular no repo `crmbrl`, com @angular/service-worker |
| Entrega | Docker (Caddy no front) · compose no repo da API |

Qualquer tecnologia fora desta lista passa por aprovação antes de entrar.

## Fases

### Fase 0 — Base ✅
Design system (claro e escuro), shell com navegação por papel, dashboard de exemplo,
catálogo do design system, API com Postgres e migrations, Docker e documentação.

### Fase 1 — Núcleo do CRM ✅
Regras de negócio na API: **concluídas** em 2026-10-21 (todas as regras da Fase 1 e os
15 cenários de aceitação com teste). As telas ficam no repositório `crmbrl`.

- Login com sessões, troca de senha, convites e redefinição por e-mail.
- Usuários, papéis e lideranças; **desligamento com encaminhamento** ao líder ou ao
  C-level.
- **Auditoria** de toda atividade de todos os usuários; logs técnicos consultáveis.
- Contatos e empresas com deduplicação, origem/UTM e LGPD.
- Funis de Marketing, Comercial e CS em **kanban**, com etapas configuráveis.
- **Passagens automáticas** Marketing → Comercial → CS e distribuição por rodízio.
- Atividades (tarefas, ligações, reuniões, notas) com lembretes.
- **Webhooks de entrada** (captação de leads) e **de saída** (eventos), com assinatura,
  retentativas e histórico.
- Notificações internas.
- Telas: login, funis, contatos, atividades, configurações, integrações e administração;
  dashboard com dados reais.

### Fase 2 — Atendimento e comunicação ✅
- **Gateway de WhatsApp próprio** (Baileys): vários números, conexão por QR code, envio e
  recebimento de texto e mídia, status de entrega e leitura, proteções contra banimento
  (intervalos, limites diários, aquecimento).
- **Atendimento omnichannel** no CRM: caixa de entrada, distribuição e transferência de
  conversas, respostas rápidas e histórico no contato. WhatsApp primeiro; depois e-mail,
  Instagram e chat do site.
- **Chatbot** com fluxos configuráveis (menus, coleta de dados, transferência para
  humano).
- **Disparos**: módulo novo em Angular (o sistema de disparos atual serve só de
  referência), com listas e segmentos vindos dos contatos do CRM, modelos com variáveis e
  variações, mídia, agendamento, janela de envio, intervalos aleatórios, pausa por lote,
  verificação de números, pausa automática em erro e relatório por contato. Ganha o que o
  sistema atual não tem: opt-out (LGPD), limite diário por número, aquecimento de números
  novos, rodízio entre números e respostas caindo no Atendimento.
- **Chat interno da equipe** em tempo real.
- **Automações configuráveis**: gatilhos, condições, ações e cadências.
- Mídias e anexos no MinIO.

### Fase 3 — BI ✅
- Painéis por área (Marketing, Comercial, CS, Atendimento) com filtros por período, equipe
  e pessoa, e exportação.
- Métricas de atendimento (tempo de resposta, SLA, CSAT/NPS) e integração com ferramentas
  de atendimento.
- **Análise por IA** (Claude) que lê o painel e propõe ações: botão visível só ao Admin,
  que abre um modal.

### Fase 4 — Financeiro ✅
Contratos e parcelas por cliente, status de pagamento, inadimplência e MRR, com baixa
manual ou por importação (sem gateway nesta fase), ligados ao CS para o risco de churn.
A **régua de cobrança** que hoje vive no sistema de disparos (lembretes de D-7 a D+60 por
WhatsApp e e-mail, promessa de pagamento, tarefas de ligação) migra para cá — a confirmar.

### Fase 5 — Assistente de IA e chamados ✅
**Entregue (Onda D):** botão **Ajuda** em todas as telas com um assistente (Claude) que tira
dúvidas de uso com base em 40 artigos curtos (mais um índice) (`docs/ajuda`), levando em conta a tela e o papel
(não ensina o que o papel não pode). Quando a funcionalidade não existe no escopo (ou há um erro
do sistema), oferece **abrir um chamado**, só com a confirmação da pessoa: conector do
**TicketHub** (conta de serviço: login + `POST /api/chamados`) ou webhook genérico com HMAC,
pela fila com novas tentativas; a pessoa vê o número do chamado. **Histórico só do Admin** com
filtros, temas sem resposta, chamados e exportação; limite por pessoa por dia, orçamento
mensal de tokens, avaliação de cada resposta e defesa contra injeção de prompt.

**Fica para depois:** um endpoint de integração próprio no TicketHub (hoje o conector usa a
conta de serviço); resposta do TicketHub de volta ao CRM (status do chamado); mais de um
idioma na base de conhecimento; sugestão automática de artigos novos a partir dos temas sem
resposta.

### Fase 6 — PWA mobile ✅
**Entregue (Onda D):** o próprio CRM ficou **instalável** (manifesto, ícones, service worker
com o *app shell* em cache, dados sempre pela rede, estado "sem conexão", aviso de versão
nova e dica de instalação para Android e iOS), com **notificações push** por tipo (conversa
atribuída, menção, atividade vencendo, SLA estourado, negócio atribuído e parcela atrasada da
carteira) e **navegação inferior** com ações rápidas no celular. Em vez de um app separado,
optou-se por um PWA do mesmo front.

**Fica para depois:** funcionamento offline de dados (fila de ações para sincronizar depois),
push para clientes, push em iOS fora do modo "tela de início" e agrupamento de notificações.

### Produção ✅
**Entregue (Onda D):** CI no GitHub Actions nos dois repositórios (lint, unidade, integração
com Postgres de serviço, build e imagem Docker; sem deploy automático), **backups** diários
com `pg_dump` e retenção, script de restauração testado, tela **Saúde do sistema** (filas,
gateway e números, canais, erros, disco, último backup) com **alertas por e-mail** ao Admin,
cabeçalhos de segurança, limites de requisição, variáveis obrigatórias, `DEPLOY.md` com HTTPS
pelo Caddy e o **Guia do usuário**.

**Fica para depois:** cópia automática dos backups e do volume do MinIO para fora da máquina
(hoje é orientação no `DEPLOY.md`), deploy automático, métricas históricas e painel de
observabilidade, rotação automática de segredos e alta disponibilidade (a API roda em uma
instância só por causa do Socket.IO sem adaptador).

### Em todas as fases
Dicas nas telas explicando cada funcionalidade, auditoria de tudo, testes automatizados,
documentação atualizada e Docker pronto para deploy.
