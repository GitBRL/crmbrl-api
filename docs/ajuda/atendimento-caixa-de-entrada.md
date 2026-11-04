---
titulo: Caixa de entrada do Atendimento e como as conversas chegam
area: atendimento
telas: [/atendimento, /atendimento/:conversaId]
papeis: Admin e C-level veem todas as conversas; líder, as filas da sua área; membro de Comercial ou CS, as suas e as sem responsável da área. Marketing não acessa o Atendimento.
palavras-chave: [atendimento, caixa de entrada, conversas, whatsapp, e-mail, instagram, messenger, chat do site, minhas, sem responsável, todas, sla, tempo de espera]
---
# Caixa de entrada do Atendimento

O **Atendimento** reúne as conversas de WhatsApp, chat do site, e-mail, Instagram e Messenger numa só tela. No celular, mostra uma coluna por vez.

## Lista de conversas
1. Escolha a aba **Minhas**, **Sem responsável** ou **Todas** (as que o seu papel vê). Cada aba mostra um contador.
2. Busque por nome, telefone ou e-mail e filtre por canal, status (Em aberto, Aguardando o contato, Resolvidas) e etiqueta, e use os atalhos **Não lidas**, **Prazo estourado** e **Atendidas pela IA** (conversas em que o SDR com IA está falando com o lead; veja `atendimento-sdr-ia.md`). Esses filtros ficam atrás do botão **Filtros**.
3. Cada linha mostra o canal, a prévia da última mensagem, as não lidas, o responsável e o tempo de espera. O tempo fica coral quando passa do SLA da fila.
4. Conversas novas entram no topo sem recarregar a página.

## Como a conversa chega a alguém
A conversa nova vai para a fila do canal. A fila distribui por **rodízio**, por **menor carga** ou **manual** (a conversa fica sem responsável até alguém assumir). Veja o artigo de filas e SLA.

## Atalhos de teclado
Alt+↓ e Alt+↑ trocam de conversa; Alt+L vai à lista, Alt+B à busca, Alt+M ao campo de mensagem e Alt+C ao painel do contato. No Mac, em vez de Alt use **Control+Shift** (a tecla Option escreve letras especiais). Durante uma ligação, Alt+S silencia o microfone e Alt+E encerra. A dica de atalhos da tela (o "?" ao lado do título) mostra os atalhos certos para o seu computador.

## Conversas e ligações
No topo do Atendimento há duas abas: **Conversas** e **Ligações**. Em **Ligações** fica o histórico de chamadas, com filtros e busca no texto das transcrições (veja `atendimento-historico-de-ligacoes.md`).

Se a tela mostrar "Sem acesso", o seu papel (por exemplo, Marketing) não usa o Atendimento.
