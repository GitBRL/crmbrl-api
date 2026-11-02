import { Controller, Get, Header } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis } from '../../auth/decorators';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { EmailService } from '../../email/email.service';
import { SaudeDoSistemaDto } from './saude-do-sistema.dto';
import { SaudeDoSistemaService } from './saude-do-sistema.service';

/** Painel "Saúde do sistema": só o Admin (R27). */
@ApiTags('Administração')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('administracao/saude-do-sistema')
export class SaudeDoSistemaController {
  constructor(
    private readonly saude: SaudeDoSistemaService,
    private readonly email: EmailService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Saúde do sistema: filas, gateway e números de WhatsApp, canais, erros recentes, disco e último backup',
    description:
      'Cada fonte indisponível aparece como tal, sem derrubar a resposta. `alertas` traz o que precisa de ' +
      'atenção, com a dica do que fazer; os marcados `porEmail` também vão por e-mail ao Admin (com antirrepetição).',
  })
  @ApiOkResponse({ type: SaudeDoSistemaDto })
  async consultar(): Promise<SaudeDoSistemaDto> {
    const { painel } = await this.saude.consultar(this.email.configurado);
    return painel;
  }
}
