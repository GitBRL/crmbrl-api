import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { validarModelo } from '../comum/modelos/modelos';
import type { Prisma, ReguaEtapa } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  CHAVE_CONFIGURACAO_FINANCEIRO,
  VARIAVEIS_DO_TITULO,
} from './financeiro.constantes';
import type {
  AtualizarConfiguracaoReguaDto,
  SalvarEtapaDto,
} from './financeiro.dto';
import {
  podeAtuarNoFinanceiro,
  podeGerenciarARegua,
} from './permissoes-financeiro';
import {
  ETAPAS_PADRAO,
  TEXTO_PROMESSA_CONFIRMADA_PADRAO,
  TEXTO_PROMESSA_NAO_CUMPRIDA_PADRAO,
} from './regua-padrao';

/** Configuração da régua (`configuracoes.financeiro`), com padrões no código (R24.2). */
export interface ConfiguracaoDaRegua {
  ativa: boolean;
  /** `HH:MM`, America/Sao_Paulo. */
  horario: string;
  toleranciaDias: number;
  /** Número (canal) de WhatsApp do financeiro; nulo = qualquer número conectado. */
  canalWhatsappId: string | null;
  intervaloWhatsappSegundos: number;
  horarioLimiteLigacoes: string;
  pausada: boolean;
  textoPromessaConfirmada: string;
  textoPromessaNaoCumprida: string;
  /** As etapas padrão já foram criadas (não recriar se a gestão apagar todas). */
  etapasSemeadas: boolean;
}

export const CONFIGURACAO_PADRAO_DA_REGUA: Readonly<ConfiguracaoDaRegua> = {
  ativa: true,
  horario: '09:00',
  toleranciaDias: 3,
  canalWhatsappId: null,
  intervaloWhatsappSegundos: 20,
  horarioLimiteLigacoes: '17:00',
  pausada: false,
  textoPromessaConfirmada: TEXTO_PROMESSA_CONFIRMADA_PADRAO,
  textoPromessaNaoCumprida: TEXTO_PROMESSA_NAO_CUMPRIDA_PADRAO,
  etapasSemeadas: false,
};

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export function lerConfiguracaoDaRegua(valor: unknown): ConfiguracaoDaRegua {
  const b =
    valor && typeof valor === 'object' && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : {};
  const p = CONFIGURACAO_PADRAO_DA_REGUA;
  const texto = (v: unknown, padrao: string) =>
    typeof v === 'string' && v.trim() !== '' ? v : padrao;
  const inteiro = (v: unknown, padrao: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : padrao;
  return {
    ativa: typeof b.ativa === 'boolean' ? b.ativa : p.ativa,
    horario:
      typeof b.horario === 'string' && HORA.test(b.horario)
        ? b.horario
        : p.horario,
    toleranciaDias: inteiro(b.toleranciaDias, p.toleranciaDias),
    canalWhatsappId:
      typeof b.canalWhatsappId === 'string' ? b.canalWhatsappId : null,
    intervaloWhatsappSegundos: inteiro(
      b.intervaloWhatsappSegundos,
      p.intervaloWhatsappSegundos,
    ),
    horarioLimiteLigacoes:
      typeof b.horarioLimiteLigacoes === 'string' &&
      HORA.test(b.horarioLimiteLigacoes)
        ? b.horarioLimiteLigacoes
        : p.horarioLimiteLigacoes,
    pausada: typeof b.pausada === 'boolean' ? b.pausada : p.pausada,
    textoPromessaConfirmada: texto(
      b.textoPromessaConfirmada,
      p.textoPromessaConfirmada,
    ),
    textoPromessaNaoCumprida: texto(
      b.textoPromessaNaoCumprida,
      p.textoPromessaNaoCumprida,
    ),
    etapasSemeadas: b.etapasSemeadas === true,
  };
}

export interface EtapaDaReguaDto {
  id: string;
  nome: string;
  marco: number;
  /** Rótulo curto (`D-7`, `D0`, `D+3`). */
  rotuloDoMarco: string;
  ativa: boolean;
  whatsapp: boolean;
  email: boolean;
  ligacao: boolean;
  modeloWhatsappId: string | null;
  textoWhatsapp: string | null;
  modeloEmailId: string | null;
  assuntoEmail: string | null;
  textoEmail: string | null;
  roteiroLigacao: string | null;
}

export function rotuloDoMarco(marco: number): string {
  return marco === 0 ? 'D0' : marco < 0 ? `D${marco}` : `D+${marco}`;
}

function paraDto(e: ReguaEtapa): EtapaDaReguaDto {
  return {
    id: e.id,
    nome: e.nome,
    marco: e.marco,
    rotuloDoMarco: rotuloDoMarco(e.marco),
    ativa: e.ativa,
    whatsapp: e.whatsapp,
    email: e.email,
    ligacao: e.ligacao,
    modeloWhatsappId: e.modeloWhatsappId,
    textoWhatsapp: e.textoWhatsapp,
    modeloEmailId: e.modeloEmailId,
    assuntoEmail: e.assuntoEmail,
    textoEmail: e.textoEmail,
    roteiroLigacao: e.roteiroLigacao,
  };
}

/**
 * Configuração e etapas da régua (R24.1, R24.2). Qualquer um com acesso vê; só a
 * gestão (Admin, C-level, Líder de CS) altera.
 */
@Injectable()
export class ReguaConfiguracaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
  ) {}

  async configuracao(): Promise<ConfiguracaoDaRegua> {
    const linha = await this.prisma.configuracao.findUnique({
      where: { chave: CHAVE_CONFIGURACAO_FINANCEIRO },
    });
    return lerConfiguracaoDaRegua(linha?.valor);
  }

  async obter(usuario: UsuarioAutenticado) {
    this.exigirVer(usuario);
    return {
      ...(await this.configuracao()),
      variaveis: VARIAVEIS_DO_TITULO,
      podeEditar: podeGerenciarARegua(usuario.papel),
    };
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    dto: AtualizarConfiguracaoReguaDto,
  ) {
    this.exigirGestao(usuario);
    if (dto.canalWhatsappId) {
      const canal = await this.prisma.canal.findFirst({
        where: { id: dto.canalWhatsappId, tipo: 'WHATSAPP', excluidoEm: null },
        select: { id: true },
      });
      if (!canal) {
        throw new DadosInvalidosException(
          'O número de WhatsApp escolhido não existe.',
          {
            campos: [
              {
                campo: 'canalWhatsappId',
                mensagens: ['canal de WhatsApp não encontrado'],
              },
            ],
          },
        );
      }
    }
    for (const campo of [
      'textoPromessaConfirmada',
      'textoPromessaNaoCumprida',
    ] as const) {
      const texto = dto[campo];
      if (texto !== undefined) {
        const { erros } = validarModelo(texto, {
          variaveisExtras: VARIAVEIS_DO_TITULO,
          permitirVariaveisDaExecucao: false,
        });
        if (erros.length > 0) {
          throw new DadosInvalidosException(
            'O texto tem variáveis inválidas.',
            {
              campos: [{ campo, mensagens: erros.map((e) => e.mensagem) }],
            },
          );
        }
      }
    }
    const depois = await this.prisma.$transaction(async (tx) => {
      const linha = await tx.configuracao.findUnique({
        where: { chave: CHAVE_CONFIGURACAO_FINANCEIRO },
      });
      const antes = lerConfiguracaoDaRegua(linha?.valor);
      const novo = lerConfiguracaoDaRegua({ ...antes, ...semIndefinidos(dto) });
      await tx.configuracao.upsert({
        where: { chave: CHAVE_CONFIGURACAO_FINANCEIRO },
        create: {
          chave: CHAVE_CONFIGURACAO_FINANCEIRO,
          valor: { ...novo },
          atualizadoPorId: usuario.id,
        },
        update: { valor: { ...novo }, atualizadoPorId: usuario.id },
      });
      await this.auditoria.registrar(tx, {
        acao: 'regua.configuracao_atualizada',
        entidade: 'configuracao',
        entidadeId: null,
        resumo: `${usuario.nome} alterou a configuração da régua de cobrança`,
        dados: {
          alteracoes: calcularAlteracoes({ ...antes }, { ...novo }),
          regra: 'R24.2',
        },
      });
      return novo;
    });
    return { ...depois, variaveis: VARIAVEIS_DO_TITULO, podeEditar: true };
  }

  // ---- etapas --------------------------------------------------------------

  async etapas(usuario: UsuarioAutenticado): Promise<EtapaDaReguaDto[]> {
    this.exigirVer(usuario);
    return (await this.todasAsEtapas()).map(paraDto);
  }

  /** Etapas ordenadas pelo marco; cria as padrão na primeira vez. */
  async todasAsEtapas(): Promise<ReguaEtapa[]> {
    await this.semearSeNecessario();
    return this.prisma.reguaEtapa.findMany({ orderBy: { marco: 'asc' } });
  }

  async semearSeNecessario(): Promise<void> {
    const config = await this.configuracao();
    if (config.etapasSemeadas) return;
    await this.prisma.$transaction(async (tx) => {
      const [linha] = await tx.$queryRaw<{ valor: unknown }[]>`
        SELECT valor FROM configuracoes WHERE chave = ${CHAVE_CONFIGURACAO_FINANCEIRO} FOR UPDATE`;
      if (lerConfiguracaoDaRegua(linha?.valor).etapasSemeadas) return;
      if ((await tx.reguaEtapa.count()) === 0) {
        await tx.reguaEtapa.createMany({
          data: ETAPAS_PADRAO.map((e) => ({ ...e })),
        });
      }
      const atual = lerConfiguracaoDaRegua(linha?.valor);
      await tx.configuracao.upsert({
        where: { chave: CHAVE_CONFIGURACAO_FINANCEIRO },
        create: {
          chave: CHAVE_CONFIGURACAO_FINANCEIRO,
          valor: { ...atual, etapasSemeadas: true },
        },
        update: { valor: { ...atual, etapasSemeadas: true } },
      });
    });
  }

  async criarEtapa(usuario: UsuarioAutenticado, dto: SalvarEtapaDto) {
    this.exigirGestao(usuario);
    await this.semearSeNecessario();
    await this.validarEtapa(dto);
    const criada = await this.prisma.$transaction(async (tx) => {
      await this.garantirMarcoLivre(tx, dto.marco);
      const e = await tx.reguaEtapa.create({ data: dadosDaEtapa(dto) });
      await this.auditoria.registrar(tx, {
        acao: 'regua.etapa_criada',
        entidade: 'regua_etapa',
        entidadeId: e.id,
        resumo: `${usuario.nome} criou a etapa "${e.nome}" (${rotuloDoMarco(e.marco)}) da régua`,
        dados: { marco: e.marco, regra: 'R24.1' },
      });
      return e;
    });
    return paraDto(criada);
  }

  async atualizarEtapa(
    usuario: UsuarioAutenticado,
    id: string,
    dto: SalvarEtapaDto,
  ) {
    this.exigirGestao(usuario);
    await this.validarEtapa(dto);
    const nova = await this.prisma.$transaction(async (tx) => {
      const atual = await tx.reguaEtapa.findUnique({ where: { id } });
      if (!atual) throw new NaoEncontradoException('Etapa não encontrada.');
      if (dto.marco !== atual.marco)
        await this.garantirMarcoLivre(tx, dto.marco, id);
      const e = await tx.reguaEtapa.update({
        where: { id },
        data: dadosDaEtapa(dto),
      });
      await this.auditoria.registrar(tx, {
        acao: 'regua.etapa_atualizada',
        entidade: 'regua_etapa',
        entidadeId: id,
        resumo: `${usuario.nome} alterou a etapa "${e.nome}" (${rotuloDoMarco(e.marco)}) da régua`,
        dados: {
          alteracoes: calcularAlteracoes(
            { ...paraDto(atual) },
            { ...paraDto(e) },
          ),
          regra: 'R24.1',
        },
      });
      return e;
    });
    return paraDto(nova);
  }

  async removerEtapa(usuario: UsuarioAutenticado, id: string): Promise<void> {
    this.exigirGestao(usuario);
    await this.prisma.$transaction(async (tx) => {
      const atual = await tx.reguaEtapa.findUnique({ where: { id } });
      if (!atual) throw new NaoEncontradoException('Etapa não encontrada.');
      await tx.reguaEtapa.delete({ where: { id } });
      await this.auditoria.registrar(tx, {
        acao: 'regua.etapa_removida',
        entidade: 'regua_etapa',
        entidadeId: id,
        resumo: `${usuario.nome} removeu a etapa "${atual.nome}" (${rotuloDoMarco(atual.marco)}) da régua`,
        dados: { marco: atual.marco, regra: 'R24.1' },
      });
    });
  }

  // ---- apoio -----------------------------------------------------------------

  /** A régua é da gestão e do CS; o Comercial e o Marketing não a acessam. */
  private exigirVer(usuario: UsuarioAutenticado): void {
    if (!podeAtuarNoFinanceiro(usuario.papel)) {
      throw new SemPermissaoException(
        'Você não tem acesso à régua de cobrança.',
        { regra: 'R22.1' },
      );
    }
  }

  private exigirGestao(usuario: UsuarioAutenticado): void {
    if (!podeGerenciarARegua(usuario.papel)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e Líder de CS alteram a régua.',
        { regra: 'R22.1' },
      );
    }
  }

  private async garantirMarcoLivre(
    tx: Tx,
    marco: number,
    exceto?: string,
  ): Promise<void> {
    const outra = await tx.reguaEtapa.findFirst({
      where: { marco, ...(exceto ? { id: { not: exceto } } : {}) },
      select: { nome: true },
    });
    if (outra) {
      throw new ConflitoException(
        `Já existe a etapa "${outra.nome}" em ${rotuloDoMarco(marco)}.`,
        { regra: 'R24.1', marco },
      );
    }
  }

  private async validarEtapa(dto: SalvarEtapaDto): Promise<void> {
    const campos: { campo: string; mensagens: string[] }[] = [];
    if (!dto.whatsapp && !dto.email && !dto.ligacao) {
      campos.push({
        campo: 'whatsapp',
        mensagens: ['escolha ao menos um canal'],
      });
    }
    const conferir = (campo: string, texto: string | null | undefined) => {
      if (!texto) return;
      const { erros } = validarModelo(texto, {
        variaveisExtras: VARIAVEIS_DO_TITULO,
        permitirVariaveisDaExecucao: false,
      });
      if (erros.length > 0)
        campos.push({ campo, mensagens: erros.map((e) => e.mensagem) });
    };
    conferir('textoWhatsapp', dto.textoWhatsapp);
    conferir('assuntoEmail', dto.assuntoEmail);
    conferir('textoEmail', dto.textoEmail);
    if (dto.whatsapp && !dto.modeloWhatsappId && !dto.textoWhatsapp?.trim()) {
      campos.push({
        campo: 'textoWhatsapp',
        mensagens: ['informe o texto ou um modelo de WhatsApp'],
      });
    }
    if (
      dto.email &&
      !dto.modeloEmailId &&
      !(dto.assuntoEmail?.trim() && dto.textoEmail?.trim())
    ) {
      campos.push({
        campo: 'textoEmail',
        mensagens: ['informe assunto e texto, ou um modelo de e-mail'],
      });
    }
    for (const [campo, id, canal] of [
      ['modeloWhatsappId', dto.modeloWhatsappId, 'WHATSAPP'],
      ['modeloEmailId', dto.modeloEmailId, 'EMAIL'],
    ] as const) {
      if (!id) continue;
      const modelo = await this.prisma.modeloMensagem.findFirst({
        where: { id, excluidoEm: null, OR: [{ canal }, { canal: null }] },
        select: { id: true },
      });
      if (!modelo)
        campos.push({
          campo,
          mensagens: ['modelo não encontrado para este canal'],
        });
    }
    if (campos.length > 0) {
      throw new DadosInvalidosException('A etapa tem problemas.', {
        regra: 'R24.1',
        campos,
      });
    }
  }
}

function dadosDaEtapa(
  dto: SalvarEtapaDto,
): Prisma.ReguaEtapaUncheckedCreateInput {
  const vazio = (t: string | null | undefined) =>
    t && t.trim() !== '' ? t : null;
  return {
    nome: dto.nome,
    marco: dto.marco,
    ativa: dto.ativa ?? true,
    whatsapp: dto.whatsapp ?? false,
    email: dto.email ?? false,
    ligacao: dto.ligacao ?? false,
    modeloWhatsappId: dto.modeloWhatsappId ?? null,
    textoWhatsapp: vazio(dto.textoWhatsapp),
    modeloEmailId: dto.modeloEmailId ?? null,
    assuntoEmail: vazio(dto.assuntoEmail),
    textoEmail: vazio(dto.textoEmail),
    roteiroLigacao: vazio(dto.roteiroLigacao),
  };
}

function semIndefinidos<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
