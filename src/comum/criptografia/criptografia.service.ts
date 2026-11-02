import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  type ScryptOptions,
  timingSafeEqual,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';

/** Parâmetros do scrypt (R2.1). Mudar aqui faz as senhas antigas serem refeitas no próximo login. */
export const PARAMETROS_SCRYPT = {
  N: 32_768,
  r: 8,
  p: 3,
  tamanhoChave: 64,
  tamanhoSal: 16,
} as const;

/** Limites de tamanho da senha (R2.1). */
export const TAMANHO_MINIMO_SENHA = 8;
export const TAMANHO_MAXIMO_SENHA = 128;

/** Memória que o scrypt pode usar: 128·N·r = 32 MiB nos parâmetros atuais, com folga. */
const MEMORIA_MAXIMA_SCRYPT = 128 * 1024 * 1024;

const VERSAO_CIFRA = 'v1';
const TAMANHO_IV = 12;
const TAMANHO_TAG = 16;

function derivar(
  senha: string,
  sal: Buffer,
  tamanho: number,
  opcoes: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolver, rejeitar) => {
    scrypt(senha.normalize('NFKC'), sal, tamanho, opcoes, (erro, chave) => {
      if (erro) {
        rejeitar(erro);
      } else {
        resolver(chave);
      }
    });
  });
}

interface HashDecomposto {
  N: number;
  r: number;
  p: number;
  sal: Buffer;
  hash: Buffer;
}

function decompor(texto: string): HashDecomposto | null {
  const partes = texto.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') {
    return null;
  }
  const [N, r, p] = partes.slice(1, 4).map(Number);
  if (![N, r, p].every((valor) => Number.isInteger(valor) && valor > 0)) {
    return null;
  }
  const sal = Buffer.from(partes[4], 'base64');
  const hash = Buffer.from(partes[5], 'base64');
  if (sal.length === 0 || hash.length === 0) {
    return null;
  }
  return { N, r, p, sal, hash };
}

/**
 * Criptografia da API, toda com `node:crypto`:
 *
 * - senhas com scrypt (R2.1), gravadas como `scrypt$N$r$p$sal$hash` (base64);
 * - tokens aleatórios (sessão, convite, webhooks) e SHA-256 para guardá-los;
 * - AES-256-GCM com `CHAVE_CRIPTOGRAFIA` para segredos de webhooks (R10.3);
 * - HMAC-SHA256 com comparação em tempo constante (R8.3, R9.3).
 */
@Injectable()
export class CriptografiaService {
  private readonly chave: Buffer;
  /** Hash de uma senha qualquer, para o login com e-mail inexistente gastar o mesmo tempo. */
  private hashFicticio?: Promise<string>;

  constructor(@Inject(AMBIENTE) ambiente: Ambiente) {
    this.chave = ambiente.chaveCriptografia;
  }

  /** Hash scrypt da senha (≈ 0,2 s). */
  async hashSenha(senha: string): Promise<string> {
    const { N, r, p, tamanhoChave, tamanhoSal } = PARAMETROS_SCRYPT;
    const sal = randomBytes(tamanhoSal);
    const hash = await derivar(senha, sal, tamanhoChave, {
      N,
      r,
      p,
      maxmem: MEMORIA_MAXIMA_SCRYPT,
    });
    return [
      'scrypt',
      N,
      r,
      p,
      sal.toString('base64'),
      hash.toString('base64'),
    ].join('$');
  }

  /**
   * Confere a senha com o hash gravado. Sem hash (usuário inexistente ou que
   * ainda não definiu a senha), calcula um hash fictício para gastar o mesmo
   * tempo e devolve `false` — o tempo de resposta não revela quem existe.
   */
  async verificarSenha(
    senha: string,
    hashGravado: string | null | undefined,
  ): Promise<boolean> {
    const decomposto = hashGravado ? decompor(hashGravado) : null;
    if (!decomposto) {
      await this.verificarSenha(senha, await this.obterHashFicticio());
      return false;
    }
    const calculado = await derivar(
      senha,
      decomposto.sal,
      decomposto.hash.length,
      {
        N: decomposto.N,
        r: decomposto.r,
        p: decomposto.p,
        maxmem: MEMORIA_MAXIMA_SCRYPT,
      },
    );
    return timingSafeEqual(calculado, decomposto.hash);
  }

  /** O hash foi feito com parâmetros diferentes dos atuais (refazer no próximo login)? */
  precisaRefazerHash(hashGravado: string): boolean {
    const decomposto = decompor(hashGravado);
    const { N, r, p, tamanhoChave } = PARAMETROS_SCRYPT;
    return (
      !decomposto ||
      decomposto.N !== N ||
      decomposto.r !== r ||
      decomposto.p !== p ||
      decomposto.hash.length !== tamanhoChave
    );
  }

  /** Token aleatório em base64url (32 bytes por padrão: sessão, convite, webhook). */
  gerarToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** SHA-256 em hexadecimal — como tokens são guardados no banco. */
  sha256(texto: string): string {
    return createHash('sha256').update(texto, 'utf8').digest('hex');
  }

  /** Cifra com AES-256-GCM: `v1.<iv>.<tag>.<dados>` em base64url. */
  cifrar(texto: string): string {
    const iv = randomBytes(TAMANHO_IV);
    const cifra = createCipheriv('aes-256-gcm', this.chave, iv);
    const dados = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
    const tag = cifra.getAuthTag();
    return [VERSAO_CIFRA, iv, tag, dados]
      .map((parte) =>
        typeof parte === 'string' ? parte : parte.toString('base64url'),
      )
      .join('.');
  }

  /** Decifra o que `cifrar` produziu. Lança erro se o texto foi adulterado ou a chave mudou. */
  decifrar(cifrado: string): string {
    const partes = cifrado.split('.');
    if (partes.length !== 4 || partes[0] !== VERSAO_CIFRA) {
      throw new Error('Texto cifrado em formato desconhecido.');
    }
    const [iv, tag, dados] = partes
      .slice(1)
      .map((parte) => Buffer.from(parte, 'base64url'));
    if (iv.length !== TAMANHO_IV || tag.length !== TAMANHO_TAG) {
      throw new Error('Texto cifrado em formato desconhecido.');
    }
    const decifra = createDecipheriv('aes-256-gcm', this.chave, iv);
    decifra.setAuthTag(tag);
    return Buffer.concat([decifra.update(dados), decifra.final()]).toString(
      'utf8',
    );
  }

  /** HMAC-SHA256 em hexadecimal. */
  assinarHmac(segredo: string, conteudo: string | Buffer): string {
    return createHmac('sha256', segredo).update(conteudo).digest('hex');
  }

  /**
   * Confere uma assinatura HMAC-SHA256 em tempo constante. Aceita `sha256=<hex>`
   * (cabeçalho `X-Assinatura`, R8.3) ou só o hexadecimal.
   */
  verificarHmac(
    segredo: string,
    conteudo: string | Buffer,
    assinatura: string | null | undefined,
  ): boolean {
    if (!assinatura) {
      return false;
    }
    const recebida = assinatura
      .trim()
      .replace(/^sha256=/i, '')
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(recebida)) {
      return false;
    }
    return timingSafeEqual(
      Buffer.from(this.assinarHmac(segredo, conteudo), 'hex'),
      Buffer.from(recebida, 'hex'),
    );
  }

  /** Compara dois textos em tempo constante (o tamanho diferente sai rápido, mas não revela o conteúdo). */
  compararSeguro(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    return (
      bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB)
    );
  }

  /** Segredo mascarado para exibição (R10.3): só os 4 últimos caracteres, `••••••••3f9a`. */
  mascarar(segredo: string): string {
    return segredo.length <= 8 ? '••••••••' : `••••••••${segredo.slice(-4)}`;
  }

  private obterHashFicticio(): Promise<string> {
    this.hashFicticio ??= this.hashSenha(this.gerarToken(16));
    return this.hashFicticio;
  }
}
