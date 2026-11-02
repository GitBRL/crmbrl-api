import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { CODIGOS_ERRO, type CodigoErro } from './excecoes';

/** Corpo de erro padrão, para o Swagger. */
export class RespostaErroDto {
  @ApiProperty({ example: 422 })
  statusCode: number;

  @ApiProperty({
    example: 'regra_violada',
    enum: CODIGOS_ERRO,
  })
  erro: CodigoErro;

  @ApiProperty({ example: 'Informe o motivo da perda.' })
  mensagem: string;

  @ApiPropertyOptional({
    description:
      '400: `{ campos: [{ campo, mensagens }] }`; 422: `{ regra: "R5.5", … }`.',
    example: { regra: 'R5.5' },
    type: 'object',
    additionalProperties: true,
  })
  detalhes?: Record<string, unknown>;

  @ApiProperty({
    description: 'O mesmo valor do cabeçalho X-Request-Id.',
    example: '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
  })
  requisicaoId: string;
}

const DESCRICOES: Readonly<Record<number, string>> = {
  400: 'Dados inválidos (`dados_invalidos`).',
  401: 'Sem sessão válida (`nao_autenticado`).',
  403: 'Sem permissão (`sem_permissao`).',
  404: 'Não encontrado (`nao_encontrado`).',
  405: 'Método não permitido nesta rota (`metodo_nao_permitido`).',
  409: 'Conflito com o estado atual (`conflito`).',
  410: 'Recurso desativado (`desativado`).',
  413: 'Corpo grande demais (`muito_grande`).',
  415: 'Tipo de conteúdo não aceito (`tipo_nao_suportado`).',
  422: 'Regra de negócio violada (`regra_violada`, com `detalhes.regra`).',
  429: 'Muitas tentativas (`muitas_tentativas`, com `Retry-After`).',
  500: 'Erro interno (`erro_interno`); o detalhe fica nos logs técnicos.',
  503: 'Serviço indisponível no momento (`indisponivel`).',
};

/**
 * Documenta as respostas de erro de uma rota com o corpo padrão.
 *
 * ```ts
 * @ApiRespostasDeErro(400, 404, 422)
 * ```
 */
export function ApiRespostasDeErro(...status: number[]) {
  return applyDecorators(
    ...status.map((codigo) =>
      ApiResponse({
        status: codigo,
        description: DESCRICOES[codigo] ?? 'Erro.',
        type: RespostaErroDto,
      }),
    ),
  );
}
