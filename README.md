# crmbrl-api

API HTTP do **BRL CRM** — a única fonte de regra de negócio do produto, que
atende Marketing, Comercial e Customer Success. Atende o front
[`crmbrl`](../crmbrl) (Angular), que vive em outro repositório e fala com a API
só por HTTP.

- **NestJS 12** sobre Express, **Node 24** como runtime e **Bun** como
  gerenciador de pacotes.
- **PostgreSQL 17** com **Prisma 7** (driver `pg` via `@prisma/adapter-pg`);
  fila e agendamentos com **pg-boss** no mesmo banco (schema `pgboss`).
- Rotas de negócio em `/api/v1/*`; a saúde fica em `/api/saude`, sem versão.
  Documentação OpenAPI em `/api/docs` (aberta em desenvolvimento, só Admin em
  produção).

A Fase 1 (núcleo do CRM) está implementada na API: login com sessões no banco
(cookie `crmbrl_sessao`), proteção CSRF por origem, bloqueio por força bruta,
troca, convite e redefinição de senha; usuários, papéis e lideranças com
**desligamento e encaminhamento**; contatos e empresas com deduplicação,
origem/UTM e LGPD; funis em kanban com **passagens automáticas** Marketing →
Comercial → CS e rodízio; atividades com lembretes; **auditoria** imutável e
logs técnicos consultáveis; **webhooks de entrada** (captação, com o modelo do
Disparos BRL) e **de saída** (eventos assinados, com retentativas); notificações
internas e a configuração inicial (funis-base, etapas, passagens, rodízios e o
Admin do primeiro acesso). As regras estão em
[docs/REGRAS-DE-NEGOCIO.md](docs/REGRAS-DE-NEGOCIO.md) e o desenho, com a
tabela de endpoints, em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Subir tudo com Docker

O `docker-compose.yml` desta pasta sobe o sistema inteiro: banco, API e front (o
front é construído a partir de `../crmbrl`).

```bash
docker compose up -d --build
```

Sem o plugin `docker compose` na máquina, use a imagem oficial do Docker CLI —
mesmos argumentos no fim:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v /sistemas/crm-brl:/sistemas/crm-brl -w /sistemas/crm-brl/crmbrl-api \
  docker:cli docker compose up -d --build
```

| Serviço | Endereço                  | O que é                                                    |
| ------- | ------------------------- | ---------------------------------------------------------- |
| `web`   | http://localhost:8080     | Front (Caddy), que encaminha `/api/*` à API — use por aqui |
| `api`   | http://127.0.0.1:3000/api | Esta API, publicada só na própria máquina                  |
| `banco` | `127.0.0.1:5434`          | PostgreSQL 17 (usuário, senha e banco: `crmbrl`)           |

A ordem de subida é garantida pelos healthchecks: o banco fica saudável
(`pg_isready`), a API aplica as migrations pendentes (`prisma migrate deploy`) e
sobe, e o front só sobe depois que `GET /api/saude` responde 200.

```bash
docker compose ps              # estado e saúde de cada serviço
docker compose logs -f api     # logs da API
docker compose down            # desliga (os dados ficam no volume banco-dados)
docker compose down -v         # desliga e apaga os dados do banco
```

Portas, credenciais do banco e a pasta do front mudam por variável, no ambiente
ou num `.env` nesta pasta: `BANCO_PORTA`, `API_PORTA`, `WEB_PORTA`,
`BANCO_USUARIO`, `BANCO_SENHA`, `BANCO_NOME` e `FRONT_DIR` (veja o
[`.env.example`](.env.example)). As variáveis da API (abaixo) também vêm desse
`.env`, com padrões para uso local em http: `URL_PUBLICA` e
`ORIGENS_PERMITIDAS` em `http://localhost:8080`, `COOKIE_SEGURO=false` e uma
chave de criptografia pública de desenvolvimento (a API avisa no log).

## Entrar no ambiente local

1. Crie o `.env` desta pasta (fica fora do git) a partir do exemplo e defina, no
   mínimo, a chave de criptografia e o Admin do primeiro acesso:

   ```bash
   cp .env.example .env
   # no .env:
   #   CHAVE_CRIPTOGRAFIA=<saída de: openssl rand -base64 32>
   #   ADMIN_EMAIL=admin@brl.local
   #   ADMIN_NOME=Administrador
   #   ADMIN_SENHA_INICIAL=<uma senha forte, de 8 a 128 caracteres>
   ```

2. Suba (ou atualize) o sistema: `docker compose up -d --build` — ou só a API,
   sem mexer no front: `docker compose up -d --build api`. Os dados ficam no
   volume `banco-dados`; o rebuild aplica as migrations novas e não apaga nada.
3. Abra http://localhost:8080 e entre com o `ADMIN_EMAIL` e a
   `ADMIN_SENHA_INICIAL` do `.env`. O primeiro login exige trocar a senha
   (R2.7): até lá só funcionam `auth/eu`, `auth/senha` e `auth/sair`.
4. Como Admin, crie os usuários (C-level, líderes e membros, cada um com o seu
   líder — R1.2). Sem SMTP configurado, defina uma senha temporária para cada um.

O Admin só é criado quando o banco **não tem nenhum usuário** (R2.6): a
`ADMIN_SENHA_INICIAL` vale só nessa primeira criação — mudá-la depois não muda a
senha. Sem ela, a API gera uma senha e a mostra uma única vez no log
(`docker compose logs api | grep "Senha inicial"`). Trocar a
`CHAVE_CRIPTOGRAFIA` depois invalida os segredos de webhook já gravados.

Pela linha de comando, o login passa pelo Caddy como o navegador (requisições
que alteram dados precisam do `Origin` permitido, R2.9):

```bash
curl -i -c /tmp/sessao.txt -H 'Origin: http://localhost:8080' \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@brl.local","senha":"<senha>"}' \
  http://localhost:8080/api/v1/auth/entrar
curl -b /tmp/sessao.txt http://localhost:8080/api/v1/auth/eu
```

A documentação OpenAPI fica em http://localhost:8080/api/docs — no compose
(`NODE_ENV=production`), só para o Admin logado.

## Desenvolvimento (só a API)

```bash
bun install                    # dependências
cp .env.example .env           # variáveis de desenvolvimento
docker compose up -d banco     # só o PostgreSQL, em 127.0.0.1:5434
bun run prisma:gerar           # gera o Prisma Client em src/generated/prisma
bun run prisma:aplicar         # aplica as migrations no banco local
bun run start:dev              # API em http://localhost:3000/api, com recarga
```

Confira com `curl http://localhost:3000/api/saude` e abra a documentação em
http://localhost:3000/api/docs. O front em desenvolvimento (`ng serve`)
encaminha `/api` para `localhost:3000`, então não precisa de CORS; a origem
dele (`http://localhost:4200`) já está em `ORIGENS_PERMITIDAS` no
`.env.example`. Requisições que alteram dados precisam do cabeçalho `Origin`
de uma origem permitida (o navegador manda sozinho; no `curl`, use
`-H 'Origin: http://localhost:4200'`).

Sem Bun na máquina, instale as dependências pela imagem oficial (no Debian, para
os binários servirem no host) e rode os scripts com `npm run`, que lê o mesmo
`package.json` (com npm, flags vão depois de `--`):

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app oven/bun:1 bun install
npm run start:dev
```

A API sobe mesmo com o banco fora do ar: o log avisa e `GET /api/saude` responde
503 até o banco voltar.

## Variáveis de ambiente

Lidas e validadas em `src/config/ambiente.ts`. Se algo estiver errado, a API não
sobe e diz o que corrigir (sem repetir valores secretos). Em desenvolvimento elas
vêm do `.env` (carregado com `process.loadEnvFile()` quando o arquivo existe); o
que já estiver definido no ambiente tem prioridade. Variável vazia vale como não
definida.

| Variável                                                                                 | Padrão                                   | Para que serve                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                           | — (obrigatória)                          | Conexão com o PostgreSQL. Lida também pelo CLI do Prisma (`prisma.config.ts`) e pelo pg-boss.                                                                |
| `PORT`                                                                                   | `3000`                                   | Porta HTTP.                                                                                                                                                  |
| `NODE_ENV`                                                                               | `development`                            | Ambiente; aparece em `GET /api/saude`. A imagem Docker usa `production`, que torna obrigatórias `URL_PUBLICA` e `CHAVE_CRIPTOGRAFIA`.                        |
| `CORS_ORIGENS`                                                                           | vazio                                    | Origens liberadas no CORS (com credenciais), separadas por vírgula. Vazio: CORS desligado.                                                                   |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`                                                  | vazias                                   | Chaves do `@nestjs/observe`. Ele só liga com as duas.                                                                                                        |
| `URL_PUBLICA`                                                                            | `http://localhost:4200` fora de produção | Endereço do CRM: base dos links de convite/redefinição e dos endereços de webhook.                                                                           |
| `ORIGENS_PERMITIDAS`                                                                     | a origem da `URL_PUBLICA`                | Origens aceitas em `POST`/`PUT`/`PATCH`/`DELETE` (CSRF, R2.9), pelo `Origin` ou `Referer`.                                                                   |
| `COOKIE_SEGURO`                                                                          | `true` em produção                       | Atributo `Secure` do cookie `crmbrl_sessao` (só HTTPS).                                                                                                      |
| `CHAVE_CRIPTOGRAFIA`                                                                     | chave de desenvolvimento (com aviso)     | 32 bytes em base64 ou hex; cifra os segredos dos webhooks (AES-256-GCM, R10.3). Obrigatória em produção: `openssl rand -base64 32`.                          |
| `SESSAO_INATIVIDADE_DIAS`                                                                | `7`                                      | A sessão expira depois de tantos dias sem uso (R2.2).                                                                                                        |
| `SESSAO_DURACAO_MAXIMA_DIAS`                                                             | `30`                                     | …e, em qualquer caso, tantos dias depois do login.                                                                                                           |
| `SESSAO_RENOVACAO_MINUTOS`                                                               | `5`                                      | Intervalo mínimo entre duas gravações da renovação.                                                                                                          |
| `ADMIN_EMAIL`, `ADMIN_NOME`                                                              | vazio, `Administrador`                   | Admin criado quando não há nenhum usuário (R2.6), com troca de senha obrigatória.                                                                            |
| `ADMIN_SENHA_INICIAL`                                                                    | vazia                                    | Senha inicial desse Admin (8 a 128 caracteres). Vazia: a API gera uma e a mostra uma vez no log.                                                             |
| `SMTP_HOST`, `SMTP_PORTA`, `SMTP_SEGURO`, `SMTP_USUARIO`, `SMTP_SENHA`, `SMTP_REMETENTE` | vazias, `587`                            | Envio de e-mail (nodemailer). Sem `SMTP_HOST`, convite e "esqueci minha senha" ficam indisponíveis (R2.8). `SMTP_SEGURO` vazio = TLS direto só na porta 465. |
| `WEBHOOKS_PERMITIR_REDE_INTERNA`                                                         | `false`                                  | Webhooks de saída podem chamar rede interna/localhost (R9.1).                                                                                                |
| `DOCS_PUBLICAS`                                                                          | `true` fora de produção                  | `/api/docs` e `/api/docs-json` abertos; com `false`, só o Admin logado.                                                                                      |
| `PROCESSAR_FILAS`                                                                        | `true`                                   | Trabalhadores da fila, agendamentos e despachante de eventos. `false` para réplicas só HTTP (e nos testes).                                                  |
| `LOG_FORMATO`                                                                            | `json` em produção, `texto` fora         | Formato do log do console (logger nativo do Nest).                                                                                                           |
| `MIGRAR_AO_INICIAR`                                                                      | `true`                                   | Só no container: `false` pula o `prisma migrate deploy` ao subir.                                                                                            |
| `DATABASE_URL_TESTE`                                                                     | —                                        | Só nos testes de integração: o banco descartável que eles apagam.                                                                                            |

## Banco e migrations

O schema fica em [`prisma/schema.prisma`](prisma/schema.prisma) e as migrations
em `prisma/migrations/`. Convenção: modelos em PascalCase, no singular e em
português; tabelas e colunas em snake_case, tabelas no plural (`@@map`/`@map`);
datas em `timestamptz`.

```bash
bun run prisma:migrar --name <o-que-mudou>   # cria a migration a partir do schema e aplica no banco local
bun run prisma:aplicar                       # aplica as pendentes (o container faz isso sozinho ao subir)
bun run prisma:gerar                         # regera o Prisma Client
```

> **Nunca edite uma migration já aplicada** — em nenhum ambiente. Nos bancos em
> que ela já rodou, a versão editada nunca é aplicada (os ambientes divergem sem
> aviso), e o `migrate dev` compara o checksum guardado em `_prisma_migrations`,
> acusa a mudança e propõe apagar o banco local. Mudou de ideia? Altere o schema
> e gere outra migration.

O que o Prisma não gera fica escrito à mão no fim da migration
`fase1_nucleo` (e o `migrate dev` não propõe removê-lo): os CHECKs de valores e
de normalização e os gatilhos — a auditoria recusa `UPDATE`, `DELETE` e
`TRUNCATE` (R3.3) e a primeira origem do contato é imutável (R4.3). Os índices
únicos parciais (deduplicação de contatos, CNPJ, um funil-base por área, uma
etapa de ganho e uma de perda por funil) ficam no próprio schema, com o preview
`partialIndexes`.

> Esses índices parciais aparecem no `findUnique` do Prisma Client (ex.:
> `contato.findUnique({ where: { email } })`), mas **não** garantem um único
> registro: excluídos podem repetir o valor. Use `findFirst` com
> `excluidoEm: null`.

O Prisma Client é gerado em `src/generated/prisma/`, fora do git. Gere depois de
clonar o repositório ou de mudar o schema. `build`, `test`, `test:e2e` e `lint`
já geram antes de rodar, e `prisma:migrar` gera depois (no Prisma 7 o
`migrate dev` não faz isso sozinho).

## Testes e lint

```bash
bun run test        # unitários (src/**/*.spec.ts), sem banco
bun run test:e2e    # integração (test/*.e2e-spec.ts) contra um PostgreSQL de teste
bun run test:cov    # cobertura
bun run lint        # oxlint --type-aware
bun run format      # prettier
```

Os testes de integração sobem a API inteira contra o banco de
`DATABASE_URL_TESTE` — **um PostgreSQL descartável**: eles aplicam as
migrations e apagam todos os dados a cada teste. A URL do banco do compose
(porta 5434) é recusada.

```bash
docker run -d --name crmbrl-teste -e POSTGRES_USER=crmbrl -e POSTGRES_PASSWORD=crmbrl \
  -e POSTGRES_DB=crmbrl -p 127.0.0.1:55432:5432 postgres:17-alpine
DATABASE_URL_TESTE=postgresql://crmbrl:crmbrl@localhost:55432/crmbrl bun run test:e2e
docker rm -f crmbrl-teste
```

Os utilitários ficam em `test/utils` (`criarAppTeste`, `limparBanco`,
fábricas, `entrarComo`, drenagem de eventos e filas); veja o exemplo no topo de
`test/utils/index.ts`. Cada teste cita a regra que cobre (`R7.2 — …`); os 15
cenários de aceitação da seção 13 das regras levam "cenário N" no nome
(`--testNamePattern "[Cc]enário"` roda só eles), e `test/integracao.e2e-spec.ts`
percorre a jornada inteira de um lead, do webhook ao CS. A suíte completa (21
arquivos) leva cerca de 2 minutos, em série num banco só.

## Saúde da API

`GET /api/saude` responde **200** quando a API e o banco respondem e **503**, com
o mesmo corpo e `status: "degradado"`, quando o banco falha. É o que o
healthcheck do Docker usa.

```json
{
  "status": "ok",
  "versao": "0.0.1",
  "ambiente": "production",
  "horario": "2026-10-20T18:00:00.000Z",
  "uptimeSegundos": 42,
  "banco": { "status": "ok", "latenciaMs": 3 },
  "migrations": { "aplicadas": 2, "ultima": "20261020224552_fase1_nucleo" }
}
```

O contrato completo está em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Documentação

- [Regras de negócio](docs/REGRAS-DE-NEGOCIO.md) — as regras (R…) que a API aplica
- [Roadmap](docs/ROADMAP.md) — fases e tecnologias aprovadas
- [Arquitetura](docs/ARQUITETURA.md) — contexto, endpoints, inventário e decisões
- [Histórico](docs/HISTORICO.md) — o que foi feito, execução por execução
- `/api/docs` — a documentação OpenAPI de cada endpoint, gerada do código

Para atualizar depois de mexer no código:

```bash
bun run docs --nota "o que foi feito"
```

Sem a nota (`bun run docs`) o histórico se vira sozinho com os commits novos.

Pelo Claude Code: `/atualizar-docs <o que foi feito>`. Detalhes em
[`tools/doc-updater/README.md`](tools/doc-updater/README.md).
