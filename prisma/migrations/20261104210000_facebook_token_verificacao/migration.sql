-- Onda H (R32.14): token de verificação do webhook de páginas, por conexão (cifrado).
ALTER TABLE "conexoes_facebook" ADD COLUMN "token_verificacao_cifrado" TEXT;
