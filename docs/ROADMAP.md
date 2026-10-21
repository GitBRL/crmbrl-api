# Roadmap — BRL CRM

CRM completo da BRL, no nível do CRM Clint, para os fluxos de **Marketing, Comercial e
Customer Success (CS)**: o lead chega por webhook, Marketing e Comercial trabalham a
oportunidade e o negócio ganho entra automaticamente no pipeline de CS. Tudo com
atendimento ao cliente dentro do CRM, sem ferramenta externa, e telas que se explicam
sozinhas para qualquer pessoa conseguir usar.

As regras de cada fase ficam em [REGRAS-DE-NEGOCIO.md](REGRAS-DE-NEGOCIO.md); as decisões
técnicas, em [ARQUITETURA.md](ARQUITETURA.md).

> Atualizado em 2026-10-21.

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

### Fase 1 — Núcleo do CRM
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

### Fase 2 — Atendimento e comunicação
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

### Fase 3 — BI
- Painéis por área (Marketing, Comercial, CS, Atendimento) com filtros por período, equipe
  e pessoa, e exportação.
- Métricas de atendimento (tempo de resposta, SLA, CSAT/NPS) e integração com ferramentas
  de atendimento.
- **Análise por IA** (Claude) que lê o painel e propõe ações: botão visível só ao Admin,
  que abre um modal.

### Fase 4 — Financeiro
Contratos e parcelas por cliente, status de pagamento, inadimplência e MRR, com baixa
manual ou por importação (sem gateway nesta fase), ligados ao CS para o risco de churn.
A **régua de cobrança** que hoje vive no sistema de disparos (lembretes de D-7 a D+60 por
WhatsApp e e-mail, promessa de pagamento, tarefas de ligação) migra para cá — a confirmar.

### Fase 5 — Assistente de IA e chamados
- Assistente (Claude) que tira dúvidas de uso com base na documentação do CRM.
- Histórico de dúvidas visível **só ao Admin**, para descobrir evoluções que ninguém pediu.
- Quando a IA não resolve, e a pergunta está no escopo mas a funcionalidade ainda não
  existe, o sistema abre um chamado por webhook no **TicketHub** (destino configurável para
  outros sistemas de chamados). O TicketHub ainda não tem webhook de entrada: o conector
  usa uma conta de serviço (login + `POST /api/chamados`), o que funciona sem mudar o
  TicketHub; um endpoint de integração próprio nele é uma melhoria recomendada.

### Fase 6 — PWA mobile
App instalável e separado, pensado para o celular: atendimento, atividades, funis e
notificações push.

### Em todas as fases
Dicas nas telas explicando cada funcionalidade, auditoria de tudo, testes automatizados,
documentação atualizada e Docker pronto para deploy.
