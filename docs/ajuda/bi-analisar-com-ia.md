---
titulo: Analisar um painel do BI com IA
area: bi
telas: [/bi, /bi/analises]
papeis: Só o Admin. Os demais papéis não veem o botão.
palavras-chave: [análise por ia, analisar com ia, claude, insights, riscos, ações recomendadas, histórico de análises, perguntar]
---
# Analisar um painel do BI com IA

1. Como Admin, abra o painel desejado em **BI e relatórios** e clique em **Analisar com IA**.
2. O modal mostra o painel lido, o período e quantas análises restam hoje. A IA lê só números agregados, sem dado pessoal.
3. Clique em **Gerar análise**. O texto aparece aos poucos e termina com "Análise pronta: N destaques, N riscos e N ações".
4. O resultado traz Resumo, Destaques, Riscos e Ações recomendadas (com prioridade e link para a lista que as sustenta).
5. Para aprofundar, use "Perguntar sobre esta análise" (até 1.000 caracteres e 5 perguntas).

O histórico (quem pediu, painel, filtros, tokens e resultado) fica em **Análises** (`/bi/analises`). Se o modal disser que não há chave configurada, quem administra o servidor precisa definir a chave da IA. Se o limite diário estourar, o aviso mostra a hora em que volta.
