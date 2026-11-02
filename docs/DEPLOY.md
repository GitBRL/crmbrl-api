# Deploy em produção — servidor com Docker Compose e HTTPS pelo Caddy

Guia para colocar o BRL CRM num servidor Linux com Docker, com HTTPS automático (Caddy + Let's Encrypt),
backup diário do banco e cópia dos dados para fora da máquina. Tudo roda pelo `docker-compose.yml` deste
repositório, mais o `docker-compose.producao.yml` (HTTPS e variáveis obrigatórias). Não há deploy
automático: a CI (GitHub Actions) só testa e constrói; a publicação é manual, como abaixo. Para publicar no
Railway em vez de um servidor próprio, siga o `DEPLOY-RAILWAY.md`.

Os comandos são feitos dentro de `crmbrl-api/`, com o repositório do front (`crmbrl/`) ao lado, na mesma
pasta pai (o compose constrói o front de `../crmbrl`; mude com `FRONT_DIR`). Abreviação usada no texto:

```bash
alias crm='docker compose -f docker-compose.yml -f docker-compose.producao.yml'
```

## 1. O que sobe

| Serviço     | O que é                                                     | Porta no host                                     |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `proxy`     | Caddy de borda: HTTPS, HSTS, cabeçalhos; encaminha `/api` à API e o resto ao front | 80 e 443 (única entrada pública)  |
| `web`       | Caddy do front (Angular + Content-Security-Policy)          | nenhuma (só o proxy)                              |
| `api`       | API NestJS (aplica as migrations ao subir)                  | `127.0.0.1:3000` (só a própria máquina)           |
| `whatsapp`  | Gateway de WhatsApp (mesma imagem da API)                   | nenhuma                                           |
| `banco`     | PostgreSQL 17                                               | nenhuma em produção                               |
| `arquivos`  | MinIO (anexos, mídias do WhatsApp, importações, gravações de ligações) | nenhuma                         |
| `transcricao` | whisper.cpp (transcrição das ligações, R30)               | nenhuma                                           |
| `backup`    | `pg_dump` diário no volume `backups`                        | nenhuma                                           |

Volumes (nomes com o prefixo do projeto, `crmbrl_`): `banco-dados`, `arquivos-dados`, `modelos-whisper`, `backups`,
`caddy-dados` (certificados), `caddy-config`.

## 2. Pré-requisitos

- Servidor Linux com Docker Engine e o plugin Compose (`docker compose version`), 2 vCPU e 4 GB de RAM no
  mínimo (a construção das imagens usa mais memória que a execução) e disco para o banco, os arquivos e
  os backups.
- Um domínio (ex.: `crm.suaempresa.com.br`) com registro DNS `A` (e `AAAA`, se houver IPv6) apontando para o
  servidor. O Let's Encrypt só emite o certificado se o DNS já estiver certo.
- Portas 80 e 443 abertas no firewall (a 80 é usada na emissão do certificado e redireciona para HTTPS). Não
  abra a 3000 nem a 5432.
- Um servidor SMTP (convites e "esqueci minha senha" dependem dele).

## 3. Variáveis (`.env`)

Crie o `.env` em `crmbrl-api/` (fora do git) com `chmod 600 .env`. O `docker-compose.producao.yml` **se
recusa a subir** se faltar uma variável obrigatória, em vez de usar os padrões públicos de desenvolvimento.
Gere os segredos com `openssl rand -base64 32` (ou `openssl rand -hex 24` para senhas sem caracteres
especiais) e nunca os coloque em chat, ticket ou repositório.

```bash
# --- Obrigatórias ---
DOMINIO=crm.suaempresa.com.br
URL_PUBLICA=https://crm.suaempresa.com.br
ORIGENS_PERMITIDAS=https://crm.suaempresa.com.br     # a mesma origem da URL_PUBLICA
BANCO_SENHA=<senha forte do PostgreSQL>
BANCO_SENHA_CODIFICADA=<a mesma senha; se tiver @ : / ? # ou %, codifique para URL (%40 …)>
CHAVE_CRIPTOGRAFIA=<openssl rand -base64 32>          # cifra os segredos gravados no banco
ARQUIVOS_CHAVE=<usuário do MinIO>
ARQUIVOS_SEGREDO=<senha do MinIO, 12+ caracteres>
WHATSAPP_TOKEN_INTERNO=<openssl rand -base64 32>      # API <-> gateway, 32+ caracteres
ADMIN_EMAIL=voce@suaempresa.com.br                    # primeiro Admin

# --- Recomendadas ---
ADMIN_SENHA_INICIAL=                                  # vazia: a API gera e mostra uma vez no log
SMTP_HOST=smtp.suaempresa.com.br
SMTP_PORTA=587
SMTP_USUARIO=...
SMTP_SENHA=...
SMTP_REMETENTE=BRL CRM <crm@suaempresa.com.br>

# --- Backup (padrões entre parênteses) ---
BACKUP_HORARIO=03:00                                  # (03:00) HH:MM no fuso abaixo
BACKUP_FUSO=America/Sao_Paulo                         # (America/Sao_Paulo)
BACKUP_RETENCAO_DIAS=14                               # (14) 0 = nunca apagar

# --- Opcionais ---
ANTHROPIC_API_KEY=                                    # análise do BI, assistente de IA e resumo das ligações
WHISPER_MODELO=small                                  # (small) modelo da transcrição das ligações; veja a seção 3.1
TRANSCRICAO_CPUS=4                                    # (4) limite de CPU do serviço transcricao
TRANSCRICAO_MEMORIA=3g                                # (3g) limite de memória do serviço transcricao
TRANSCRICAO_URL=                                      # (http://transcricao:8080) vazio = transcrição desligada
TICKETHUB_URL= / TICKETHUB_EMAIL= / TICKETHUB_SENHA=  # chamados do assistente (ou pela tela do Admin)
VAPID_CHAVE_PUBLICA= / VAPID_CHAVE_PRIVADA= / VAPID_ASSUNTO=mailto:voce@suaempresa.com.br
```

`COOKIE_SEGURO=true`, `DOCS_PUBLICAS=false` e `WHATSAPP_SIMULADO=false` já vêm fixados no
`docker-compose.producao.yml`. A lista completa de variáveis está no `README.md` ("Variáveis de ambiente").

Na subida, a API valida o ambiente e **não inicia** se algo obrigatório faltar ou estiver malformado (a
mensagem lista todos os problemas, sem repetir segredos). Ela também registra **avisos** no log para o que
sobe mas é inseguro em produção: `URL_PUBLICA` em http, `COOKIE_SEGURO=false`, chave de criptografia,
segredo do MinIO, token interno ou senha do banco iguais aos padrões públicos de desenvolvimento. Depois de
subir, confira: `crm logs api | grep -i aviso` deve vir vazio.

### 3.1 Transcrição das ligações (serviço `transcricao`)

As ligações gravadas são transcritas por um **whisper.cpp** (imagem oficial `ghcr.io/ggml-org/whisper.cpp`,
licença MIT, fixada por digest no `docker-compose.yml`) que só fala com a API pela rede do compose. Roda em
**CPU**, uma transcrição por vez (a fila serializa); o resumo depende da `ANTHROPIC_API_KEY`.

- **Primeira subida:** o serviço baixa o modelo (`small`: ~470 MB) do Hugging Face para o volume
  `modelos-whisper`; fica "starting" até terminar (alguns minutos, `crm logs transcricao`). Depois disso, o
  modelo fica no volume e reinícios são rápidos. A API sobe e grava normalmente enquanto ele não está pronto:
  as gravações esperam na fila.
- **Modelo recomendado: `small`** (boa qualidade em português, ~1 GB de memória; uma ligação de 10 minutos
  leva cerca de 3 a 6 minutos com 4 CPUs). Com folga de CPU e memória, **`large-v3-turbo-q5_0`** (turbo
  quantizado, ~600 MB em disco e ~2 GB de memória) transcreve melhor, mais devagar; `base` é rápido e
  pior; `medium` pede ~2,5 GB. Troque com `WHISPER_MODELO` e `crm up -d transcricao`.
- **Dimensionamento:** reserve **4 CPUs e 3 GB** para o serviço (`TRANSCRICAO_CPUS`, `TRANSCRICAO_MEMORIA`,
  `WHISPER_THREADS`) além do que a API, o banco e o MinIO usam; o servidor de 2 vCPU / 4 GB da seção 2 serve
  para o CRM sem ligações gravadas, mas com transcrição precisa de pelo menos 4 vCPU e 8 GB. Sem CPU para
  isso, deixe `TRANSCRICAO_URL=` vazia: a gravação e o áudio para ouvir continuam, sem texto e sem resumo.
- **Disco:** uma hora de ligação ocupa ~15 MB (webm original) mais ~15 MB (ogg para ouvir), no MinIO. A guarda
  é por canal (`retencaoDias`, padrão 365): depois do prazo, a gravação e a transcrição são apagadas todo dia
  às 03:30 e o registro, a duração e o resumo ficam.
- **Saúde:** a tela **Saúde do sistema** mostra o serviço (`ok`, `fora_do_ar` ou `desativada`), o modelo e a
  fila; serviço ligado e fora do ar gera um alerta.

## 4. Primeira subida

```bash
git clone <repositório crmbrl-api> && git clone <repositório crmbrl>   # lado a lado
cd crmbrl-api
# crie o .env (seção 3)
crm config -q                      # valida o compose e as variáveis obrigatórias (sem saída = ok)
crm up -d --build                  # constrói as imagens e sobe tudo
crm ps                             # todos "healthy"; o proxy emite o certificado na 1ª visita
crm logs api | head -n 40          # senha inicial do Admin (se ADMIN_SENHA_INICIAL estava vazia)
```

1. Abra `https://<DOMINIO>` e entre com `ADMIN_EMAIL` e a senha inicial; a troca de senha é obrigatória.
2. Se o certificado não sair: `crm logs proxy` (quase sempre DNS ainda não propagado ou porta 80/443
   bloqueada). O Caddy tenta de novo sozinho.
3. Teste: `curl -sI https://<DOMINIO>/api/saude` deve mostrar `200`, `strict-transport-security` e
   `x-content-type-options`.
4. Em **Configurações**, conecte os canais (WhatsApp por QR, e-mail, Meta, chat do site) e convide a equipe.
5. Faça um backup manual e confira a tela **Saúde do sistema** (seção 7).

## 5. Atualização

```bash
cd crmbrl-api && git pull && (cd ../crmbrl && git pull)
crm exec backup sh /backup.sh uma-vez     # backup logo antes de atualizar
crm up -d --build                         # reconstrói e recria só o que mudou; a API aplica as migrations
crm ps && crm logs --since 5m api | tail -n 30
```

- As migrations rodam ao subir a API (`MIGRAR_AO_INICIAR=true`); se uma falhar, o container para em vez de
  subir com o banco fora do esquema, e a versão anterior da imagem continua disponível para voltar
  (`git checkout <tag anterior>` + `crm up -d --build`; migrations já aplicadas não voltam sozinhas: restaure
  o backup da seção 8 se a nova versão tiver mudado o banco).
- O gateway de WhatsApp reinicia junto: as conexões dos números voltam sozinhas (as chaves ficam no banco).
- Para liberar espaço: `docker image prune -f` (nunca `docker volume prune` nem `down -v`: apagam os dados).

## 6. Segurança em produção (o que já vem configurado)

- **HTTPS e HSTS** pelo Caddy de borda; cookie de sessão `Secure` + `HttpOnly`; proteção CSRF por origem
  (`ORIGENS_PERMITIDAS`).
- **Cabeçalhos** em toda resposta: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` (na API e no Caddy) e, no front, uma Content-Security-Policy com hash dos scripts.
- **Limites de requisição** (429 com `Retry-After`): login (5 falhas por e-mail em 15 min bloqueiam o e-mail;
  30 tentativas sem sucesso por IP em 15 min), pedido de link de senha (3 por e-mail e 10 por IP em 15 min),
  consulta e uso de token de senha (30 por IP em 15 min), webhooks de entrada (60 por minuto por ponto),
  chat do site (por IP) e webhook da Meta. Os limites ficam em memória: valem para a instância única da API.
- Banco, MinIO, front e gateway **sem porta publicada**; a API só em `127.0.0.1`. Documentação `/api/docs`
  só para o Admin logado.
- Firewall: só 22 (SSH, de preferência restrito por IP), 80 e 443.

## 7. Backups

O serviço `backup` (imagem `postgres:17-alpine`, script `scripts/backup.sh`) faz um `pg_dump` completo no
formato custom (compactado) todo dia em `BACKUP_HORARIO`, grava em `crmbrl_backups` (`/backups`), valida o
arquivo (`pg_restore --list`) e apaga os dumps com mais de `BACKUP_RETENCAO_DIAS` dias. A cada execução
escreve `/backups/ultimo.json`:

```json
{"inicio":"2026-10-31T06:00:00Z","fim":"2026-10-31T06:00:03Z","arquivo":"crmbrl-20261031-060000.dump",
 "tamanhoBytes":315328,"ok":true,"erro":null}
```

A API monta o mesmo volume **somente leitura** em `/backups` (`BACKUP_DIR`) e a tela **Saúde do sistema**
mostra o último backup; falha de backup gera alerta por e-mail ao Admin. Sem o arquivo: "nenhum backup
registrado".

```bash
crm exec backup sh /backup.sh uma-vez     # backup agora
crm logs backup | tail                    # histórico do serviço
crm exec backup ls -lh /backups           # arquivos e tamanhos
```

Os dumps contêm dados de clientes: o arquivo é legível só pelo root do serviço (`umask 077`).

### 7.1 Cópia para fora da máquina (obrigatória)

Backup na mesma máquina não protege de disco perdido, servidor apagado ou ransomware. Copie
**três coisas** para outro lugar (outro servidor, bucket S3/Backblaze, NAS), todo dia, depois do horário do
backup, e guarde as cópias fora do alcance de quem acessa o servidor de produção:

1. **Os dumps do banco** (volume `crmbrl_backups`).
2. **O volume do MinIO** (`crmbrl_arquivos-dados`): anexos e mídias; o dump do banco não os contém.
3. **O `.env`** (guarde num cofre de senhas): sem `CHAVE_CRIPTOGRAFIA` os segredos gravados no banco não
   abrem de novo.

Exemplo com `tar` por container e envio por `rsync` (ajuste o destino; roda no cron do servidor, ex.
`30 4 * * *`):

```bash
#!/bin/sh
set -eu
DESTINO=usuario@servidor-de-backup:/dados/crmbrl     # ou um disco montado
TMP=/var/backups/crmbrl-export; mkdir -p "$TMP"

# dumps (somente leitura) e MinIO (somente leitura) para um tar.gz cada
docker run --rm -v crmbrl_backups:/dados:ro -v "$TMP":/saida alpine \
  tar czf /saida/backups.tar.gz -C /dados .
docker run --rm -v crmbrl_arquivos-dados:/dados:ro -v "$TMP":/saida alpine \
  tar czf /saida/minio.tar.gz -C /dados .

rsync -a --partial "$TMP"/ "$DESTINO"/
```

- O MinIO guarda cada objeto num arquivo; uma cópia com a aplicação em uso pode pegar um arquivo no meio de
  um envio. Para uma cópia 100% consistente, rode `crm stop arquivos` durante o `tar` (a API fica sem
  anexos por alguns segundos) e depois `crm start arquivos`. Como o banco e os arquivos são copiados em
  momentos diferentes, um anexo enviado entre os dois pode faltar de um lado: é aceitável, pois o CRM mostra
  "arquivo indisponível" nesses casos.
- Com `rclone` (instalado no servidor, fora do projeto) a mesma pasta `$TMP` pode ir para S3, Backblaze etc.
- Guarde mais retenção fora da máquina do que dentro (ex.: 30 dias lá, 14 aqui) e **teste a restauração**
  (seção 8) pelo menos uma vez por trimestre, num servidor de teste.

## 8. Restauração

O script `scripts/restaurar-backup.sh` restaura um dump num banco, confere o arquivo antes, nunca apaga nada
sem confirmação e compara a contagem de linhas com outro banco quando pedido. Ele precisa do cliente do
PostgreSQL 17: o passo a passo usa o container `postgres:17-alpine`.

### 8.1 Ensaio: restaurar num banco ao lado (sem mexer no banco em uso)

```bash
ARQ=crmbrl-20261031-060000.dump            # veja os nomes em: crm exec backup ls /backups
docker run --rm --network crmbrl_default \
  -v crmbrl_backups:/backups:ro -v "$PWD/scripts":/scripts:ro \
  -e PGHOST=banco -e PGUSER=crmbrl -e PGPASSWORD="$(grep ^BANCO_SENHA= .env | cut -d= -f2-)" \
  postgres:17-alpine sh /scripts/restaurar-backup.sh /backups/$ARQ \
  --banco crmbrl_restaurado --comparar crmbrl
```

Cria o banco `crmbrl_restaurado`, restaura e imprime "contagens IGUAIS" (ou a diferença por tabela; se o CRM
recebeu dados depois do backup, a diferença é esperada). Apague o ensaio depois:
`crm exec banco psql -U crmbrl -d postgres -c 'DROP DATABASE crmbrl_restaurado'`.

### 8.2 Desastre: restaurar sobre o banco em uso

1. Pare quem usa o banco (o `backup` e o `banco` ficam de pé):
   `crm stop proxy web api whatsapp`
2. Restaure apagando e recriando o banco `crmbrl` (peça confirmação digitando `SIM`):

   ```bash
   docker run --rm -it --network crmbrl_default \
     -v crmbrl_backups:/backups:ro -v "$PWD/scripts":/scripts:ro \
     -e PGHOST=banco -e PGUSER=crmbrl -e PGPASSWORD="$(grep ^BANCO_SENHA= .env | cut -d= -f2-)" \
     postgres:17-alpine sh /scripts/restaurar-backup.sh /backups/$ARQ --banco crmbrl --substituir
   ```

3. Suba de novo: `crm up -d`. A API confere as migrations (o dump já traz o histórico delas).
4. Arquivos do MinIO (se perdidos): com `arquivos` parado, restaure o tar copiado para fora:
   `crm stop arquivos`
   `docker run --rm -v crmbrl_arquivos-dados:/dados -v /caminho/da/copia:/entrada:ro alpine sh -c 'rm -rf /dados/* /dados/.[!.]* ; tar xzf /entrada/minio.tar.gz -C /dados'`
   `crm start arquivos`
5. Em **servidor novo**: instale Docker, clone os repositórios, recoloque o `.env` **idêntico** (a
   `CHAVE_CRIPTOGRAFIA` precisa ser a mesma), faça `crm up -d --build`, pare `api whatsapp web proxy`,
   copie o dump para o volume `crmbrl_backups` (`docker run --rm -v crmbrl_backups:/b -v /pasta:/e:ro alpine
   cp /e/<arquivo>.dump /b/`), siga os passos 2 a 4 e aponte o DNS para o novo servidor.
6. Conferência: entre no CRM, abra **Saúde do sistema** (backup, filas, gateway) e veja se os números de
   WhatsApp reconectaram.

## 9. Rotação de segredos

Faça uma de cada vez, com backup recente (`crm exec backup sh /backup.sh uma-vez`), em horário de pouco
uso. Depois de cada troca: atualize o `.env` e o cofre de senhas, rode o comando indicado e confira
`crm ps` e `crm logs --since 5m api`.

| Segredo | Quando trocar | Como | Efeito |
| --- | --- | --- | --- |
| `ADMIN_*` e senhas de usuários | saída de alguém, suspeita de vazamento | pela tela (Usuários → senha temporária) | o usuário troca no próximo login; desligar um usuário encerra suas sessões |
| `BANCO_SENHA` | anual / suspeita | 1) `crm exec banco psql -U crmbrl -d postgres -c "ALTER USER crmbrl PASSWORD 'nova'"` 2) atualize `BANCO_SENHA` **e** `BANCO_SENHA_CODIFICADA` no `.env` 3) `crm up -d --force-recreate api whatsapp backup banco` | `POSTGRES_PASSWORD` só vale na criação do volume; por isso o `ALTER USER` vem primeiro |
| `ARQUIVOS_CHAVE` / `ARQUIVOS_SEGREDO` (MinIO) | anual / suspeita | altere no `.env` e rode `crm up -d --force-recreate arquivos api whatsapp` | o MinIO adota as credenciais novas ao subir; os arquivos continuam |
| `WHATSAPP_TOKEN_INTERNO` | anual / suspeita | novo valor (`openssl rand -base64 32`) e `crm up -d --force-recreate api whatsapp` | só o canal interno API↔gateway; números e conversas não são afetados |
| `SMTP_SENHA`, `ANTHROPIC_API_KEY`, `TICKETHUB_SENHA` | conforme o provedor | altere no `.env` e `crm up -d --force-recreate api` (ou pela tela do Admin, quando a configuração é feita lá) | nenhuma perda de dados |
| `VAPID_CHAVE_PRIVADA` / `PUBLICA` | só se vazar | gere par novo (`npx web-push generate-vapid-keys`) e `crm up -d --force-recreate api` | todas as inscrições de push deixam de valer: cada pessoa reativa as notificações no CRM |
| Tokens e segredos de webhooks, chaves de canais | suspeita de vazamento | pelas telas (Webhooks: "regenerar token/segredo"; Canais: gerar nova chave) | atualize o sistema que envia/recebe |
| `CHAVE_CRIPTOGRAFIA` | só com suspeita de vazamento da chave ou do `.env` | veja abaixo | **invalida** todos os segredos cifrados no banco |

### 9.1 Trocar a `CHAVE_CRIPTOGRAFIA`

A chave cifra (AES-256-GCM) os segredos gravados no banco: segredos de webhooks de entrada e de saída,
credenciais dos canais (e-mail, Meta, chat do site), configuração do assistente (TicketHub) e as chaves de
autenticação dos números de WhatsApp. **Não existe recifragem automática**: com a chave nova, o que foi
gravado com a antiga deixa de abrir. Então:

1. Faça backup do banco e guarde o `.env` antigo (com a chave antiga) até terminar.
2. Gere a chave nova (`openssl rand -base64 32`), troque no `.env` e rode `crm up -d --force-recreate api whatsapp`.
3. Refaça o que dependia dos segredos antigos: regenerar o segredo de cada webhook (entrada e saída) e
   atualizar o sistema parceiro; informar de novo as credenciais dos canais de e-mail e Meta e da
   configuração do TicketHub; **reconectar cada número de WhatsApp pelo QR code**.
4. Quando tudo estiver funcionando, descarte a chave antiga. Sessões de usuários **não** são afetadas
   (o token de sessão é aleatório e fica só como hash no banco).

Sem suspeita de vazamento, prefira **não** trocar esta chave: o custo operacional é alto. Proteja o `.env`
(`chmod 600`, cofre de senhas, sem cópia em chat ou repositório) e o acesso ao servidor.

## 10. Rotina e conferências

- Diário (automático): backup às `BACKUP_HORARIO`; conferir a **Saúde do sistema** e o e-mail de alertas.
- Semanal: `crm ps`, `df -h` (volume dos backups e do MinIO), `docker image prune -f`.
- Mensal: atualizar o sistema operacional do servidor e as imagens base (`crm pull proxy banco backup` e
  `crm up -d --build`), conferir a cópia fora da máquina (abrir o `.tar.gz` e listar o conteúdo).
- Trimestral: ensaio de restauração (seção 8.1) e rotação dos segredos anuais.
- Renovação do certificado é automática (o Caddy renova sozinho antes de vencer; o volume `caddy-dados` guarda os
  certificados).
