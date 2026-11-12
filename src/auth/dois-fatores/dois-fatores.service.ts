import { Injectable } from '@nestjs/common';
import { toDataURL } from 'qrcode';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { Ator } from '../../comum/contexto/contexto-requisicao';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import {
  DadosInvalidosException,
  NaoAutenticadoException,
  RegraVioladaException,
} from '../../comum/erros/excecoes';
import type { Usuario } from '../../generated/prisma/client';
import { NotificacoesService } from '../../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  excecaoDeBloqueio,
  ForcaBrutaService,
  LIMITES_DE_LOGIN,
} from '../forca-bruta.service';
import type { UsuarioAutenticado } from '../usuario-autenticado';
import {
  gerarCodigoDeRecuperacao,
  gerarSegredoBase32,
  normalizarCodigo,
  QUANTIDADE_CODIGOS_RECUPERACAO,
  urlOtpauth,
  verificarTotp,
} from './totp';

/** O desafio da segunda etapa do login vale 5 minutos (R2.11). */
export const VALIDADE_DO_DESAFIO_MINUTOS = 5;
/** Códigos errados que um desafio aceita antes de ser descartado (R2.11). */
export const TENTATIVAS_POR_DESAFIO = 5;
export const EMISSOR_TOTP = 'BRL CRM';

export const MENSAGEM_DESAFIO_EXPIRADO =
  'A verificação expirou. Entre de novo com e-mail e senha.';
export const MENSAGEM_CODIGO_INCORRETO = 'Código incorreto.';

export interface MetaDeRequisicao {
  ip?: string;
  userAgent?: string;
}

export type ViaDoCodigo = 'totp' | 'recuperacao';

export interface AtivacaoIniciada {
  chave: string;
  qrCode: string;
  urlOtpauth: string;
}

export interface SituacaoDoisFatores {
  ativo: boolean;
  ativadoEm: string | null;
  codigosRestantes: number;
}

/**
 * Verificação em duas etapas opcional (R2.11): ativar, confirmar, códigos de
 * recuperação, desativar, redefinição pelo Admin e o desafio do login. Nada que
 * seja segredo, código ou hash vai para a auditoria.
 */
@Injectable()
export class DoisFatoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly forcaBruta: ForcaBrutaService,
    private readonly auditoria: AuditoriaService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  async situacao(usuarioId: string): Promise<SituacaoDoisFatores> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
      select: { doisFatoresAtivadoEm: true },
    });
    const codigosRestantes = usuario.doisFatoresAtivadoEm
      ? await this.prisma.codigoRecuperacao.count({
          where: { usuarioId, usadoEm: null },
        })
      : 0;
    return {
      ativo: usuario.doisFatoresAtivadoEm !== null,
      ativadoEm: usuario.doisFatoresAtivadoEm?.toISOString() ?? null,
      codigosRestantes,
    };
  }

  /** Gera (ou troca, se ainda não foi confirmado) o segredo e devolve o QR e a chave. */
  async iniciarAtivacao(
    autenticado: UsuarioAutenticado,
  ): Promise<AtivacaoIniciada> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: autenticado.id },
    });
    if (usuario.doisFatoresAtivadoEm) {
      throw new RegraVioladaException(
        'R2.11',
        'A verificação em duas etapas já está ativa. Desative-a antes de configurar de novo.',
      );
    }
    const chave = gerarSegredoBase32();
    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        doisFatoresSegredo: this.cripto.cifrar(chave),
        doisFatoresUltimoPasso: null,
      },
    });
    const url = urlOtpauth(chave, usuario.email, EMISSOR_TOTP);
    return {
      chave,
      urlOtpauth: url,
      qrCode: await toDataURL(url, { margin: 1, width: 256 }),
    };
  }

  /** Confere o primeiro código, liga o 2FA e devolve os códigos de recuperação (só desta vez). */
  async confirmarAtivacao(
    autenticado: UsuarioAutenticado,
    codigo: string,
    meta: MetaDeRequisicao,
  ): Promise<string[]> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: autenticado.id },
    });
    if (usuario.doisFatoresAtivadoEm) {
      throw new RegraVioladaException(
        'R2.11',
        'A verificação em duas etapas já está ativa.',
      );
    }
    if (!usuario.doisFatoresSegredo) {
      throw new RegraVioladaException(
        'R2.11',
        'Comece a ativação para gerar o QR e a chave.',
      );
    }
    const agora = new Date();
    await this.exigirSemBloqueio(usuario.email, meta.ip, agora);
    // Na ativação o código não é "gasto": a pessoa pode entrar logo em seguida com o mesmo.
    const via = await this.conferirCodigo(usuario, codigo, {
      aceitarRecuperacao: false,
      registrarPasso: false,
    });
    if (!via) {
      await this.registrarFalha(usuario, meta, agora, 'ativacao');
      throw this.codigoIncorreto();
    }
    const { codigos, hashes } = this.novosCodigos();
    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: { doisFatoresAtivadoEm: agora },
      });
      await this.trocarCodigos(tx, usuario.id, hashes);
      await this.auditoria.registrar(tx, {
        acao: 'usuario.dois_fatores_ativado',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: `${usuario.nome} ativou a verificação em duas etapas`,
        dados: { codigosRecuperacao: hashes.length },
      });
    });
    return codigos;
  }

  /** Novos códigos de recuperação (os antigos deixam de valer). Pede um código do aplicativo. */
  async gerarNovosCodigos(
    autenticado: UsuarioAutenticado,
    codigo: string,
    meta: MetaDeRequisicao,
  ): Promise<string[]> {
    const usuario = await this.exigirAtivo(autenticado.id);
    const agora = new Date();
    await this.exigirSemBloqueio(usuario.email, meta.ip, agora);
    const via = await this.conferirCodigo(usuario, codigo, {
      aceitarRecuperacao: false,
    });
    if (!via) {
      await this.registrarFalha(usuario, meta, agora, 'novos_codigos');
      throw this.codigoIncorreto();
    }
    const { codigos, hashes } = this.novosCodigos();
    await this.prisma.$transaction(async (tx) => {
      await this.trocarCodigos(tx, usuario.id, hashes);
      await this.auditoria.registrar(tx, {
        acao: 'usuario.dois_fatores_codigos_gerados',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: `${usuario.nome} gerou novos códigos de recuperação`,
        dados: { codigosRecuperacao: hashes.length },
      });
    });
    return codigos;
  }

  /** Desliga o 2FA com a senha atual e um código (do aplicativo ou de recuperação). */
  async desativar(
    autenticado: UsuarioAutenticado,
    senha: string,
    codigo: string,
    meta: MetaDeRequisicao,
  ): Promise<void> {
    const usuario = await this.exigirAtivo(autenticado.id);
    const agora = new Date();
    await this.exigirSemBloqueio(usuario.email, meta.ip, agora);
    if (!(await this.cripto.verificarSenha(senha, usuario.senhaHash))) {
      await this.registrarFalha(usuario, meta, agora, 'desativacao', {
        motivo: 'SENHA_INCORRETA',
      });
      throw new DadosInvalidosException('A senha atual está incorreta.', {
        campos: [{ campo: 'senha', mensagens: ['está incorreta'] }],
      });
    }
    const via = await this.conferirCodigo(usuario, codigo, {
      aceitarRecuperacao: true,
    });
    if (!via) {
      await this.registrarFalha(usuario, meta, agora, 'desativacao');
      throw this.codigoIncorreto();
    }
    await this.prisma.$transaction(async (tx) => {
      await this.limpar(tx, usuario.id);
      await this.auditoria.registrar(tx, {
        acao: 'usuario.dois_fatores_desativado',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: `${usuario.nome} desativou a verificação em duas etapas`,
        dados: { via },
      });
    });
  }

  /**
   * O Admin redefine o 2FA de quem perdeu o aparelho: desliga, apaga os códigos
   * e avisa a pessoa por notificação. Roda na transação de quem chama.
   */
  async redefinirPeloAdmin(
    tx: Tx,
    admin: UsuarioAutenticado,
    alvo: Usuario,
  ): Promise<void> {
    if (!alvo.doisFatoresAtivadoEm && !alvo.doisFatoresSegredo) {
      throw new RegraVioladaException(
        'R2.11',
        `${alvo.nome} não usa a verificação em duas etapas.`,
      );
    }
    await this.limpar(tx, alvo.id);
    await this.auditoria.registrar(tx, {
      acao: 'usuario.dois_fatores_redefinido',
      entidade: 'usuario',
      entidadeId: alvo.id,
      resumo: `${admin.nome} redefiniu a verificação em duas etapas de ${alvo.nome}`,
      dados: { porAdminId: admin.id, estavaAtivo: !!alvo.doisFatoresAtivadoEm },
    });
    await this.notificacoes.notificar(tx, alvo.id, {
      tipo: 'seguranca.dois_fatores_redefinido',
      titulo: 'Verificação em duas etapas redefinida',
      texto: `${admin.nome} desligou a verificação em duas etapas da sua conta. Ative-a de novo no Meu perfil quando quiser.`,
      link: '/configuracoes/perfil',
    });
  }

  // ---- login -------------------------------------------------------------

  /** Desafio da segunda etapa: o token em claro só existe na resposta do login. */
  async criarDesafio(
    tx: Tx,
    usuarioId: string,
    agora: Date,
  ): Promise<{ token: string; expiraEm: Date }> {
    const token = this.cripto.gerarToken();
    const expiraEm = new Date(
      agora.getTime() + VALIDADE_DO_DESAFIO_MINUTOS * 60_000,
    );
    // Um desafio por vez: os anteriores ainda abertos deixam de valer.
    await tx.desafioDoisFatores.updateMany({
      where: { usuarioId, usadoEm: null },
      data: { usadoEm: agora },
    });
    await tx.desafioDoisFatores.create({
      data: { usuarioId, tokenHash: this.cripto.sha256(token), expiraEm },
    });
    return { token, expiraEm };
  }

  /** O desafio aberto e dentro do prazo, ou 401. */
  async buscarDesafio(token: string, agora: Date) {
    const desafio = await this.prisma.desafioDoisFatores.findUnique({
      where: { tokenHash: this.cripto.sha256(token) },
      include: { usuario: true },
    });
    if (
      !desafio ||
      desafio.usadoEm ||
      desafio.expiraEm <= agora ||
      desafio.tentativas >= TENTATIVAS_POR_DESAFIO
    ) {
      throw new NaoAutenticadoException(MENSAGEM_DESAFIO_EXPIRADO, {
        regra: 'R2.11',
      });
    }
    return desafio;
  }

  /** Conta o código errado no desafio; ao esgotar as tentativas, ele deixa de valer. */
  async contarErroNoDesafio(desafioId: string, agora: Date): Promise<number> {
    const { tentativas } = await this.prisma.desafioDoisFatores.update({
      where: { id: desafioId },
      data: { tentativas: { increment: 1 } },
      select: { tentativas: true },
    });
    if (tentativas >= TENTATIVAS_POR_DESAFIO) {
      await this.prisma.desafioDoisFatores.updateMany({
        where: { id: desafioId, usadoEm: null },
        data: { usadoEm: agora },
      });
    }
    return TENTATIVAS_POR_DESAFIO - tentativas;
  }

  /** Marca o desafio como usado; falso se outra requisição chegou antes. */
  async consumirDesafio(
    tx: Tx,
    desafioId: string,
    agora: Date,
  ): Promise<boolean> {
    const { count } = await tx.desafioDoisFatores.updateMany({
      where: { id: desafioId, usadoEm: null },
      data: { usadoEm: agora },
    });
    return count === 1;
  }

  // ---- códigos -----------------------------------------------------------

  /**
   * Confere um código: 6 dígitos = TOTP (janela ±1, cada passo vale uma vez);
   * senão, código de recuperação (uso único). Devolve a via ou `null`.
   */
  async conferirCodigo(
    usuario: Usuario,
    codigoBruto: string,
    opcoes: { aceitarRecuperacao: boolean; registrarPasso?: boolean },
  ): Promise<ViaDoCodigo | null> {
    if (!usuario.doisFatoresSegredo) {
      return null;
    }
    const codigo = normalizarCodigo(codigoBruto);
    if (/^\d{6}$/.test(codigo)) {
      const passo = verificarTotp(
        this.cripto.decifrar(usuario.doisFatoresSegredo),
        codigo,
      );
      if (passo === null) {
        return null;
      }
      if (opcoes.registrarPasso === false) {
        return 'totp';
      }
      const { count } = await this.prisma.usuario.updateMany({
        where: {
          id: usuario.id,
          OR: [
            { doisFatoresUltimoPasso: null },
            { doisFatoresUltimoPasso: { lt: passo } },
          ],
        },
        data: { doisFatoresUltimoPasso: passo },
      });
      return count === 1 ? 'totp' : null;
    }
    if (!opcoes.aceitarRecuperacao || !/^[A-Z0-9]{10}$/.test(codigo)) {
      return null;
    }
    const { count } = await this.prisma.codigoRecuperacao.updateMany({
      where: {
        usuarioId: usuario.id,
        codigoHash: this.hashDoCodigo(codigo),
        usadoEm: null,
      },
      data: { usadoEm: new Date() },
    });
    return count === 1 ? 'recuperacao' : null;
  }

  /** Aviso quando um código de recuperação é usado no login. */
  async avisarUsoDeRecuperacao(tx: Tx, usuario: Usuario): Promise<number> {
    const restantes = await tx.codigoRecuperacao.count({
      where: { usuarioId: usuario.id, usadoEm: null },
    });
    await this.auditoria.registrar(tx, {
      acao: 'usuario.dois_fatores_recuperacao_usada',
      entidade: 'usuario',
      entidadeId: usuario.id,
      resumo: `${usuario.nome} entrou com um código de recuperação`,
      dados: { restantes },
    });
    await this.notificacoes.notificar(tx, usuario.id, {
      tipo: 'seguranca.codigo_recuperacao_usado',
      titulo: 'Você usou um código de recuperação',
      texto:
        restantes > 0
          ? `Restam ${restantes} código${restantes === 1 ? '' : 's'}. Gere novos no Meu perfil quando quiser.`
          : 'Não restam códigos. Gere novos no Meu perfil.',
      link: '/configuracoes/perfil',
    });
    return restantes;
  }

  /**
   * Registra o código errado como falha de credencial (conta no bloqueio do
   * e-mail e do IP, R2.5), audita e, se a falha fechou um bloqueio, audita o bloqueio.
   */
  async registrarFalha(
    usuario: Usuario,
    meta: MetaDeRequisicao,
    agora: Date,
    origem: string,
    opcoes: { motivo?: 'DOIS_FATORES_INCORRETO' | 'SENHA_INCORRETA' } = {},
  ): Promise<void> {
    const motivo = opcoes.motivo ?? 'DOIS_FATORES_INCORRETO';
    // No login quem tentou não é, necessariamente, a pessoa do cookie.
    const ator: Ator | undefined =
      origem === 'login'
        ? { tipoAtor: 'USUARIO', descricao: usuario.email }
        : undefined;
    await this.prisma.$transaction(async (tx) => {
      await this.forcaBruta.registrar(tx, {
        email: usuario.email,
        ip: meta.ip,
        usuarioId: usuario.id,
        sucesso: false,
        motivo,
        userAgent: meta.userAgent,
      });
      await this.auditoria.registrar(tx, {
        acao:
          motivo === 'SENHA_INCORRETA'
            ? 'usuario.dois_fatores_senha_incorreta'
            : 'usuario.dois_fatores_codigo_incorreto',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo:
          motivo === 'SENHA_INCORRETA'
            ? `Senha atual incorreta ao desativar a verificação em duas etapas de ${usuario.email}`
            : `Código de verificação incorreto para ${usuario.email}`,
        dados: { email: usuario.email, origem, motivo },
        ator,
      });
      const bloqueio = await this.forcaBruta.verificar(
        usuario.email,
        meta.ip,
        agora,
        tx,
      );
      if (bloqueio) {
        await this.auditoria.registrar(tx, {
          acao: 'usuario.bloqueado_forca_bruta',
          entidade: 'usuario',
          entidadeId: usuario.id,
          resumo:
            bloqueio.motivo === 'BLOQUEADO_EMAIL'
              ? `Login de ${usuario.email} bloqueado após ${LIMITES_DE_LOGIN.falhasPorEmail} falhas em ${LIMITES_DE_LOGIN.janelaMinutos} minutos`
              : `Login pelo IP ${meta.ip ?? '?'} bloqueado após ${LIMITES_DE_LOGIN.tentativasPorIp} falhas em ${LIMITES_DE_LOGIN.janelaMinutos} minutos`,
          dados: {
            email: usuario.email,
            ip: meta.ip,
            motivo: bloqueio.motivo,
            ate: bloqueio.ate,
          },
          ator,
        });
      }
    });
  }

  async exigirSemBloqueio(
    email: string,
    ip: string | undefined,
    agora: Date,
  ): Promise<void> {
    const bloqueio = await this.forcaBruta.verificar(email, ip, agora);
    if (bloqueio) {
      throw excecaoDeBloqueio(bloqueio, agora);
    }
  }

  codigoIncorreto(restantes?: number): DadosInvalidosException {
    return new DadosInvalidosException(MENSAGEM_CODIGO_INCORRETO, {
      regra: 'R2.11',
      ...(restantes === undefined ? {} : { tentativasRestantes: restantes }),
      campos: [{ campo: 'codigo', mensagens: ['está incorreto'] }],
    });
  }

  // ---- internos ----------------------------------------------------------

  private async exigirAtivo(usuarioId: string): Promise<Usuario> {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
    });
    if (!usuario.doisFatoresAtivadoEm) {
      throw new RegraVioladaException(
        'R2.11',
        'A verificação em duas etapas não está ativa.',
      );
    }
    return usuario;
  }

  private hashDoCodigo(codigoNormalizado: string): string {
    return this.cripto.hmacComChave(`2fa-recuperacao:${codigoNormalizado}`);
  }

  private novosCodigos(): { codigos: string[]; hashes: string[] } {
    const codigos = new Set<string>();
    while (codigos.size < QUANTIDADE_CODIGOS_RECUPERACAO) {
      codigos.add(gerarCodigoDeRecuperacao());
    }
    const lista = [...codigos];
    return {
      codigos: lista,
      hashes: lista.map((codigo) =>
        this.hashDoCodigo(normalizarCodigo(codigo)),
      ),
    };
  }

  private async trocarCodigos(
    tx: Tx,
    usuarioId: string,
    hashes: string[],
  ): Promise<void> {
    await tx.codigoRecuperacao.deleteMany({ where: { usuarioId } });
    await tx.codigoRecuperacao.createMany({
      data: hashes.map((codigoHash) => ({ usuarioId, codigoHash })),
    });
  }

  /** Desliga o 2FA: apaga segredo, códigos e desafios abertos. */
  private async limpar(tx: Tx, usuarioId: string): Promise<void> {
    await tx.usuario.update({
      where: { id: usuarioId },
      data: {
        doisFatoresSegredo: null,
        doisFatoresAtivadoEm: null,
        doisFatoresUltimoPasso: null,
      },
    });
    await tx.codigoRecuperacao.deleteMany({ where: { usuarioId } });
    await tx.desafioDoisFatores.deleteMany({ where: { usuarioId } });
  }
}
