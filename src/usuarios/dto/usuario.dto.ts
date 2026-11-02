import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  areaDoPapel,
  type NivelPapel,
  nivelDoPapel,
  rotuloDoPapel,
} from '../../comum/dominio/papeis';
import {
  Area,
  Papel,
  type Prisma,
  type Usuario,
} from '../../generated/prisma/client';

/** Campos do usuário que vão nos resumos (líder, destinatário, liderados). */
export const SELECAO_RESUMO = {
  id: true,
  nome: true,
  email: true,
  papel: true,
  ativo: true,
} as const satisfies Prisma.UsuarioSelect;

export type UsuarioResumido = Prisma.UsuarioGetPayload<{
  select: typeof SELECAO_RESUMO;
}>;

/** O `include` do usuário com o resumo do líder. */
export const INCLUIR_LIDER = {
  lider: { select: SELECAO_RESUMO },
} as const satisfies Prisma.UsuarioInclude;

export type UsuarioComLider = Usuario & { lider: UsuarioResumido | null };

const NIVEIS: NivelPapel[] = ['ADMINISTRADOR', 'DIRETORIA', 'LIDER', 'MEMBRO'];

/** Os campos do resumo, como objeto simples (base do resumo e do completo). */
function camposDoResumo(usuario: UsuarioResumido) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    rotuloPapel: rotuloDoPapel(usuario.papel),
    area: areaDoPapel(usuario.papel),
    ativo: usuario.ativo,
  };
}

/** Resumo de um usuário. */
export class UsuarioResumoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  @ApiProperty({ example: 'ana@brl.com.br' })
  email: string;

  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({ example: 'Líder Comercial' })
  rotuloPapel: string;

  @ApiPropertyOptional({
    enum: Area,
    enumName: 'Area',
    nullable: true,
    description: 'Nula para Admin e C-level.',
  })
  area: Area | null;

  @ApiProperty({ description: 'Falso para quem foi desligado.' })
  ativo: boolean;

  static de(usuario: UsuarioResumido): UsuarioResumoDto {
    return camposDoResumo(usuario);
  }
}

/** Usuário completo, como a gestão de usuários mostra (nunca leva a senha). */
export class UsuarioDto extends UsuarioResumoDto {
  @ApiProperty({ enum: NIVEIS })
  nivel: NivelPapel;

  @ApiPropertyOptional({
    type: UsuarioResumoDto,
    nullable: true,
    description:
      'Membro → líder da área; líder → C-level responsável; Admin e C-level: nulo (R1.2).',
  })
  lider: UsuarioResumoDto | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  desligadoEm: string | null;

  @ApiProperty({
    description: 'Troca de senha obrigatória no próximo acesso (R2.7).',
  })
  deveTrocarSenha: boolean;

  @ApiProperty({
    description:
      'Falso para quem foi convidado e ainda não definiu a senha (R2.8).',
  })
  senhaDefinida: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '5511987654321',
    description: 'E.164 só com dígitos.',
  })
  telefone: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  ultimoAcessoEm: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static completo(usuario: UsuarioComLider): UsuarioDto {
    return {
      ...camposDoResumo(usuario),
      nivel: nivelDoPapel(usuario.papel),
      lider: usuario.lider ? UsuarioResumoDto.de(usuario.lider) : null,
      desligadoEm: usuario.desligadoEm?.toISOString() ?? null,
      deveTrocarSenha: usuario.deveTrocarSenha,
      senhaDefinida: usuario.senhaHash !== null,
      telefone: usuario.telefone,
      avatarUrl: usuario.avatarUrl,
      ultimoAcessoEm: usuario.ultimoAcessoEm?.toISOString() ?? null,
      criadoEm: usuario.criadoEm.toISOString(),
      atualizadoEm: usuario.atualizadoEm.toISOString(),
    };
  }
}

/** Situação do convite por e-mail enviado na criação (R2.8). */
export class ConviteDto {
  @ApiProperty({
    description:
      'O e-mail saiu. Falso quando o servidor de e-mail falhou: reenvie com POST /usuarios/{id}/convite.',
  })
  enviado: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Validade do link (24 horas).',
  })
  expiraEm: string | null;
}

/** Resposta da criação de um usuário. */
export class UsuarioCriadoDto {
  @ApiProperty({ type: UsuarioDto })
  usuario: UsuarioDto;

  @ApiPropertyOptional({
    type: ConviteDto,
    nullable: true,
    description:
      'Nulo quando o Admin definiu uma senha temporária (sem convite por e-mail).',
  })
  convite: ConviteDto | null;
}

/** Resposta do envio de convite. */
export class ConviteEnviadoDto {
  @ApiProperty({ example: 'Convite enviado para ana@brl.com.br.' })
  mensagem: string;

  @ApiProperty({ format: 'date-time', description: 'Validade do link.' })
  expiraEm: string;
}
