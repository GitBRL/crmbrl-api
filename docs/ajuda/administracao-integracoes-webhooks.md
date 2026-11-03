---
titulo: Webhooks de entrada (captar leads) e de saída (avisar outros sistemas)
area: administracao
telas: [/integracoes]
papeis: Só o Admin.
palavras-chave: [webhook, integração, captação de leads, formulário, api, assinatura, hmac, entrega, reprocessar, reenviar, url secreta]
---
# Webhooks de entrada e de saída

Abra **Integrações** (menu **Sistema**).

## Webhook de entrada (receber leads de formulários e outros sistemas)
1. Clique para criar e siga os passos: (1) nome e destino (funil, etapa, distribuição); (2) mapeamento dos campos: modelo pronto (Genérico, Disparos BRL) ou personalizado, com prévia num JSON de exemplo; (3) segurança (segredo de assinatura opcional).
2. Ao concluir, o CRM mostra a **URL uma única vez**, com botão copiar e um exemplo `curl`. Guarde-a.
3. Na aba **Recebimentos**, veja cada chamada, o resultado e **Reprocessar**.
O painel permite simular, gerar novo endereço (o antigo para na hora), exigir ou remover a assinatura, desativar e excluir (com confirmação forte). A assinatura de entrada usa o cabeçalho `X-Assinatura`.

## Webhook de saída (avisar outro sistema quando algo acontece)
1. Crie informando nome, URL, os eventos desejados (cada um tem descrição) e cabeçalhos extras. O segredo aparece uma vez.
2. Use **Enviar teste**. Na aba **Entregas** veja tentativas, status HTTP e **Reenviar**.
2b. O evento **Ligação encerrada** (`ligacao.encerrada`) avisa quando uma ligação do WhatsApp oficial termina, com o contato, o atendente, o resultado, a duração e a espera. Nunca leva o áudio, a transcrição nem as atividades sugeridas. O **resumo** só vai se o Admin ligar **Incluir o resumo da ligação no webhook** nas configurações das ligações do canal; nesse caso o evento espera o resumo ficar pronto (até 20 minutos).
3. O destino que falha demais é desativado sozinho e aparece em destaque com o motivo. A assinatura de saída usa `X-CRM-Assinatura`; a tela traz exemplos de como validar.
