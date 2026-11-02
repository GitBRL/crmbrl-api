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
# opcionais: ANTHROPIC_API_KEY, TICKETHUB_URL, TICKETHUB_EMAIL, TICKETHUB_SENHA,
#            VAPID_CHAVE_PUBLICA, VAPID_CHAVE_PRIVADA, VAPID_ASSUNTO

# --- whatsapp ---
DATABASE_URL=${{Postgres.DATABASE_URL}}
PORT=3100                                             # a porta que o healthcheck do Railway consulta

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

## 8. Diferenças em relação ao servidor próprio (pendentes)

- **IP do cliente:** atrás do proxy do Railway, a API registra o IP do proxy, não o do visitante. Isso afeta a
  auditoria, os recebimentos de webhook e o limite por IP do chat do site (todos os visitantes contam
  juntos). A correção é um ajuste no `Caddyfile` do front para usar o cabeçalho `X-Real-IP` do Railway.
- **HSTS:** no servidor próprio, o Caddy de borda envia o `Strict-Transport-Security`; no Railway, ninguém
  envia.

## Referências do Railway

- [Rede privada](https://docs.railway.com/private-networking)
- [Comando de início](https://docs.railway.com/deployments/start-command)
- [Troca de deploys (sobreposição e encerramento)](https://docs.railway.com/deployments/deployment-teardown)
- [Backups do PostgreSQL](https://docs.railway.com/guides/postgres-backups-restores)
