import { type PipeTransform, Injectable } from '@nestjs/common';
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import type { AplicativoDeLogin } from '../../generated/prisma/client';
import { APLICATIVOS_DE_LOGIN } from './apps-de-login.dto';

/** `META`, `TYPEFORM` ou `RD_STATION` na rota; outro valor → 400. */
@Injectable()
export class ParseAplicativoDeLoginPipe implements PipeTransform<
  unknown,
  AplicativoDeLogin
> {
  transform(valor: unknown): AplicativoDeLogin {
    if (
      typeof valor === 'string' &&
      (APLICATIVOS_DE_LOGIN as readonly string[]).includes(valor)
    ) {
      return valor as AplicativoDeLogin;
    }
    throw new DadosInvalidosException('Aplicativo inválido.', {
      campos: [
        {
          campo: 'aplicativo',
          mensagens: [
            `deve ser um destes valores: ${APLICATIVOS_DE_LOGIN.join(', ')}`,
          ],
        },
      ],
    });
  }
}
