/** Modelos dos e-mails da API (texto e HTML simples, sem dependências). */
import type { MensagemEmail } from './email.service';

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatarDataHora(data: Date): string {
  return data.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function html(
  titulo: string,
  paragrafos: string[],
  botao: { texto: string; link: string },
): string {
  const corpo = paragrafos
    .map((paragrafo) => `<p>${escaparHtml(paragrafo)}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="pt-BR"><body style="font-family: Helvetica, Arial, sans-serif; color: #111; line-height: 1.5;">
<h2>${escaparHtml(titulo)}</h2>
${corpo}
<p><a href="${escaparHtml(botao.link)}" style="display: inline-block; padding: 10px 18px; background: #000; color: #fff; text-decoration: none; border-radius: 6px;">${escaparHtml(botao.texto)}</a></p>
<p style="color: #555; font-size: 13px;">Se o botão não funcionar, copie este endereço no navegador:<br>${escaparHtml(botao.link)}</p>
</body></html>`;
}

/** Convite para definir a primeira senha (R2.8). */
export function modeloConvite(dados: {
  para: string;
  nome: string;
  link: string;
  expiraEm: Date;
}): MensagemEmail {
  const titulo = 'Seu acesso ao BRL CRM';
  const paragrafos = [
    `Olá, ${dados.nome}!`,
    'Você foi convidado para usar o BRL CRM. Defina sua senha pelo link abaixo.',
    `O link vale até ${formatarDataHora(dados.expiraEm)} e só pode ser usado uma vez.`,
  ];
  return {
    para: dados.para,
    assunto: titulo,
    texto: [...paragrafos, '', dados.link].join('\n'),
    html: html(titulo, paragrafos, {
      texto: 'Definir minha senha',
      link: dados.link,
    }),
  };
}

/** Redefinição de senha ("esqueci minha senha", R2.8). */
export function modeloRedefinicao(dados: {
  para: string;
  nome: string;
  link: string;
  expiraEm: Date;
}): MensagemEmail {
  const titulo = 'Redefinição de senha do BRL CRM';
  const paragrafos = [
    `Olá, ${dados.nome}!`,
    'Recebemos um pedido para redefinir a sua senha. Para criar uma nova, use o link abaixo.',
    `O link vale até ${formatarDataHora(dados.expiraEm)} e só pode ser usado uma vez. Se não foi você, ignore este e-mail: sua senha continua a mesma.`,
  ];
  return {
    para: dados.para,
    assunto: titulo,
    texto: [...paragrafos, '', dados.link].join('\n'),
    html: html(titulo, paragrafos, {
      texto: 'Redefinir minha senha',
      link: dados.link,
    }),
  };
}
