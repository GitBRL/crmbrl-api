/**
 * Rotas só de teste da base (`/api/v1/teste-base/...`), para exercitar a
 * infraestrutura de dentro de uma requisição de verdade: guards, filtro de
 * erros, contexto, auditoria, outbox, fila e notificações.
 */
import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AuditoriaService } from '../src/auditoria/auditoria.service';
import {
  Papeis,
  Publico,
  SemVerificacaoDeOrigem,
  UsuarioAtual,
} from '../src/auth/decorators';
import type { UsuarioAutenticado } from '../src/auth/usuario-autenticado';
import { contextoAtual } from '../src/comum/contexto/contexto-requisicao';
import {
  ConflitoException,
  MuitasTentativasException,
  RegraVioladaException,
} from '../src/comum/erros/excecoes';
import { EventosDominioService } from '../src/eventos/eventos-dominio.service';
import { FilaService } from '../src/fila/fila.service';
import { NotificacoesService } from '../src/notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../src/notificacoes/tipos-notificacao';
import { PrismaService } from '../src/prisma/prisma.service';

export const FILA_DE_TESTE = 'teste-base.fila';

class EnderecoDto {
  @IsString({ message: 'deve ser um texto' })
  cidade: string;
}

class CadastroDto {
  @IsEmail()
  email: string;

  @Length(3, 10)
  nome: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EnderecoDto)
  endereco?: EnderecoDto;
}

class FalharDto {
  @IsOptional()
  @IsString()
  falhar?: string;
}

@Controller('teste-base')
class RotasDeTesteController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly fila: FilaService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  @Get('publico')
  @Publico()
  publico(@UsuarioAtual({ opcional: true }) usuario?: UsuarioAutenticado) {
    return { usuarioId: usuario?.id ?? null, contexto: contextoAtual() };
  }

  @Get('contexto')
  contexto() {
    return contextoAtual();
  }

  @Get('so-admin')
  @Papeis('ADMIN')
  soAdmin() {
    return { ok: true };
  }

  @Post('sem-origem')
  @Publico()
  @SemVerificacaoDeOrigem()
  semOrigem() {
    return { ok: true };
  }

  @Post('validar')
  @Publico()
  validar(@Body() corpo: CadastroDto) {
    return corpo;
  }

  @Get('erro/:tipo')
  @Publico()
  async erro(@Param('tipo') tipo: string): Promise<never> {
    switch (tipo) {
      case 'regra':
        throw new RegraVioladaException(
          'R1.2',
          'O líder precisa ser da mesma área.',
          { liderId: 'x' },
        );
      case 'conflito':
        throw new ConflitoException('Já desligado.');
      case 'tentativas':
        throw new MuitasTentativasException('Calma.', 42);
      case 'prisma-unico': {
        const dados = {
          nome: 'Dup',
          email: 'duplicado@teste.local',
          papel: 'ADMIN' as const,
        };
        await this.prisma.usuario.create({ data: dados });
        await this.prisma.usuario.create({ data: dados });
        break;
      }
      case 'prisma-inexistente':
        await this.prisma.usuario.findUniqueOrThrow({
          where: { id: '00000000-0000-4000-8000-000000000000' },
        });
        break;
      default:
        throw new Error('falha interna com detalhe secreto');
    }
    throw new Error('inalcançável');
  }

  @Post('auditar')
  @Publico()
  async auditar(@Body() corpo: { contatoId?: string }) {
    const evento = await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'teste.auditado',
        entidade: 'negocio',
        entidadeId: '11111111-1111-4111-8111-111111111111',
        resumo: 'Evento de teste',
        dados: {
          senha: 'nao-pode-aparecer',
          valor: 10,
          quando: new Date('2026-01-02T03:04:05Z'),
        },
        relacionados: { contato: corpo.contatoId },
      }),
    );
    return { id: evento.id.toString() };
  }

  @Post('publicar')
  @Publico()
  async publicar(
    @Query() consulta: FalharDto,
    @Body() dados: Record<string, unknown>,
  ) {
    const evento = await this.prisma.$transaction(async (tx) => {
      const publicado = await this.eventos.publicar(tx, 'teste.criado', dados);
      if (consulta.falhar) {
        throw new ConflitoException('Desfez a transação de propósito.');
      }
      return publicado;
    });
    return { id: evento.id };
  }

  @Post('enfileirar')
  @Publico()
  async enfileirar(
    @Query() consulta: FalharDto,
    @Body() dados: Record<string, unknown>,
  ) {
    const id = await this.prisma.$transaction(async (tx) => {
      const criado = await this.fila.enviar(FILA_DE_TESTE, dados, { tx });
      if (consulta.falhar) {
        throw new ConflitoException('Desfez a transação de propósito.');
      }
      return criado;
    });
    return { id, requisicaoId: contextoAtual().requisicaoId };
  }

  @Post('notificar')
  @Publico()
  async notificar(@Body() corpo: { usuarioId: string; titulo: string }) {
    const notificacao = await this.prisma.$transaction((tx) =>
      this.notificacoes.notificar(tx, corpo.usuarioId, {
        tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
        titulo: corpo.titulo,
        texto: 'Texto de teste',
        link: '/funis/comercial',
        dados: { negocioId: 'n1' },
      }),
    );
    return { id: notificacao.id };
  }
}

@Module({ controllers: [RotasDeTesteController] })
export class RotasDeTesteModule {}
