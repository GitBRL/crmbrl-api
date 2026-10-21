import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  CriptografiaService,
  TAMANHO_MAXIMO_SENHA,
  TAMANHO_MINIMO_SENHA,
} from '../comum/criptografia/criptografia.service';
import { normalizarEmail } from '../comum/dominio/email';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { EmailService } from '../email/email.service';
import { modeloConvite, modeloRedefinicao } from '../email/modelos';
import type {
  TipoTokenSenha,
  TokenSenha,
  Usuario,
} from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import type { ConsultaTokenDto } from './dto/auth.dto';
import { SessoesService } from './sessoes.service';

/** Validade dos links de convite e de redefinição (R2.8). */
export const VALIDADE_TOKEN_SENHA_HORAS = 24;

/** Intervalo mínimo entre dois e-mails de redefinição para o mesmo usuário. */
const INTERVALO_ENTRE_REDEFINICOES_MS = 2 * 60 * 1000;

/** Caminhos do front para os links dos e-mails. */
export const CAMINHO_DEFINIR_SENHA = '/definir-senha';
export const CAMINHO_REDEFINIR_SENHA = '/redefinir-senha';

/**
 * Senhas além do login (R2.8):
 *
 * - convite e "esqueci minha senha" por e-mail, com token de uso único válido
 *   por 24 horas (só o hash fica no banco) — exigem SMTP configurado;
 * - senha temporária definida pelo Admin (revoga as sessões e exige troca).
 *
 * As operações já gravam a auditoria; quem chama cuida da permissão (só o Admin
 * convida e define senha temporária, R1.5).
 */
@Injectable()
export class SenhasService {
  private readonly logger = new Logger(SenhasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly sessoes: SessoesService,
    private readonly auditoria: AuditoriaService,
    private readonly email: EmailService,
    private readonly logs: LogsTecnicosService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  /** Há SMTP para convite e redefinição por e-mail? */
  get envioPorEmailDisponivel(): boolean {
    return this.email.configurado;
  }

  /**
   * Cria um token de convite ou redefinição (invalida os anteriores do mesmo
   * tipo ainda não usados) e devolve o token em claro — que só existe aqui e no
   * link do e-mail.
   */
  async emitirToken(
    tx: Tx,
    usuarioId: string,
    tipo: TipoTokenSenha,
    criadoPorId?: string,
  ): Promise<{ token: string; expiraEm: Date }> {
    const agora = new Date();
    await tx.tokenSenha.updateMany({
      where: { usuarioId, tipo, usadoEm: null, invalidadoEm: null },
      data: { invalidadoEm: agora },
    });
    const token = this.cripto.gerarToken(32);
    const expiraEm = new Date(
      agora.getTime() + VALIDADE_TOKEN_SENHA_HORAS * 60 * 60 * 1000,
    );
    await tx.tokenSenha.create({
      data: {
        usuarioId,
        tipo,
        tokenHash: this.cripto.sha256(token),
        criadoPorId: criadoPorId ?? null,
        criadoEm: agora,
        expiraEm,
      },
    });
    return { token, expiraEm };
  }

  /**
   * Envia (ou reenvia) o convite para o usuário definir a senha (R2.8). Exige
   * SMTP (422 `R2.8` sem ele). Grava `usuario.convite_enviado` na auditoria.
   */
  async enviarConvite(
    usuarioId: string,
    criadoPorId?: string,
  ): Promise<{ expiraEm: Date }> {
    this.exigirEmail();
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
    });
    if (!usuario) {
      throw new NaoEncontradoException('Usuário não encontrado.');
    }
    if (!usuario.ativo) {
      throw new RegraVioladaException(
        'R2.8',
        'Usuário desligado não recebe convite.',
      );
    }
    const { token, expiraEm } = await this.prisma.$transaction(async (tx) => {
      const emitido = await this.emitirToken(
        tx,
        usuario.id,
        'CONVITE',
        criadoPorId,
      );
      await this.auditoria.registrar(tx, {
        acao: 'usuario.convite_enviado',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: `Convite de acesso enviado para ${usuario.email}`,
        dados: { expiraEm: emitido.expiraEm },
      });
      return emitido;
    });
    try {
      await this.email.enviar(
        modeloConvite({
          para: usuario.email,
          nome: usuario.nome,
          link: this.link(CAMINHO_DEFINIR_SENHA, token),
          expiraEm,
        }),
      );
    } catch (erro) {
      await this.logs.erro(
        'Email',
        `Falha ao enviar o convite para ${usuario.email}`,
        erro,
      );
      throw new ServicoIndisponivelException(
        'Não foi possível enviar o e-mail de convite. Tente de novo mais tarde.',
      );
    }
    return { expiraEm };
  }

  /**
   * "Esqueci minha senha" (R2.8). Responde igual exista o e-mail ou não; para
   * usuário ativo, envia o link (no máximo um a cada 2 minutos).
   */
  async solicitarRedefinicao(email: string): Promise<void> {
    this.exigirEmail();
    const usuario = await this.prisma.usuario.findUnique({
      where: { email: normalizarEmail(email) },
    });
    if (!usuario || !usuario.ativo) {
      return;
    }
    const recente = await this.prisma.tokenSenha.findFirst({
      where: {
        usuarioId: usuario.id,
        tipo: 'REDEFINICAO',
        criadoEm: {
          gt: new Date(Date.now() - INTERVALO_ENTRE_REDEFINICOES_MS),
        },
      },
    });
    if (recente) {
      return;
    }
    const { token, expiraEm } = await this.prisma.$transaction(async (tx) => {
      const emitido = await this.emitirToken(tx, usuario.id, 'REDEFINICAO');
      await this.auditoria.registrar(tx, {
        acao: 'usuario.redefinicao_solicitada',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: `Redefinição de senha solicitada para ${usuario.email}`,
      });
      return emitido;
    });
    try {
      await this.email.enviar(
        modeloRedefinicao({
          para: usuario.email,
          nome: usuario.nome,
          link: this.link(CAMINHO_REDEFINIR_SENHA, token),
          expiraEm,
        }),
      );
    } catch (erro) {
      // Sem revelar ao solicitante: o problema vai para os logs técnicos.
      await this.logs.erro(
        'Email',
        `Falha ao enviar a redefinição para ${usuario.email}`,
        erro,
      );
    }
  }

  /** O token (do link) ainda vale? Para a tela de definir/redefinir senha. */
  async consultarToken(token: string): Promise<ConsultaTokenDto> {
    const encontrado = await this.buscarTokenValido(token);
    if (!encontrado) {
      return { valido: false };
    }
    return {
      valido: true,
      tipo: encontrado.tipo,
      nome: encontrado.usuario.nome,
      email: encontrado.usuario.email,
      expiraEm: encontrado.expiraEm.toISOString(),
    };
  }

  /**
   * Define a senha pelo token do convite ou da redefinição: grava a senha, gasta
   * o token, encerra todas as sessões do usuário e audita.
   */
  async redefinirComToken(token: string, novaSenha: string): Promise<void> {
    validarTamanho(novaSenha, 'novaSenha');
    const encontrado = await this.buscarTokenValido(token);
    if (!encontrado) {
      throw new RegraVioladaException(
        'R2.8',
        'Este link é inválido, já foi usado ou expirou. Peça um novo.',
      );
    }
    const hash = await this.cripto.hashSenha(novaSenha);
    const agora = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tokenSenha.updateMany({
        where: { id: encontrado.id, usadoEm: null, invalidadoEm: null },
        data: { usadoEm: agora },
      });
      if (count === 0) {
        throw new RegraVioladaException(
          'R2.8',
          'Este link já foi usado. Peça um novo.',
        );
      }
      await tx.usuario.update({
        where: { id: encontrado.usuarioId },
        data: {
          senhaHash: hash,
          deveTrocarSenha: false,
          senhaAlteradaEm: agora,
        },
      });
      const sessoesEncerradas = await this.sessoes.revogarTodas(
        tx,
        encontrado.usuarioId,
        'redefinicao_de_senha',
      );
      await this.auditoria.registrar(tx, {
        acao: 'usuario.senha_redefinida',
        entidade: 'usuario',
        entidadeId: encontrado.usuarioId,
        resumo:
          encontrado.tipo === 'CONVITE'
            ? `${encontrado.usuario.nome} definiu a senha pelo convite`
            : `${encontrado.usuario.nome} redefiniu a senha pelo e-mail`,
        dados: { via: encontrado.tipo, sessoesEncerradas },
        ator: {
          tipoAtor: 'USUARIO',
          usuario: {
            id: encontrado.usuario.id,
            papel: encontrado.usuario.papel,
            nome: encontrado.usuario.nome,
          },
        },
      });
    });
  }

  /**
   * Senha temporária definida pelo Admin (R2.8): grava, exige troca no próximo
   * acesso, encerra todas as sessões e audita `usuario.senha_temporaria_definida`.
   * Chame dentro da transação do serviço de usuários (que confere se é Admin).
   */
  async definirSenhaTemporaria(
    tx: Tx,
    usuario: Pick<Usuario, 'id' | 'nome'>,
    senhaTemporaria: string,
  ): Promise<void> {
    validarTamanho(senhaTemporaria, 'senha');
    const hash = await this.cripto.hashSenha(senhaTemporaria);
    await tx.usuario.update({
      where: { id: usuario.id },
      data: {
        senhaHash: hash,
        deveTrocarSenha: true,
        senhaAlteradaEm: new Date(),
      },
    });
    const sessoesEncerradas = await this.sessoes.revogarTodas(
      tx,
      usuario.id,
      'senha_temporaria',
    );
    await this.auditoria.registrar(tx, {
      acao: 'usuario.senha_temporaria_definida',
      entidade: 'usuario',
      entidadeId: usuario.id,
      resumo: `Senha temporária definida para ${usuario.nome} (troca obrigatória)`,
      dados: { sessoesEncerradas },
    });
  }

  private async buscarTokenValido(
    token: string,
  ): Promise<(TokenSenha & { usuario: Usuario }) | null> {
    if (!token || token.length > 200) {
      return null;
    }
    const encontrado = await this.prisma.tokenSenha.findUnique({
      where: { tokenHash: this.cripto.sha256(token) },
      include: { usuario: true },
    });
    if (
      !encontrado ||
      encontrado.usadoEm ||
      encontrado.invalidadoEm ||
      encontrado.expiraEm.getTime() <= Date.now() ||
      !encontrado.usuario.ativo
    ) {
      return null;
    }
    return encontrado;
  }

  private link(caminho: string, token: string): string {
    return `${this.ambiente.urlPublica}${caminho}?token=${encodeURIComponent(token)}`;
  }

  private exigirEmail(): void {
    if (!this.email.configurado) {
      throw new RegraVioladaException(
        'R2.8',
        'O envio de e-mails não está configurado. Peça ao administrador uma senha temporária.',
      );
    }
  }
}

function validarTamanho(senha: string, campo: string): void {
  if (
    senha.length < TAMANHO_MINIMO_SENHA ||
    senha.length > TAMANHO_MAXIMO_SENHA
  ) {
    throw new DadosInvalidosException(
      `A senha precisa ter de ${TAMANHO_MINIMO_SENHA} a ${TAMANHO_MAXIMO_SENHA} caracteres (R2.1).`,
      {
        campos: [
          {
            campo,
            mensagens: [
              `deve ter de ${TAMANHO_MINIMO_SENHA} a ${TAMANHO_MAXIMO_SENHA} caracteres`,
            ],
          },
        ],
      },
    );
  }
}
