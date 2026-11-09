---
titulo: Integração RD Station — receber conversões e oportunidades
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [apps de login, entrar com o rd station, janela, pop-up, conexão, webhook automático, buscar campos, rd station, rd station marketing, conversão, oportunidade, webhook, lead, chave de autenticação, custom_fields, utm, mapeamento]
---
# Integração RD Station

Recebe as **conversões** e as **oportunidades** do **RD Station Marketing** por um webhook. Há **dois modos**: **Entrar com o RD Station**, em que o CRM **cria o webhook sozinho** no RD, e **Colar o endereço no RD (manual)**, em que você configura o webhook no RD. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md) e [Apps de login](integracoes-apps-de-login.md).

## O que você precisa ter antes
- **Pelo login:** o app do RD Station cadastrado no CRM pelo Admin, uma vez, em **Configurações > Apps de login** (veja [Apps de login](integracoes-apps-de-login.md)), e um endereço público com https no CRM (o RD testa o endereço ao criar o webhook; não funciona em ambiente local).
- Uma conta do RD Station Marketing com acesso a **Integrações > Webhook**. A disponibilidade de webhooks depende do plano do RD; confira no seu plano.
- Opcional: uma **chave de autenticação**. O RD permite configurar um cabeçalho com a chave; se você informar a mesma chave no CRM, a integração recusa chamadas sem ela.

## Passo a passo
### Modo login (o CRM cria o webhook)
1. Em **Integrações → Aplicativos**, escolha **RD Station**.
2. Em **Ação e nome**, dê um nome e escolha alvo e modo. No passo da conta, escolha **Entrar com o RD Station (o CRM cria o webhook sozinho)**: abre **outra janela** com o login do RD. Escolha a conta, autorize e a janela se fecha sozinha, voltando ao assistente ("Aguardando o login na outra janela…", com **Abrir de novo** e **Cancelar**). Se ela não fechar, clique em **Voltar ao CRM**. Se o navegador bloquear o pop-up, o login abre na própria aba e o assistente reabre no mesmo passo. Conexões já existentes aparecem numa lista para reaproveitar.
3. Escolha o **gatilho**: **Conversão** (e, se quiser, conversões específicas; vazio vale para todas) ou **Oportunidade**.
4. No **Mapeamento**, use **Buscar campos do RD**: o CRM busca os campos de contato pela API do RD e preenche a lista.
5. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**: o CRM cria o webhook no RD. Ao desativar ou excluir a integração, ele remove o webhook. Se o RD recusar a criação, a tela mostra o erro e o botão **Tentar de novo**.

### Modo manual (colar o endereço no RD)
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **RD Station**.
2. Em **Ação e nome**, dê um nome e escolha alvo e modo.
3. Em **Endereço**, copie o endereço. Se quiser, defina a **chave de autenticação** (gerada pelo CRM ou combinada); ela aparece uma única vez.

**No RD Station Marketing**
1. No menu superior direito, abra **Integrações > Webhook > Configurar** e clique em **Criar webhook**.
2. Dê um nome, cole o endereço da integração e escolha o gatilho: **Conversão** (escolha as conversões ou deixe vazio para todas) ou **Oportunidade**.
3. Se quiser autenticar, configure no RD um cabeçalho com a chave e informe a mesma chave no CRM.
4. Converta um lead de teste.

**De volta ao CRM**
1. No **Mapeamento**, use **Atualizar campos recebidos**. O modelo pronto reconhece `name`, `email`, `mobile_phone`/`personal_phone`, `company`, `job_title`, `tags`, as UTMs da última conversão e os campos personalizados (`custom_fields.<nome>` ou `cf_<nome>`).
2. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

## Como testar
Faça uma conversão de teste (preencha um formulário do RD com seus dados). O recebimento aparece em **Integrações → Histórico**.

## O que aparece no histórico
O RD pode mandar **vários leads de uma vez** (`leads`): cada um é processado e o resultado de cada lead aparece no detalhe do recebimento. Status: **Processado**, **Ignorado** ou **Erro**. Cada recebimento processa até **100 leads**; os que passarem disso ficam como **Ignorado** ("excedentes") no detalhe, e você reenvia esses em outro recebimento.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada lead. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- Para mudar o negócio pelo RD, use campos personalizados com esses dados e mapeie para **etapa** (nome ou posição), **dono** (e-mail ou **Identificador nas integrações**) e **status** (`aberto`, `ganho`, `perdido`).
- Todo lead precisa de **e-mail ou telefone**.

## Erros comuns
- **Passou de manual para o login:** o webhook que você colou à mão no RD continua lá. Apague-o no RD (o CRM só apaga os que ele mesmo criou); senão cada conversão chega duas vezes.
- **"O CRM ainda não conseguiu remover o webhook" ao excluir a conexão:** o RD estava fora do ar quando você excluiu a integração. O CRM tenta de novo a cada 15 minutos; ou apague o webhook no RD (a mensagem traz o identificador) e confirme a exclusão da conexão.
- **"O app do RD Station ainda não foi cadastrado":** peça ao Admin para cadastrar o app em **Configurações > Apps de login**.
- **O webhook não foi criado (erro na ativação):** o RD testa o endereço do CRM na criação e só aceita se ele responder; confira se o CRM tem endereço público com https. Use **Tentar de novo**. O webhook criado pela API **não aparece** na tela de webhooks do RD; isso é normal.
- **"Precisa de atenção":** o acesso foi revogado, o RD recusou renovar ou o Admin trocou o app ("O app de login mudou nas Configurações: conecte de novo"). Use **Reconectar**.
- **A janela de login não abre:** o navegador bloqueou o pop-up; permita pop-ups para o endereço do CRM e clique em **Abrir de novo**, ou use o login na própria aba.
- **Retorno do login com erro logo depois de cadastrar o app:** a mudança da URL de callback no RD pode levar até 1 hora.
- **Ao ativar pelo login aparece um recebimento "Teste de validação" no histórico:** é o teste que o RD faz no endereço; pode ignorar.
- **401 na chamada:** o RD não está enviando o cabeçalho com a chave, ou a chave difere da do CRM. Reconfira os dois lados.
- **Nada chega:** confira o gatilho escolhido no RD (conversão ou oportunidade) e se a integração está **Ativa** (desativada responde 410).
- **Campos personalizados fora do mapeamento:** use **Atualizar campos recebidos** depois de uma conversão que tenha esses campos preenchidos.
- **Formato [INFERIDO]:** o RD tem mais de um formato (lista de leads, lead único e a API 2.0). Confira o **primeiro recebimento** no histórico e ajuste o mapeamento se algum campo vier em outro caminho.
