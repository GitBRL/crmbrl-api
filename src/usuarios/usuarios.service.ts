import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { DoisFatoresService } from '../auth/dois-fatores/dois-fatores.service';
import { SenhasService } from '../auth/senhas.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { formatarValor } from '../comum/dominio/dinheiro';
import { normalizarEmail } from '../comum/dominio/email';
import {
  ehDiretoria,
  ehLider,
  liderEsperado,
  papelTemSetor,
  rotuloDoPapel,
} from '../comum/dominio/papeis';
import { nomeDoSetor } from '../comum/dominio/setores';
import {
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { Prisma, type Papel } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  problemaDeMudancaDePapel,
  temLiderEsperado,
} from './dominio/hierarquia';
import { filtroDeVisibilidade, podeVerUsuario } from './dominio/visibilidade';
import type { AtualizarUsuarioDto } from './dto/atualizar-usuario.dto';
import type { CriarUsuarioDto } from './dto/criar-usuario.dto';
import type {
  EquipeDto,
  FiltroEquipesDto,
  IndicadoresDto,
  MembroDaEquipeDto,
} from './dto/equipe.dto';
import type { FiltroUsuariosDto } from './dto/filtro-usuarios.dto';
import {
  type FiltroOpcoesDePessoasDto,
  OpcaoDePessoaDto,
} from './dto/opcoes-de-pessoas.dto';
import type { DefinirSenhaTemporariaDto } from './dto/senha-temporaria.dto';
import {
  type ConviteDto,
  type ConviteEnviadoDto,
  INCLUIR_LIDER,
  SELECAO_RESUMO,
  type UsuarioCriadoDto,
  UsuarioDto,
  UsuarioResumoDto,
} from './dto/usuario.dto';
import {
  excecaoDaRegra,
  exigirEmailLivre,
  exigirLiderValido,
  exigirOutroAdminAtivo,
  exigirSetorDoPapel,
  lerIdentificadorDeIntegracao,
  lerTelefone,
  lideradosAtivos,
  travarHierarquia,
} from './hierarquia-no-banco';

/** Campos editáveis comparados na auditoria de `usuario.atualizado`. */
const CAMPOS_EDITAVEIS = [
  'nome',
  'email',
  'papel',
  'area',
  'liderId',
  'telefone',
  'identificadorIntegracao',
  'avatarUrl',
] as const;

/** Papéis que encabeçam equipes: C-level (com os líderes) e os líderes de setor. */
const PAPEIS_DE_CABECA: Papel[] = ['C_LEVEL', 'LIDER'];

/**
 * Usuários, papéis e hierarquia (R1), senha temporária e convite (R2.8) e a
 * visão de equipe. Gerenciar é só do Admin (R1.5, conferido no controller com
 * `@Papeis('ADMIN')`); ver segue o recorte de visibilidade: C-level vê todos, o
 * líder vê a própria equipe e o membro, a si mesmo.
 */
@Injectable()
export class UsuariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly senhas: SenhasService,
    private readonly doisFatores: DoisFatoresService,
    private readonly cripto: CriptografiaService,
    private readonly tempoReal: TempoRealService,
  ) {}

  /**
   * Pessoas ativas para os editores de acessos (R5.11): qualquer setor, por
   * trecho do nome e/ou setor, só o resumo. Quem pode pedir (Admin, C-level e
   * líderes) é conferido no controller.
   */
  async opcoes(filtro: FiltroOpcoesDePessoasDto): Promise<OpcaoDePessoaDto[]> {
    const pessoas = await this.prisma.usuario.findMany({
      where: {
        ativo: true,
        ...(filtro.busca
          ? { nome: { contains: filtro.busca, mode: 'insensitive' } }
          : {}),
        ...(filtro.area ? { area: filtro.area } : {}),
      },
      select: {
        id: true,
        nome: true,
        avatarUrl: true,
        papel: true,
        area: true,
      },
      orderBy: [{ nome: 'asc' }, { id: 'asc' }],
      take: filtro.limite,
    });
    return pessoas.map((pessoa) => OpcaoDePessoaDto.de(pessoa));
  }

  async listar(
    observador: UsuarioAutenticado,
    filtro: FiltroUsuariosDto,
  ): Promise<Pagina<UsuarioDto>> {
    const condicoes: Prisma.UsuarioWhereInput[] = [
      filtroDeVisibilidade(observador),
    ];
    if (filtro.busca) {
      condicoes.push({
        OR: [
          { nome: { contains: filtro.busca, mode: 'insensitive' } },
          { email: { contains: filtro.busca.toLowerCase() } },
        ],
      });
    }
    if (filtro.papel) {
      condicoes.push({ papel: filtro.papel });
    }
    if (filtro.area) {
      // Só Líder e Membro têm setor (CHECK `usuarios_area_check`).
      condicoes.push({ area: filtro.area });
    }
    if (filtro.ativo !== undefined) {
      condicoes.push({ ativo: filtro.ativo });
    }
    if (filtro.liderId) {
      condicoes.push({ liderId: filtro.liderId });
    }
    const where: Prisma.UsuarioWhereInput = { AND: condicoes };
    const [itens, total] = await Promise.all([
      this.prisma.usuario.findMany({
        where,
        include: INCLUIR_LIDER,
        orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.usuario.count({ where }),
    ]);
    return montarPagina(
      itens.map((usuario) => UsuarioDto.completo(usuario)),
      total,
      filtro,
    );
  }

  /** Um usuário visível para o observador (404 para quem não pode vê-lo). */
  async detalhar(
    observador: UsuarioAutenticado,
    id: string,
  ): Promise<UsuarioDto> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id },
      include: INCLUIR_LIDER,
    });
    if (!usuario || !podeVerUsuario(observador, usuario)) {
      throw new NaoEncontradoException('Usuário não encontrado.');
    }
    return UsuarioDto.completo(usuario);
  }

  /**
   * Cria um usuário (R1.1, R1.2). Com `senhaTemporaria`, ele troca a senha no
   * primeiro acesso; sem ela, recebe o convite por e-mail (exige SMTP, R2.8).
   */
  async criar(
    admin: UsuarioAutenticado,
    dto: CriarUsuarioDto,
  ): Promise<UsuarioCriadoDto> {
    if (!dto.senhaTemporaria && !this.senhas.envioPorEmailDisponivel) {
      throw new RegraVioladaException(
        'R2.8',
        'O envio de e-mails não está configurado: informe uma senha temporária para o novo usuário.',
      );
    }
    const email = normalizarEmail(dto.email);
    const telefone = lerTelefone(dto.telefone ?? null);
    // O scrypt é lento: calculado antes, para a transação (e a trava) durar pouco.
    const senhaHash = dto.senhaTemporaria
      ? await this.cripto.hashSenha(dto.senhaTemporaria)
      : null;

    const criado = await this.prisma.$transaction(async (tx) => {
      await travarHierarquia(tx);
      await exigirEmailLivre(tx, email);
      const identificadorIntegracao = await lerIdentificadorDeIntegracao(
        tx,
        dto.identificadorIntegracao,
      );
      const area = await exigirSetorDoPapel(tx, dto.papel, dto.area);
      const liderId = await exigirLiderValido(
        tx,
        { papel: dto.papel, area },
        dto.liderId ?? null,
      );
      const usuario = await tx.usuario.create({
        data: {
          nome: dto.nome,
          email,
          papel: dto.papel,
          area,
          liderId,
          telefone,
          identificadorIntegracao,
          avatarUrl: dto.avatarUrl ?? null,
          senhaHash,
          deveTrocarSenha: senhaHash !== null,
          senhaAlteradaEm: senhaHash ? new Date() : null,
        },
        include: INCLUIR_LIDER,
      });
      await this.auditoria.registrar(tx, {
        acao: 'usuario.criado',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo:
          `Usuário ${usuario.nome} (${usuario.email}) criado como ${rotuloDoPapel(usuario.papel, usuario.area)}` +
          (usuario.lider ? `, respondendo a ${usuario.lider.nome}` : ''),
        dados: {
          papel: usuario.papel,
          area: usuario.area,
          liderId: usuario.liderId,
          acesso: senhaHash ? 'senha_temporaria' : 'convite_por_email',
        },
        relacionados: { usuario: usuario.liderId },
      });
      return usuario;
    });

    let convite: ConviteDto | null = null;
    if (!senhaHash) {
      try {
        const { expiraEm } = await this.senhas.enviarConvite(
          criado.id,
          admin.id,
        );
        convite = { enviado: true, expiraEm: expiraEm.toISOString() };
      } catch (erro) {
        // O usuário já existe; a falha do SMTP foi para os logs técnicos e o
        // Admin reenvia o convite depois.
        if (!(erro instanceof ServicoIndisponivelException)) {
          throw erro;
        }
        convite = { enviado: false, expiraEm: null };
      }
    }
    return { usuario: UsuarioDto.completo(criado), convite };
  }

  /**
   * Edita um usuário (só Admin). Mudar o papel ou o setor revalida a hierarquia
   * (R1.3): o líder do novo papel (R1.2), os liderados e o último Admin (R1.4);
   * o novo setor precisa estar ativo (R1.9).
   */
  async atualizar(id: string, dto: AtualizarUsuarioDto): Promise<UsuarioDto> {
    const telefone =
      dto.telefone === undefined ? undefined : lerTelefone(dto.telefone);
    let mudouAcesso = false;
    const resultado = await this.prisma.$transaction(async (tx) => {
      await travarHierarquia(tx);
      const antes = await tx.usuario.findUnique({
        where: { id },
        include: INCLUIR_LIDER,
      });
      if (!antes) {
        throw new NaoEncontradoException('Usuário não encontrado.');
      }
      const papel = dto.papel ?? antes.papel;
      // Admin e C-level não têm setor: o pedido é ignorado e a área fica nula.
      const areaPedida = papelTemSetor(papel)
        ? dto.area !== undefined
          ? dto.area
          : antes.area
        : null;
      const area = await exigirSetorDoPapel(
        tx,
        papel,
        areaPedida,
        areaPedida !== antes.area,
      );
      const mudouPapel = papel !== antes.papel || area !== antes.area;

      let liderId: string | null | undefined;
      if (mudouPapel || dto.liderId !== undefined) {
        if (papel !== antes.papel && antes.papel === 'ADMIN' && antes.ativo) {
          await exigirOutroAdminAtivo(tx, antes, 'rebaixar');
        }
        if (mudouPapel) {
          const problema = problemaDeMudancaDePapel(
            antes,
            { papel, area },
            await lideradosAtivos(tx, antes.id),
          );
          if (problema) {
            throw excecaoDaRegra(problema);
          }
        }
        // Sem líder no pedido: o atual, revalidado — salvo para Admin e C-level,
        // que não têm líder (R1.2).
        const pedido =
          dto.liderId !== undefined
            ? dto.liderId
            : liderEsperado({ papel, area }) === null
              ? null
              : antes.liderId;
        liderId = await exigirLiderValido(
          tx,
          { papel, area },
          pedido,
          antes.id,
        );
      }
      const email =
        dto.email === undefined ? undefined : normalizarEmail(dto.email);
      if (email !== undefined && email !== antes.email) {
        await exigirEmailLivre(tx, email, antes.id);
      }
      const identificadorIntegracao = await lerIdentificadorDeIntegracao(
        tx,
        dto.identificadorIntegracao,
        antes.id,
      );

      const depois = await tx.usuario.update({
        where: { id },
        data: {
          nome: dto.nome,
          email,
          papel: papel !== antes.papel ? papel : undefined,
          area: area !== antes.area ? area : undefined,
          liderId,
          telefone,
          identificadorIntegracao,
          avatarUrl: dto.avatarUrl,
        },
        include: INCLUIR_LIDER,
      });
      mudouAcesso = mudouPapel || depois.liderId !== antes.liderId;
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_EDITAVEIS);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'usuario.atualizado',
          entidade: 'usuario',
          entidadeId: id,
          resumo: `Usuário ${depois.nome} atualizado (${Object.keys(alteracoes).join(', ')})`,
          dados: { alteracoes },
          relacionados: { usuario: depois.liderId },
        });
      }
      return UsuarioDto.completo(depois);
    });
    // As salas do socket (papel, setor) são fixadas no handshake: quem mudou de
    // papel, setor ou líder reconecta e entra nas salas certas (R12.5). Só depois
    // do commit, para o novo handshake já ler o perfil novo.
    if (mudouAcesso) {
      this.tempoReal.desconectarUsuario(id);
    }
    return resultado;
  }

  /**
   * Senha temporária definida pelo Admin (R2.8): grava, exige troca no próximo
   * acesso e encerra as sessões do usuário (o `SenhasService` também audita).
   */
  async definirSenhaTemporaria(
    admin: UsuarioAutenticado,
    id: string,
    dto: DefinirSenhaTemporariaDto,
  ): Promise<UsuarioDto> {
    if (id === admin.id) {
      throw new RegraVioladaException(
        'R2.8',
        'Para trocar a sua própria senha, use a troca de senha (auth/senha).',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.findUnique({ where: { id } });
      if (!usuario) {
        throw new NaoEncontradoException('Usuário não encontrado.');
      }
      if (!usuario.ativo) {
        throw new RegraVioladaException(
          'R2.8',
          `O usuário ${usuario.nome} está desligado: reative-o antes de definir uma senha.`,
        );
      }
      await this.senhas.definirSenhaTemporaria(tx, usuario, dto.senha);
    });
    return this.detalhar(admin, id);
  }

  /**
   * O Admin redefine a verificação em duas etapas de quem perdeu o aparelho (R2.11):
   * desliga, apaga os códigos, audita e avisa a pessoa.
   */
  async redefinirDoisFatores(
    admin: UsuarioAutenticado,
    id: string,
  ): Promise<UsuarioDto> {
    if (id === admin.id) {
      throw new RegraVioladaException(
        'R2.11',
        'Para desativar a sua própria verificação em duas etapas, use o Meu perfil.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.findUnique({ where: { id } });
      if (!usuario) {
        throw new NaoEncontradoException('Usuário não encontrado.');
      }
      await this.doisFatores.redefinirPeloAdmin(tx, admin, usuario);
    });
    return this.detalhar(admin, id);
  }

  /** (Re)envia o convite por e-mail para definir a senha (R2.8; exige SMTP). */
  async enviarConvite(
    admin: UsuarioAutenticado,
    id: string,
  ): Promise<ConviteEnviadoDto> {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id },
      select: { email: true },
    });
    if (!usuario) {
      throw new NaoEncontradoException('Usuário não encontrado.');
    }
    const { expiraEm } = await this.senhas.enviarConvite(id, admin.id);
    return {
      mensagem: `Convite enviado para ${usuario.email}.`,
      expiraEm: expiraEm.toISOString(),
    };
  }

  /**
   * Visão de equipe: cada líder (ou C-level) com quem responde a ele e a carga
   * de trabalho de cada um. O líder vê só a própria equipe; Admin e C-level,
   * todas (R1.5).
   */
  async equipes(
    observador: UsuarioAutenticado,
    filtro: FiltroEquipesDto,
  ): Promise<EquipeDto[]> {
    const condicoes: Prisma.UsuarioWhereInput[] = [{ ativo: true }];
    if (ehLider(observador.papel)) {
      if (filtro.liderId && filtro.liderId !== observador.id) {
        throw new SemPermissaoException('Você só vê a sua própria equipe.', {
          regra: 'R1.5',
        });
      }
      condicoes.push({ id: observador.id });
    } else if (ehDiretoria(observador.papel)) {
      condicoes.push(
        filtro.liderId
          ? { id: filtro.liderId }
          : {
              OR: [
                { papel: { in: PAPEIS_DE_CABECA } },
                { liderados: { some: { ativo: true } } },
              ],
            },
      );
      if (filtro.area) {
        condicoes.push({ papel: 'LIDER', area: filtro.area });
      }
    } else {
      throw new SemPermissaoException(
        'A visão de equipe é de líderes, C-level e Admin.',
        { regra: 'R1.5' },
      );
    }

    const cabecas = await this.prisma.usuario.findMany({
      where: { AND: condicoes },
      select: {
        ...SELECAO_RESUMO,
        lider: { select: { papel: true, area: true, ativo: true } },
        liderados: {
          where: { ativo: true },
          select: SELECAO_RESUMO,
          orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [
        { papel: 'asc' },
        { setor: { ordem: 'asc' } },
        { nome: 'asc' },
        { id: 'asc' },
      ],
    });
    if (filtro.liderId && cabecas.length === 0) {
      throw new NaoEncontradoException('Líder não encontrado.');
    }

    const ids = new Set<string>();
    for (const cabeca of cabecas) {
      ids.add(cabeca.id);
      for (const liderado of cabeca.liderados) {
        ids.add(liderado.id);
      }
    }
    const indicadores = await this.indicadores([...ids]);
    const vazio: IndicadoresDto = {
      atividadesPendentes: 0,
      atividadesAtrasadas: 0,
      negociosAbertos: 0,
      valorEmAberto: '0.00',
      contatos: 0,
    };

    return cabecas.map((cabeca) => {
      const lider: MembroDaEquipeDto = {
        usuario: UsuarioResumoDto.de(cabeca),
        indicadores: indicadores.get(cabeca.id) ?? vazio,
        aguardandoNovoLider: !temLiderEsperado(cabeca, cabeca.lider),
      };
      const area = papelTemSetor(cabeca.papel) ? cabeca.area : null;
      return {
        lider,
        area,
        nomeSetor: area ? nomeDoSetor(area) : null,
        membros: cabeca.liderados.map((liderado) => ({
          usuario: UsuarioResumoDto.de(liderado),
          indicadores: indicadores.get(liderado.id) ?? vazio,
          aguardandoNovoLider: !temLiderEsperado(liderado, cabeca),
        })),
      };
    });
  }

  /** Carga de trabalho por pessoa: atividades, negócios abertos e contatos. */
  private async indicadores(
    ids: string[],
  ): Promise<Map<string, IndicadoresDto>> {
    const resultado = new Map<string, IndicadoresDto>();
    if (ids.length === 0) {
      return resultado;
    }
    const agora = new Date();
    const [pendentes, atrasadas, negocios, contatos] = await Promise.all([
      this.prisma.atividade.groupBy({
        by: ['responsavelId'],
        where: { responsavelId: { in: ids }, status: 'PENDENTE' },
        _count: { _all: true },
      }),
      this.prisma.atividade.groupBy({
        by: ['responsavelId'],
        where: {
          responsavelId: { in: ids },
          status: 'PENDENTE',
          venceEm: { lt: agora },
        },
        _count: { _all: true },
      }),
      this.prisma.negocio.groupBy({
        by: ['responsavelId'],
        where: {
          responsavelId: { in: ids },
          status: 'ABERTO',
          excluidoEm: null,
        },
        _count: { _all: true },
        _sum: { valor: true },
      }),
      this.prisma.contato.groupBy({
        by: ['responsavelId'],
        where: { responsavelId: { in: ids }, excluidoEm: null },
        _count: { _all: true },
      }),
    ]);
    for (const id of ids) {
      resultado.set(id, {
        atividadesPendentes:
          pendentes.find((linha) => linha.responsavelId === id)?._count._all ??
          0,
        atividadesAtrasadas:
          atrasadas.find((linha) => linha.responsavelId === id)?._count._all ??
          0,
        negociosAbertos:
          negocios.find((linha) => linha.responsavelId === id)?._count._all ??
          0,
        valorEmAberto:
          formatarValor(
            negocios.find((linha) => linha.responsavelId === id)?._sum.valor ??
              new Prisma.Decimal(0),
          ) ?? '0.00',
        contatos:
          contatos.find((linha) => linha.responsavelId === id)?._count._all ??
          0,
      });
    }
    return resultado;
  }
}
