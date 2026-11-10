---
titulo: Importar contatos e empresas de uma planilha
area: importacao
telas: [/contatos/importar, /contatos]
papeis: Admin, C-level e líderes. Membros não importam. Cada pessoa vê o histórico das suas importações (Admin e C-level veem todas).
palavras-chave: [Clint, exportação do Clint, conferir funis, tradução de funil, negócio ganho, negócio perdido, ID do negócio, filtro da planilha, negócio para todos, funil, etapa, sem cabeçalho, DDI, importar, planilha, csv, excel, xlsx, mapeamento de colunas, duplicados, relatório, importação, lista de contatos]
---
# Importar contatos e empresas de uma planilha

1. Em **Contatos e empresas**, clique em **Importar planilha** (só aparece para quem pode). A tela tem duas abas: **Nova importação** e **Execuções**. O botão **Ver tutorial** mostra este passo a passo.
2. **Arquivo**: escolha se vai importar contatos ou empresas e solte a planilha CSV ou Excel (até 10 MB e 50 mil linhas). Se preferir, clique em **Baixar planilha modelo**: as colunas já vêm certas e são reconhecidas sozinhas.
3. **Opções do arquivo**:
   - **Arquivo tem cabeçalho**: desligue para planilhas sem cabeçalho; as colunas viram "Coluna 1", "Coluna 2"… e a linha 1 é dado.
   - **Delimitador** e **Acentuação** (só CSV) são detectados sozinhos, mas dá para trocar; no Excel, escolha a **aba**.
   - **Contatos duplicados** (mesmo e-mail ou telefone): completar o que está vazio, pular quem já existe ou trocar pelos dados da planilha. O "?" ao lado explica.
   - **DDI padrão**: usado nos telefones sem `+` nem `00` que ainda não começam com ele (o padrão `55` segue a regra brasileira).
4. **Para todos os registros** (opcional):
   - **Etiquetas para todos** e "De onde vem esta lista?" (origem).
   - **Responsável para todos**: quem importou, rodízio da área ou uma pessoa fixa. A coluna "Responsável" (e-mail ou nome de um usuário ativo) tem prioridade e define o dono do contato novo e do negócio.
   - **Negócio para todos** (só contatos): escolha funil e etapa (e, se quiser, título e valor) para criar um negócio para cada contato importado. As colunas **Funil**, **Etapa**, **Título** e **Valor** da planilha valem linha a linha e têm prioridade; funil e etapa são achados pelo nome, sem ligar para maiúsculas, acentos ou espaços a mais. Se o contato já tem negócio aberto naquele funil, a importação registra uma reconversão em vez de criar outro. Funil inexistente ou sem permissão não impede o contato de entrar: a linha leva um aviso. Cada responsável recebe uma única notificação com o total de negócios da importação.
   - **Negócio ganho ou perdido**: com a coluna **Status do negócio** (Aberto, Ganho ou Perdido), o negócio nasce já fechado, direto na etapa de ganho ou de perda do funil, sem passar por passagens para outro funil. Use também **Motivo da perda**, **Data do ganho**, **Data da perda** e **Data de criação do negócio** (`dd/mm/aaaa`, com hora opcional, horário de Brasília). Datas inválidas ou futuras são ignoradas com um aviso.
   - **ID do negócio na origem**: com essa coluna, importar de novo o mesmo ID não cria outro negócio. Conforme a opção de duplicados, o negócio é pulado, completado (só o que está vazio) ou atualizado e movido de etapa. Serve para importar um arquivo grande em partes. O contador **negócios atualizados** mostra quantos foram tocados.
5. **Filtrar linhas da planilha** (opcional): importe só as linhas que passam em até 10 regras sobre qualquer coluna, mesmo as que você não vai importar (é igual a, contém, começa com, é um destes, está vazio, maior que…), combinadas por "todas" ou "qualquer uma". A contagem mostra quantas linhas passam; as demais ficam como "fora do filtro".
6. **Mapeamento de colunas**: diga o que é cada coluna (nome, e-mail, telefone, empresa, cargo, etiquetas, campos personalizados, funil, etapa, responsável…) ou "Ignorar coluna". O CRM sugere o mapeamento, mostra uma amostra de cada coluna e as primeiras linhas que passam no filtro; dá para salvar e aplicar **modelos de mapeamento** (o modelo guarda também filtro, negócio e DDI). Nome e e-mail ou telefone são obrigatórios.
7. **Exportação do Clint**: se a planilha tem as colunas `origin`, `stage`, `status` e `user_email`, o CRM avisa que parece uma exportação do Clint e já liga as colunas (`origin` → Funil, `stage` → Etapa, `status` → Status do negócio, `lost_status` → Motivo da perda, `user_email` → Responsável, `id` → ID do negócio, `complete_phone` → Telefone). No Clint o funil se chama "origem"; a coluna `origem` em minúsculas (campo de formulário) não vira funil. Abaixo do mapeamento, **Funis e etapas da planilha** confere, para cada funil, quantas linhas há (abertas, ganhas e perdidas) e se ele existe no CRM. Quando não existe, escolha **Usar o funil** (traduz o nome da planilha para um funil seu) ou, se você pode configurar funis, **Criar funil**. O mesmo vale para as etapas das linhas abertas (**Usar a etapa** ou **Criar etapa**). Linhas sem destino não bloqueiam: o contato entra e a linha leva um aviso. As traduções ficam guardadas no modelo de mapeamento.
8. **Criar importação**: o botão só habilita quando não falta nada (o rodapé diz o que falta). O processamento acontece em segundo plano.
9. **Execuções**: acompanhe a barra de andamento e os contadores (criados, atualizados, ignorados, com erro, fora do filtro, negócios criados, reconversões e atualizados). O "Resultado linha a linha" mostra o motivo de cada erro ou aviso. É possível cancelar, retomar e **Baixar relatório (Excel)**.

Você pode sair e voltar: o rascunho fica guardado. A lista importada pode ser usada como público de uma campanha de Disparos. Para importar parcelas do Financeiro, veja o artigo próprio.
