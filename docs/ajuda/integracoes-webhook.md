---
titulo: Integração Webhook — receber leads de qualquer sistema e avisar outros sistemas
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico, /integracoes/saida]
papeis: Só o Admin.
palavras-chave: [webhook, receber, enviar, post, get, json, formulário, x-assinatura, hmac, segredo, endereço, mapeamento, integração, gatilho, saída, entrega, criar ou atualizar]
---
# Integração Webhook: receber e enviar

O aplicativo **Webhook** serve para qualquer sistema que consiga chamar um endereço (URL). Ele tem duas metades: **receber** (o outro sistema manda um lead para o CRM) e **enviar** (o CRM avisa o outro sistema quando algo acontece num negócio). Só o Admin configura. Veja também o artigo geral [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- **Receber:** o sistema de origem precisa conseguir enviar uma requisição **POST** (JSON ou formulário) com até 256 KB. Não há plano nem credencial a contratar.
- **Enviar:** o endereço de destino precisa ser **HTTPS e público** (o CRM recusa endereços internos, por segurança). Se o destino exigir autenticação, use os cabeçalhos extras ou valide a assinatura do CRM.

## Receber leads (passo a passo)
**No CRM**
1. Abra **Integrações** (menu **Sistema**), em **Aplicativos** escolha **Webhook**.
2. Em **Ação e nome**, dê um nome e escolha **Negócio** ou **Contato** e o que fazer (veja os modos abaixo). Ao sair deste passo a integração é criada **inativa**.
3. Em **Endereço**, copie o endereço da integração. Se quiser proteção extra, crie um **segredo HMAC** (gerado pelo CRM ou combinado com você). Ele aparece **uma única vez**: guarde-o no sistema de origem.
4. Em **Mapeamento**, escolha onde cada campo recebido entra. O modelo **Genérico** já reconhece nome, e-mail, telefone e UTMs com nomes comuns.
5. Em **Configurações**, escolha funil, etapa de entrada, status inicial, etiquetas e quem fica com o lead (rodízio, responsável fixo ou líder da área).
6. Clique em **Salvar e ativar**.

**No sistema de origem**
1. Cadastre o endereço copiado como destino de um webhook, método **POST**.
2. Envie o corpo em JSON (`Content-Type: application/json`) ou como formulário (`application/x-www-form-urlencoded`), com até 256 KB.
3. Se criou um segredo, assine o corpo bruto com HMAC-SHA256 e envie no cabeçalho `X-Assinatura` como `sha256=<hexadecimal>`.
4. Dispare um envio de teste.

Exemplo de corpo (dados fictícios):
```json
{ "nome": "Maria Souza", "email": "maria@exemplo.com.br", "telefone": "11987654321", "utm_source": "google" }
```

## Como testar
Dispare um envio de teste no sistema de origem e, no CRM, use **Atualizar campos recebidos** no mapeamento para ver o que chegou. Em **Conferir com um exemplo** o CRM mostra o que faria com um JSON, sem gravar nada. Depois confira em **Histórico**.

## O que aparece no histórico
Cada chamada vira um recebimento em **Integrações → Histórico** (guardado por 90 dias): **Processado** (criou ou atualizou), **Ignorado** (por exemplo, modo Atualizar sem negócio aberto) ou **Erro**. Abra o recebimento para ver os cabeçalhos, o corpo, os avisos e o contato e o negócio criados. **Reprocessar** tenta de novo com a configuração atual.

## Criar ou atualizar: etapa, dono e status
- **Criar:** todo recebimento abre um negócio novo, mesmo que o contato já tenha um aberto.
- **Criar ou atualizar:** se o contato tem negócio aberto no funil da integração, o CRM atualiza o mais recente e registra a reconversão; senão, cria.
- **Atualizar:** só atualiza. Sem negócio aberto, o recebimento fica **Ignorado**, com o motivo.
- Alvo **Contato:** cria ou atualiza só o contato, sem negócio.
- Todo recebimento precisa de **e-mail ou telefone**.
- Para mudar o negócio pelo recebimento, mapeie os destinos **etapa** (nome da etapa ou posição de 1 a n), **dono** (e-mail ou o **Identificador nas integrações** do usuário) e **status** (`aberto`, `ganho` ou `perdido`; também vale `open`, `won`, `lost`). Valor que não existe no funil não derruba o recebimento: o resto é aplicado e o histórico mostra um aviso.

## Enviar webhooks (o CRM avisa outro sistema)
1. Em **Integrações → Webhooks de saída**, crie informando nome, endereço de destino e o **formato do envio**.
2. **Envelope do CRM:** escolha os eventos desejados e, se precisar, cabeçalhos extras. A assinatura vai em `X-CRM-Assinatura` (a tela traz exemplos de validação).
3. **Formato Clint:** escolha o método (**POST** com JSON ou **GET** com parâmetros na URL), os **gatilhos** (negócio criado, negócio entra na etapa X, negócio muda de etapa, negócio muda de status), cada um com filtro de funil, e os **campos enviados** (contato, negócio, etapa, status, dono, etiquetas, UTMs e personalizados), cada um com o nome que o destino espera. O formato não muda depois de criado.
4. O segredo aparece uma única vez. Use **Enviar teste** e acompanhe em **Entregas** (tentativas, status HTTP, **Reenviar**).
5. O CRM tenta de novo quando o destino falha; o destino que falha demais é **desativado sozinho** e aparece em destaque com o motivo.

## Erros comuns
- **401 na chamada** ("Assinatura ausente" ou "Assinatura inválida"): o sistema de origem não enviou `X-Assinatura` ou assinou outro texto. Assine exatamente o corpo bruto, sem reformatar o JSON.
- **410:** a integração está **desativada**. Ative em **Suas integrações**.
- **Erro "sem e-mail ou telefone":** mapeie ao menos um dos dois e confira o nome do campo no corpo recebido.
- **Contato criado, negócio não:** o alvo está em **Contato**, ou o modo é **Atualizar** e não havia negócio aberto.
- **Endereço antigo:** integrações anteriores ao assistente mostram **Endereço antigo**; use **Gerar novo endereço** (o anterior para na hora) e troque no sistema de origem.
- **Saída desativada sozinha:** corrija o destino e reative; use **Reenviar** nas entregas que falharam.
