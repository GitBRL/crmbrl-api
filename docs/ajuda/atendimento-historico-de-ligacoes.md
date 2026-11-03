---
titulo: Histórico de ligações: filtrar, buscar no que foi dito, ouvir e ler a transcrição
area: atendimento
telas: [/atendimento/ligacoes, /atendimento/ligacoes/:ligacaoId, /contatos/:id, /bi/atendimento]
papeis: Admin, C-level e líderes e membros de Comercial e CS (Marketing não usa o Atendimento). Cada pessoa vê só as ligações que o seu papel permite. Gravação, transcrição e resumo aparecem só nas ligações gravadas.
palavras-chave: [histórico de ligações, ligações, aba ligações, buscar na transcrição, transcrição, gravação, ouvir gravação, resumo da ligação, ligação perdida, filtros, atendente, fila, período, linha do tempo, painel da ligação, BI]
---
# Histórico de ligações: filtrar, buscar no que foi dito, ouvir e ler a transcrição

O Atendimento tem duas abas no topo: **Conversas** e **Ligações**. A aba **Ligações** (`/atendimento/ligacoes`) mostra todas as ligações do WhatsApp oficial, da mais recente para a mais antiga.

## Ver a lista e filtrar
Cada linha traz o nome do contato, a data e a hora, o resultado em texto (**Atendida**, **Perdida**, **Recusada**, **Sem resposta**, **Falhou** ou **Em andamento**), se foi recebida ou feita, a duração, quem atendeu e o canal. Quando a ligação foi gravada e resumida, aparece também o assunto.

Clique em **Filtros** (o botão ao lado da busca) para escolher:
- **Período:** 7, 30 ou 90 dias, **Tudo** ou **Outro período** (de uma data até outra). O padrão são os últimos 30 dias.
- **Direção:** todas, só recebidas ou só feitas.
- **Situação:** uma ou mais (atendidas, perdidas, recusadas, sem resposta, falharam, em andamento).
- **Atendente:** uma pessoa ou **Sem atendente (perdidas)**, que são as ligações que ninguém atendeu.
- **Fila** e **Conta do canal.**

O número ao lado do botão diz quantos filtros estão ligados; **Limpar filtros** volta ao padrão. Abaixo da busca, a tela diz quantas ligações casam com o que você escolheu. **Mostrar mais ligações** traz as seguintes. A lista se atualiza sozinha quando uma ligação termina.

## Buscar no que foi dito
O campo de busca procura no **texto das transcrições**. Não faz diferença entre maiúsculas e minúsculas, acentos ou plural e singular (buscar "preços" acha "preço"). Digite e espere um instante, ou aperte Enter.
- Aspas procuram a frase exata: `"segunda via"`.
- Um traço exclui uma palavra: `boleto -cancelar`.
- `or` entre duas palavras acha qualquer uma delas: `boleto or fatura`.

Cada ligação encontrada mostra até 3 trechos, com a palavra destacada, quem falou (**Atendente**, **Cliente** ou **Participante**) e o minuto. A busca só enxerga ligações **gravadas e já transcritas**; ligação sem gravação não aparece numa busca. Se nada for encontrado, a tela diz e oferece **Limpar a busca e os filtros**.

## Abrir uma ligação
Clique numa linha para abrir o painel ao lado (no celular, ele ocupa a tela; a seta volta para a lista). Em cima ficam o contato (o nome leva ao cadastro), o resultado, quando começou, a duração, o atendente e o canal, e o botão **Ver a conversa**. Abaixo:
- **Gravação:** o player de áudio. Só Admin e líderes podem baixar o arquivo.
- **Resumo:** assunto, pontos principais, combinados, próximos passos e o sentimento do cliente, escritos pelo Claude. As **atividades sugeridas** só viram atividade depois que você clica em **Criar** e confirma.
- **Transcrição:** o texto da ligação, com o tempo de cada trecho. **Clique num trecho** para ouvir exatamente aquele ponto. Use o campo de busca da transcrição para achar uma palavra; se você chegou pela busca da lista, ela já vem digitada.
- **Reprocessar:** o atendente da ligação, líderes e o Admin podem refazer a transcrição e o resumo se algo falhou.

Depois do prazo de guarda definido pelo Admin no canal, o áudio e a transcrição são apagados; o registro da ligação, a duração e o resumo continuam.

## Onde mais as ligações aparecem
- **Linha do tempo do contato e da empresa:** cada ligação entra com o resultado, a duração e o resumo. O filtro **Ligações** mostra só elas. **Ouvir e ler a transcrição** abre o painel ali mesmo; **Abrir a ligação** leva à tela completa.
- **Painel do contato, na conversa:** a seção **Ligações** lista as últimas cinco.
- **BI, aba Atendimento:** cartões de ligações recebidas, feitas, atendidas e perdidas, taxa de atendimento, espera e duração média, e os gráficos por hora do dia e por atendente (veja `bi-usar-paineis.md`).
