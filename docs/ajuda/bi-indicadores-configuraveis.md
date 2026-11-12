---
titulo: Montar e usar painéis de indicadores configuráveis
area: bi
telas: [/bi/indicadores]
papeis: Admin, C-level e líderes montam, editam, duplicam e excluem painéis (o líder só os que criou). Todos os papéis veem os painéis compartilhados com eles, só com os números que já podem ver.
palavras-chave: [indicadores, painel, configurável, meta, taxa de conversão, no-show, comparecimento, lead atendido, reuniões, ligações, compartilhar, time comercial, widget, ranking, exportar]
---
# Montar e usar painéis de indicadores configuráveis

Em **BI e relatórios**, a aba **Indicadores** reúne painéis feitos sob medida: taxa de conversão, leads atendidos, reuniões, no-show, comparecimento, ligações e mais. Cada pessoa vê **só os números que já veria** nas listas: o membro vê o que é dele, o líder a área e a diretoria tudo. Compartilhar um painel não mostra dados de ninguém além do que a pessoa já podia ver.

## Abrir um painel
1. Entre em **BI e relatórios** e escolha a aba **Indicadores**.
2. A lista mostra os seus painéis e os que foram compartilhados com você. Clique num painel para abri-lo.
3. No topo, escolha o **período** (hoje, 7 ou 30 dias, mês atual ou anterior, trimestre, ano ou outro intervalo de até 1 ano) e os **filtros**: funil, etapa, setor, equipe, pessoas, origem, UTM e etiquetas. **Atualizar** recalcula na hora (os números guardam 30 segundos).
4. Clique num número ou numa linha para abrir a lista que o sustenta, quando houver: negócios abertos, leads sem atendimento, as reuniões de um resultado, as atividades atrasadas, ou o quadro numa etapa.
5. **Planilha** e **CSV** exportam o painel com os mesmos filtros.

## Criar um painel (Admin, C-level e líder)
1. Em **Indicadores**, escolha **Novo painel** e dê um nome. Ou use o modelo **Time comercial**, que cria com um clique leads recebidos e atendidos, taxa de atendimento, tempo até o atendimento, reuniões, no-show, taxas de comparecimento e de no-show, conversão, ganhos, valor ganho, ranking por vendedor e ligações.
2. Em **Editar**, use **Adicionar indicador**: o catálogo é agrupado (Leads, Reuniões, Vendas, Ligações, Atividades) e tem busca.
3. Para cada indicador, escolha como mostrar: **Número** (com o período anterior e a variação), **Série** (por dia, semana ou mês), **Ranking** (por pessoa), **Por etapa**, **Barras** ou **Funil**. Alguns indicadores pedem um parâmetro (por exemplo as etapas de origem e de destino na conversão entre etapas).
4. Escolha a **largura** (1 a 3 colunas) e, se quiser, um título, filtros só daquele indicador e uma **meta**.
5. Reordene arrastando pela alça, ou com o teclado: foque a alça, aperte Espaço, use as setas e Espaço de novo para soltar.
6. **Salvar**.

## Metas
Em indicadores de número ou ranking, defina a meta do período: geral e, no ranking, **por pessoa**. A tela mostra a porcentagem alcançada e uma barra. Em indicadores em que menos é melhor (tempo até o atendimento, no-show), a meta é um teto.

## Compartilhar
Em **Compartilhar**, escolha setores, pessoas ou papéis. O líder compartilha só com o próprio setor e com pessoas dele; Admin e C-level, com qualquer um. Quem recebe vê o painel, mas não edita.

## Como os números são contados
- **Lead atendido:** o negócio teve a primeira interação de uma pessoa (ligação, mensagem enviada, e-mail ou atividade concluída). O tempo até o atendimento vai da criação à primeira interação.
- **Reuniões:** contam pelo início, sem as canceladas. **Comparecimento** = compareceu ÷ (compareceu + não compareceu); **no-show** é o inverso. Remarcadas e sem resultado ficam fora das taxas. Registre o resultado ao concluir a reunião.
- **Conversão:** ganhos ÷ (ganhos + perdidos) fechados no período. A **conversão dos leads do período** olha os criados no período e quantos já foram ganhos.
- **Ligações:** vêm de todas as ligações do CRM, qualquer que seja o provedor.
- Uma taxa sem base (por exemplo, nenhuma reunião com resultado) aparece como "—", não como zero.

## Se algo falhar
Se um indicador não puder ser calculado (por exemplo, o painel usa um funil que você não vê), só ele mostra o erro e **Tentar de novo**; os outros continuam funcionando.
