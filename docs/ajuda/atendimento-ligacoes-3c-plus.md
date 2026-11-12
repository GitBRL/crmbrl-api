---
titulo: Ligações pelo 3C+: conectar, entrar na campanha, ligar e qualificar
area: atendimento
telas: [/configuracoes/perfil, /contatos/:id, /funis/:area/:negocioId, /atendimento/:conversaId, /atendimento/ligacoes, /funis/:area, /integracoes/3c-plus]
papeis: Todo vendedor conecta o próprio usuário e liga. Só o Admin configura a conexão da empresa. Admin, C-level e líderes enviam negócios ao discador.
palavras-chave: [3c+, 3cplus, discador, ligar, ligação, telefone, campanha, agente, pausa, qualificação, qualificar, conectar, desconectar, ramal, gravação, ligação recebida, receptivo, enviar ao discador, lista, mailing, filtrados, reconciliar, token]
---
# Ligações pelo 3C+: conectar, entrar na campanha, ligar e qualificar

O 3C+ é o discador de ligações da empresa. Com ele ligado ao CRM você liga pelo contato ou pelo negócio, o CRM guarda a ligação (com a gravação e a qualificação) na ficha e na linha do tempo, e o discador recebe os leads do funil. O áudio continua no seu 3C+ (o telefone ou o webphone dele); o CRM comanda a ligação.

## 1. Conectar o seu usuário (uma vez)
1. Abra **Meu perfil** e vá ao cartão **Conectar ao 3C+**. Se você clicar em **Ligar pelo 3C+** sem estar conectado, o CRM leva você direto até lá.
2. Digite o **usuário do 3C+** (o e-mail ou o ramal que você usa para entrar no 3C+) e a **senha do 3C+**.
3. Clique em **Conectar ao 3C+**.

A senha é usada **uma única vez**, para entrar no 3C+, e **não é guardada** no CRM. Só fica o token do agente, cifrado, e o ramal. Para sair, use **Desconectar do 3C+** no mesmo cartão. Se o Admin desvincular você (Integrações, aba 3C+), conecte de novo.

Se aparecer "A integração com o 3C+ não está ativa", peça ao Admin para ativá-la.

## 2. O painel do agente (barra de cima)
Depois de conectado, aparece na barra superior o botão do agente, com um ponto de cor e o estado:
- **Fora da campanha** (cinza): você não está em nenhuma campanha.
- **Manual** ou **Disponível** (verde): em campanha, pronto para ligar.
- **Em ligação** (azul), **Pós-atendimento** (amarelo, falta qualificar) e **Em pausa** (vermelho).

Clique no botão para abrir o painel: a campanha, o modo (manual, em que você liga; ou discador, em que o 3C+ liga para você), o tempo no estado e as ações. **Entrar na campanha** escolhe a campanha e o modo; **Sair da campanha** só vale quando você não está numa ligação. Em **Entrar em pausa** escolha o motivo; **Voltar da pausa** devolve você à campanha. Esc fecha o painel. No celular o botão mostra só o ícone e o ponto de cor.

Se a conexão ao vivo cair, o painel avisa "Reconectando…" e confere o estado de novo quando voltar.

## 3. Ligar
Use **Ligar pelo 3C+** ao lado do telefone: na ficha do contato, na aba Cliente e no cabeçalho do negócio e na conversa do Atendimento. O botão só aparece quando a empresa usa o 3C+.
- Se você ainda está **fora da campanha**, o CRM entra por você na campanha padrão e a barra mostra **Entrando na campanha…**.
- A **barra da ligação** fica no pé da tela, em qualquer página: nome (ou número), o estado (Chamando, Em ligação, Sem resposta, Falhou), o tempo e **Desligar**.
- Só uma ligação por vez. Se você ligar a partir de um negócio, a ligação entra nele.

## 4. Qualificar
Quando a ligação termina, abre o quadro **Qualificar a ligação**: escolha a qualificação (cada uma tem a sua cor), escreva a **observação** e, nas qualificações que permitem (por exemplo "Retornar depois"), defina o **retorno agendado**. **Depois** fecha sem qualificar; a barra e o painel do agente continuam mostrando **Qualificar**. Enquanto não qualificar você fica em pós-atendimento, e o 3C+ qualifica sozinho depois de um tempo.

## 5. Ligação recebida
Quando um cliente liga para o seu ramal, aparece um aviso com o **nome, a empresa, os negócios** e **Abrir a ficha**. Se o número não é de nenhum contato, o aviso mostra **Novo contato** e **Cadastrar contato** abre o cadastro com o telefone preenchido.

## 6. Ver as ligações
No **Histórico de ligações** (Atendimento) e na **linha do tempo** do contato, as ligações do 3C+ trazem o selo **3C+**, a **campanha** e a **qualificação**. A gravação aparece quando o 3C+ a entrega ("Ouvir e ler a transcrição"); depois vem a transcrição e o resumo, como nas outras ligações.

## 7. Enviar negócios ao discador (Admin, C-level e líder)
No quadro do funil, clique em **Selecionar**, marque os negócios e use **Enviar ao discador…**. Escolha a **campanha** e a **lista** (uma que já existe ou uma nova). O CRM mostra o relatório: quantos foram **importados** e quantos **filtrados**, com o motivo (sem telefone válido, número já ligado recentemente, na lista de bloqueio…).

## Para o Admin: conexão da empresa
Em **Integrações**, aba **3C+**: o endereço da API, o do socket, o formato dos eventos, o **token do gestor** (guardado cifrado; só os 4 últimos caracteres aparecem) e a **campanha padrão**. **Testar conexão** confere o token; o selo mostra se o **ouvinte de eventos** está conectado; **Reconciliar agora** recupera ligações cujos avisos se perderam. Abaixo, a lista de vendedores conectados, com **Desvincular**.

**Atenção ao trocar o endereço (o domínio) da API ou do socket:** o CRM só aceita endereços permitidos; ao trocar o domínio, o token do gestor é apagado e **todos os vendedores precisam conectar de novo**. A tela avisa antes de salvar. Se aparecer "O endereço do 3C+ configurado não é permitido", fale com o Admin.

## O que só a conta real do 3C+ confirma
A integração foi construída e testada contra um 3C+ simulado. Estes pontos só se confirmam com a conta real; se algo não bater, avise o suporte com o horário da ligação:
- O endereço e o caminho do socket, e o formato dos eventos (por isso ficam configuráveis na aba 3C+, com a opção Automático).
- Se o agente recebe só os eventos dele e se a qualificação gera um evento próprio.
- A lista de qualificações da campanha, o efeito de não qualificar e o discar com ou sem o DDI 55.
- Como o 3C+ identifica a ligação recebida e a campanha dela.
- O som: o CRM não toca o áudio; mantenha o webphone do 3C+ aberto para falar e ouvir.
- Limites de uso, tempo de guarda das gravações e fuso dos horários.
