import { Injectable } from '@nestjs/common';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  areaDoPapel,
  ehDiretoria,
  ehLider,
  rotuloDaArea,
} from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type { Area, Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { REGRA_ATENDIMENTO } from './atendimento.constantes';
import { ConversasService, exigirAtendimento } from './conversas.service';
import { PessoaDto } from './dto/comum.dto';
import type {
  AtualizarRespostaRapidaDto,
  CriarRespostaRapidaDto,
  FiltroRespostasRapidasDto,
  RespostaAplicadaDto,
  RespostaRapidaDto,
} from './dto/resposta-rapida.dto';
import { FUSO_HORARIO_PADRAO, lerHorario } from './horario';
import {
  aplicarVariaveis,
  FORMATO_DO_ATALHO,
  normalizarAtalho,
  valoresDasVariaveis,
  VARIAVEIS_DISPONIVEIS,
  type VariavelDisponivel,
  variaveisDesconhecidas,
  variaveisDoTexto,
} from './variaveis';

const INCLUIR_RESPOSTA = {
  arquivo: true,
  criadoPor: { select: { id: true, nome: true, avatarUrl: true } },
} satisfies Prisma.RespostaRapidaInclude;

type RespostaCompleta = Prisma.RespostaRapidaGetPayload<{
  include: typeof INCLUIR_RESPOSTA;
}>;

const CAMPOS_AUDITADOS = [
  'atalho',
  'titulo',
  'texto',
  'area',
  'arquivoId',
  'ativa',
] as const;

/** Quem gerencia as respostas rápidas de um escopo: diretoria todas; o líder, as da sua área. */
export function podeGerenciarRespostas(
  usuario: Pick<UsuarioAutenticado, 'papel'>,
  area: Area | null,
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  return (
    area !== null &&
    ehLider(usuario.papel) &&
    areaDoPapel(usuario.papel) === area
  );
}

/**
 * Respostas rápidas (R12): "/atalho" no compositor, com variáveis
 * (`{{contato.primeiroNome}}`…). Globais (todas as áreas) ou de uma área.
 * Quem usa o Atendimento lista as globais e as da sua área; Admin e C-level
 * gerenciam todas; o líder, as da sua área.
 */
@Injectable()
export class RespostasRapidasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly arquivos: ArquivosService,
    private readonly conversas: ConversasService,
  ) {}

  variaveis(usuario: UsuarioAutenticado): readonly VariavelDisponivel[] {
    exigirAtendimento(usuario);
    return VARIAVEIS_DISPONIVEIS;
  }

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroRespostasRapidasDto,
  ): Promise<RespostaRapidaDto[]> {
    exigirAtendimento(usuario);
    const condicoes: Prisma.RespostaRapidaWhereInput[] = [{ excluidoEm: null }];
    if (!ehDiretoria(usuario.papel)) {
      condicoes.push({
        OR: [{ area: null }, { area: areaDoPapel(usuario.papel) }],
      });
    }
    if (filtro.area) {
      condicoes.push({ area: filtro.area === 'GLOBAL' ? null : filtro.area });
    }
    const gerencia = ehDiretoria(usuario.papel) || ehLider(usuario.papel);
    if (!filtro.incluirInativas || !gerencia) {
      condicoes.push({ ativa: true });
    }
    if (filtro.busca) {
      condicoes.push({
        OR: [
          { atalho: { contains: normalizarAtalho(filtro.busca) } },
          { titulo: { contains: filtro.busca, mode: 'insensitive' } },
          { texto: { contains: filtro.busca, mode: 'insensitive' } },
        ],
      });
    }
    const respostas = await this.prisma.respostaRapida.findMany({
      where: { AND: condicoes },
      include: INCLUIR_RESPOSTA,
      orderBy: [{ atalho: 'asc' }, { area: 'asc' }, { id: 'asc' }],
    });
    return respostas.map((resposta) => this.paraDto(usuario, resposta));
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<RespostaRapidaDto> {
    exigirAtendimento(usuario);
    return this.paraDto(usuario, await this.visivel(this.prisma, usuario, id));
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarRespostaRapidaDto,
  ): Promise<RespostaRapidaDto> {
    exigirAtendimento(usuario);
    const area = dto.area ?? null;
    this.exigirGerenciar(usuario, area);
    const atalho = this.validarAtalho(dto.atalho);
    this.validarTexto(dto.texto);
    const resposta = await this.prisma.$transaction(async (tx) => {
      if (dto.arquivoId) {
        await this.validarArquivo(usuario, dto.arquivoId);
      }
      const criada = await tx.respostaRapida.create({
        data: {
          atalho,
          titulo: dto.titulo,
          texto: dto.texto,
          area,
          arquivoId: dto.arquivoId ?? null,
          ativa: dto.ativa ?? true,
          criadoPorId: usuario.id,
        },
        include: INCLUIR_RESPOSTA,
      });
      await this.auditoria.registrar(tx, {
        acao: 'resposta_rapida.criada',
        entidade: 'resposta_rapida',
        entidadeId: criada.id,
        resumo: `Resposta rápida "/${criada.atalho}" criada (${area ? rotuloDaArea(area) : 'todas as áreas'})`,
        dados: { alteracoes: calcularAlteracoes({}, criada, CAMPOS_AUDITADOS) },
      });
      return criada;
    });
    return this.paraDto(usuario, resposta);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarRespostaRapidaDto,
  ): Promise<RespostaRapidaDto> {
    exigirAtendimento(usuario);
    const resposta = await this.prisma.$transaction(async (tx) => {
      const antes = await this.visivel(tx, usuario, id);
      this.exigirGerenciar(usuario, antes.area);
      const area = dto.area === undefined ? antes.area : dto.area;
      if (area !== antes.area) {
        this.exigirGerenciar(usuario, area);
      }
      if (dto.texto !== undefined) {
        this.validarTexto(dto.texto);
      }
      if (dto.arquivoId) {
        await this.validarArquivo(usuario, dto.arquivoId);
      }
      const depois = await tx.respostaRapida.update({
        where: { id },
        data: {
          ...(dto.atalho !== undefined
            ? { atalho: this.validarAtalho(dto.atalho) }
            : {}),
          ...(dto.titulo !== undefined ? { titulo: dto.titulo } : {}),
          ...(dto.texto !== undefined ? { texto: dto.texto } : {}),
          area,
          ...(dto.arquivoId !== undefined ? { arquivoId: dto.arquivoId } : {}),
          ...(dto.ativa !== undefined ? { ativa: dto.ativa } : {}),
        },
        include: INCLUIR_RESPOSTA,
      });
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'resposta_rapida.atualizada',
          entidade: 'resposta_rapida',
          entidadeId: id,
          resumo: `Resposta rápida "/${depois.atalho}" alterada`,
          dados: { alteracoes },
        });
      }
      return depois;
    });
    return this.paraDto(usuario, resposta);
  }

  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    exigirAtendimento(usuario);
    await this.prisma.$transaction(async (tx) => {
      const resposta = await this.visivel(tx, usuario, id);
      this.exigirGerenciar(usuario, resposta.area);
      await tx.respostaRapida.update({
        where: { id },
        data: { excluidoEm: new Date() },
      });
      await this.auditoria.registrar(tx, {
        acao: 'resposta_rapida.excluida',
        entidade: 'resposta_rapida',
        entidadeId: id,
        resumo: `Resposta rápida "/${resposta.atalho}" excluída`,
      });
    });
  }

  /** O texto com as variáveis desta conversa (o compositor mostra para revisar). */
  async aplicar(
    usuario: UsuarioAutenticado,
    id: string,
    conversaId: string,
  ): Promise<RespostaAplicadaDto> {
    exigirAtendimento(usuario);
    const resposta = await this.visivel(this.prisma, usuario, id);
    if (!resposta.ativa) {
      throw new NaoEncontradoException('Resposta rápida não encontrada.');
    }
    const conversa = await this.conversas.visivel(
      this.prisma,
      usuario,
      conversaId,
    );
    const [contato, canal] = await Promise.all([
      this.prisma.contato.findUniqueOrThrow({
        where: { id: conversa.contatoId },
        select: {
          nome: true,
          email: true,
          telefone: true,
          empresa: { select: { nome: true } },
        },
      }),
      this.prisma.canal.findUniqueOrThrow({
        where: { id: conversa.canalId },
        select: { nome: true, horarioAtendimento: true },
      }),
    ]);
    const valores = valoresDasVariaveis({
      contato: {
        nome: contato.nome,
        email: contato.email,
        telefone: contato.telefone,
        empresa: contato.empresa?.nome ?? null,
      },
      usuario: { nome: usuario.nome },
      canal: { nome: canal.nome },
      fusoHorario:
        lerHorario(canal.horarioAtendimento)?.fusoHorario ??
        FUSO_HORARIO_PADRAO,
    });
    return {
      texto: aplicarVariaveis(resposta.texto, valores),
      arquivo:
        resposta.arquivo && !resposta.arquivo.removidoEm
          ? ArquivoDto.de(resposta.arquivo)
          : null,
    };
  }

  // -------------------------------------------------------------------------

  private async visivel(
    tx: Tx | PrismaService,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<RespostaCompleta> {
    const resposta = await tx.respostaRapida.findFirst({
      where: { id, excluidoEm: null },
      include: INCLUIR_RESPOSTA,
    });
    const area = areaDoPapel(usuario.papel);
    if (
      !resposta ||
      (!ehDiretoria(usuario.papel) &&
        resposta.area !== null &&
        resposta.area !== area)
    ) {
      throw new NaoEncontradoException('Resposta rápida não encontrada.');
    }
    return resposta;
  }

  private exigirGerenciar(
    usuario: UsuarioAutenticado,
    area: Area | null,
  ): void {
    if (!podeGerenciarRespostas(usuario, area)) {
      throw new SemPermissaoException(
        area
          ? `Só Admin, C-level e o líder de ${rotuloDaArea(area)} gerenciam as respostas rápidas dessa área.`
          : 'Só Admin e C-level gerenciam as respostas rápidas de todas as áreas.',
        { regra: REGRA_ATENDIMENTO },
      );
    }
  }

  private validarAtalho(bruto: string): string {
    const atalho = normalizarAtalho(bruto);
    if (!FORMATO_DO_ATALHO.test(atalho)) {
      throw new DadosInvalidosException(
        'O atalho precisa ter de 1 a 40 caracteres, sem espaços nem barras.',
        {
          campos: [
            {
              campo: 'atalho',
              mensagens: ['sem espaços nem barras, até 40 caracteres'],
            },
          ],
        },
      );
    }
    return atalho;
  }

  private validarTexto(texto: string): void {
    const desconhecidas = variaveisDesconhecidas(texto);
    if (desconhecidas.length > 0) {
      const lista = desconhecidas.map((nome) => `{{${nome}}}`).join(', ');
      throw new DadosInvalidosException(
        `Variável desconhecida no texto: ${lista}.`,
        {
          campos: [
            { campo: 'texto', mensagens: [`variável desconhecida: ${lista}`] },
          ],
        },
      );
    }
  }

  private async validarArquivo(
    usuario: UsuarioAutenticado,
    arquivoId: string,
  ): Promise<void> {
    const arquivo = await this.prisma.arquivo.findUnique({
      where: { id: arquivoId },
    });
    if (
      !arquivo ||
      arquivo.removidoEm ||
      arquivo.contexto !== 'MENSAGEM' ||
      !(await this.arquivos.podeLer(usuario, arquivo))
    ) {
      throw new DadosInvalidosException('Anexo não encontrado.', {
        campos: [
          {
            campo: 'arquivoId',
            mensagens: ['envie o arquivo com contexto=MENSAGEM'],
          },
        ],
      });
    }
  }

  private paraDto(
    usuario: UsuarioAutenticado,
    resposta: RespostaCompleta,
  ): RespostaRapidaDto {
    return {
      id: resposta.id,
      atalho: resposta.atalho,
      titulo: resposta.titulo,
      texto: resposta.texto,
      area: resposta.area,
      arquivo:
        resposta.arquivo && !resposta.arquivo.removidoEm
          ? ArquivoDto.de(resposta.arquivo)
          : null,
      ativa: resposta.ativa,
      variaveis: variaveisDoTexto(resposta.texto),
      criadoPor: PessoaDto.ouNulo(resposta.criadoPor),
      podeEditar: podeGerenciarRespostas(usuario, resposta.area),
      criadoEm: resposta.criadoEm.toISOString(),
      atualizadoEm: resposta.atualizadoEm.toISOString(),
    };
  }
}
