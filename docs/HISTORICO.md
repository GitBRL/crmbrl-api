# Historico de mudancas — crmbrl-api

Registro gerado por `tools/doc-updater`. Cada entrada reune os commits novos,
os arquivos alterados e o impacto deles na arquitetura. Entradas mais recentes no topo.

<!-- doc-updater:historico — novas entradas entram aqui -->

## 2026-10-21 — sem commits novos

**O que foi feito:** Fase 1: regras de negócio do núcleo do BRL CRM

### Impacto na arquitetura

**Modulos**

- **+** `AdministracaoModule`
- **+** `AtividadesModule`
- **+** `AuditoriaModule`
- **+** `AuditoriaConsultaModule`
- **+** `AuthModule`
- **+** `ComumModule`
- **+** `ContatosModule`
- **+** `EmailModule`
- **+** `EventosModule`
- **+** `FilaModule`
- **+** `FunisModule`
- **+** `LogsModule`
- **+** `NotificacoesModule`
- **+** `SeedsModule`
- **+** `UsuariosModule`
- **+** `WebhooksModule`


**Controllers**

- **+** `AdministracaoController`
- **+** `AtividadesController`
- **+** `AuditoriaConsultaController`
- **+** `AuthController`
- **+** `ContatosController`
- **+** `EmpresasController`
- **+** `DistribuicaoController`
- **+** `FunisController`
- **+** `NegociosController`
- **+** `PassagensController`
- **+** `NotificacoesController`
- **+** `DesligamentoController`
- **+** `UsuariosController`
- **+** `WebhooksEntradaController`
- **+** `WebhookEntradaPublicoController`
- **+** `WebhooksSaidaController`


**Servicos**

- **+** `LogsTecnicosConsultaService`
- **+** `ResumoAdministracaoService`
- **+** `RetencaoService`
- **+** `AtividadesService`
- **+** `LembretesAtividadesService`
- **+** `AuditoriaService`
- **+** `AuditoriaConsultaService`
- **+** `ParseIdSequencialPipe`
- **+** `AuthService`
- **+** `ForcaBrutaService`
- **+** `OrigemGuard`
- **+** `PapeisGuard`
- **+** `SessaoGuard`
- **+** `SenhasService`
- **+** `SessoesService`
- **+** `CriptografiaService`
- **+** `ParseIdPipe`
- **+** `ContatosService`
- **+** `EmpresasService`
- **+** `LinhaDoTempoService`
- **+** `PermissoesContatosService`
- **+** `EmailService`
- **+** `EventosDominioService`
- **+** `FilaService`
- **+** `DistribuicaoService`
- **+** `FunisService`
- **+** `MetricasService`
- **+** `MotorDeNegociosService`
- **+** `NegociosConsultaService`
- **+** `NegociosService`
- **+** `ParseAreaPipe`
- **+** `PassagensService`
- **+** `LogsTecnicosService`
- **+** `NotificacoesService`
- **+** `SeedsService`
- **+** `DesligamentoService`
- **+** `UsuariosService`
- **+** `ProcessamentoEntradaService`
- **+** `RecebimentosService`
- **+** `WebhooksEntradaService`
- **+** `EntregasService`
- **+** `WebhooksSaidaService`


**Endpoints HTTP**

- **+** `GET /administracao/resumo`
- **+** `GET /administracao/logs-tecnicos`
- **+** `GET /administracao/logs-tecnicos/:id`
- **+** `POST /atividades`
- **+** `GET /atividades`
- **+** `GET /atividades/agrupadas`
- **+** `GET /atividades/:id`
- **+** `PATCH /atividades/:id`
- **+** `POST /atividades/:id/concluir`
- **+** `POST /atividades/:id/cancelar`
- **+** `POST /atividades/:id/reabrir`
- **+** `GET /auditoria`
- **+** `GET /auditoria/filtros`
- **+** `GET /auditoria/:id`
- **+** `POST /auth/entrar`
- **+** `POST /auth/sair`
- **+** `GET /auth/eu`
- **+** `POST /auth/senha`
- **+** `POST /auth/senha/esqueci`
- **+** `POST /auth/senha/token`
- **+** `POST /auth/senha/redefinir`
- **+** `GET /contatos`
- **+** `GET /contatos/etiquetas`
- **+** `POST /contatos`
- **+** `GET /contatos/:id`
- **+** `PATCH /contatos/:id`
- **+** `POST /contatos/:id/anonimizar`
- **+** `GET /contatos/:id/linha-do-tempo`
- **+** `GET /empresas`
- **+** `GET /empresas/etiquetas`
- **+** `POST /empresas`
- **+** `GET /empresas/:id`
- **+** `PATCH /empresas/:id`
- **+** `GET /empresas/:id/linha-do-tempo`
- **+** `GET /regras-distribuicao`
- **+** `GET /regras-distribuicao/:area`
- **+** `PATCH /regras-distribuicao/:area`
- **+** `PUT /regras-distribuicao/:area/participantes/:usuarioId`
- **+** `DELETE /regras-distribuicao/:area/participantes/:usuarioId`
- **+** `GET /funis`
- **+** `POST /funis`
- **+** `GET /funis/:id`
- **+** `PATCH /funis/:id`
- **+** `DELETE /funis/:id`
- **+** `POST /funis/:id/etapas`
- **+** `POST /funis/:id/etapas/reordenar`
- **+** `PATCH /funis/:id/etapas/:etapaId`
- **+** `DELETE /funis/:id/etapas/:etapaId`
- **+** `GET /funis/:id/quadro`
- **+** `GET /funis/:id/metricas`
- **+** `GET /negocios`
- **+** `POST /negocios`
- **+** `GET /negocios/:id`
- **+** `PATCH /negocios/:id`
- **+** `DELETE /negocios/:id`
- **+** `POST /negocios/:id/mover`
- **+** `POST /negocios/:id/reabrir`
- **+** `POST /negocios/:id/assumir`
- **+** `GET /negocios/:id/movimentacoes`
- **+** `GET /negocios/:id/linha-do-tempo`
- **+** `GET /passagens`
- **+** `POST /passagens`
- **+** `GET /passagens/:id`
- **+** `PATCH /passagens/:id`
- **+** `DELETE /passagens/:id`
- **+** `GET /notificacoes`
- **+** `GET /notificacoes/nao-lidas/contagem`
- **+** `POST /notificacoes/marcar-todas-lidas`
- **+** `POST /notificacoes/:id/marcar-lida`
- **+** `GET /usuarios/:id/desligamento/previa`
- **+** `POST /usuarios/:id/desligar`
- **+** `POST /usuarios/:id/reativar`
- **+** `GET /usuarios`
- **+** `GET /usuarios/equipes`
- **+** `GET /usuarios/:id`
- **+** `POST /usuarios`
- **+** `PATCH /usuarios/:id`
- **+** `POST /usuarios/:id/senha-temporaria`
- **+** `POST /usuarios/:id/convite`
- **+** `GET /webhooks/entradas/modelos`
- **+** `POST /webhooks/entradas/previa`
- **+** `GET /webhooks/entradas`
- **+** `POST /webhooks/entradas`
- **+** `GET /webhooks/entradas/:id`
- **+** `PATCH /webhooks/entradas/:id`
- **+** `DELETE /webhooks/entradas/:id`
- **+** `POST /webhooks/entradas/:id/regenerar-token`
- **+** `POST /webhooks/entradas/:id/segredo`
- **+** `DELETE /webhooks/entradas/:id/segredo`
- **+** `POST /webhooks/entradas/:id/previa`
- **+** `GET /webhooks/entradas/:id/recebimentos`
- **+** `GET /webhooks/entradas/:id/recebimentos/:recebimentoId`
- **+** `POST /webhooks/entradas/:id/recebimentos/:recebimentoId/reprocessar`
- **+** `POST /webhooks/entrada/:token`
- **+** `GET /webhooks/saidas/eventos`
- **+** `GET /webhooks/saidas`
- **+** `POST /webhooks/saidas`
- **+** `GET /webhooks/saidas/:id`
- **+** `PATCH /webhooks/saidas/:id`
- **+** `DELETE /webhooks/saidas/:id`
- **+** `POST /webhooks/saidas/:id/regenerar-segredo`
- **+** `POST /webhooks/saidas/:id/testar`
- **+** `GET /webhooks/saidas/:id/entregas`
- **+** `GET /webhooks/saidas/:id/entregas/:entregaId`
- **+** `POST /webhooks/saidas/:id/entregas/:entregaId/reenviar`


**Testes**

- **+** `src/atividades/dto/transformacoes.spec.ts`
- **+** `src/atividades/fuso-horario.spec.ts`
- **+** `src/atividades/lembretes-atividades.spec.ts`
- **+** `src/atividades/regras-atividades.spec.ts`
- **+** `src/auditoria/consulta/alteracoes.spec.ts`
- **+** `src/auditoria/consulta/auditoria-consulta.dto.spec.ts`
- **+** `src/auditoria/consulta/consulta-comum.spec.ts`
- **+** `src/comum/contexto/contexto-requisicao.spec.ts`
- **+** `src/comum/criptografia/criptografia.service.spec.ts`
- **+** `src/comum/dados/sanitizar.spec.ts`
- **+** `src/comum/dominio/normalizacoes.spec.ts`
- **+** `src/comum/dominio/papeis.spec.ts`
- **+** `src/comum/erros/filtro-de-erros.spec.ts`
- **+** `src/comum/validacao/validacao.spec.ts`
- **+** `src/contatos/contatos.service.spec.ts`
- **+** `src/contatos/deduplicacao.spec.ts`
- **+** `src/documentacao.spec.ts`
- **+** `src/funis/acesso-funis.spec.ts`
- **+** `src/funis/metricas-calculo.spec.ts`
- **+** `src/funis/negocio-completo.spec.ts`
- **+** `src/funis/posicao.spec.ts`
- **+** `src/funis/rodizio.spec.ts`
- **+** `src/usuarios/dominio/destinatario.spec.ts`
- **+** `src/usuarios/dominio/encaminhamento.spec.ts`
- **+** `src/usuarios/dominio/hierarquia.spec.ts`
- **+** `src/usuarios/dominio/visibilidade.spec.ts`
- **+** `src/usuarios/repeticao.spec.ts`
- **+** `src/webhooks/entrada/mapeamento.spec.ts`
- **+** `src/webhooks/saida/envelope.spec.ts`
- **+** `src/webhooks/saida/envio-http.spec.ts`
- **+** `src/webhooks/saida/protecao-ssrf.spec.ts`
- **+** `test/atividades-lembretes.e2e-spec.ts`
- **+** `test/atividades.e2e-spec.ts`
- **+** `test/auditoria-administracao.e2e-spec.ts`
- **+** `test/auditoria-consulta.e2e-spec.ts`
- **+** `test/base-auth.e2e-spec.ts`
- **+** `test/base-infraestrutura.e2e-spec.ts`
- **+** `test/contatos-empresas.e2e-spec.ts`
- **+** `test/contatos-linha-do-tempo.e2e-spec.ts`
- **+** `test/contatos.e2e-spec.ts`
- **+** `test/funis-configuracao.e2e-spec.ts`
- **+** `test/funis-distribuicao.e2e-spec.ts`
- **+** `test/funis-metricas.e2e-spec.ts`
- **+** `test/funis-negocios.e2e-spec.ts`
- **+** `test/funis-passagens.e2e-spec.ts`
- **+** `test/integracao.e2e-spec.ts`
- **+** `test/usuarios-desligamento.e2e-spec.ts`
- **+** `test/usuarios.e2e-spec.ts`
- **+** `test/webhooks-entrada.e2e-spec.ts`
- **+** `test/webhooks-saida-ssrf.e2e-spec.ts`
- **+** `test/webhooks-saida.e2e-spec.ts`


**Variaveis de ambiente**

- **+** `DATABASE_URL_TESTE`
- **−** `CORS_ORIGENS`
- **−** `NODE_ENV`
- **−** `OBSERVE_APP_KEY`
- **−** `OBSERVE_APP_SECRET`
- **−** `PORT`


**Dependencias**

- **+** `@nestjs/swagger ^12.0.2`
- **+** `class-transformer ^0.5.1`
- **+** `class-validator ^0.15.1`
- **+** `nodemailer ^10.1.7`
- **+** `pg-boss 12.35.1`


**Scripts npm**

- **+** `format:verificar prettier --check "src/**/*.ts" "test/**/*.ts"`


### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 38 | 269 | +231 |
| Linhas | 1433 | 54010 | +52577 |


---

## 2026-10-20 — 2 commits

**O que foi feito:** Base da API: Prisma 7.10.1 com @prisma/adapter-pg e PostgreSQL 17, migration inicial (usuários com papéis e liderança), configuração validada por variável de ambiente sem bibliotecas, endpoint GET /api/saude (200/503), prefixo /api, trust proxy, CORS opcional, @nestjs/observe só com as duas chaves, Dockerfile multi-stage, docker-entrypoint com migrate deploy e docker-compose completo (banco, api e web). Scaffold Hello World removido.

### Commits

| Commit | Data | Autor | Mensagem |
| --- | --- | --- | --- |
| `8ea7e65` | 2026-10-20 | luishdsg | Merge pull request #1 from GitBRL/dev |
| `951c255` | 2026-10-20 | luis | update |


### Arquivos alterados (11 · +1577 / -0)

- `tools/doc-updater/gerar.mjs` (+376 / -0)
- `tools/doc-updater/escanear.mjs` (+297 / -0)
- `tools/doc-updater/index.mjs` (+226 / -0)
- `docs/ARQUITETURA.md` (+198 / -0)
- `docs/.estado-docs.json` (+118 / -0)
- `tools/doc-updater/comparar.mjs` (+110 / -0)
- `tools/doc-updater/README.md` (+97 / -0)
- `docs/HISTORICO.md` (+71 / -0)
- `.claude/commands/atualizar-docs.md` (+67 / -0)
- `README.md` (+16 / -0)
- `package.json` (+1 / -0)


### Impacto na arquitetura

**Modulos**

- **+** `AmbienteModule`
- **+** `PrismaModule`
- **+** `SaudeModule`


**Controllers**

- **+** `SaudeController`
- **−** `AppController`


**Servicos**

- **+** `PrismaService`
- **+** `SaudeService`
- **−** `AppService`


**Endpoints HTTP**

- **+** `GET /saude`
- **−** `GET /`


**Testes**

- **+** `src/config/ambiente.spec.ts`
- **+** `src/observabilidade.spec.ts`
- **+** `src/saude/falha-do-banco.spec.ts`
- **+** `src/saude/saude.service.spec.ts`
- **+** `test/saude.e2e-spec.ts`
- **−** `src/app.controller.spec.ts`
- **−** `test/app.e2e-spec.ts`


**Variaveis de ambiente**

- **+** `CORS_ORIGENS`
- **+** `DATABASE_URL`
- **+** `NODE_ENV`
- **+** `OBSERVE_APP_KEY`
- **+** `OBSERVE_APP_SECRET`


**Dependencias**

- **+** `@prisma/adapter-pg 7.10.1`
- **+** `@prisma/client 7.10.1`
- **+** `pg ^8.23.1`
- **+** `prisma 7.10.1`


**Scripts npm**

- **+** `prisma:gerar prisma generate`
- **+** `prisma:migrar prisma migrate dev`
- **+** `postprisma:migrar prisma generate`
- **+** `prisma:aplicar prisma migrate deploy`
- **+** `prelint prisma generate`
- **+** `pretest prisma generate`
- **+** `pretest:e2e prisma generate`
- **~** `build: nest build -> prisma generate && nest build`


### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 18 | 38 | +20 |
| Linhas | 139 | 1433 | +1294 |


---

## 2026-10-20 — sem commits novos

**O que foi feito:** Script 'docs' adicionado ao package.json para rodar a atualizacao da documentacao.

### Impacto na arquitetura

**Scripts npm**

- **+** `docs node tools/doc-updater/index.mjs`


### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 18 | 18 | 0 |
| Linhas | 139 | 139 | 0 |


---

## 2026-10-20 — sem commits novos

**O que foi feito:** Ferramenta de documentacao e comando /atualizar-docs movidos para dentro do repositorio (tools/doc-updater e .claude/commands).

### Impacto na arquitetura

Nenhuma mudanca estrutural detectada desde a ultima atualizacao.

### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 18 | 18 | 0 |
| Linhas | 139 | 139 | 0 |


---

## 2026-10-20 — crmbrl-api (1 commit)

**O que foi feito:** Documentacao inicial: scaffolds do front-end Angular 22 e da API NestJS 12.

### Commits

| Commit | Data | Autor | Mensagem |
| --- | --- | --- | --- |
| `b28fd4c` | 2026-10-20 | luis | update |


### Impacto na arquitetura

Primeira execucao da ferramenta: inventario inicial registrado.

### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 0 | 18 | +18 |
| Linhas | 0 | 139 | +139 |


---

