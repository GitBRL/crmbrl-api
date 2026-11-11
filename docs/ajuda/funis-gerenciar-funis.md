---
titulo: Criar, configurar, arquivar e excluir funis (visibilidade e acessos)
area: funis
telas: [/configuracoes/funis, /configuracoes/funis/novo, /configuracoes/funis/:id, /funis/:area]
papeis: Ver a lista de funis: todos, só os que a pessoa vê. Criar e configurar: Admin, C-level e líder (no próprio setor). Quem só tem acesso extra abre o quadro, mas não configura.
palavras-chave: [funis, novo funil, criar funil, configurar funil, visibilidade, funil restrito, acessos, só ver, como membro, ver e editar todos, arquivar funil, excluir funil, funil-base, setor]
---
# Criar, configurar, arquivar e excluir funis

## Onde ver os funis
Abra Configurações e clique em Funis. A lista mostra todos os funis que você vê, agrupados por setor. Cada funil traz o nome, se é o funil-base do setor, se está arquivado, quem o vê ("Todo o setor" ou "Só líderes e convidados"), quantas etapas tem e o seu nível de acesso. Para ver os arquivados, marque "Mostrar arquivados". No quadro, o seletor de funis também agrupa por setor e inclui funis de outros setores que você enxerga por acesso.

Se a lista vier vazia, o funil do seu setor pode estar restrito a líderes e convidados, ou arquivado. Peça acesso a quem lidera o setor.

## O que cada nível faz
1. Só ver: vê todos os negócios, mas não cria, edita nem move nada.
2. Como membro: vê os negócios dele e os sem responsável; cria, assume, edita e move esses.
3. Ver e editar todos: vê, cria, edita e move todos os negócios e troca o responsável.
4. Configurar (líder do setor dono, C-level e Admin): tudo o acima, mais reabrir e excluir negócios e configurar o funil. Esse nível não se concede por acesso extra.

## Criar um funil
1. Em Configurações > Funis, clique em Novo funil (só Admin, C-level e líderes).
2. Preencha o nome. Admin e C-level escolhem o setor entre os ativos; o líder cria sempre no próprio setor.
3. Se quiser, escreva uma descrição e escolha quem vê o funil.
4. Ajuste as etapas: o funil já vem com Novo, Em andamento, Ganho e Perdido. Dá para renomear, reordenar, adicionar e remover etapas abertas (sempre ao menos uma). Todo funil tem exatamente uma etapa de ganho e uma de perda, que ficam no fim.
5. Clique em Criar funil. O quadro do funil novo abre em seguida. Nome repetido no setor aparece no campo Nome.

## Configurar um funil
Em Configurações > Funis, clique em Configurar no funil (ou em Configurar funil no quadro). A tela tem cinco blocos:
- Geral: nome e descrição.
- Etapas: a lista de etapas e o botão Editar etapas (prazo-alvo, probabilidade, ordem; veja "Configurar as etapas de um funil").
- Visibilidade: "Todo o setor" deixa todas as pessoas do setor dono verem o funil. "Só líderes e convidados" deixa só os líderes do setor; os membros e as pessoas de outros setores só entram se estiverem na lista de acessos do funil (os acessos gerais do setor não valem).
- Acessos: dê acesso a um setor inteiro ou a uma pessoa de outro setor, com o nível "Só ver", "Como membro" ou "Ver e editar todos". Dá para trocar o nível e remover. Clique em Salvar acessos: a lista que você enviar substitui a atual. Setor desativado e pessoa desligada continuam na lista, marcados, mas não podem ser incluídos de novo. O setor dono do funil não entra como alvo.
- Zona de perigo: arquivar e excluir.

## Arquivar, reativar e excluir
- Arquivar tira o funil do quadro e impede negócios novos; os negócios e o histórico ficam guardados. Reativar traz o funil de volta. O CRM recusa arquivar um funil usado por passagem ou webhook de entrada ativos e diz qual desativar antes.
- Excluir só vale para funis sem negócios abertos e que não sejam funil-base. O funil-base de cada setor só pode ser arquivado. Ao excluir, você digita o nome do funil para confirmar; se o CRM recusar, o motivo aparece na própria janela.

## Mensagens comuns
- "Você só pode ver este funil": seu nível é Só ver; peça "Como membro" ou mais.
- Responsável sem acesso: a pessoa precisa ter "Como membro" ou mais no funil para ser responsável por negócios.
- Reabrir negócio fechado e excluir negócio: só quem configura o funil.
