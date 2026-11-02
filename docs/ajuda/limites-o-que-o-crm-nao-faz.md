---
titulo: O que o CRM não faz (limites conhecidos)
area: inicio
telas: [todas as telas]
papeis: Todos (referência para reconhecer pedidos fora do escopo).
palavras-chave: [não existe, não faz, limite, funcionalidade inexistente, não tem, fora do escopo, sugestão, chamado, impossível, não suporta]
---
# O que o CRM não faz (limites conhecidos)

Use esta lista para reconhecer pedidos sem funcionalidade correspondente. Se o pedido está aqui, explique o limite e, se for algo que faria sentido existir, ofereça **Abrir chamado**. Se a lista não cobre o pedido e nenhum artigo o descreve, não invente: diga que não encontrou na documentação.

## Comunicação
- Os canais são só cinco: WhatsApp, chat do site, e-mail, Instagram e Messenger. Não há SMS, Telegram, nem ligação telefônica pelo CRM (a ligação é feita fora; o CRM mostra o telefone e registra o resultado).
- O WhatsApp usa conexão própria por QR code (não é a API oficial do WhatsApp Business). Mensagens de grupos de WhatsApp, status e canais são ignoradas.
- Instagram e Messenger só permitem responder até 24 horas depois da última mensagem do cliente (regra da Meta).
- Disparos enviam por WhatsApp e e-mail, um destinatário por vez, com intervalos: não é envio instantâneo em massa. Quem pediu opt-out não recebe.
- Nota interna e Chat da equipe nunca chegam ao cliente. Conversas diretas do chat só as duas pessoas leem, nem o Admin.

## Funis, contatos e dados
- Não se move um negócio direto para outro funil: isso acontece pelas passagens (Marketing → Comercial → CS), configuradas pelo Admin ou C-level.
- Os funis Marketing, Comercial e Customer Success não podem ser excluídos; etapa com negócios não pode ser removida; todo funil mantém uma etapa de ganho e uma de perda.
- Contato anonimizado não volta atrás. Só o Admin anonimiza.
- A auditoria não se edita nem se apaga.
- Reativar um usuário desligado não devolve o que foi encaminhado.

## Financeiro
- Não há conexão com bancos nem gateway de pagamento; não emite boleto, Pix nem nota fiscal. A baixa é manual ou por importação de planilha.
- Marketing não acessa o Financeiro.

## Relatórios e IA
- Os painéis do BI são os que existem na tela, com filtros e exportação em XLSX e CSV; não há construtor de painéis próprios.
- A análise por IA do BI é só do Admin e lê números agregados, sem dados pessoais.
- O assistente de Ajuda explica o uso, mas não executa ações no CRM, não vê dados de clientes e não substitui o Admin em decisões de permissão.

## Outros
- Sem aplicativo separado em lojas de aplicativos: o CRM é usado no navegador (também no celular).
- A interface é só em português.
- Não consta sincronização com agendas externas (Google Agenda, Outlook) nem conectores prontos de outros sistemas além de webhooks de entrada e saída.
- Mudar papel, líder, canais, integrações e senhas de outras pessoas é do Admin; o assistente não consegue fazer isso por você.

## Fora do escopo do assistente
Perguntas que nada têm a ver com o uso do CRM (política, programação, assuntos pessoais, jurídico) estão fora do escopo: diga que só ajuda com o uso do BRL CRM.
