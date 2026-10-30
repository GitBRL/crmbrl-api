import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { NaoEncontradoException } from '../erros/excecoes';
import {
  type DadosDoModelo,
  type ErroDeModelo,
  type OpcoesDeRenderizacao,
  type OpcoesDeValidacao,
  renderizarModelo,
  validarModelo,
  VARIAVEIS_DE_MODELO,
} from './modelos';

/** Para quem o modelo é renderizado. */
export interface AlvoDoModelo {
  contatoId?: string | null;
  /** Com negócio, `{{responsavel.*}}` é o responsável do negócio (senão, o do contato). */
  negocioId?: string | null;
  /** Variáveis da execução (`{{variaveis.*}}`). */
  variaveis?: Record<string, unknown> | null;
}

export interface ModeloRenderizado {
  texto: string;
  /** Erros de validação do modelo (variáveis desconhecidas, sintaxe). */
  erros: ErroDeModelo[];
}

/** Dados de exemplo da prévia sem contato. */
export const DADOS_DE_EXEMPLO: DadosDoModelo = {
  contato: {
    nome: 'Ana Souza',
    email: 'ana@exemplo.com.br',
    telefone: '5511987654321',
    cargo: 'Diretora',
    campos: {},
  },
  empresa: { nome: 'Exemplo Ltda', campos: {} },
  negocio: {
    titulo: 'Plano anual',
    valor: '1500.00',
    etapa: 'Proposta',
    funil: 'Comercial',
    campos: {},
  },
  responsavel: { nome: 'Bruno Lima', email: 'bruno@brl.com.br' },
};

/**
 * Renderização de modelos com dados do banco (Onda B, §2.1). As funções puras
 * (`renderizarModelo`, `validarModelo`) estão em `./modelos`.
 *
 * ```ts
 * const { texto } = await this.modelos.renderizarPara(campanha.texto,
 *   { contatoId: destinatario.contatoId }, { semente: destinatario.id });
 * ```
 */
@Injectable()
export class ModelosService {
  constructor(private readonly prisma: PrismaService) {}

  /** Carrega contato, empresa, negócio e responsável. 404 se o contato/negócio não existir. */
  async carregarDados(alvo: AlvoDoModelo, tx?: Tx): Promise<DadosDoModelo> {
    const banco = tx ?? this.prisma;
    const negocio = alvo.negocioId
      ? await banco.negocio.findFirst({
          where: { id: alvo.negocioId, excluidoEm: null },
          include: {
            etapa: { select: { nome: true } },
            funil: { select: { nome: true } },
            responsavel: {
              select: { nome: true, email: true, telefone: true },
            },
          },
        })
      : null;
    if (alvo.negocioId && !negocio) {
      throw new NaoEncontradoException('Negócio não encontrado.');
    }
    const contatoId = alvo.contatoId ?? negocio?.contatoId ?? null;
    const contato = contatoId
      ? await banco.contato.findFirst({
          where: { id: contatoId, excluidoEm: null },
          include: {
            empresa: { select: { nome: true, camposPersonalizados: true } },
            responsavel: {
              select: { nome: true, email: true, telefone: true },
            },
          },
        })
      : null;
    if (contatoId && !contato) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
    return {
      contato: contato && {
        nome: contato.nome,
        email: contato.email,
        telefone: contato.telefone,
        cargo: contato.cargo,
        campos: objeto(contato.camposPersonalizados),
      },
      empresa: contato?.empresa && {
        nome: contato.empresa.nome,
        campos: objeto(contato.empresa.camposPersonalizados),
      },
      negocio: negocio && {
        titulo: negocio.titulo,
        valor: negocio.valor.toFixed(2),
        etapa: negocio.etapa.nome,
        funil: negocio.funil.nome,
        campos: objeto(negocio.camposPersonalizados),
      },
      responsavel: negocio?.responsavel ?? contato?.responsavel ?? null,
      variaveis: alvo.variaveis ?? null,
    };
  }

  /** Valida e renderiza para o alvo. Sem contato nem negócio, usa `DADOS_DE_EXEMPLO`. */
  async renderizarPara(
    texto: string,
    alvo: AlvoDoModelo,
    opcoes: OpcoesDeRenderizacao & OpcoesDeValidacao & { tx?: Tx } = {},
  ): Promise<ModeloRenderizado> {
    const { erros } = validarModelo(texto, opcoes);
    const dados =
      alvo.contatoId || alvo.negocioId
        ? await this.carregarDados(alvo, opcoes.tx)
        : { ...DADOS_DE_EXEMPLO, variaveis: alvo.variaveis ?? null };
    return { texto: renderizarModelo(texto, dados, opcoes), erros };
  }

  /** Variáveis do editor, com as chaves de campos personalizados em uso. */
  async catalogo(): Promise<{
    variaveis: typeof VARIAVEIS_DE_MODELO;
    camposPersonalizados: {
      contato: string[];
      empresa: string[];
      negocio: string[];
    };
  }> {
    const [contato, empresa, negocio] = await Promise.all([
      this.chavesEmUso('contatos'),
      this.chavesEmUso('empresas'),
      this.chavesEmUso('negocios'),
    ]);
    return {
      variaveis: VARIAVEIS_DE_MODELO,
      camposPersonalizados: { contato, empresa, negocio },
    };
  }

  /** Chaves de `campos_personalizados` em uso numa tabela (até 200, em ordem alfabética). */
  async chavesEmUso(
    tabela: 'contatos' | 'empresas' | 'negocios',
  ): Promise<string[]> {
    const linhas = await this.prisma.$queryRawUnsafe<{ chave: string }[]>(
      `SELECT DISTINCT jsonb_object_keys(campos_personalizados) AS chave
         FROM "${tabela}"
        WHERE excluido_em IS NULL AND jsonb_typeof(campos_personalizados) = 'object'
        ORDER BY 1 LIMIT 200`,
    );
    return linhas.map(({ chave }) => chave);
  }
}

function objeto(valor: Prisma.JsonValue): Record<string, unknown> {
  return valor && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}
