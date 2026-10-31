---
titulo: Conectar um número de WhatsApp
area: configuracoes
telas: [/configuracoes/canais, /configuracoes/canais/whatsapp/:id]
papeis: Só o Admin cadastra, conecta, desconecta, pausa e exclui canais.
palavras-chave: [whatsapp, qr code, conectar número, desconectar, aquecimento, limite diário, banimento, canal, pausar número]
---
# Conectar um número de WhatsApp

1. Abra a tela de canais (endereço `/configuracoes/canais`; ela não tem aba na barra de seções de Configurações), clique em **Novo canal** e escolha WhatsApp.
2. Na tela do canal, em **Conexão**, aparece o QR code ao vivo, com contagem regressiva (ele se renova sozinho). O passo a passo na tela explica quem nunca conectou.
3. No celular do número, abra o WhatsApp, vá em aparelhos conectados e leia o QR.
4. Quando conectar, a tela mostra o número e o botão **Desconectar**. O mesmo celular não pode ficar em dois canais.

## Proteções do número
A tela mostra os envios de hoje contra o limite, o ritmo entre envios e o **aquecimento** (nos primeiros 14 dias o limite diário sobe aos poucos). Há pausar e retomar. O CRM pausa sozinho depois de falhas seguidas ou de limite imposto pelo WhatsApp. Reconectar pelo CRM tira a pausa automática.

Se o número desconectar, as campanhas esperam e o Atendimento não envia até reconectar.
