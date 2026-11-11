# crmbrl-api — guia rápido

NestJS 12, Prisma 7 com adapter-pg (PostgreSQL 17), pg-boss (filas, agendamentos e relay da outbox),
Socket.IO (`/api/socket.io`, namespace `/tempo-real`), gateway de WhatsApp próprio (Baileys) como segundo
processo (`node dist/whatsapp/main.js`). Gerenciador: Bun; execução: Node 24.

## Comandos
O Bun não está instalado na máquina: rode os scripts com `npm run` (usa o `node_modules` já instalado).
Dependências e `bun.lock` só pelo Bun no Docker — nunca gere `package-lock.json`:
`docker run --rm -v /sistemas/crm-brl/crmbrl-api:/app -w /app oven/bun:1 bun add <pacote>` (depois confira o dono
dos arquivos com `ls -l bun.lock node_modules | head -3` e corrija com `docker run … chown -R 1000:1000` se preciso).
```bash
npm run build                 # prisma generate + nest build (gera dist/main.js e dist/whatsapp/main.js)
npm run lint                  # oxlint --type-aware
npm run format:verificar      # Prettier (npm run format corrige)
npm test -- -w 2 2>&1 | tail -n 30                  # unidade (no máximo 2 workers)
DATABASE_URL_TESTE=postgresql://crmbrl:crmbrl@localhost:<porta>/crmbrl npm run test:e2e -- <arquivo>   # integração (1 worker, o padrão; nunca -w: os workers disputam o mesmo banco)
# suíte e2e completa: rode em lotes de ~8 arquivos (num só processo estoura o heap de 4 GB do Node)
```
Banco de teste descartável (os testes APAGAM tudo):
`docker run -d --name crmbrl-teste-<rotulo> -e POSTGRES_USER=crmbrl -e POSTGRES_PASSWORD=crmbrl -e POSTGRES_DB=crmbrl -p 127.0.0.1:<porta>:5432 postgres:17-alpine`.
Ao terminar: `docker rm -f -v crmbrl-teste-<rotulo>` (com `-v`, senão o volume anônimo, ~500 mil arquivos, fica para trás).
Rode a suíte e2e completa só na verificação final; durante o trabalho, rode só os arquivos afetados.

## Mapa
- `src/<modulo>/` — um módulo Nest por domínio (auth, usuarios, contatos, funis, atividades, auditoria,
  webhooks, atendimento, canais, whatsapp, chat-interno, arquivos, tempo-real, notificacoes, fila, eventos…).
- `src/comum/` — peças compartilhadas; `src/config/` — variáveis de ambiente validadas; `prisma/` — schema e migrations.
- `test/*.e2e-spec.ts` — integração contra a API inteira; utilitários em `test/utils/index.ts`
  (fábricas, clientes autenticados, `drenar` da fila, e-mail falso, tempo real, gateway falso).

## Convenções
- Rotas em `/api/v1`; erros sempre `{statusCode, erro, mensagem, detalhes?, requisicaoId}` em português,
  sem código de regra na mensagem (o código vai em `detalhes.regra`).
- Sessão por cookie httpOnly `crmbrl_sessao`; checagem de origem (CSRF) por `ORIGENS_PERMITIDAS`.
- Toda ação de usuário, automação ou sistema passa pelos serviços de domínio e é auditada (auditoria
  imutável por gatilho no banco). Eventos de domínio vão para a outbox e saem pelo pg-boss.
- Segredos de integração cifrados (AES-256-GCM, `CHAVE_CRIPTOGRAFIA`) e nunca devolvidos inteiros.
- Regras de negócio numeradas (R1…): cada teste cita a regra que cobre (`R7.2 — …`); cenários de aceitação
  com título `cenário N`.

## Documentos (leia por seção)
- `docs/REGRAS-DE-NEGOCIO.md` — §1–13 Fase 1; §14 Arquivos (R11), §15 Atendimento (R12), §16 WhatsApp (R13),
  §17 Canais (R14), §18 Chat interno (R15), §19 Tempo real, §20 Cenários da Onda A.
- `docs/ARQUITETURA.md` — "Contexto" (l. 3), "Inventario tecnico" (l. ~782), "Decisoes de arquitetura" (l. ~1126).
  Use `grep -n '^### '` para achar o módulo.
- `docs/ROADMAP.md`, `README.md` (variáveis de ambiente).
