import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  nivelDoPapel,
  type NivelPapel,
  rotuloDoPapel,
  setorDaPessoa,
} from '../../comum/dominio/papeis';
import { type Area, nomeDoSetor } from '../../comum/dominio/setores';
import {
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
  area: true,
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
  const area = setorDaPessoa(usuario);
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    rotuloPapel: rotuloDoPapel(usuario.papel, area),
    area,
    nomeSetor: area ? nomeDoSetor(area) : null,
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

  @ApiProperty({
    enum: Papel,
    enumName: 'Papel',
    description: 'O nível (`ADMIN`, `C_LEVEL`, `LIDER`, `MEMBRO`).',
  })
  papel: Papel;

  @ApiProperty({
    example: 'Líder Comercial',
    description:
      'Admin, C-level, "Líder " + nome do setor, ou só o nome do setor (membro).',
  })
  rotuloPapel: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COMERCIAL',
    description: 'Setor (chave); nulo para Admin e C-level.',
  })
  area: Area | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Comercial',
    description: 'Nome do setor; nulo para Admin e C-level.',
  })
  nomeSetor: string | null;

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
      'Membro → líder do setor; líder → C-level responsável; Admin e C-level: nulo (R1.2).',
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

  @ApiProperty({
    description:
      'A pessoa usa a verificação em duas etapas (R2.11). O Admin pode redefini-la.',
  })
  doisFatoresAtivo: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '5511987654321',
    description: 'E.164 só com dígitos.',
  })
  telefone: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'ana.vendas',
    description: 'Identificador nas integrações (R32.4): nulo se não definido.',
  })
  identificadorIntegracao: string | null;

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
      doisFatoresAtivo: usuario.doisFatoresAtivadoEm !== null,
      telefone: usuario.telefone,
      identificadorIntegracao: usuario.identificadorIntegracao,
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
