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
  MuitasTentativasException,
  NaoAutenticadoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type { Sessao, Usuario } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { chavesDosSetoresAtivos } from '../setores/setores-no-banco';
import type { EntrarDto, PerfilDto, TrocarSenhaDto } from './dto/auth.dto';
import {
  type Bloqueio,
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
  ) {}

  async entrar(
    dto: EntrarDto,
    meta: MetadadosDoLogin,
  ): Promise<{ token: string; sessaoId: string; perfil: PerfilDto }> {
    const email = normalizarEmail(dto.email);
    const agora = new Date();

    const bloqueio = await this.forcaBruta.verificar(email, meta.ip, agora);
    if (bloqueio) {
      await this.forcaBruta.registrar(this.prisma, {
        email,
        ip: meta.ip,
        sucesso: false,
        motivo: bloqueio.motivo,
        userAgent: meta.userAgent,
      });
      throw excecaoDeBloqueio(bloqueio, agora);
    }

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
      await this.registrarFalha(email, usuario, motivo, meta, agora);
      throw new NaoAutenticadoException(MENSAGEM_CREDENCIAIS_INVALIDAS);
    }

    if (!usuario.ativo) {
      await this.registrarFalha(
        email,
        usuario,
        'USUARIO_DESLIGADO',
        meta,
        agora,
      );
      throw new SemPermissaoException(MENSAGEM_ACESSO_DESATIVADO);
    }

    const novoHash = this.cripto.precisaRefazerHash(usuario.senhaHash ?? '')
      ? await this.cripto.hashSenha(dto.senha)
      : undefined;
    const { token, sessao } = await this.prisma.$transaction(async (tx) => {
      if (meta.tokenAnterior) {
        await this.sessoes.revogarPorToken(
          tx,
          meta.tokenAnterior,
          'novo_login',
        );
      }
      const criada = await this.sessoes.criar(tx, usuario.id, meta);
      await this.forcaBruta.registrar(tx, {
        email,
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
        },
        ator: {
          tipoAtor: 'USUARIO',
          usuario: { id: usuario.id, papel: usuario.papel, nome: usuario.nome },
        },
      });
      return criada;
    });
    return {
      token,
      sessaoId: sessao.id,
      perfil: await this.perfil(usuario.id, sessao),
    };
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
  ): Promise<void> {
    const ator: Ator | undefined =
      origem === 'login'
        ? { tipoAtor: 'USUARIO', descricao: email }
        : undefined;
    await this.prisma.$transaction(async (tx) => {
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

function excecaoDeBloqueio(
  bloqueio: Bloqueio,
  agora: Date,
): MuitasTentativasException {
  const segundos = Math.max(
    1,
    Math.ceil((bloqueio.ate.getTime() - agora.getTime()) / 1000),
  );
  const minutos = Math.ceil(segundos / 60);
  return new MuitasTentativasException(
    `Muitas tentativas de login. Tente de novo em ${minutos} minuto${minutos === 1 ? '' : 's'}.`,
    segundos,
    { regra: 'R2.5', motivo: bloqueio.motivo, ate: bloqueio.ate.toISOString() },
  );
}
