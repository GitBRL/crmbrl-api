import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import type { Area, Etapa, Funil } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import {
  AREAS_COM_RODIZIO,
  FUNIS_BASE,
  type FunilInicial,
  PASSAGENS_INICIAIS,
} from './dados-iniciais';

export interface ResumoDaConfiguracaoInicial {
  funisCriados: number;
  passagensCriadas: number;
  regrasCriadas: number;
  adminCriado: boolean;
}

type FunilComEtapas = Funil & { etapas: Etapa[] };

/** Tentativas de rodar a configuração inicial quando o banco está fora na subida. */
const TENTATIVAS_NA_SUBIDA = 20;

/**
 * Configuração inicial, idempotente, rodada a cada subida da API (e pelo
 * `limparBanco()` dos testes): cria só o que falta — nunca altera o que o Admin
 * já configurou.
 *
 * - funis-base e etapas (R5.1, R5.2);
 * - passagens Marketing → Comercial e Comercial → CS (R5.7);
 * - uma regra de distribuição (rodízio) por área (R5.8);
 * - o Admin inicial, se não existir nenhum usuário (R2.6).
 *
 * Roda numa transação com trava, então duas réplicas subindo juntas não
 * duplicam nada. Tudo que cria é auditado com o ator `SISTEMA`.
 */
@Injectable()
export class SeedsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ConfiguracaoInicial');
  private temporizador?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly auditoria: AuditoriaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.executarNaSubida(1);
  }

  onModuleDestroy(): void {
    clearTimeout(this.temporizador);
  }

  async executar(): Promise<ResumoDaConfiguracaoInicial> {
    const { resumo, senhaGerada } = await executarComoAtor(
      { tipoAtor: 'SISTEMA', descricao: 'Configuração inicial' },
      () =>
        this.prisma.$transaction(async (tx) => {
          await travarChave(tx, 'configuracao-inicial');
          const funis: FunilComEtapas[] = [];
          let funisCriados = 0;
          for (const definicao of FUNIS_BASE) {
            const { funil, criado } = await this.garantirFunilBase(
              tx,
              definicao,
            );
            funis.push(funil);
            funisCriados += criado ? 1 : 0;
          }
          const passagensCriadas = await this.garantirPassagens(tx, funis);
          const regrasCriadas = await this.garantirRegrasDeDistribuicao(tx);
          const admin = await this.garantirAdmin(tx);
          return {
            resumo: {
              funisCriados,
              passagensCriadas,
              regrasCriadas,
              adminCriado: admin.criado,
            },
            senhaGerada: admin.senhaGerada,
          };
        }),
    );
    if (senhaGerada && this.ambiente.admin) {
      // Só no console (nunca nos logs técnicos do banco): é a única vez que ela aparece.
      this.logger.warn(
        `Admin inicial criado: ${this.ambiente.admin.email}. Senha inicial gerada: ${senhaGerada} ` +
          '(troca obrigatória no primeiro acesso; defina ADMIN_SENHA_INICIAL para escolher a sua).',
      );
    }
    return resumo;
  }

  private async executarNaSubida(tentativa: number): Promise<void> {
    try {
      const resumo = await this.executar();
      const criados =
        resumo.funisCriados +
        resumo.passagensCriadas +
        resumo.regrasCriadas +
        (resumo.adminCriado ? 1 : 0);
      if (criados > 0) {
        this.logger.log(
          `Configuração inicial aplicada: ${resumo.funisCriados} funil(is), ${resumo.passagensCriadas} passagem(ns), ` +
            `${resumo.regrasCriadas} regra(s) de distribuição${resumo.adminCriado ? ' e o Admin inicial' : ''}.`,
        );
      }
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      if (tentativa >= TENTATIVAS_NA_SUBIDA) {
        this.logger.error(`Configuração inicial não aplicada: ${mensagem}`);
        return;
      }
      this.logger.warn(
        `Configuração inicial adiada (${mensagem.split('\n').at(-1)}); nova tentativa em 30 s.`,
      );
      this.temporizador = setTimeout(
        () => void this.executarNaSubida(tentativa + 1),
        30_000,
      );
      this.temporizador.unref();
    }
  }

  private async garantirFunilBase(
    tx: Tx,
    definicao: FunilInicial,
  ): Promise<{ funil: FunilComEtapas; criado: boolean }> {
    const existente = await tx.funil.findFirst({
      where: { area: definicao.area, base: true },
      include: { etapas: true },
    });
    if (existente) {
      return { funil: existente, criado: false };
    }
    const funil = await tx.funil.create({
      data: {
        nome: definicao.nome,
        area: definicao.area,
        base: true,
        ordem: definicao.ordem,
        descricao: definicao.descricao,
        etapas: {
          create: definicao.etapas.map((etapa, indice) => ({
            chave: etapa.chave,
            nome: etapa.nome,
            ordem: indice + 1,
            tipo: etapa.tipo,
            prazoDias: etapa.prazoDias,
          })),
        },
      },
      include: { etapas: true },
    });
    await this.auditoria.registrar(tx, {
      acao: 'funil.criado',
      entidade: 'funil',
      entidadeId: funil.id,
      resumo: `Funil-base ${funil.nome} criado pela configuração inicial`,
      dados: {
        area: funil.area,
        etapas: funil.etapas.map((etapa) => etapa.nome),
      },
    });
    return { funil, criado: true };
  }

  private async garantirPassagens(
    tx: Tx,
    funis: readonly FunilComEtapas[],
  ): Promise<number> {
    let criadas = 0;
    for (const definicao of PASSAGENS_INICIAIS) {
      const existente = await tx.passagem.findUnique({
        where: { chave: definicao.chave },
      });
      if (existente) {
        continue;
      }
      const origem = this.encontrarEtapa(
        funis,
        definicao.origem.area,
        definicao.origem.etapa,
      );
      const destino = this.encontrarEtapa(
        funis,
        definicao.destino.area,
        definicao.destino.etapa,
      );
      if (!origem || !destino) {
        this.logger.warn(
          `Passagem "${definicao.nome}" não criada: etapa de origem ou de destino não existe mais.`,
        );
        continue;
      }
      const passagem = await tx.passagem.create({
        data: {
          chave: definicao.chave,
          nome: definicao.nome,
          funilOrigemId: origem.funil.id,
          etapaGatilhoId: origem.etapa.id,
          funilDestinoId: destino.funil.id,
          etapaDestinoId: destino.etapa.id,
          estrategia: definicao.estrategia,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'passagem.criada',
        entidade: 'passagem',
        entidadeId: passagem.id,
        resumo: `Passagem ${passagem.nome} criada pela configuração inicial`,
        dados: {
          gatilho: `${origem.funil.nome} / ${origem.etapa.nome}`,
          destino: `${destino.funil.nome} / ${destino.etapa.nome}`,
          estrategia: passagem.estrategia,
        },
      });
      criadas++;
    }
    return criadas;
  }

  private encontrarEtapa(
    funis: readonly FunilComEtapas[],
    area: Area,
    chave: string,
  ): { funil: FunilComEtapas; etapa: Etapa } | null {
    const funil = funis.find((candidato) => candidato.area === area);
    const etapa = funil?.etapas.find((candidata) => candidata.chave === chave);
    return funil && etapa ? { funil, etapa } : null;
  }

  private async garantirRegrasDeDistribuicao(tx: Tx): Promise<number> {
    let criadas = 0;
    for (const area of AREAS_COM_RODIZIO) {
      const existente = await tx.regraDistribuicao.findUnique({
        where: { area },
      });
      if (existente) {
        continue;
      }
      const regra = await tx.regraDistribuicao.create({ data: { area } });
      await this.auditoria.registrar(tx, {
        acao: 'regra_distribuicao.criada',
        entidade: 'regra_distribuicao',
        entidadeId: regra.id,
        resumo: `Rodízio da área ${area} criado pela configuração inicial`,
        dados: { area, incluirLideres: regra.incluirLideres },
      });
      criadas++;
    }
    return criadas;
  }

  /** R2.6: sem nenhum usuário, cria o Admin de `ADMIN_EMAIL` com troca de senha obrigatória. */
  private async garantirAdmin(
    tx: Tx,
  ): Promise<{ criado: boolean; senhaGerada: string | null }> {
    const total = await tx.usuario.count();
    if (total > 0) {
      return { criado: false, senhaGerada: null };
    }
    const configuracao = this.ambiente.admin;
    if (!configuracao) {
      this.logger.warn(
        'Nenhum usuário cadastrado e ADMIN_EMAIL não definido: ninguém consegue entrar. Defina ADMIN_EMAIL (e ADMIN_SENHA_INICIAL).',
      );
      return { criado: false, senhaGerada: null };
    }
    const senhaGerada = configuracao.senhaInicial
      ? null
      : this.cripto.gerarToken(12);
    const senha = configuracao.senhaInicial ?? senhaGerada ?? '';
    const admin = await tx.usuario.create({
      data: {
        nome: configuracao.nome,
        email: configuracao.email,
        papel: 'ADMIN',
        senhaHash: await this.cripto.hashSenha(senha),
        deveTrocarSenha: true,
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'usuario.criado',
      entidade: 'usuario',
      entidadeId: admin.id,
      resumo: `Admin inicial ${admin.nome} (${admin.email}) criado pela configuração inicial`,
      dados: {
        regra: 'R2.6',
        papel: admin.papel,
        deveTrocarSenha: true,
        senhaInicialGerada: senhaGerada !== null,
      },
    });
    return { criado: true, senhaGerada };
  }
}
