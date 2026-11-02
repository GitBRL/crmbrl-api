---
titulo: Ligações pelo WhatsApp: atender, ligar e pedir permissão ao cliente
area: atendimento
telas: [/atendimento/:conversaId, /contatos/:id, /atividades, /financeiro/regua, /configuracoes/canais/whatsapp-oficial/:id]
papeis: Atendem e ligam Admin, C-level e líderes e membros de Comercial e CS (Marketing não usa o Atendimento). Só o Admin configura as ligações do canal.
palavras-chave: [ligação, ligar, atender, softphone, telefone, chamada, whatsapp oficial, permissão para ligar, pedir permissão, mudo, microfone, alto-falante, encerrar, ligação perdida, retornar ligação, anotação, calls, webhook, celular, tela bloqueada, push, gravação]
---
# Ligações pelo WhatsApp: atender, ligar e pedir permissão ao cliente

As ligações funcionam no canal **WhatsApp oficial** (API da Meta). A voz vai direto entre o navegador de quem atende e a Meta: não é preciso telefone, headset especial nem programa. Basta um microfone e o CRM aberto.

## Atender uma ligação
1. Quando um cliente liga, aparece um aviso no canto da tela, **em qualquer página do CRM**, com o nome, o número, a empresa e o canal. O CRM toca um som e, para quem usa leitor de tela, anuncia a ligação.
2. Clique em **Atender** (ou use **Alt+A**). O navegador pode pedir permissão para usar o microfone na primeira vez: clique em **Permitir**.
3. **Recusar** (ou **Alt+R**) apenas silencia o toque para você. A ligação continua tocando para os outros atendentes da fila e vira **perdida** se ninguém atender dentro do tempo de toque.
4. Se outra pessoa atender primeiro, o aviso some e o CRM mostra quem atendeu.

Quem toca primeiro é o responsável pela conversa ou pelo contato, se estiver online e livre. Se não houver, toca para todos os atendentes online e livres da fila das ligações.

Se o som do toque não sair, o aviso diz "O toque está sem som": clique em qualquer lugar da página uma vez. O navegador só libera o som depois de um clique seu.

## Durante a ligação
Uma **barra fica fixa no pé da tela** e acompanha você por todas as páginas. Navegar não derruba a ligação.
- **Nome e tempo.** O nome leva ao contato.
- **Mudo (Alt+M).** Desliga só o seu microfone; o cliente continua ouvindo o silêncio da linha e você continua ouvindo.
- **Encerrar (Alt+E).** Desliga na hora. A duração fica registrada.
- **Ajustes.** Escolha o **microfone** e o **alto-falante** (nem todo navegador deixa trocar o alto-falante) e escreva a **anotação rápida**. A anotação é salva sozinha e vai para a descrição da atividade da ligação.
- **Gravando.** Quando o canal está configurado para gravar, a barra mostra o indicador "Gravando". Avise o cliente.
- **Aviso de conexão ruim.** Se o áudio começa a falhar, a barra avisa. Se o áudio nem conectar (algumas redes de empresa bloqueiam chamadas de voz pela internet), ela sugere trocar de rede.
- **Sem conexão com o CRM.** A conversa continua, mas se a conexão não voltar em 15 segundos a ligação é encerrada.

No celular a barra vira uma faixa compacta (nome, tempo, mudo e encerrar); toque na seta para abrir os ajustes.

Se você recarregar a página no meio da ligação, o áudio se perde. A barra mostra que a ligação segue aberta "sem áudio nesta aba" e só deixa **Encerrar**. Feche a ligação por ali.

## Ao terminar
- O CRM registra a duração e o motivo, cria ou conclui a **atividade de ligação** do contato (com sua anotação) e põe um registro na conversa do Atendimento.
- Se ninguém atendeu, a ligação vira **perdida**: o CRM cria a atividade **Retornar ligação**, avisa por notificação e, se o Admin ativou a mensagem de ligação perdida, manda uma mensagem automática ao cliente.

## Ligar para um cliente
O botão **Ligar** aparece:
- no **contato** (bloco "Contato"), junto do estado da permissão;
- na **conversa** do Atendimento (ícone de telefone no topo e botão no painel do contato), quando a conversa é do WhatsApp oficial;
- na **atividade de ligação** aberta (inclui a etapa de ligação da **régua de cobrança**). Ao ligar daqui, a ligação cumpre a atividade.

O botão não aparece se o canal não tem ligações ativas, se o Admin escondeu o botão ou se o seu papel não usa o Atendimento.

### A permissão do cliente
A Meta só deixa a empresa ligar para quem **permitiu**. O CRM mostra o estado ao lado do botão:
- **Permissão concedida até (data):** pode ligar. A permissão temporária vale 7 dias; a permanente não vence.
- **Aguardando o cliente:** o pedido foi enviado e o cliente ainda não tocou em "Permitir".
- **O cliente não permitiu**, **Permissão retirada** ou **Permissão vencida:** é preciso pedir de novo.
- **Sem permissão para ligar:** nunca houve pedido.

Antes de cada ligação o CRM confere a permissão na Meta, porque ela não avisa quando a permissão vence.

### Pedir permissão para ligar
1. Clique em **Ligar** (ou em **Pedir permissão** ao lado do estado). Sem permissão, abre a janela **Ligar para (nome)**.
2. Escreva uma mensagem (opcional) e clique em **Pedir permissão para ligar**. O cliente recebe no WhatsApp uma mensagem com um botão para permitir.
3. Quando ele permitir, o estado muda sozinho e o botão **Ligar** libera.

Dentro da janela de 24 horas o pedido vai como mensagem normal. Fora dela, vai por um **template aprovado** com o botão de permissão; se o canal não tem esse template, o CRM avisa e o Admin precisa criá-lo na Meta.

### Os limites da Meta
A janela mostra, sempre antes de bater neles:
- no máximo **1 pedido por dia** e **2 por semana** para o mesmo cliente (mostra quantos restam e quando poderá pedir de novo);
- **4 ligações seguidas sem resposta** fazem a Meta retirar a permissão;
- há um **limite diário de ligações feitas** por número; se for atingido, o CRM diz até quando.

### Como a chamada aparece
A barra mostra **Chamando…**, depois **Tocando no WhatsApp do cliente…** e, quando ele atende, o tempo. Se o cliente recusar ou não atender, a barra diz "O cliente recusou a ligação" ou "O cliente não atendeu". Se algo falhar (por exemplo, a Meta não respondeu), a barra diz o motivo. Você pode cancelar a chamada enquanto ela toca, com **Cancelar** ou **Encerrar**.

## Erros comuns
- **"O navegador não deixou o CRM usar o microfone".** Clique no cadeado ao lado do endereço, permita o microfone e tente de novo. O CRM só usa o microfone em endereço seguro (https).
- **"Você já está em uma ligação".** Cada atendente tem uma ligação por vez.
- **Sem botão Ligar.** Veja a lista acima; o Admin pode ter desativado as ligações do canal.
- **Sem som da ligação.** Confira o alto-falante nos ajustes da barra e o volume do sistema.

## No celular
Atender e ligar funcionam **com o CRM aberto** na tela. Com o **celular bloqueado ou o aplicativo em segundo plano** o navegador não mantém o CRM ativo, então a ligação **não toca**: chega apenas uma notificação (se você ativou os avisos no aparelho) com o botão **Abrir ligação**. Ao tocar nela, o CRM abre; se a ligação ainda estiver tocando, o aviso de atender aparece. Passado o tempo de toque, ela vira perdida e o CRM cria a atividade "Retornar ligação". Isso é uma limitação dos navegadores de celular, não do CRM. Para não perder ligações, mantenha o CRM aberto e a tela ligada, ou atenda pelo computador.

Ative os avisos em **Meu perfil > No celular** e deixe marcado **Ligação recebida**.

## Configurar as ligações do canal (Admin)
Em **Configurações > Canais > WhatsApp oficial**, abra o canal e a aba **Ligações**:
- **Ativar ligações** liga as chamadas no número, na Meta. Se a Meta recusar, nada é salvo e a tela explica o motivo (por exemplo, limite de mensagens abaixo de 2.000 por dia).
- **Fila que atende** e **horário das ligações** (padrão: o horário de atendimento). Fora do horário a ligação vira perdida.
- **Mostrar o botão Ligar** para o cliente liga e desliga o botão no CRM.
- **Tempo de toque**, de 10 a 40 segundos (a Meta só espera de 30 a 60).
- **Gravar as ligações** (a gravação roda no navegador de quem atende).
- **Mensagem para ligação perdida:** resposta automática ao cliente (desligada por padrão).

### O que a Meta exige
1. O número fica **só na API oficial**; não funciona junto com o aplicativo WhatsApp Business no celular (coexistência).
2. Limite de mensagens de **2.000 ou mais** por dia no Meta Business.
3. **Forma de pagamento** cadastrada na conta: as ligações feitas pela empresa são cobradas por minuto.
4. No painel do app da Meta, em Webhooks, assine também o campo **calls**, no mesmo endereço do canal.
5. O cliente precisa **permitir** as ligações da empresa.
6. O áudio vai direto do navegador para a Meta: use o CRM em https, permita o microfone e evite redes que bloqueiam chamadas de voz pela internet.
