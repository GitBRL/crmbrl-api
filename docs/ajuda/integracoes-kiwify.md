---
titulo: Integração Kiwify — vendas, Pix, boletos, carrinhos e assinaturas
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [kiwify, token do webhook, signature, compra aprovada, pix gerado, boleto gerado, carrinho abandonado, reembolso, chargeback, assinatura, curso, tabela de eventos]
---
# Integração Kiwify

Recebe os eventos da **Kiwify** (venda aprovada, Pix e boleto gerados, compra recusada, carrinho abandonado, reembolso, chargeback e assinaturas) e deixa você escolher o que cada evento faz no funil. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta de produtor na Kiwify com acesso a **Apps > Webhooks**.
- Um **token do webhook**, que você mesmo define ao criar o webhook na Kiwify. É **opcional, mas recomendado**: a Kiwify acrescenta ao endereço o parâmetro `signature` (HMAC-SHA1 do corpo, usando o token) e o CRM recusa assinatura ausente ou diferente. Guarde o token como senha.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Kiwify**.
2. Em **Ação e nome**, dê um nome. Não há credencial de API.
3. Em **Endereço**, copie o endereço e defina o **Token do webhook** (gerado pelo CRM ou combinado). Ele aparece uma única vez: use o mesmo na Kiwify.
4. Na **tabela de eventos**, escolha o que cada evento faz (veja abaixo) e, se quiser, filtre por **produto**.
5. Em **Configurações**, escolha funil, etapa de entrada, etiquetas e distribuição. Termine em **Salvar e ativar**.

**Na Kiwify**
1. Abra **Apps > Webhooks** e clique em **Criar Webhook**.
2. No painel lateral, escolha o produto (ou todos) e os eventos (compra aprovada, boleto gerado, Pix gerado, compra recusada, carrinho abandonado, reembolso, chargeback, assinatura cancelada, atrasada e renovada).
3. Cole o endereço da integração, defina o **token** (o mesmo do CRM) e clique em **Criar**.
4. Use **Testar Webhook** (com dados fictícios).

## A tabela de eventos
Cada evento tem uma ação:
- **Ignorar:** nada acontece (**Ignorado**, com o motivo).
- **Criar ou atualizar negócio aberto:** abre o negócio do comprador na etapa que você escolher (sem escolha, vale a etapa de entrada).
- **Marcar como ganho:** ganho com valor (convertido de centavos para reais) e produto.
- **Marcar como perdido:** perdido com motivo (sem motivo, vale o motivo padrão da integração).
- **Só etiquetar o contato.**

Todas, menos Ignorar, podem somar etiquetas. Modelos prontos: **Vendas completas** (padrão: venda aprovada vira ganho; Pix e boleto gerados, compra recusada e carrinho abandonado abrem negócio na etapa inicial; reembolso e chargeback viram perdido com motivo; assinatura cancelada, atrasada e renovada só etiquetam), **Só compras aprovadas** e **Recuperação de vendas**. O **filtro por produto** aceita nome ou ID; vazio significa todos.

## Como testar
Use **Testar Webhook** na Kiwify e abra **Integrações → Histórico**. Em **Ver logs** da Kiwify você pode **reenviar** os que falharam: o CRM ignora o evento repetido.

## O que aparece no histórico
Um recebimento por evento. **Processado** quando agiu; **Ignorado** (evento configurado para ignorar, fora da tabela, produto fora do filtro ou **evento repetido**: a Kiwify pode mandar o mesmo evento mais de uma vez e o CRM não duplica); **Erro** (falta e-mail e telefone, ou assinatura recusada na chegada, 401).

## Criar ou atualizar: etapa, dono e status
A tabela de eventos já decide etapa e status por evento. O modo e o alvo da integração valem como nas outras (**Criar**, **Criar ou atualizar**, **Atualizar**) e o dono vem da distribuição em **Configurações**. Reembolso e chargeback só encontram a compra se a **transação** for a mesma: mantenha `negocio.camposPersonalizados.transacao` no mapeamento; sem isso, só agem sobre negócio **aberto**. Reembolso ou chargeback de uma cobrança de assinatura também cancelam a assinatura: chegam ainda como **assinatura cancelada**.

## Erros comuns
- **401, "Assinatura ausente ou inválida":** o token no CRM difere do token do webhook na Kiwify. Atualize um dos dois para ficarem iguais. Cole o endereço sem alterá-lo: a Kiwify acrescenta sozinha o parâmetro `signature` e o endereço aceita essa query string.
- **Valor errado (cem vezes maior):** a Kiwify manda centavos; o modelo divide por 100 em `calculado.valor`. Se trocou o mapeamento, use `calculado.valor` no campo **valor**.
- **Carrinho abandonado sem dados:** o formato dele é próprio (sem `order_id`); nome, e-mail, telefone e produto vêm na raiz.
- **Tudo "Ignorado" por "Evento não está na tabela":** acrescente o código do evento à tabela.
- **Formato [INFERIDO]:** a Kiwify não publica a lista de campos do webhook de venda. Os nomes (`Customer`, `Product`, `Commissions`, `TrackingParameters`), os centavos e o carrinho foram inferidos. Use **Testar Webhook**, confira o **primeiro recebimento** no histórico e ajuste o mapeamento.
