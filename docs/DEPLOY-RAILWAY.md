# Deploy no Railway

Alternativa ao servidor próprio (`DEPLOY.md`): as mesmas imagens (o `Dockerfile` de cada repositório)
rodando como serviços do [Railway](https://railway.com). O Railway cuida do HTTPS, do domínio, dos volumes e
dos backups do banco; o `docker-compose*.yml`, o Caddy de borda (`deploy/Caddyfile.producao`) e o serviço
`backup` não são usados aqui. Escrito em novembro de 2026: nomes de menus do Railway podem mudar.

## 1. Antes de começar

- **Plano Pro.** No plano Hobby o Railway bloqueia o SMTP de saída (portas 25, 465, 587 e 2525): convites,
  "esqueci minha senha" e o canal de e-mail deixam de funcionar.
- **Código no branch publicado.** O Railway constrói a partir do GitHub. A API só compila com a pasta
  `src/logs/` versionada (PR #4, `fase-1` → `dev`, e depois `dev` → `main`): publique o `main` só depois
  desses merges.
- **Região.** Escolha a mais próxima do Brasil entre as oferecidas (até aqui, `US East`). Com os dados fora
  do Brasil, cite a transferência internacional na política de privacidade (LGPD).
- **Domínio** (ex.: `crm.suaempresa.com.br`) com acesso ao DNS, e um servidor SMTP.

## 2. Serviços

Crie um projeto e, dentro dele, os serviços abaixo **com estes nomes**: a rede privada do Railway os
encontra por `<nome>.railway.internal`.

| Serviço    | Origem                                                                                      | Volume                       | Público           |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------------------- | ----------------- |
| `Postgres` | modelo PostgreSQL do Railway, com a imagem `ghcr.io/railwayapp-templates/postgres-ssl:17`   | o do modelo                  | não               |
| `arquivos` | imagem Docker `bitnamilegacy/minio:2025.7.23-debian-12-r5` (a mesma do compose)             | `/bitnami/minio/data`        | não               |
| `api`      | repositório `crmbrl-api` (usa o `Dockerfile`)                                               | —                            | não               |
| `whatsapp` | repositório `crmbrl-api` de novo, com o comando de início da seção 4                        | `/app/trava`, 1 GB (seção 4) | não               |
| `transcricao` | repositório `crmbrl-api` com `Dockerfile.transcricao` (a imagem do whisper.cpp do compose; opcional) | `/modelos`, 2 GB | não |
| `web`      | repositório `crmbrl` (usa o `Dockerfile`)                                                   | —                            | **sim** (domínio) |

Só o `web` recebe domínio: ele serve o front e repassa `/api` para a `api` pela rede privada, como no
compose. Confira a versão do `Postgres` (17, a do projeto) em Settings > Source.

## 3. Variáveis

Gere os segredos com `openssl rand -base64 32` e nunca os coloque em chat, ticket ou repositório. A lista
completa de variáveis está no `README.md` ("Variáveis de ambiente").

**Compartilhadas** (Project Settings > Shared Variables), usadas pela `api` e pelo `whatsapp`:

```bash
URL_PUBLICA=https://crm.suaempresa.com.br
ORIGENS_PERMITIDAS=https://crm.suaempresa.com.br      # a mesma origem da URL_PUBLICA
CHAVE_CRIPTOGRAFIA=<openssl rand -base64 32>          # cifra os segredos gravados no banco: guarde uma cópia segura
ARQUIVOS_DRIVER=s3
ARQUIVOS_ENDPOINT=http://arquivos.railway.internal:9000
ARQUIVOS_REGIAO=us-east-1
ARQUIVOS_BUCKET=crmbrl                                # a API cria o bucket na primeira subida
ARQUIVOS_CHAVE=<usuário do MinIO>
ARQUIVOS_SEGREDO=<senha do MinIO, 12+ caracteres>
WHATSAPP_URL_INTERNA=http://whatsapp.railway.internal:3100
WHATSAPP_PORTA=3100
WHATSAPP_TOKEN_INTERNO=<openssl rand -base64 32>      # API <-> gateway, 32+ caracteres
WHATSAPP_SIMULADO=false
LOG_FORMATO=json
```

**De cada serviço** (aba Variables):

```bash
# --- api ---
DATABASE_URL=${{Postgres.DATABASE_URL}}               # endereço privado do banco
PORT=3000
COOKIE_SEGURO=true
DOCS_PUBLICAS=false
ADMIN_EMAIL=voce@suaempresa.com.br                    # primeiro Admin
ADMIN_SENHA_INICIAL=                                  # vazia: a API gera e mostra uma vez no log do deploy
SMTP_HOST=smtp.suaempresa.com.br
SMTP_PORTA=587
SMTP_USUARIO=...
SMTP_SENHA=...
SMTP_REMETENTE=BRL CRM <crm@suaempresa.com.br>
# transcrição das ligações (R30, opcional; sem TRANSCRICAO_URL a gravação continua, sem texto):
TRANSCRICAO_URL=http://transcricao.railway.internal:8080
WHISPER_MODELO=small
# ligações (R29/R30), opcionais: LIGACOES_STUN_URLS, LIGACOES_ESPERA_PRE_ACEITE_MS, TRANSCRICAO_TEMPO_LIMITE_S,
#            LIGACOES_GRAVACAO_MAX_MB, LIGACOES_GRAVACAO_MAX_MIN
# opcionais: ANTHROPIC_API_KEY (assistente, BI, resumo das ligações e SDR com IA; sem ela o SDR fica indisponível), LIGACOES_RESUMO_MODELO, TICKETHUB_URL, TICKETHUB_EMAIL, TICKETHUB_SENHA,
#            VAPID_CHAVE_PUBLICA, VAPID_CHAVE_PRIVADA, VAPID_ASSUNTO
# integrações (Onda H, R32), opcionais e só para apontar para APIs de teste; em produção deixe sem definir:
#            TYPEFORM_API_URL (padrão https://api.typeform.com), TYPEFORM_DIALOGO_URL (padrão https://api.typeform.com),
#            RD_STATION_API_URL (padrão https://api.rd.services), RD_STATION_DIALOGO_URL (padrão https://api.rd.services),
#            MANYCHAT_API_URL (padrão https://api.manychat.com),
#            META_DIALOGO_URL (padrão https://www.facebook.com, diálogo de login do Facebook Lead Ads)

# --- whatsapp ---
DATABASE_URL=${{Postgres.DATABASE_URL}}
PORT=3100                                             # a porta que o healthcheck do Railway consulta

# --- transcricao (opcional) ---
WHISPER_MODELO=small                                  # o mesmo valor da api
WHISPER_THREADS=4

# --- web ---
PORT=8080
API_UPSTREAM=api.railway.internal:3000

# --- arquivos ---
MINIO_ROOT_USER=${{shared.ARQUIVOS_CHAVE}}
MINIO_ROOT_PASSWORD=${{shared.ARQUIVOS_SEGREDO}}
MINIO_BROWSER=off
MINIO_SKIP_CLIENT=yes
RAILWAY_RUN_UID=0                                     # a imagem roda sem root e o volume do Railway é do root
```

**O que muda no Railway para o login do Facebook, do Typeform e do RD Station (Onda H):** nenhuma variável é obrigatória.
As cinco variáveis `*_URL` (`META_DIALOGO_URL`, `TYPEFORM_API_URL`, `TYPEFORM_DIALOGO_URL`, `RD_STATION_API_URL` e
`RD_STATION_DIALOGO_URL`) só servem para apontar para APIs de teste; no Railway deixe-as sem definir. Os três serviços
dependem de `URL_PUBLICA` ser o domínio público do serviço do front, com **https** (o domínio do Railway, como
`https://seu-front.up.railway.app`, ou o seu próprio): eles devolvem o login ao CRM e chamam o CRM com os avisos. O ID e o
segredo do app de cada serviço são cadastrados pelo Admin em **Configurações > Apps de login** (guardados cifrados com a
`CHAVE_CRIPTOGRAFIA`), não em variáveis. Cadastre, em cada serviço, estes endereços com o domínio público:

| Serviço | Onde cadastrar | Endereço |
|---|---|---|
| Meta | Login do Facebook > Configurações > URIs de redirecionamento OAuth válidos | `URL_PUBLICA/api/v1/publico/facebook/oauth/retorno` |
| Meta | Webhooks > Page > URL de callback (campo `leadgen`; o token de verificação aparece na tela Apps de login) | `URL_PUBLICA/api/v1/publico/meta/webhook` |
| Typeform | Organization > Developer Apps > Redirect URI(s) | `URL_PUBLICA/api/v1/publico/conexoes/oauth/retorno` |
| RD Station | App Publisher > URL de callback (a mudança leva até 1 hora) | `URL_PUBLICA/api/v1/publico/conexoes/oauth/retorno` |

Ao trocar o domínio (por exemplo, do endereço do Railway para o seu), refaça os três cadastros e reconecte as conexões. O
passo a passo de criar os apps está em `docs/ajuda/integracoes-apps-de-login.md`.

## 4. Ajustes de cada serviço (Settings)

- **api:** Healthcheck Path `/api/saude`; 1 réplica.
- **whatsapp:**
  - Custom Start Command: `/bin/sh /app/docker-entrypoint.sh whatsapp` (no Railway, o comando de início
    substitui o `ENTRYPOINT` da imagem; sem ele, este serviço subiria outra API).
  - Healthcheck Path `/saude`.
  - Volume de 1 GB em `/app/trava`. Nada é gravado nele: com um volume, o Railway para o deploy antigo antes
    de subir o novo. Sem isso, os dois gateways ficam no ar juntos por alguns segundos com os mesmos números,
    e o WhatsApp derruba as conexões.
  - **Sempre 1 réplica**, pelo mesmo motivo.
- **transcricao (opcional):** serviço do whisper.cpp para transcrever as ligações gravadas.
  - Crie o serviço a partir do repositório `crmbrl-api`, com a variável
    `RAILWAY_DOCKERFILE_PATH=Dockerfile.transcricao`. Esse Dockerfile é a imagem fixada do whisper.cpp com o
    entrypoint embutido, porque o Railway não monta arquivos do repositório numa imagem pronta.
  - O whisper-server escuta em `0.0.0.0`. Isso basta nos ambientes do Railway criados depois de 16/10/2025, cuja
    rede privada também tem IPv4. Num ambiente antigo, só com IPv6, a `api` não o alcançaria.
  - Volume de 2 GB em `/modelos` (o modelo é baixado só na primeira subida).
  - Sem domínio público: a `api` o chama por `transcricao.railway.internal:8080`. Healthcheck Path `/health`
    (a primeira subida leva alguns minutos, pelo download do modelo).
  - **Recursos:** o modelo recomendado é `small` (~1 GB de memória; 4 vCPU deixam a transcrição de uma
    ligação de 10 minutos em 3 a 6 minutos). Com folga, `large-v3-turbo-q5_0` (~2 GB). O plano precisa
    comportar 4 vCPU e 3 GB só para ele; sem isso, não crie o serviço e deixe `TRANSCRICAO_URL` vazia.
  - 1 réplica.
- **web:** Networking > Custom Domain com `crm.suaempresa.com.br`; crie no DNS o registro que o Railway
  mostrar (o certificado sai sozinho). Healthcheck Path `/`.
- **api, whatsapp e web:** em Source, branch `main` e "Wait for CI" ligado (só publica se a CI do GitHub
  passar). Deixe o App Sleeping (Serverless) desligado.

## 5. Primeira subida

1. Suba o `Postgres` e o `arquivos` e espere ficarem ativos.
2. Suba a `api`. Nos Deploy Logs devem aparecer "aplicando migrations pendentes" e, se a
   `ADMIN_SENHA_INICIAL` estava vazia, a senha inicial do Admin. Procure também "aviso" nos logs: deve vir
   vazio (a API avisa de configuração insegura, como na seção 3 do `DEPLOY.md`).
3. Suba o `whatsapp` e o `web`.
4. Teste: `curl -sI https://crm.suaempresa.com.br/api/saude` deve mostrar `200`.
5. Entre com o Admin (a troca de senha é obrigatória), conecte os canais em **Configurações > Canais**
   (WhatsApp por QR) e convide a equipe.

## 6. Atualização

Um merge no `main` dispara o build e o deploy dos três serviços, depois da CI. A API aplica as migrations ao
subir; se uma falhar, o deploy novo não fica saudável e o anterior continua no ar. Antes de uma versão que
muda o banco, faça um backup manual do `Postgres` (seção 7). O gateway fica alguns segundos fora a cada
deploy (efeito do volume da seção 4) e as conexões dos números voltam sozinhas.

## 7. Backups

- **Banco:** no serviço `Postgres`, aba Backups, agende backups diários e semanais (cópias do volume).
- **Arquivos:** o mesmo na aba Backups do serviço `arquivos`.
- **Cópia fora do Railway (obrigatória):** os backups do Railway se perdem junto com o volume ou o projeto.
  Agende um dump lógico do banco para um bucket externo (há modelos prontos de backup de PostgreSQL no
  Railway) e copie os arquivos do MinIO periodicamente.
- A tela **Saúde do sistema** mostra "nenhum backup": ela lê o `ultimo.json` do serviço `backup` do compose,
  que não existe no Railway. É esperado.

## 7.1 Problemas encontrados na primeira instalação (03/11/2026)

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `docker-entrypoint: DATABASE_URL não definida` em loop | Banco criado pela imagem `postgres-ssl`, que não cria a `DATABASE_URL` | Criar o banco pelo modelo (New → Database → Add PostgreSQL), com o nome `Postgres` |
| `/api` responde 502 e o log da `api` mostra `whisper_model_load…` | `RAILWAY_DOCKERFILE_PATH=Dockerfile.transcricao` também na `api` (ou nas Shared Variables) | Deixar essa variável só no serviço de transcrição; `api` e `whatsapp` com Dockerfile Path `/Dockerfile` |
| Build com `Cannot find module '…/logs/…'` | Redeploy de um deploy antigo, que reconstrói o mesmo commit | Ctrl+K → "Deploy latest commit"; conferir o branch em Settings → Source |
| `whatsapp` sem ffmpeg ou com imagem diferente da testada | Builder "Railpack" no lugar de "Dockerfile" | Settings → Build → Builder: Dockerfile |
| Gateway: "Variáveis de ambiente inválidas" (URL_PUBLICA, CHAVE_CRIPTOGRAFIA…) | Referências `${{api.…}}` que não resolveram no serviço | Usar valores diretos, os mesmos da `api` (a CHAVE_CRIPTOGRAFIA e o WHATSAPP_TOKEN_INTERNO precisam ser iguais nos dois), ou Shared Variables com `${{shared.…}}` |
| `wget … :3000` dá `Connection refused` a partir do `web` | Nada escutando na porta: veja o Deploy Logs da `api` | O log mostra o motivo (variável, banco ou Dockerfile errado) |

Os registros que o Railway marca em vermelho como "error" no Whisper e no MinIO não são falhas. Esses
programas escrevem tudo na saída de erro, inclusive as mensagens normais de início.

## 8. Diferenças em relação ao servidor próprio (pendentes)

- **IP do cliente (corrigido na U4):** o `Caddyfile` do front confia nos cabeçalhos `X-Forwarded-For` /
  `X-Real-IP` só quando chegam pela rede privada (`trusted_proxies static private_ranges`, que é por onde o
  proxy de borda do Railway entrega) e repassa à API um único `X-Forwarded-For` com o IP do cliente
  (`header_up X-Forwarded-For {client_ip}`). Um cabeçalho forjado pelo visitante não chega à API, então o
  bloqueio por força bruta (R2.5), a auditoria, os webhooks e o limite do chat do site enxergam o IP real.
  Confira depois da subida: a tabela `tentativas_login` deve mostrar o IP do visitante, não o do proxy.
- **HSTS (corrigido na U4):** o Caddy do front envia `Strict-Transport-Security` quando a requisição chega por
  https (`X-Forwarded-Proto: https`, posto pelo proxy de borda); o endereço local em http (`:8080`) não recebe.
- **Segredos de desenvolvimento (U4):** com `NODE_ENV=production` (a imagem Docker) a API **recusa subir** com a
  chave `CHAVE_CRIPTOGRAFIA`, o `WHATSAPP_TOKEN_INTERNO` ou o `ARQUIVOS_SEGREDO` públicos de desenvolvimento,
  com a senha do banco `crmbrl` ou com `COOKIE_SEGURO=false` e `URL_PUBLICA` em https. Só
  `PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO=true` deixa subir (teste local: vira aviso alto no log e em
  `GET /api/saude` do Admin). No Railway, defina valores próprios e não use essa variável.
- **`GET /api/saude` (U4):** responde só `{ "status": "ok" | "degradado" }` (200 ou 503) para qualquer pessoa; versão, banco,
  migrations e avisos de configuração só saem para o Admin logado. O healthcheck do Railway e do Docker
  (`/api/saude`) continua igual: só olha o código HTTP.
- **Cookie de sessão (U4):** com `COOKIE_SEGURO=true` o cookie passa a se chamar `__Host-crmbrl_sessao`. **Na primeira
  publicação depois dessa mudança todo mundo é deslogado uma vez** (o nome antigo deixa de valer).

### Pendências conhecidas de segurança (U4, só documentadas)

- **DNS rebinding nos webhooks de saída:** `webhooks/saida/protecao-ssrf.ts` confere o endereço ao cadastrar e
  ao enviar, mas não fixa o IP resolvido na conexão (isso exigiria `undici` como dependência direta). O
  https obrigatório em produção e a recusa de redes internas mitigam; a correção completa depende de aprovar
  essa dependência.
- **Imagem do MinIO:** `bitnamilegacy/minio:2025.7.23-debian-12-r5` não recebe correções (CVE-2025-62506,
  autorização de chaves de serviço). Troque por uma imagem mantida (por exemplo, a oficial `minio/minio` ou
  `quay.io/minio/minio` fixada por digest) assim que possível; o volume e as variáveis são compatíveis, mas
  teste a troca num ambiente descartável antes.
- **`Dockerfile.transcricao`:** a imagem do whisper.cpp roda como root e o modelo baixado no primeiro boot não
  tem conferência de SHA-256. Mitigação: o serviço é só da rede privada e sem segredos. Correção sugerida:
  rodar com usuário sem privilégios (o volume `/modelos` precisa de dono correspondente) e fixar o SHA-256
  de cada modelo em `scripts/transcricao-entrypoint.sh`.
- **Zip forjado no XLSX:** a conferência de bomba de zip lê o diretório central (tamanhos declarados); um zip que
  mente nesses tamanhos ainda passa por ela, e o limite de linhas e de memória do processo continua sendo a
  última barreira.

## Referências do Railway

- [Rede privada](https://docs.railway.com/private-networking)
- [Comando de início](https://docs.railway.com/deployments/start-command)
- [Troca de deploys (sobreposição e encerramento)](https://docs.railway.com/deployments/deployment-teardown)
- [Backups do PostgreSQL](https://docs.railway.com/guides/postgres-backups-restores)
