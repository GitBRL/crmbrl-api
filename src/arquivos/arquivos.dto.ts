import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { type Arquivo, ContextoArquivo } from '../generated/prisma/client';

/** Caminho do download de um arquivo, relativo à origem do CRM. */
export function urlDoArquivo(id: string): string {
  return `/api/v1/arquivos/${id}`;
}

/** Arquivo como a API devolve (a chave no bucket nunca sai). */
export class ArquivoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'proposta.pdf' })
  nome: string;

  @ApiProperty({ example: 'application/pdf' })
  mime: string;

  @ApiProperty({ description: 'Em bytes.', example: 182044 })
  tamanho: number;

  @ApiProperty({ enum: ContextoArquivo, enumName: 'ContextoArquivo' })
  contexto: ContextoArquivo;

  @ApiPropertyOptional({ nullable: true, type: Number })
  largura: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  altura: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  duracaoSegundos: number | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({
    description:
      'Endereço do download (`GET`, com a sessão). `?download=true` força salvar em vez de abrir.',
    example: '/api/v1/arquivos/6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
  })
  url: string;

  static de(arquivo: Arquivo): ArquivoDto {
    return {
      id: arquivo.id,
      nome: arquivo.nome,
      mime: arquivo.mime,
      tamanho: arquivo.tamanho,
      contexto: arquivo.contexto,
      largura: arquivo.largura,
      altura: arquivo.altura,
      duracaoSegundos: arquivo.duracaoSegundos,
      criadoEm: arquivo.criadoEm.toISOString(),
      url: urlDoArquivo(arquivo.id),
    };
  }
}

/** Query do envio: o contexto define o limite e quem poderá baixar (R11). */
export class EnvioDeArquivoDto {
  @ApiProperty({
    enum: ContextoArquivo,
    enumName: 'ContextoArquivo',
    description:
      '`MENSAGEM` (Atendimento), `CHAT` (chat interno), `IMPORTACAO`, `AVATAR` ou `OUTRO`.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(ContextoArquivo, {
    message: 'deve ser um contexto de arquivo válido',
  })
  contexto: ContextoArquivo;
}

/** Corpo do envio (para o Swagger): `multipart/form-data` com o campo `arquivo`. */
export class CorpoDoEnvioDto {
  @ApiProperty({ type: 'string', format: 'binary' })
  arquivo: unknown;
}

/** Query do download. */
export class DownloadDeArquivoDto {
  @ApiPropertyOptional({
    description:
      'Força `Content-Disposition: attachment` (salvar em vez de abrir).',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true || value === '1'
      ? true
      : value === 'false' || value === false || value === '0'
        ? false
        : value,
  )
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  download: boolean = false;
}
