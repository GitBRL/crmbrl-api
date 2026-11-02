import { Injectable } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import type {
  AdaptadorCanal,
  TemplatePreparado,
} from '../canais/adaptador-canal';
import { gerarIdDeMensagemWhatsapp } from '../canais/whatsapp/contrato-gateway';
import {
  RegistroCanais,
  ROTULO_DO_TIPO_DE_CANAL,
} from '../canais/registro-canais';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  Arquivo,
  Canal,
  Conversa,
  Prisma,
  TipoMensagem,
} from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import {
  EVENTOS_DO_ATENDIMENTO,
  linkDaConversa,
  REGRA_ATENDIMENTO,
  resumir,
  TIPOS_NOTIFICACAO_ATENDIMENTO,
} from './atendimento.constantes';
import { ConversasService, exigirAtendimento } from './conversas.service';
import type {
  ConversaDetalheDto,
  IniciarConversaDto,
} from './dto/conversa.dto';
import {
  type CriarNotaDto,
  type EnviarMensagemDto,
  type FiltroMensagensDto,
  INCLUIR_MENSAGEM,
  MensagemDaConversaDto,
  type PaginaMensagensDto,
} from './dto/mensagem.dto';
import { inicioDaContagem, lerHorario } from './horario';
import { MotorDoAtendimento } from './motor-do-atendimento.service';
import { prazosDoSla } from './sla';
import { podeVerConversa } from './visibilidade';

/** Tipo da mensagem pelo MIME do anexo. */
export function tipoDoAnexo(mime: string): TipoMensagem {
  if (mime.startsWith('image/')) {
    return 'IMAGEM';
  }
  if (mime.startsWith('audio/')) {
    return 'AUDIO';
  }
  if (mime.startsWith('video/')) {
    return 'VIDEO';
  }
  return 'DOCUMENTO';
}

/**
 * Mensagens das conversas (§2.4): histórico paginado, envio ao contato (vira
 * `PENDENTE` e entra na fila de envio do canal), notas internas, nova
 * tentativa de uma mensagem que falhou e o início de uma conversa pelo CRM.
 */
@Injectable()
export class MensagensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversas: ConversasService,
    private readonly motor: MotorDoAtendimento,
    private readonly registro: RegistroCanais,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  /** Das mais novas para as mais antigas, por cursor; cada página em ordem cronológica. */
  async listar(
    usuario: UsuarioAutenticado,
    conversaId: string,
    filtro: FiltroMensagensDto,
  ): Promise<PaginaMensagensDto> {
    await this.conversas.visivel(this.prisma, usuario, conversaId);
    const cursor = filtro.cursor ? lerCursor(filtro.cursor) : null;
    const mensagens = await this.prisma.mensagem.findMany({
      where: {
        conversaId,
        ...(cursor
          ? {
              OR: [
                { ocorridaEm: { lt: cursor.ocorridaEm } },
                { ocorridaEm: cursor.ocorridaEm, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: INCLUIR_MENSAGEM,
      orderBy: [{ ocorridaEm: 'desc' }, { id: 'desc' }],
      take: filtro.limite + 1,
    });
    const temMais = mensagens.length > filtro.limite;
    const pagina = mensagens.slice(0, filtro.limite);
    const maisAntiga = pagina.at(-1);
    return {
      itens: pagina
        .reverse()
        .map((mensagem) => MensagemDaConversaDto.de(mensagem)),
      proximoCursor:
        temMais && maisAntiga
          ? escreverCursor(maisAntiga.ocorridaEm, maisAntiga.id)
          : null,
    };
  }

  /**
   * Envia ao contato. Conversa sem responsável passa a ser de quem respondeu.
   * 422 se a conversa está resolvida ou o canal não aceita resposta agora
   * (ex.: janela de 24 h da Meta fechada).
   */
  async enviar(
    usuario: UsuarioAutenticado,
    conversaId: string,
    dto: EnviarMensagemDto,
  ): Promise<MensagemDaConversaDto> {
    const texto = dto.texto?.trim() || null;
    if (dto.template && texto) {
      throw new DadosInvalidosException(
        'Com template, o texto vem do próprio template: não envie `texto`.',
        {
          campos: [
            { campo: 'texto', mensagens: ['não vale junto com template'] },
          ],
        },
      );
    }
    if (!texto && !dto.arquivoId && !dto.template) {
      throw new DadosInvalidosException(
        'Escreva a mensagem ou anexe um arquivo.',
        {
          campos: [{ campo: 'texto', mensagens: ['é obrigatório sem anexo'] }],
        },
      );
    }
    const arquivo = dto.arquivoId
      ? await this.anexoDoUsuario(usuario, dto.arquivoId)
      : null;
    const { mensagem, assumiu } = await this.prisma.$transaction(async (tx) => {
      const conversa = await this.conversas.travarVisivel(
        tx,
        usuario,
        conversaId,
      );
      this.conversas.exigirEmAberto(conversa);
      const canal = await tx.canal.findUniqueOrThrow({
        where: { id: conversa.canalId },
      });
      const preparado = dto.template
        ? await this.prepararTemplate(canal, dto.template, arquivo)
        : null;
      if (!preparado) {
        this.exigirCanalQueResponde(conversa, canal);
      }
      if (dto.respostaAId) {
        const citada = await tx.mensagem.findFirst({
          where: { id: dto.respostaAId, conversaId },
          select: { id: true },
        });
        if (!citada) {
          throw new DadosInvalidosException(
            'A mensagem respondida não é desta conversa.',
            {
              campos: [
                {
                  campo: 'respostaAId',
                  mensagens: ['mensagem não encontrada'],
                },
              ],
            },
          );
        }
      }
      let atual: Conversa = conversa;
      if (!conversa.responsavelId) {
        atual = await this.motor.atribuir(tx, conversa, {
          usuarioId: usuario.id,
          motivo: 'ASSUMIDA',
        });
        await this.motor.avisoDeSistema(
          tx,
          { ...atual, fila: conversa.fila },
          `${usuario.nome} assumiu a conversa.`,
          { evento: 'assumida', usuarioId: usuario.id },
        );
        await this.eventos.publicar(
          tx,
          EVENTOS_DO_ATENDIMENTO.CONVERSA_ATRIBUIDA,
          { conversaId, responsavelId: usuario.id, motivo: 'ASSUMIDA' },
        );
      }
      const salasAntes = this.motor.salas(conversa);
      const criada = await this.motor.criarSaida(tx, atual, canal, {
        tipo: preparado
          ? preparado.tipo
          : arquivo
            ? tipoDoAnexo(arquivo.mime)
            : 'TEXTO',
        texto: preparado ? preparado.texto : texto,
        arquivoId: arquivo?.id ?? null,
        respostaAId: dto.respostaAId ?? null,
        autorId: usuario.id,
        ...(preparado
          ? { metadados: preparado.metadados as Prisma.InputJsonObject }
          : {}),
      });
      await this.motor.emitirConversa(tx, conversaId, { salasAntes });
      await this.motor.publicarContagens(tx, {
        usuarios: [usuario.id, conversa.responsavelId],
        areas: [conversa.fila?.area],
      });
      return { mensagem: criada, assumiu: !conversa.responsavelId };
    });
    if (assumiu) {
      // Os colegas da área que olhavam a conversa sem responsável deixam de vê-la.
      await this.conversas.podarSala(conversaId);
    }
    return MensagemDaConversaDto.de(mensagem);
  }

  /** Nota interna: só a equipe vê; avisa o responsável quando é de outra pessoa. */
  async criarNota(
    usuario: UsuarioAutenticado,
    conversaId: string,
    dto: CriarNotaDto,
  ): Promise<MensagemDaConversaDto> {
    const mensagem = await this.prisma.$transaction(async (tx) => {
      const conversa = await this.conversas.visivel(tx, usuario, conversaId);
      const nota = await tx.mensagem.create({
        data: {
          conversaId,
          canalId: conversa.canalId,
          direcao: 'INTERNA',
          tipo: 'TEXTO',
          texto: dto.texto,
          autorId: usuario.id,
          autorTipo: 'USUARIO',
        },
      });
      if (conversa.responsavelId && conversa.responsavelId !== usuario.id) {
        await this.notificacoes.notificar(tx, conversa.responsavelId, {
          tipo: TIPOS_NOTIFICACAO_ATENDIMENTO.NOTA_INTERNA,
          titulo: `${usuario.nome} deixou uma nota numa conversa sua`,
          texto: `${conversa.contato.nome}: ${resumir(dto.texto)}`,
          link: linkDaConversa(conversaId),
          dados: { conversaId, mensagemId: nota.id },
        });
      }
      return this.motor.emitirMensagem(tx, conversa, nota.id);
    });
    return MensagemDaConversaDto.de(mensagem);
  }

  /** Nova tentativa de uma mensagem que falhou (volta a `PENDENTE` e à fila). */
  async reenviar(
    usuario: UsuarioAutenticado,
    conversaId: string,
    mensagemId: string,
  ): Promise<MensagemDaConversaDto> {
    const mensagem = await this.prisma.$transaction(async (tx) => {
      const conversa = await this.conversas.travarVisivel(
        tx,
        usuario,
        conversaId,
      );
      const original = await tx.mensagem.findFirst({
        where: { id: mensagemId, conversaId },
      });
      if (!original) {
        throw new NaoEncontradoException('Mensagem não encontrada.');
      }
      if (original.direcao !== 'SAIDA' || original.status !== 'FALHOU') {
        throw new ConflitoException(
          'Só dá para tentar de novo uma mensagem que falhou.',
          { status: original.status },
        );
      }
      this.conversas.exigirEmAberto(conversa);
      const canal = await tx.canal.findUniqueOrThrow({
        where: { id: conversa.canalId },
      });
      if (ehMensagemDeTemplate(original.metadados)) {
        // Template vale fora da janela de 24 h: só confere se o canal está no ar.
        this.exigirCanalDisponivel(canal);
      } else {
        this.exigirCanalQueResponde(conversa, canal);
      }
      const atualizada = await tx.mensagem.update({
        where: { id: mensagemId },
        data: {
          status: 'PENDENTE',
          erro: null,
          idExterno:
            canal.tipo === 'WHATSAPP' ? gerarIdDeMensagemWhatsapp() : null,
        },
      });
      await this.motor.enfileirarEnvio(tx, mensagemId);
      await this.motor.emitirStatus(tx, atualizada);
      return tx.mensagem.findUniqueOrThrow({
        where: { id: mensagemId },
        include: INCLUIR_MENSAGEM,
      });
    });
    return MensagemDaConversaDto.de(mensagem);
  }

  /**
   * Começa a conversa com um contato num canal (ou continua a que já está em
   * aberto) e envia a primeira mensagem. A conversa nova fica com quem a
   * começou, na fila padrão do canal.
   */
  async iniciar(
    usuario: UsuarioAutenticado,
    dto: IniciarConversaDto,
  ): Promise<ConversaDetalheDto> {
    exigirAtendimento(usuario);
    const texto = dto.texto?.trim() || null;
    if (!texto && !dto.arquivoId && !dto.template) {
      throw new DadosInvalidosException(
        'Escreva a mensagem ou anexe um arquivo.',
        {
          campos: [{ campo: 'texto', mensagens: ['é obrigatório sem anexo'] }],
        },
      );
    }
    const arquivo = dto.arquivoId
      ? await this.anexoDoUsuario(usuario, dto.arquivoId)
      : null;
    const conversaId = await this.prisma.$transaction(async (tx) => {
      const canal = await tx.canal.findFirst({
        where: { id: dto.canalId, excluidoEm: null },
        include: { filaPadrao: true },
      });
      if (!canal) {
        throw new NaoEncontradoException('Canal não encontrado.');
      }
      const contato = await tx.contato.findFirst({
        where: { id: dto.contatoId, excluidoEm: null },
        include: { identificadores: true },
      });
      if (!contato) {
        throw new NaoEncontradoException('Contato não encontrado.');
      }
      await travarChave(tx, 'atendimento-conversa', canal.id, contato.id);
      const aberta = await tx.conversa.findFirst({
        where: {
          canalId: canal.id,
          contatoId: contato.id,
          status: { not: 'RESOLVIDA' },
        },
        include: {
          fila: { select: { area: true } },
          responsavel: { select: { nome: true } },
        },
      });
      if (aberta) {
        if (!podeVerConversa(usuario, aberta)) {
          throw new ConflitoException(
            `${contato.nome} já está em atendimento neste canal${aberta.responsavel ? ` com ${aberta.responsavel.nome}` : ''}.`,
            { motivo: 'conversa_em_aberto' },
          );
        }
        return aberta.id;
      }
      if (!canal.ativo) {
        throw new RegraVioladaException(
          REGRA_ATENDIMENTO,
          'Este canal está desativado.',
          { motivo: 'canal_desativado' },
        );
      }
      this.registro.obter(canal.tipo);
      this.exigirDestino(canal, contato);
      if (dto.template) {
        this.exigirCanalComTemplates(canal);
      } else if (canal.tipo === 'WHATSAPP_OFICIAL') {
        // Conversa nova não tem janela aberta: a primeira mensagem é um template (R28.4).
        this.exigirCanalQueResponde({ janelaAte: null } as Conversa, canal);
      }
      const fila =
        canal.filaPadrao &&
        canal.filaPadrao.ativa &&
        !canal.filaPadrao.excluidoEm
          ? canal.filaPadrao
          : null;
      const conversa = await tx.conversa.create({
        data: {
          canalId: canal.id,
          contatoId: contato.id,
          filaId: fila?.id ?? null,
          assunto: dto.assunto ?? null,
          // Começada pela equipe: só o prazo de resolução vale (ninguém
          // espera a primeira resposta).
          slaResolucaoAte: prazosDoSla(
            fila,
            inicioDaContagem(lerHorario(canal.horarioAtendimento), new Date()),
          ).slaResolucaoAte,
        },
      });
      await this.motor.atribuir(tx, conversa, {
        usuarioId: usuario.id,
        motivo: 'MANUAL',
      });
      await this.auditoria.registrar(tx, {
        acao: 'conversa.criada',
        entidade: 'conversa',
        entidadeId: conversa.id,
        resumo: `${usuario.nome} começou uma conversa com "${contato.nome}" no ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} (${canal.nome})`,
        dados: {
          canalId: canal.id,
          filaId: conversa.filaId,
          iniciadaPelaEquipe: true,
        },
        relacionados: { contato: contato.id },
      });
      await this.eventos.publicar(tx, EVENTOS_DO_ATENDIMENTO.CONVERSA_CRIADA, {
        conversaId: conversa.id,
        canalId: canal.id,
        canalTipo: canal.tipo,
        contatoId: contato.id,
        filaId: conversa.filaId,
        iniciadaPelaEquipe: true,
      });
      await this.motor.emitirConversa(tx, conversa.id, { nova: true });
      return conversa.id;
    });
    await this.enviar(usuario, conversaId, {
      ...(texto && !dto.template ? { texto } : {}),
      ...(arquivo ? { arquivoId: arquivo.id } : {}),
      ...(dto.template ? { template: dto.template } : {}),
    });
    return this.conversas.detalhar(usuario, conversaId);
  }

  // -------------------------------------------------------------------------

  /** O anexo existe, é de mensagem e a pessoa pode usá-lo (enviou ou vê). */
  private async anexoDoUsuario(
    usuario: UsuarioAutenticado,
    arquivoId: string,
  ): Promise<Arquivo> {
    const arquivo = await this.prisma.arquivo.findUnique({
      where: { id: arquivoId },
    });
    if (
      !arquivo ||
      arquivo.removidoEm ||
      !(await this.arquivos.podeLer(usuario, arquivo))
    ) {
      throw new DadosInvalidosException('Anexo não encontrado.', {
        campos: [{ campo: 'arquivoId', mensagens: ['arquivo não encontrado'] }],
      });
    }
    if (arquivo.contexto !== 'MENSAGEM') {
      throw new DadosInvalidosException(
        'Este arquivo não foi enviado como anexo de mensagem.',
        {
          campos: [
            { campo: 'arquivoId', mensagens: ['envie com contexto=MENSAGEM'] },
          ],
        },
      );
    }
    return arquivo;
  }

  /** O canal está ligado e instalado? (422 se não.) */
  private exigirCanalDisponivel(canal: Canal): void {
    if (!canal.ativo || canal.excluidoEm) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        'O canal desta conversa está desativado.',
        { motivo: 'canal_desativado' },
      );
    }
    this.registro.obter(canal.tipo);
  }

  /** O canal está ligado, instalado e aceita resposta comum agora? (422 se não.) */
  private exigirCanalQueResponde(conversa: Conversa, canal: Canal): void {
    this.exigirCanalDisponivel(canal);
    const permissao = this.registro.podeResponder(conversa, canal);
    if (!permissao.pode) {
      throw new RegraVioladaException(
        canal.tipo === 'INSTAGRAM' || canal.tipo === 'MESSENGER'
          ? 'R14'
          : canal.tipo === 'WHATSAPP_OFICIAL'
            ? 'R28'
            : REGRA_ATENDIMENTO,
        permissao.motivo ?? 'Este canal não aceita resposta agora.',
        {
          motivo: 'canal_nao_aceita_resposta',
          ...(permissao.apenasTemplate ? { apenasTemplate: true } : {}),
        },
      );
    }
  }

  /** O canal trabalha com templates? (422 se não.) */
  private exigirCanalComTemplates(canal: Canal): void {
    this.exigirCanalDisponivel(canal);
    if (!this.registro.obter(canal.tipo).prepararTemplate) {
      throw new RegraVioladaException(
        REGRA_ATENDIMENTO,
        `O canal ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} não trabalha com templates.`,
        { motivo: 'canal_sem_templates' },
      );
    }
  }

  /** Confere e preenche o template no canal (o canal sabe o que a Meta aceita). */
  private async prepararTemplate(
    canal: Canal,
    template: NonNullable<EnviarMensagemDto['template']>,
    arquivo: Arquivo | null,
  ): Promise<TemplatePreparado> {
    this.exigirCanalComTemplates(canal);
    return (
      this.registro.obter(canal.tipo) as Required<
        Pick<AdaptadorCanal, 'prepararTemplate'>
      >
    ).prepararTemplate(canal, template, { arquivoMime: arquivo?.mime ?? null });
  }

  /** Dá para falar com o contato por este canal sem ele ter escrito antes? */
  private exigirDestino(
    canal: Canal,
    contato: {
      email: string | null;
      telefone: string | null;
      identificadores: Array<{ tipo: string }>;
    },
  ): void {
    const tem = (tipo: string) =>
      contato.identificadores.some(
        (identificador) => identificador.tipo === tipo,
      );
    const motivo = ((): string | null => {
      switch (canal.tipo) {
        case 'WHATSAPP':
          return contato.telefone || tem('WHATSAPP') || tem('WHATSAPP_LID')
            ? null
            : 'O contato não tem telefone para o WhatsApp.';
        case 'EMAIL':
          return contato.email || tem('EMAIL')
            ? null
            : 'O contato não tem e-mail.';
        case 'WHATSAPP_OFICIAL':
          return contato.telefone || tem('WHATSAPP') || tem('WHATSAPP_BSUID')
            ? null
            : 'O contato não tem telefone para o WhatsApp.';
        case 'WEBCHAT':
          return 'O chat do site só continua conversas que o visitante começou no site.';
        case 'INSTAGRAM':
        case 'MESSENGER':
          return `A Meta só deixa responder até 24 horas depois da última mensagem do contato: espere ele escrever pelo ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]}.`;
      }
    })();
    if (motivo) {
      throw new RegraVioladaException(REGRA_ATENDIMENTO, motivo, {
        motivo: 'sem_destino',
      });
    }
  }
}

/** A mensagem foi enviada por template (`metadados.template`)? */
function ehMensagemDeTemplate(metadados: unknown): boolean {
  return (
    typeof metadados === 'object' &&
    metadados !== null &&
    typeof (metadados as { template?: unknown }).template === 'object' &&
    (metadados as { template?: unknown }).template !== null
  );
}

/** Cursor opaco das mensagens: `<ocorridaEm ISO>|<id>` em base64url. */
function escreverCursor(ocorridaEm: Date, id: string): string {
  return Buffer.from(`${ocorridaEm.toISOString()}|${id}`).toString('base64url');
}

function lerCursor(cursor: string): { ocorridaEm: Date; id: string } {
  const [data, id] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  const ocorridaEm = new Date(data ?? '');
  if (!id || Number.isNaN(ocorridaEm.getTime())) {
    throw new DadosInvalidosException('Cursor inválido.', {
      campos: [{ campo: 'cursor', mensagens: ['cursor inválido'] }],
    });
  }
  return { ocorridaEm, id };
}
