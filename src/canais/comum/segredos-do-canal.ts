import { Injectable } from '@nestjs/common';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { ServicoIndisponivelException } from '../../comum/erros/excecoes';
import type { Canal } from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';

/**
 * Segredos de um canal (senhas do IMAP/SMTP, app secret e token de página da
 * Meta, token de verificação do webhook…): um JSON cifrado com AES-256-GCM em
 * `canais.segredos_cifrados` (R10.3). Nunca saem da API; na tela, só mascarados.
 *
 * ```ts
 * const { imapSenha } = await this.segredos.ler<SegredosEmail>(canal);
 * const cifrado = this.segredos.cifrar({ ...atuais, imapSenha: nova });
 * ```
 */
@Injectable()
export class SegredosDoCanal {
  constructor(
    private readonly cripto: CriptografiaService,
    private readonly logs: LogsTecnicosService,
  ) {}

  /**
   * Os segredos do canal (objeto vazio se não houver). Se o texto cifrado não
   * pode ser lido (a `CHAVE_CRIPTOGRAFIA` mudou), registra o erro e responde
   * 503 com uma orientação para o Admin.
   */
  async ler<T extends object>(
    canal: Pick<Canal, 'id' | 'nome' | 'segredosCifrados'>,
  ): Promise<Partial<T>> {
    const lidos = this.lerSemFalhar<T>(canal);
    if (lidos !== null) {
      return lidos;
    }
    await this.logs.erro(
      'Canais',
      `Segredos ilegíveis no canal "${canal.nome}" (a CHAVE_CRIPTOGRAFIA mudou?).`,
      undefined,
      { canalId: canal.id },
    );
    throw new ServicoIndisponivelException(
      `As credenciais do canal "${canal.nome}" não podem ser lidas. O Admin precisa informá-las de novo.`,
      { canalId: canal.id },
    );
  }

  /** Como `ler`, mas devolve `null` em vez de lançar quando não dá para decifrar. */
  lerSemFalhar<T extends object>(
    canal: Pick<Canal, 'segredosCifrados'>,
  ): Partial<T> | null {
    if (!canal.segredosCifrados) {
      return {};
    }
    try {
      const valor: unknown = JSON.parse(
        this.cripto.decifrar(canal.segredosCifrados),
      );
      return typeof valor === 'object' &&
        valor !== null &&
        !Array.isArray(valor)
        ? (valor as Partial<T>)
        : {};
    } catch {
      return null;
    }
  }

  /** Cifra os segredos para gravar em `segredosCifrados` (sem campos vazios). */
  cifrar(segredos: object): string | null {
    const limpos = Object.fromEntries(
      Object.entries(segredos).filter(
        ([, valor]) => valor !== undefined && valor !== null && valor !== '',
      ),
    );
    return Object.keys(limpos).length > 0
      ? this.cripto.cifrar(JSON.stringify(limpos))
      : null;
  }

  /** Segredo mascarado para a tela (`••••••••3f9a`), ou `null` se não há. */
  mascarar(valor: unknown): string | null {
    return typeof valor === 'string' && valor !== ''
      ? this.cripto.mascarar(valor)
      : null;
  }
}
