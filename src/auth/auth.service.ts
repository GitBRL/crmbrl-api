import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { Ator } from '../comum/contexto/contexto-requisicao';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import { normalizarEmail } from '../comum/dominio/email';
import {
  nivelDoPapel,
  rotuloComNomeDoSetor,
  setorDaPessoa,
} from '../comum/dominio/papeis';
import { areasVisiveis, permissoesDoPapel } from '../comum/dominio/permissoes';
import {
  DadosInvalidosException,
  NaoAutenticadoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type { Sessao, Usuario } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { chavesDosSetoresAtivos } from '../setores/setores-no-banco';
import type {
  ConcluirEntradaDto,
  EntrarDto,
  PerfilDto,
  TrocarSenhaDto,
} from './dto/auth.dto';
import {
  DoisFatoresService,
  MENSAGEM_DESAFIO_EXPIRADO,
  type ViaDoCodigo,
} from './dois-fatores/dois-fatores.service';
import {
  excecaoDeBloqueio,
  ForcaBrutaService,
  LIMITES_DE_LOGIN,
  type MotivoTentativa,
} from './forca-bruta.service';
import { SessoesService } from './sessoes.service';
import type { UsuarioAutenticado } from './usuario-autenticado';

/** Mensagem única para credenciais erradas (R2.3). */
export const MENSAGEM_CREDENCIAIS_INVALIDAS = 'E-mail ou senha incorretos.';

/** Mensagem para usuário desligado com a senha certa (R2.3). */
export const MENSAGEM_ACESSO_DESATIVADO =
  'Acesso desativado. Fale com o administrador.';

export interface MetadadosDoLogin {
  ip?: string;
  userAgent?: string;
  /** Token do cookie que já vinha na requisição (é encerrado no novo login). */
  tokenAnterior?: string;
}

/** Resultado da primeira etapa do login: sessão aberta ou desafio de duas etapas (R2.11). */
export type ResultadoDoLogin =
  | { tipo: 'sessao'; token: string; sessaoId: string; perfil: PerfilDto }
  | { tipo: 'dois_fatores'; desafio: string; expiraEm: string };

/**
 * Login, logout, perfil (`auth/eu`) e troca da própria senha (R2.1–R2.7).
 * Login, logout, falha de login, bloqueio por força bruta e troca de senha são
 * auditados (R3.2).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly sessoes: SessoesService,
    private readonly forcaBruta: ForcaBrutaService,
    private readonly auditoria: AuditoriaService,
    private readonly doisFatores: DoisFatoresService,
  ) {}

  async entrar(
    dto: EntrarDto,
    meta: MetadadosDoLogin,
  ): Promise<ResultadoDoLogin> {
    const email = normalizarEmail(dto.email);
    const agora = new Date();

    // Confere o bloqueio e reserva a tentativa antes do hash lento, sob trava (R2.5).
    const reserva = await this.forcaBruta.reservar(
      { email, ip: meta.ip, userAgent: meta.userAgent },
      'SENHA_INCORRETA',
      agora,
    );
    if (reserva.bloqueio) {
      throw excecaoDeBloqueio(reserva.bloqueio, agora);
    }
    const { reservaId } = reserva;

    const usuario = await this.prisma.usuario.findUnique({ where: { email } });
    // Sem usuário (ou sem senha definida) o hash fictício gasta o mesmo tempo.
    const senhaCorreta = await this.cripto.verificarSenha(
      dto.senha,
      usuario?.senhaHash,
    );
    if (!usuario || !senhaCorreta) {
      const motivo: MotivoTentativa = !usuario
        ? 'USUARIO_INEXISTENTE'
        : !usuario.senhaHash
          ? 'SEM_SENHA'
          : 'SENHA_INCORRETA';
      await this.registrarFalha(
        email,
        usuario,
        motivo,
        meta,
        agora,
        'login',
        reservaId,
      );
      throw new NaoAutenticadoException(MENSAGEM_CREDENCIAIS_INVALIDAS);
    }

    if (!usuario.ativo) {
      await this.registrarFalha(
        email,
        usuario,
        'USUARIO_DESLIGADO',
        meta,
        agora,
        'login',
        reservaId,
      );
      throw new SemPermissaoException(MENSAGEM_ACESSO_DESATIVADO);
    }

    const novoHash = this.cripto.precisaRefazerHash(usuario.senhaHash ?? '')
      ? await this.cripto.hashSenha(dto.senha)
      : undefined;

    // Com verificação em duas etapas (R2.11) a sessão só nasce depois do código:
    // aqui sai um desafio de 5 minutos. A senha certa não zera a contagem de
    // falhas (não há registro de sucesso), senão os códigos seriam adivinháveis sem limite.
    if (usuario.doisFatoresAtivadoEm) {
      const desafio = await this.prisma.$transaction(async (tx) => {
        await this.forcaBruta.liberar(tx, reservaId);
        if (novoHash) {
          await tx.usuario.update({
            where: { id: usuario.id },
            data: { senhaHash: novoHash },
          });
        }
        const criado = await this.doisFatores.criarDesafio(
          tx,
          usuario.id,
          agora,
        );
        await this.auditoria.registrar(tx, {
          acao: 'usuario.dois_fatores_solicitado',
          entidade: 'usuario',
          entidadeId: usuario.id,
          resumo: `${usuario.nome} acertou a senha e precisa do código de verificação`,
          dados: { expiraEm: criado.expiraEm },
          ator: {
            tipoAtor: 'USUARIO',
            usuario: {
              id: usuario.id,
              papel: usuario.papel,
              nome: usuario.nome,
            },
          },
        });
        return criado;
      });
      return {
        tipo: 'dois_fatores',
        desafio: desafio.token,
        expiraEm: desafio.expiraEm.toISOString(),
      };
    }

    const { token, sessao } = await this.prisma.$transaction((tx) =>
      this.abrirSessao(
        tx,
        usuario,
        meta,
        agora,
        novoHash,
        undefined,
        reservaId,
      ),
    );
    return {
      tipo: 'sessao',
      token,
      sessaoId: sessao.id,
      perfil: await this.perfil(usuario.id, sessao),
    };
  }

  /**
   * Segunda etapa do login (R2.11): o código do aplicativo ou um código de
   * recuperação, com o desafio recebido na primeira etapa. Erros contam na
   * força bruta (R2.5) e no limite do próprio desafio.
   */
  async concluirEntrada(
    dto: ConcluirEntradaDto,
    meta: MetadadosDoLogin,
  ): Promise<{ token: string; sessaoId: string; perfil: PerfilDto }> {
    const agora = new Date();
    const desafio = await this.doisFatores.buscarDesafio(dto.desafio, agora);
    const usuario = desafio.usuario;
    const reserva = await this.forcaBruta.reservar(
      {
        email: usuario.email,
        ip: meta.ip,
        usuarioId: usuario.id,
        userAgent: meta.userAgent,
      },
      'DOIS_FATORES_INCORRETO',
      agora,
    );
    if (reserva.bloqueio) {
      throw excecaoDeBloqueio(reserva.bloqueio, agora);
    }
    const { reservaId } = reserva;
    if (!usuario.ativo) {
      await this.registrarFalha(
        usuario.email,
        usuario,
        'USUARIO_DESLIGADO',
        meta,
        agora,
        'login',
        reservaId,
      );
      throw new SemPermissaoException(MENSAGEM_ACESSO_DESATIVADO);
    }
    const via = await this.doisFatores.conferirCodigo(usuario, dto.codigo, {
      aceitarRecuperacao: true,
    });
    if (!via) {
      const restantes = await this.doisFatores.contarErroNoDesafio(
        desafio.id,
        agora,
      );
      await this.doisFatores.registrarFalha(usuario, meta, agora, 'login', {
        reservaId,
      });
      if (restantes <= 0) {
        throw new NaoAutenticadoException(MENSAGEM_DESAFIO_EXPIRADO, {
          regra: 'R2.11',
        });
      }
      throw this.doisFatores.codigoIncorreto(restantes);
    }
    const { token, sessao } = await this.prisma.$transaction(async (tx) => {
      await this.forcaBruta.liberar(tx, reservaId);
      if (!(await this.doisFatores.consumirDesafio(tx, desafio.id, agora))) {
        throw new NaoAutenticadoException(MENSAGEM_DESAFIO_EXPIRADO, {
          regra: 'R2.11',
        });
      }
      const criada = await this.abrirSessao(
        tx,
        usuario,
        meta,
        agora,
        undefined,
        via,
      );
      if (via === 'recuperacao') {
        await this.doisFatores.avisarUsoDeRecuperacao(tx, usuario);
      }
      return criada;
    });
    return {
      token,
      sessaoId: sessao.id,
      perfil: await this.perfil(usuario.id, sessao),
    };
  }

  /** Cria a sessão, registra o sucesso (zera as falhas do e-mail) e audita o login. */
  private async abrirSessao(
    tx: Tx,
    usuario: Usuario,
    meta: MetadadosDoLogin,
    agora: Date,
    novoHash?: string,
    doisFatores?: ViaDoCodigo,
    reservaId?: bigint,
  ) {
    await this.forcaBruta.liberar(tx, reservaId);
    if (meta.tokenAnterior) {
      await this.sessoes.revogarPorToken(tx, meta.tokenAnterior, 'novo_login');
    }
    const criada = await this.sessoes.criar(tx, usuario.id, meta);
    await this.forcaBruta.registrar(tx, {
      email: usuario.email,
      ip: meta.ip,
      usuarioId: usuario.id,
      sucesso: true,
      motivo: 'SUCESSO',
      userAgent: meta.userAgent,
    });
    await tx.usuario.update({
      where: { id: usuario.id },
      data: {
        ultimoAcessoEm: agora,
        ...(novoHash ? { senhaHash: novoHash } : {}),
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'usuario.login',
      entidade: 'usuario',
      entidadeId: usuario.id,
      resumo: `${usuario.nome} entrou no CRM`,
      dados: {
        sessaoId: criada.sessao.id,
        deveTrocarSenha: usuario.deveTrocarSenha,
        ...(doisFatores ? { doisFatores } : {}),
      },
      ator: {
        tipoAtor: 'USUARIO',
        usuario: { id: usuario.id, papel: usuario.papel, nome: usuario.nome },
      },
    });
    return criada;
  }

  async sair(usuario: UsuarioAutenticado): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.sessoes.revogar(tx, usuario.sessaoId, 'logout');
      await this.auditoria.registrar(tx, {
        acao: 'usuario.logout',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: `${usuario.nome} saiu do CRM`,
        dados: { sessaoId: usuario.sessaoId },
      });
    });
  }

  /**
   * "Encerrar as outras sessões" (R2.2): revoga todas as sessões da pessoa menos a atual (outros
   * navegadores e aparelhos) e audita `usuario.sessoes_encerradas`.
   */
  async encerrarOutrasSessoes(usuario: UsuarioAutenticado): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const encerradas = await this.sessoes.revogarTodas(
        tx,
        usuario.id,
        'encerrar_outras',
        { exceto: usuario.sessaoId },
      );
      await this.auditoria.registrar(tx, {
        acao: 'usuario.sessoes_encerradas',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: `${usuario.nome} encerrou as outras sessões (${encerradas})`,
        dados: { sessaoAtualId: usuario.sessaoId, encerradas },
      });
      return encerradas;
    });
  }

  /** O perfil de `auth/eu`: usuário, papel, setor, permissões derivadas e a sessão. */
  async perfil(usuarioId: string, sessao: Sessao | string): Promise<PerfilDto> {
    const [usuario, dadosDaSessao, setoresAtivos] = await Promise.all([
      this.prisma.usuario.findUniqueOrThrow({
        where: { id: usuarioId },
        include: {
          lider: { select: { id: true, nome: true, papel: true, area: true } },
          setor: { select: { nome: true } },
        },
      }),
      typeof sessao === 'string'
        ? this.prisma.sessao.findUniqueOrThrow({ where: { id: sessao } })
        : Promise.resolve(sessao),
      chavesDosSetoresAtivos(this.prisma),
    ]);
    const permissoes = permissoesDoPapel(usuario.papel);
    const area = setorDaPessoa(usuario);
    const nomeSetor = area ? (usuario.setor?.nome ?? area) : null;
    return {
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        papel: usuario.papel,
        rotuloPapel: rotuloComNomeDoSetor(usuario.papel, nomeSetor),
        area,
        nomeSetor,
        nivel: nivelDoPapel(usuario.papel),
        lider: usuario.lider,
        avatarUrl: usuario.avatarUrl,
        telefone: usuario.telefone,
        ultimoAcessoEm: usuario.ultimoAcessoEm?.toISOString() ?? null,
        doisFatoresAtivo: usuario.doisFatoresAtivadoEm !== null,
      },
      deveTrocarSenha: usuario.deveTrocarSenha,
      permissoes: {
        ...permissoes,
        areasVisiveis: [...areasVisiveis(usuario, setoresAtivos)],
      },
      sessao: {
        criadaEm: dadosDaSessao.criadoEm.toISOString(),
        expiraEm: dadosDaSessao.expiraEm.toISOString(),
      },
    };
  }

  /**
   * Troca da própria senha (também a obrigatória, R2.6/R2.7). Confere a atual
   * (erros contam para o bloqueio por força bruta), encerra as outras sessões e
   * audita.
   */
  async trocarSenha(
    usuario: UsuarioAutenticado,
    dto: TrocarSenhaDto,
    meta: MetadadosDoLogin,
  ): Promise<PerfilDto> {
    if (dto.novaSenha === dto.senhaAtual) {
      throw new DadosInvalidosException(
        'A nova senha precisa ser diferente da atual.',
        {
          campos: [
            {
              campo: 'novaSenha',
              mensagens: ['deve ser diferente da senha atual'],
            },
          ],
        },
      );
    }
    const agora = new Date();
    const bloqueio = await this.forcaBruta.verificar(
      usuario.email,
      meta.ip,
      agora,
    );
    if (bloqueio) {
      throw excecaoDeBloqueio(bloqueio, agora);
    }
    const registro = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuario.id },
    });
    if (
      !(await this.cripto.verificarSenha(dto.senhaAtual, registro.senhaHash))
    ) {
      await this.registrarFalha(
        usuario.email,
        registro,
        'SENHA_INCORRETA',
        meta,
        agora,
        'troca_de_senha',
      );
      throw new DadosInvalidosException('A senha atual está incorreta.', {
        campos: [{ campo: 'senhaAtual', mensagens: ['está incorreta'] }],
      });
    }
    const hash = await this.cripto.hashSenha(dto.novaSenha);
    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          senhaHash: hash,
          deveTrocarSenha: false,
          senhaAlteradaEm: agora,
        },
      });
      const sessoesEncerradas = await this.sessoes.revogarTodas(
        tx,
        usuario.id,
        'troca_de_senha',
        {
          exceto: usuario.sessaoId,
        },
      );
      await this.auditoria.registrar(tx, {
        acao: 'usuario.senha_alterada',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: registro.deveTrocarSenha
          ? `${usuario.nome} fez a troca de senha obrigatória`
          : `${usuario.nome} trocou a própria senha`,
        dados: { obrigatoria: registro.deveTrocarSenha, sessoesEncerradas },
      });
    });
    return this.perfil(usuario.id, usuario.sessaoId);
  }

  /**
   * Registra a tentativa que falhou, audita e, se ela fechou um bloqueio, audita
   * o bloqueio. A senha atual errada na troca de senha conta como tentativa.
   *
   * Na falha de login o ator é sempre o e-mail tentado, sem usuário: o navegador
   * pode ter a sessão de outra pessoa aberta (o cookie dela vai junto), e quem
   * tentou entrar não é essa pessoa. Na troca de senha o ator é quem está logado.
   */
  private async registrarFalha(
    email: string,
    usuario: Usuario | null,
    motivo: MotivoTentativa,
    meta: MetadadosDoLogin,
    agora: Date,
    origem: 'login' | 'troca_de_senha' = 'login',
    reservaId?: bigint,
  ): Promise<void> {
    const ator: Ator | undefined =
      origem === 'login'
        ? { tipoAtor: 'USUARIO', descricao: email }
        : undefined;
    await this.prisma.$transaction(async (tx) => {
      await this.forcaBruta.liberar(tx, reservaId);
      await this.forcaBruta.registrar(tx, {
        email,
        ip: meta.ip,
        usuarioId: usuario?.id,
        sucesso: false,
        motivo,
        userAgent: meta.userAgent,
      });
      await this.auditoria.registrar(tx, {
        acao:
          origem === 'login'
            ? 'usuario.login_falhou'
            : 'usuario.troca_de_senha_falhou',
        entidade: 'usuario',
        entidadeId: usuario?.id,
        resumo:
          origem === 'troca_de_senha'
            ? `Senha atual incorreta na troca de senha de ${email}`
            : motivo === 'USUARIO_DESLIGADO'
              ? `Tentativa de login de usuário desligado (${email})`
              : `Falha de login para ${email}`,
        dados: { email, motivo },
        ator,
      });
      // Antes desta falha não havia bloqueio (foi conferido); se há agora, ela o fechou.
      const bloqueio = await this.forcaBruta.verificar(
        email,
        meta.ip,
        agora,
        tx,
      );
      if (bloqueio) {
        await this.auditoria.registrar(tx, {
          acao: 'usuario.bloqueado_forca_bruta',
          entidade: 'usuario',
          entidadeId: usuario?.id,
          resumo:
            bloqueio.motivo === 'BLOQUEADO_EMAIL'
              ? `Login de ${email} bloqueado após ${LIMITES_DE_LOGIN.falhasPorEmail} falhas em ${LIMITES_DE_LOGIN.janelaMinutos} minutos`
              : `Login pelo IP ${meta.ip ?? '?'} bloqueado após ${LIMITES_DE_LOGIN.tentativasPorIp} falhas em ${LIMITES_DE_LOGIN.janelaMinutos} minutos`,
          dados: {
            email,
            ip: meta.ip,
            motivo: bloqueio.motivo,
            ate: bloqueio.ate,
          },
          ator,
        });
      }
    });
  }
}
