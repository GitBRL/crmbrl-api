import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehAdmin, ehDiretoria, ehLider } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { funisAcessiveis } from '../funis/acessos-no-banco';
import { PrismaService } from '../prisma/prisma.service';
import {
  comoObjeto,
  desembrulhar,
  listaDe,
  numeroDe,
  textoDe,
} from './cliente-tresc-plus';
import { ConexaoTrescPlusService } from './conexao.service';
import { traduzindo } from './agente.service';
import {
  LIMITE_ENVIO_DISCADOR,
  REGRA_TRESC_PLUS,
} from './tresc-plus.constantes';
import type {
  EnviarAoDiscadorDto,
  ItemDoRelatorioDto,
  ListaTrescDto,
  RelatorioDoDiscadorDto,
} from './tresc-plus.dto';
import {
  identifierDoDiscador,
  somenteDigitos,
  telefoneParaTresc,
} from './telefone';

/** Quem envia ao discador: Admin, C-level e líderes (R34.6). */
export function podeEnviarAoDiscador(
  usuario: Pick<UsuarioAutenticado, 'papel'>,
): boolean {
  return (
    ehAdmin(usuario.papel) ||
    ehDiretoria(usuario.papel) ||
    ehLider(usuario.papel)
  );
}

const MOTIVOS_DO_3C: Record<string, string> = {
  check_dnd: 'Número na lista de não perturbe (DND).',
  filter_calls: 'Número ligado recentemente (filtro de ligações da campanha).',
  check_blacklist: 'Número na lista de bloqueio.',
  dnd: 'Número na lista de não perturbe (DND).',
  blacklist: 'Número na lista de bloqueio.',
  duplicate: 'Número repetido na lista.',
  invalid: 'Número inválido para o 3C+.',
};

/** Texto em português do motivo de o 3C+ ter filtrado um número. */
export function motivoDoFiltro(valor: unknown): string {
  const texto = textoDe(valor);
  if (!texto) return 'O 3C+ filtrou este número.';
  return (
    MOTIVOS_DO_3C[texto.toLowerCase()] ??
    `O 3C+ filtrou este número (${texto}).`
  );
}

interface RegistroDoMailing {
  phone: string;
  identifier: string;
  data: Record<string, unknown>;
}

/**
 * Envio ao discador (R34.6): negócios/contatos viram um `mailing.json` (`identifier` = id do negócio
 * ou do contato, `data` com nome, empresa, funil e etapa) numa lista de uma campanha do 3C+. Usa o
 * token do gestor (a rota exige perfil de gestor). O relatório devolve importados e filtrados, com o
 * motivo, e fica guardado em `tresc_plus_envios`.
 */
@Injectable()
export class DiscadorTrescPlusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly conexao: ConexaoTrescPlusService,
  ) {}

  async listas(campanhaId: number): Promise<ListaTrescDto[]> {
    const corpo = await traduzindo(async () =>
      (await this.conexao.clienteDaEmpresaAtual()).listas(campanhaId),
    );
    return listaDe(corpo).flatMap((item) => {
      const l = comoObjeto(item);
      const id = l ? numeroDe(l.id) : null;
      return l && id !== null
        ? [{ id, nome: textoDe(l.name) ?? `Lista ${id}` }]
        : [];
    });
  }

  async enviar(
    usuario: UsuarioAutenticado,
    dto: EnviarAoDiscadorDto,
  ): Promise<RelatorioDoDiscadorDto> {
    if (!podeEnviarAoDiscador(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes enviam leads ao discador.',
        { regra: REGRA_TRESC_PLUS },
      );
    }
    const negocioIds = [...new Set(dto.negocioIds ?? [])];
    const contatoIds = [...new Set(dto.contatoIds ?? [])];
    if (negocioIds.length + contatoIds.length === 0) {
      throw new DadosInvalidosException(
        'Informe os negócios ou os contatos a enviar.',
        {
          campos: [
            {
              campo: 'negocioIds',
              mensagens: ['informe ao menos um negócio ou contato'],
            },
          ],
        },
      );
    }
    if (negocioIds.length + contatoIds.length > LIMITE_ENVIO_DISCADOR) {
      throw new DadosInvalidosException(
        `Envie no máximo ${LIMITE_ENVIO_DISCADOR} registros por vez.`,
      );
    }
    if (!dto.listaId && !dto.nomeLista?.trim()) {
      throw new DadosInvalidosException(
        'Informe a lista da campanha ou o nome de uma lista nova.',
        {
          campos: [
            {
              campo: 'listaId',
              mensagens: ['informe a lista ou o nome de uma lista nova'],
            },
          ],
        },
      );
    }
    const config = await this.conexao.ler();
    if (!config.ativa) {
      throw new RegraVioladaException(
        REGRA_TRESC_PLUS,
        'A integração com o 3C+ não está ativa.',
        { motivo: 'integracao_inativa' },
      );
    }
    const { registros, naoEnviados } = await this.montar(
      usuario,
      negocioIds,
      contatoIds,
    );
    const cliente = await this.conexao.clienteDaEmpresaAtual();
    let listaId = dto.listaId ?? 0;
    let listaNome = dto.nomeLista?.trim() ?? null;
    if (!dto.listaId) {
      const criada = comoObjeto(
        desembrulhar(
          await traduzindo(() =>
            cliente.criarLista(dto.campanhaId, listaNome ?? 'CRM BRL'),
          ),
        ),
      );
      const id = criada ? numeroDe(criada.id) : null;
      if (id === null) {
        throw new RegraVioladaException(
          REGRA_TRESC_PLUS,
          'O 3C+ não criou a lista. Tente de novo.',
          { motivo: 'lista_nao_criada' },
        );
      }
      listaId = id;
    }
    let importados = 0;
    const filtrados: ItemDoRelatorioDto[] = [];
    if (registros.length > 0) {
      const resposta = await traduzindo(() =>
        cliente.enviarMailing(dto.campanhaId, listaId, registros),
      );
      const lido = this.lerRelatorio(resposta, registros);
      importados = lido.importados;
      filtrados.push(...lido.filtrados);
    }
    const detalhes = [...naoEnviados, ...filtrados];
    const campanhaNome = await this.nomeDaCampanha(dto.campanhaId);
    const envio = await this.prisma.$transaction(async (tx) => {
      const criado = await tx.trescPlusEnvio.create({
        data: {
          usuarioId: usuario.id,
          campanhaId: dto.campanhaId,
          campanhaNome,
          listaId,
          listaNome,
          enviados: registros.length,
          importados,
          filtrados: detalhes.length,
          detalhes: detalhes as unknown as object,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'tresc-plus.envio-ao-discador',
        entidade: 'tresc_plus',
        entidadeId: criado.id,
        resumo: `${usuario.nome} enviou ${registros.length} lead(s) à campanha ${campanhaNome ?? dto.campanhaId} do 3C+ (${importados} importados)`,
        dados: {
          regra: REGRA_TRESC_PLUS,
          campanhaId: dto.campanhaId,
          listaId,
          enviados: registros.length,
          importados,
          filtrados: detalhes.length,
        },
      });
      return criado;
    });
    return {
      envioId: envio.id,
      campanhaId: dto.campanhaId,
      listaId,
      listaNome,
      enviados: registros.length,
      importados,
      filtrados: detalhes.length,
      detalhes,
    };
  }

  private async nomeDaCampanha(id: number): Promise<string | null> {
    try {
      const corpo = await (
        await this.conexao.clienteDaEmpresaAtual()
      ).campanha(id);
      return textoDe(comoObjeto(desembrulhar(corpo))?.name);
    } catch {
      return null;
    }
  }

  /** Monta os registros do `mailing.json`; o que não dá para enviar vai direto para o relatório. */
  private async montar(
    usuario: UsuarioAutenticado,
    negocioIds: string[],
    contatoIds: string[],
  ): Promise<{
    registros: RegistroDoMailing[];
    naoEnviados: ItemDoRelatorioDto[];
  }> {
    const registros: RegistroDoMailing[] = [];
    const naoEnviados: ItemDoRelatorioDto[] = [];
    if (negocioIds.length > 0) {
      const negocios = await this.prisma.negocio.findMany({
        where: { id: { in: negocioIds }, excluidoEm: null },
        include: {
          contato: { select: { nome: true, telefone: true, email: true } },
          empresa: { select: { nome: true } },
          funil: { select: { nome: true } },
          etapa: { select: { nome: true } },
        },
      });
      const acesso = await funisAcessiveis(this.prisma, usuario);
      const porId = new Map(negocios.map((n) => [n.id, n]));
      for (const id of negocioIds) {
        const negocio = porId.get(id);
        if (!negocio || !acesso.podeVerNegocio(negocio)) {
          naoEnviados.push({
            identifier: identifierDoDiscador(id),
            telefone: null,
            motivo: 'Negócio não encontrado.',
          });
          continue;
        }
        const telefone = telefoneParaTresc(negocio.contato.telefone);
        if (!telefone) {
          naoEnviados.push({
            identifier: identifierDoDiscador(id),
            telefone: negocio.contato.telefone,
            motivo: 'O contato do negócio não tem um telefone válido.',
          });
          continue;
        }
        registros.push({
          phone: telefone,
          identifier: identifierDoDiscador(id),
          data: {
            nome: negocio.contato.nome,
            empresa: negocio.empresa?.nome ?? '',
            funil: negocio.funil.nome,
            etapa: negocio.etapa.nome,
            negocio: negocio.titulo,
            email: negocio.contato.email ?? '',
          },
        });
      }
    }
    if (contatoIds.length > 0) {
      const contatos = await this.prisma.contato.findMany({
        where: { id: { in: contatoIds }, excluidoEm: null },
        include: { empresa: { select: { nome: true } } },
      });
      const porId = new Map(contatos.map((c) => [c.id, c]));
      for (const id of contatoIds) {
        const contato = porId.get(id);
        if (!contato) {
          naoEnviados.push({
            identifier: identifierDoDiscador(id),
            telefone: null,
            motivo: 'Contato não encontrado.',
          });
          continue;
        }
        const telefone = telefoneParaTresc(contato.telefone);
        if (!telefone) {
          naoEnviados.push({
            identifier: identifierDoDiscador(id),
            telefone: contato.telefone,
            motivo: 'O contato não tem um telefone válido.',
          });
          continue;
        }
        registros.push({
          phone: telefone,
          identifier: identifierDoDiscador(id),
          data: {
            nome: contato.nome,
            empresa: contato.empresa?.nome ?? '',
            email: contato.email ?? '',
          },
        });
      }
    }
    return { registros, naoEnviados };
  }

  /** Lê `{data:{total, imported:{quantity,numbers}, filtered:{quantity,details}}}` com tolerância. */
  private lerRelatorio(
    resposta: unknown,
    registros: RegistroDoMailing[],
  ): { importados: number; filtrados: ItemDoRelatorioDto[] } {
    const dados = comoObjeto(desembrulhar(resposta)) ?? {};
    const importado = comoObjeto(dados.imported);
    const filtrado = comoObjeto(dados.filtered);
    const identifierDoNumero = new Map(
      registros.map((r) => [somenteDigitos(r.phone), r.identifier]),
    );
    const itens: ItemDoRelatorioDto[] = [];
    const detalhes = Array.isArray(filtrado?.details) ? filtrado.details : [];
    for (const item of detalhes) {
      const o = comoObjeto(item);
      const numero = o ? (o.phone ?? o.number ?? o.numero) : item;
      const digitos = somenteDigitos(numero);
      itens.push({
        identifier:
          textoDe(o?.identifier) ?? identifierDoNumero.get(digitos) ?? null,
        telefone: digitos || null,
        motivo: motivoDoFiltro(
          o ? (o.reason ?? o.motivo ?? o.filter ?? o.type) : null,
        ),
      });
    }
    const quantidadeFiltrada = numeroDe(filtrado?.quantity) ?? itens.length;
    while (itens.length < quantidadeFiltrada) {
      itens.push({
        identifier: null,
        telefone: null,
        motivo: 'O 3C+ filtrou este número.',
      });
    }
    const importados =
      numeroDe(importado?.quantity) ??
      (Array.isArray(importado?.numbers)
        ? importado.numbers.length
        : Math.max(0, registros.length - itens.length));
    return { importados, filtrados: itens };
  }
}
