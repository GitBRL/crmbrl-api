import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ModelosService } from '../modelos/modelos.service';
import { ApiRespostasDeErro } from '../erros/documentacao-erros';
import {
  CAMPOS_DE_SEGMENTO,
  OPERADORES_DE_CAMPO_PERSONALIZADO,
  OPERADORES_DE_UTM,
  PARTES_DA_UTM,
} from './segmentos';
import { type ContatoDaAmostra, SegmentosService } from './segmentos.service';

export class PreviaDeSegmentoDto {
  @ApiProperty({
    description:
      'Segmento (`{ combinacao, condicoes }`), ver `src/comum/segmentos`.',
    type: 'object',
    additionalProperties: true,
    example: {
      combinacao: 'todas',
      condicoes: [
        { campo: 'etiquetas', operador: 'contem_alguma', valor: ['vip'] },
      ],
    },
  })
  @IsObject()
  segmento: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Tirar quem tem opt-out de marketing (padrão: sim).',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  excluirOptOut?: boolean;

  @ApiPropertyOptional({ default: 10, minimum: 0, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  amostra?: number;
}

export class ContatoDaAmostraDto implements ContatoDaAmostra {
  @ApiProperty() id: string;
  @ApiProperty() nome: string;
  @ApiProperty({ nullable: true, type: String }) email: string | null;
  @ApiProperty({ nullable: true, type: String }) telefone: string | null;
  @ApiProperty({ type: [String] }) etiquetas: string[];
  @ApiProperty() optOutMarketing: boolean;
}

export class PreviaDeSegmentoRespostaDto {
  @ApiProperty({ example: 128 }) total: number;
  @ApiProperty({ type: [ContatoDaAmostraDto] }) amostra: ContatoDaAmostraDto[];
}

/**
 * Construtor de segmentos (Onda B, §2.1): campos/operadores e contagem ao vivo.
 * Todo usuário logado vê contatos (R4), mas as condições de negócio respeitam os
 * funis que a pessoa vê (R5.9): outro funil responde 400.
 */
@ApiTags('Segmentos')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('segmentos')
export class SegmentosController {
  constructor(
    private readonly segmentos: SegmentosService,
    private readonly modelos: ModelosService,
  ) {}

  @Get('campos')
  @ApiOperation({
    summary: 'Campos e operadores dos segmentos',
    description:
      'Campos fixos com rótulo e operadores (cada operador diz o tipo do valor), os prefixos dinâmicos (`campos.<chave>`, `utm.<parte>`, `primeira_utm.<parte>`) e as chaves de campos personalizados de contato em uso.',
  })
  @ApiOkResponse({
    description:
      '`{ campos, camposPersonalizados: { operadores, chaves }, utm: { partes, operadores } }`',
  })
  async campos() {
    return {
      campos: CAMPOS_DE_SEGMENTO,
      camposPersonalizados: {
        operadores: OPERADORES_DE_CAMPO_PERSONALIZADO,
        chaves: await this.modelos.chavesEmUso('contatos'),
      },
      utm: { partes: PARTES_DA_UTM, operadores: OPERADORES_DE_UTM },
    };
  }

  @Post('previa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Conta o segmento e mostra uma amostra',
    description:
      'Valida o segmento (400 com `detalhes.problemas` = `[{ caminho, mensagem }]`), conta os contatos e devolve os mais recentes.',
  })
  @ApiOkResponse({ type: PreviaDeSegmentoRespostaDto })
  @ApiRespostasDeErro(400)
  async previa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: PreviaDeSegmentoDto,
  ): Promise<PreviaDeSegmentoRespostaDto> {
    const segmento = await this.segmentos.validarParaUsuario(
      dto.segmento,
      usuario,
    );
    const opcoes = {
      ...this.segmentos.opcoesDoUsuario(usuario),
      excluirOptOut: dto.excluirOptOut ?? true,
    };
    const limite = dto.amostra ?? 10;
    const [total, amostra] = await Promise.all([
      this.segmentos.contar(segmento, opcoes),
      limite > 0 ? this.segmentos.amostra(segmento, { ...opcoes, limite }) : [],
    ]);
    return { total, amostra };
  }
}
