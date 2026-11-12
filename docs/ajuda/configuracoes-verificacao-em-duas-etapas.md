---
titulo: Ativar a verificação em duas etapas
area: configuracoes
telas: [/configuracoes, /entrar]
papeis: Todos ativam a própria. Só o Admin redefine a de outra pessoa.
palavras-chave: [verificação em duas etapas, 2fa, duas etapas, código, autenticador, aplicativo autenticador, qr code, código de recuperação, perdi o celular, segurança, login, google authenticator]
---
# Ativar a verificação em duas etapas

A verificação em duas etapas é opcional: com ela, além da senha, você digita um código de 6 dígitos que muda a cada 30 segundos num aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy, 1Password etc.). Mesmo que alguém descubra sua senha, não entra sem o seu celular.

## Ativar
1. Abra **Meu perfil** e, no cartão **Verificação em duas etapas**, clique em **Ativar**.
2. No aplicativo, leia o QR code. Se não puder ler, escolha digitar a chave que aparece abaixo dele.
3. Digite o código de 6 dígitos que o aplicativo mostra e clique em **Confirmar**.
4. Guarde os **10 códigos de recuperação**: eles aparecem só agora. Use **Copiar** ou **Baixar .txt** e guarde num lugar seguro (um gerenciador de senhas, por exemplo). Marque que guardou para fechar.

## Entrar com a verificação ativa
1. Digite e-mail e senha como sempre.
2. Digite o código de 6 dígitos do aplicativo. Você tem 5 minutos e 5 tentativas; passando disso, volte e entre de novo.
3. Sem o celular, escolha **Usar um código de recuperação** e digite um dos seus 10 códigos. Cada um vale uma vez só, e você recebe um aviso no CRM quando usa um.

Errar o código conta como errar a senha: 5 erros seguidos bloqueiam o e-mail por 15 minutos.

## Gerar novos códigos de recuperação
No cartão, clique em **Gerar novos códigos** e digite um código do aplicativo. Os códigos antigos deixam de valer.

## Desativar
No cartão, clique em **Desativar**, digite sua senha atual e um código (do aplicativo ou de recuperação).

## Perdi o celular e os códigos
Peça a um Admin: em **Configurações > Usuários**, na linha da pessoa, a ação **Redefinir verificação em duas etapas** desliga a proteção. A pessoa é avisada por notificação, a ação fica na auditoria e ela pode entrar só com a senha e ativar de novo.

## Observações
- A troca obrigatória de senha e o "esqueci minha senha" continuam funcionando; o código é pedido no login seguinte.
- Se o código do aplicativo for recusado sempre, confira a data e a hora do celular (devem estar em horário automático).
