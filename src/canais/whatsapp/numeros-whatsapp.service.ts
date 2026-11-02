import { Injectable, Logger } from '@nestjs/common';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { calcularAlteracoes } from '../../comum/dados/sanitizar';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
} from '../../comum/erros/excecoes';
import type {
  Canal,
  FilaAtendimento,
  Prisma,
  WhatsappEnvioDiario,
  WhatsappNumero,
} from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { ClienteGatewayWhatsapp } from './cliente-gateway';
import type {
  EstadoDoNumero,
  ResultadoDaVerificacao,
} from './contrato-gateway';
import type {
  AtualizarNumeroWhatsappDto,
  CriarNumeroWhatsappDto,
  DesconectarNumeroWhatsappDto,
  EnviosDoNumeroNoDiaDto,
  NumeroWhatsappDto,
  PausarNumeroWhatsappDto,
  ProtecoesDoNumeroDto,
} from './dto/numeros-whatsapp.dto';
import {
  type ConfiguracaoDoNumero,
  dataDoDia,
  diaEmSaoPaulo,
  lerConfiguracao,
  limiteDoDia,
  situacaoDoAquecimento,
} from './protecoes';

type NumeroCompleto = WhatsappNumero & {
  canal: Canal & { filaPadrao: FilaAtendimento | null };
};

const INCLUIR = { canal: { include: { filaPadrao: true } } } as const;

/** Campos do número que entram na auditoria das edições. */
const CAMPOS_AUDITADOS = [
  'nome',
  'limiteDiario',
  'intervaloMinimoSegundos',
  'intervaloMaximoSegundos',
  'aquecimentoDias',
] as const;

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Números de WhatsApp (R13), do lado da API: cada número é um canal
 * `WHATSAPP` do Atendimento com a linha de `whatsapp_numeros` (limites,
 * aquecimento, proteções, pausa). Só o Admin gerencia.
 *
 * Conectar, desconectar, o status ao vivo (com o QR) e a verificação de
 * telefone são comandos ao gateway (`ClienteGatewayWhatsapp`); o status que
 * o gateway grava chega à tela pelo evento `whatsapp.conexao`. O resto
 * (cadastro, limites, pausa) é gravado aqui, com auditoria — o gateway lê a
 * configuração do banco a cada envio.
 */
@Injectable()
export class NumerosWhatsappService {
  private readonly logger = new Logger('WhatsApp');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly gateway: ClienteGatewayWhatsapp,
  ) {}

  async listar(): Promise<NumeroWhatsappDto[]> {
    const numeros = await this.prisma.whatsappNumero.findMany({
      where: { canal: { excluidoEm: null, tipo: 'WHATSAPP' } },
      include: INCLUIR,
      orderBy: { criadoEm: 'asc' },
    });
    return this.montar(numeros);
  }

  async detalhar(id: string): Promise<NumeroWhatsappDto> {
    const [dto] = await this.montar([await this.buscar(this.prisma, id)]);
    return dto;
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarNumeroWhatsappDto,
  ): Promise<NumeroWhatsappDto> {
    const intervalo = this.conferirIntervalo(
      dto.intervaloMinimoSegundos ?? 2,
      dto.intervaloMaximoSegundos ?? 6,
    );
    const id = await this.prisma.$transaction(async (tx) => {
      await this.garantirNomeLivre(tx, dto.nome);
      if (dto.filaPadraoId) {
        await this.conferirFila(tx, dto.filaPadraoId);
      }
      const configuracao = this.juntarProtecoes({}, dto.protecoes);
      const canal = await tx.canal.create({
        data: {
          tipo: 'WHATSAPP',
          nome: dto.nome,
          filaPadraoId: dto.filaPadraoId ?? null,
          criadoPorId: usuario.id,
        },
      });
      const numero = await tx.whatsappNumero.create({
        data: {
          canalId: canal.id,
          nome: dto.nome,
          ...(dto.limiteDiario !== undefined
            ? { limiteDiario: dto.limiteDiario }
            : {}),
          intervaloMinimoSegundos: intervalo.minimo,
          intervaloMaximoSegundos: intervalo.maximo,
          ...(dto.aquecimentoDias !== undefined
            ? { aquecimentoDias: dto.aquecimentoDias }
            : {}),
          configuracao: configuracao as Prisma.InputJsonObject,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'whatsapp.numero_criado',
        entidade: 'whatsapp_numero',
        entidadeId: numero.id,
        resumo: `Número de WhatsApp "${numero.nome}" cadastrado`,
        dados: {
          canalId: canal.id,
          filaPadraoId: canal.filaPadraoId,
          limiteDiario: numero.limiteDiario,
          intervaloMinimoSegundos: numero.intervaloMinimoSegundos,
          intervaloMaximoSegundos: numero.intervaloMaximoSegundos,
          aquecimentoDias: numero.aquecimentoDias,
          protecoes: configuracao,
        },
      });
      return numero.id;
    });
    return this.detalhar(id);
  }

  async atualizar(
    id: string,
    dto: AtualizarNumeroWhatsappDto,
  ): Promise<NumeroWhatsappDto> {
    await this.prisma.$transaction(async (tx) => {
      const antes = await this.travar(tx, id);
      const intervalo = this.conferirIntervalo(
        dto.intervaloMinimoSegundos ?? antes.intervaloMinimoSegundos,
        dto.intervaloMaximoSegundos ?? antes.intervaloMaximoSegundos,
      );
      if (dto.nome !== undefined && dto.nome !== antes.nome) {
        await this.garantirNomeLivre(tx, dto.nome, antes.canalId);
      }
      if (dto.filaPadraoId) {
        await this.conferirFila(tx, dto.filaPadraoId);
      }
      const configuracaoAntes = lerConfiguracao(antes.configuracao);
      const configuracao = this.juntarProtecoes(
        objetoDe(antes.configuracao),
        dto.protecoes,
      );
      const depois = await tx.whatsappNumero.update({
        where: { id },
        data: {
          ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
          ...(dto.limiteDiario !== undefined
            ? { limiteDiario: dto.limiteDiario }
            : {}),
          intervaloMinimoSegundos: intervalo.minimo,
          intervaloMaximoSegundos: intervalo.maximo,
          ...(dto.aquecimentoDias !== undefined
            ? { aquecimentoDias: dto.aquecimentoDias }
            : {}),
          configuracao: configuracao as Prisma.InputJsonObject,
        },
      });
      const canalAntes = antes.canal;
      const canalDepois = await tx.canal.update({
        where: { id: antes.canalId },
        data: {
          ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
          ...(dto.ativo !== undefined ? { ativo: dto.ativo } : {}),
          ...(dto.filaPadraoId !== undefined
            ? { filaPadraoId: dto.filaPadraoId }
            : {}),
        },
      });
      const alteracoes = {
        ...calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS),
        ...calcularAlteracoes(canalAntes, canalDepois, [
          'ativo',
          'filaPadraoId',
        ]),
        ...calcularAlteracoes(
          protecoesVisiveis(configuracaoAntes),
          protecoesVisiveis(lerConfiguracao(configuracao)),
        ),
      };
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'whatsapp.numero_atualizado',
          entidade: 'whatsapp_numero',
          entidadeId: id,
          resumo: `Número de WhatsApp "${depois.nome}" atualizado`,
          dados: { canalId: antes.canalId, alteracoes },
        });
      }
    });
    return this.detalhar(id);
  }

  /**
   * Exclui o número: desvincula no gateway (melhor esforço — fora do ar, a
   * sessão não volta ao subir, porque o canal está excluído), apaga as chaves
   * e exclui o canal. As conversas continuam no histórico.
   */
  async excluir(id: string): Promise<void> {
    const numero = await this.buscar(this.prisma, id);
    if (numero.status !== 'DESCONECTADO') {
      await this.gateway
        .desconectar(id, { sair: true })
        .catch((erro: unknown) =>
          this.logger.warn(
            `Não foi possível desvincular o número ${id} no gateway ao excluir: ${erro instanceof Error ? erro.message : String(erro)}`,
          ),
        );
    }
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, id);
      const agora = new Date();
      await tx.whatsappChave.deleteMany({ where: { numeroId: id } });
      await tx.whatsappNumero.update({
        where: { id },
        data: {
          status: 'DESCONECTADO',
          motivo: 'Número excluído do CRM.',
          desconectadoEm: agora,
        },
      });
      await tx.canal.update({
        where: { id: atual.canalId },
        data: { excluidoEm: agora, ativo: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'whatsapp.numero_excluido',
        entidade: 'whatsapp_numero',
        entidadeId: id,
        resumo: `Número de WhatsApp "${atual.nome}" excluído`,
        dados: { canalId: atual.canalId, telefone: atual.telefone },
      });
    });
  }

  async conectar(id: string): Promise<EstadoDoNumero> {
    await this.buscar(this.prisma, id);
    return this.gateway.conectar(id);
  }

  async desconectar(
    id: string,
    dto: DesconectarNumeroWhatsappDto,
  ): Promise<EstadoDoNumero> {
    await this.buscar(this.prisma, id);
    return this.gateway.desconectar(id, { sair: dto.sair ?? false });
  }

  async status(id: string): Promise<EstadoDoNumero> {
    await this.buscar(this.prisma, id);
    return this.gateway.status(id);
  }

  async verificar(
    id: string,
    telefone: string,
  ): Promise<ResultadoDaVerificacao> {
    await this.buscar(this.prisma, id);
    return this.gateway.verificar(id, telefone);
  }

  /** Pausa manual: nada sai pelo número (os envios esperam na fila) até retomar. */
  async pausar(
    id: string,
    dto: PausarNumeroWhatsappDto,
  ): Promise<NumeroWhatsappDto> {
    await this.prisma.$transaction(async (tx) => {
      const numero = await this.travar(tx, id);
      if (numero.pausadoEm) {
        throw new ConflitoException('O número já está pausado.');
      }
      const motivo = dto.motivo || 'Pausado pelo CRM.';
      await tx.whatsappNumero.update({
        where: { id },
        data: {
          pausadoEm: new Date(),
          pausaMotivo: motivo,
          configuracao: {
            ...objetoDe(numero.configuracao),
            pausaAutomatica: false,
          } as Prisma.InputJsonObject,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'whatsapp.pausado',
        entidade: 'whatsapp_numero',
        entidadeId: id,
        resumo: `Número de WhatsApp "${numero.nome}" pausado`,
        dados: { canalId: numero.canalId, motivo, automatica: false },
      });
    });
    return this.detalhar(id);
  }

  /** Tira a pausa (manual ou automática): os envios que esperavam voltam a sair. */
  async retomar(id: string): Promise<NumeroWhatsappDto> {
    await this.prisma.$transaction(async (tx) => {
      const numero = await this.travar(tx, id);
      if (!numero.pausadoEm) {
        throw new ConflitoException('O número não está pausado.');
      }
      await tx.whatsappNumero.update({
        where: { id },
        data: {
          pausadoEm: null,
          pausaMotivo: null,
          configuracao: {
            ...objetoDe(numero.configuracao),
            pausaAutomatica: false,
          } as Prisma.InputJsonObject,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'whatsapp.retomado',
        entidade: 'whatsapp_numero',
        entidadeId: id,
        resumo: `Número de WhatsApp "${numero.nome}" retomado`,
        dados: {
          canalId: numero.canalId,
          pausaMotivo: numero.pausaMotivo,
          automatica: lerConfiguracao(numero.configuracao).pausaAutomatica,
        },
      });
    });
    return this.detalhar(id);
  }

  /** Envios por dia (fuso de São Paulo), do mais recente ao mais antigo, com o limite de cada dia. */
  async envios(id: string, dias = 14): Promise<EnviosDoNumeroNoDiaDto[]> {
    const numero = await this.buscar(this.prisma, id);
    const agora = new Date();
    const hoje = dataDoDia(diaEmSaoPaulo(agora));
    const inicio = new Date(hoje.getTime() - (dias - 1) * UM_DIA_MS);
    const linhas = await this.prisma.whatsappEnvioDiario.findMany({
      where: { numeroId: id, dia: { gte: inicio } },
    });
    const porDia = new Map(
      linhas.map((linha) => [linha.dia.toISOString().slice(0, 10), linha]),
    );
    return Array.from({ length: dias }, (_, indice) => {
      const dia = new Date(hoje.getTime() - indice * UM_DIA_MS);
      const chave = dia.toISOString().slice(0, 10);
      const linha = porDia.get(chave);
      return {
        dia: chave,
        enviados: linha?.enviados ?? 0,
        falhas: linha?.falhas ?? 0,
        // Meio-dia daquele dia em São Paulo: o limite com o aquecimento de então.
        limite: limiteDoDia(
          numero,
          new Date(dia.getTime() + 15 * 60 * 60 * 1000),
        ),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  private async buscar(tx: Tx, id: string): Promise<NumeroCompleto> {
    const numero = await tx.whatsappNumero.findFirst({
      where: { id, canal: { excluidoEm: null, tipo: 'WHATSAPP' } },
      include: INCLUIR,
    });
    if (!numero) {
      throw new NaoEncontradoException('Número de WhatsApp não encontrado.');
    }
    return numero;
  }

  /** Trava a linha do número (edições concorrentes) e devolve o registro completo. */
  private async travar(tx: Tx, id: string): Promise<NumeroCompleto> {
    await tx.$queryRaw`SELECT 1 FROM "whatsapp_numeros" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.buscar(tx, id);
  }

  private async garantirNomeLivre(
    tx: Tx,
    nome: string,
    canalId?: string,
  ): Promise<void> {
    const repetido = await tx.canal.findFirst({
      where: {
        tipo: 'WHATSAPP',
        excluidoEm: null,
        nome: { equals: nome, mode: 'insensitive' },
        ...(canalId ? { id: { not: canalId } } : {}),
      },
      select: { id: true },
    });
    if (repetido) {
      throw new ConflitoException(
        'Já existe um número de WhatsApp com esse nome.',
        { campos: ['nome'] },
      );
    }
  }

  private async conferirFila(tx: Tx, filaId: string): Promise<void> {
    const fila = await tx.filaAtendimento.findFirst({
      where: { id: filaId, excluidoEm: null, ativa: true },
      select: { id: true },
    });
    if (!fila) {
      throw new DadosInvalidosException(
        'A fila escolhida não existe ou está inativa.',
        {
          campos: [
            {
              campo: 'filaPadraoId',
              mensagens: ['a fila não existe ou está inativa'],
            },
          ],
        },
      );
    }
  }

  private conferirIntervalo(
    minimo: number,
    maximo: number,
  ): { minimo: number; maximo: number } {
    if (maximo < minimo) {
      throw new DadosInvalidosException(
        'A espera máxima entre envios precisa ser maior ou igual à mínima.',
        {
          campos: [
            {
              campo: 'intervaloMaximoSegundos',
              mensagens: ['deve ser maior ou igual ao intervalo mínimo'],
            },
          ],
        },
      );
    }
    return { minimo, maximo };
  }

  /** A configuração gravada com as proteções novas por cima (o resto do JSON fica). */
  private juntarProtecoes(
    atual: Record<string, unknown>,
    protecoes: ProtecoesDoNumeroDto | undefined,
  ): Record<string, unknown> {
    const novas = Object.fromEntries(
      Object.entries(protecoes ?? {}).filter(
        ([, valor]) => valor !== undefined,
      ),
    );
    return { ...atual, ...novas };
  }

  private async montar(
    numeros: NumeroCompleto[],
  ): Promise<NumeroWhatsappDto[]> {
    if (numeros.length === 0) {
      return [];
    }
    const agora = new Date();
    const diaDeHoje = diaEmSaoPaulo(agora);
    const contagens = await this.prisma.whatsappEnvioDiario.findMany({
      where: {
        numeroId: { in: numeros.map((numero) => numero.id) },
        dia: dataDoDia(diaDeHoje),
      },
    });
    const porNumero = new Map<string, WhatsappEnvioDiario>(
      contagens.map((linha) => [linha.numeroId, linha]),
    );
    return numeros.map((numero) => {
      const configuracao = lerConfiguracao(numero.configuracao);
      const aquecimento = situacaoDoAquecimento(numero, agora);
      const hoje = porNumero.get(numero.id);
      return {
        id: numero.id,
        canalId: numero.canalId,
        nome: numero.nome,
        ativo: numero.canal.ativo,
        filaPadrao: numero.canal.filaPadrao
          ? {
              id: numero.canal.filaPadrao.id,
              nome: numero.canal.filaPadrao.nome,
              area: numero.canal.filaPadrao.area,
            }
          : null,
        status: numero.status,
        motivo: numero.motivo,
        telefone: numero.telefone,
        limiteDiario: numero.limiteDiario,
        intervaloMinimoSegundos: numero.intervaloMinimoSegundos,
        intervaloMaximoSegundos: numero.intervaloMaximoSegundos,
        aquecimento: {
          ativo: aquecimento.ativo,
          dia: aquecimento.dia,
          dias: aquecimento.dias,
          inicioEm: numero.aquecimentoInicioEm?.toISOString() ?? null,
          terminaEm: aquecimento.terminaEm,
        },
        hoje: {
          dia: diaDeHoje,
          enviados: hoje?.enviados ?? 0,
          falhas: hoje?.falhas ?? 0,
          limite: limiteDoDia(numero, agora),
        },
        protecoes: protecoesVisiveis(configuracao),
        pausa: numero.pausadoEm
          ? {
              pausadoEm: numero.pausadoEm.toISOString(),
              motivo: numero.pausaMotivo,
              automatica: configuracao.pausaAutomatica,
            }
          : null,
        conectadoEm: numero.conectadoEm?.toISOString() ?? null,
        desconectadoEm: numero.desconectadoEm?.toISOString() ?? null,
        ultimoEventoEm: numero.ultimoEventoEm?.toISOString() ?? null,
        tentativasReconexao: numero.tentativasReconexao,
        criadoEm: numero.criadoEm.toISOString(),
        atualizadoEm: numero.atualizadoEm.toISOString(),
      };
    });
  }
}

/** As proteções que a tela mostra e edita (a marca da pausa automática fica de fora). */
function protecoesVisiveis(
  configuracao: ConfiguracaoDoNumero,
): Omit<ConfiguracaoDoNumero, 'pausaAutomatica'> {
  return {
    digitando: configuracao.digitando,
    digitandoMaximoSegundos: configuracao.digitandoMaximoSegundos,
    verificarNumero: configuracao.verificarNumero,
    pausarAposFalhasSeguidas: configuracao.pausarAposFalhasSeguidas,
    limitarRespostas: configuracao.limitarRespostas,
  };
}

function objetoDe(json: unknown): Record<string, unknown> {
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
}
