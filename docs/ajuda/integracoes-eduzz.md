---
titulo: Integração Eduzz — faturas, carrinhos abandonados e assinaturas
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [eduzz, chave de acesso, x-signature, fatura paga, carrinho abandonado, contrato, assinatura, ping, reembolso, chargeback, curso, tabela de eventos]
---
# Integração Eduzz

Recebe os eventos da **Eduzz** (faturas, carrinhos abandonados e assinaturas) e deixa você escolher o que cada evento faz no funil. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta de produtor na Eduzz com acesso ao **Console do Desenvolvedor** (Configurações > Webhook).
- Uma **chave de acesso**, que você define na configuração do webhook da Eduzz. É **opcional, mas recomendado**: a Eduzz assina o corpo (HMAC-SHA256, em hexadecimal ou base64) no cabeçalho `x-signature` e o CRM recusa assinatura ausente ou diferente. Guarde a chave como senha.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Eduzz**.
2. Em **Ação e nome**, dê um nome. Não há credencial de API.
3. Em **Endereço**, copie o endereço e defina a **Chave de acesso** (gerada pelo CRM ou combinada). Ela aparece uma única vez: use a mesma na Eduzz.
4. Na **tabela de eventos**, escolha o que cada evento faz (veja abaixo) e, se quiser, filtre por **produto**.
5. Em **Configurações**, escolha funil, etapa de entrada, etiquetas e distribuição. Termine em **Salvar e ativar**.

**Na Eduzz**
1. No **Console do Desenvolvedor**, abra **Configurações > Webhook** e clique em **+ Nova configuração**.
2. Dê um nome, defina a **chave de acesso** (a mesma do CRM), cole o endereço da integração como **URL de destino** e escolha os eventos: faturas (paga, aguardando pagamento, reembolsada, chargeback etc.), carrinho abandonado e contratos.
3. **Valide a URL:** a Eduzz envia o evento `ping` e espera resposta 200 a 299, que o CRM dá sem processar nada.
4. Se a Eduzz pedir os produtos, escolha os específicos ou todos.

## A tabela de eventos
Cada evento tem uma ação:
- **Ignorar:** nada acontece (**Ignorado**, com o motivo).
- **Criar ou atualizar negócio aberto:** abre o negócio do comprador na etapa que você escolher (sem escolha, vale a etapa de entrada).
- **Marcar como ganho:** ganho com valor e produto.
- **Marcar como perdido:** perdido com motivo (sem motivo, vale o motivo padrão da integração).
- **Só etiquetar o contato.**

Todas, menos Ignorar, podem somar etiquetas. Modelos prontos: **Vendas completas** (padrão: fatura paga vira ganho; fatura aberta, aguardando pagamento e carrinho abandonado abrem negócio na etapa inicial; fatura expirada, cancelada, reembolsada e chargeback viram perdido com motivo; em recuperação, reembolso solicitado e assinatura cancelada ou atrasada só etiquetam), **Só compras aprovadas** e **Recuperação de vendas**. O **filtro por produto** aceita nome ou ID; vazio significa todos.

## Como testar
Valide a URL na Eduzz (o `ping` aparece no histórico como **Ignorado**, "Evento de teste") e dispare um evento de teste. Em **Histórico** da Eduzz você reenvia os que falharam: o CRM ignora o evento repetido.

## O que aparece no histórico
Um recebimento por evento. **Processado** quando agiu; **Ignorado** (ping, evento configurado para ignorar, fora da tabela, produto fora do filtro ou **evento repetido**); **Erro** (falta e-mail e telefone, ou assinatura recusada na chegada, 401).

## Criar ou atualizar: etapa, dono e status
A tabela de eventos já decide etapa e status por evento. O modo e o alvo da integração valem como nas outras (**Criar**, **Criar ou atualizar**, **Atualizar**) e o dono vem da distribuição em **Configurações**. Reembolso e chargeback só encontram a compra se a **transação** for a mesma: mantenha `negocio.camposPersonalizados.transacao` no mapeamento; sem isso, só agem sobre negócio **aberto**.

## Erros comuns
- **401, "Assinatura ausente ou inválida":** a chave de acesso do CRM difere da configurada na Eduzz. Atualize um dos dois.
- **A Eduzz não valida a URL:** a integração precisa estar **Ativa** (desativada responde 410) e a chave igual nos dois lados.
- **Assinatura cancelada não aparece:** a Eduzz não tem evento próprio de cancelamento; o CRM deduz do `contract_updated` com `contract.status = canceled` (e deduz atrasada de `late`, `defaulter` ou `suspended`). Selecione os eventos de **contratos** na Eduzz.
- **Contrato sem comprador:** o evento de contrato pode vir sem dados do comprador. Se o CRM não achar e-mail nem telefone, o recebimento fica com **Erro**; confira no histórico.
- **Carrinho abandonado sem valor:** o comprador vem em `data.customer`, só com o ID dos produtos; as UTMs ficam em `data.tracker`.
- **Formato [INFERIDO]:** a Eduzz não publica exemplos com valores. Confira o **primeiro recebimento** de cada tipo de evento no histórico e ajuste o mapeamento.
