import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria } from '../comum/dominio/papeis';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import type { DefinicaoDePassos } from '../comum/passos/definicao';
import { PassosService } from '../comum/passos/passos.service';
import { PrismaService } from '../prisma/prisma.service';
import { MOTIVOS_DE_FIM } from './chatbot.constantes';
import { janelaFechadaEm } from './condicoes';
import type { IniciarSimulacaoChatbotDto } from './chatbot.dto';
import type { ConfigDePerguntaComOpcoes } from './configuracao-dos-passos';
import { FluxosChatbotService } from './fluxos.service';
import { podeGerenciarFluxo } from './permissoes-chatbot';
import {
  type ItemDaTranscricao,
  VARIAVEL_DA_TRANSCRICAO,
} from './passos-do-chatbot.service';
import { IndiceDePassos } from '../comum/passos/definicao';

export interface EstadoDaSimulacao {
  execucaoId: string;
  status: string;
  motivoFim: string | null;
  erro: string | null;
  /** O que o fluxo espera agora (nulo = terminou ou está numa espera de tempo). */
  aguardando: {
    passoId: string;
    tipo: 'opcoes' | 'texto';
    opcoes?: Array<{ id: string; rotulo: string }>;
    /** Dá para "deixar o tempo passar" (lembrete / sem resposta). */
    temTempo: boolean;
  } | null;
  transcricao: ItemDaTranscricao[];
  variaveis: Record<string, unknown>;
}

/**
 * Simulador do editor (R18): roda o rascunho (ou a versão publicada) numa
 * execução em modo teste — esperas de tempo puladas sob demanda e nenhum efeito
 * real (nada é enviado, gravado no contato, criado ou chamado). A transcrição
 * (o que o bot disse, o que a pessoa respondeu, as ações simuladas) fica na
 * execução. Cada simulação é de quem a começou (diretoria vê todas).
 */
@Injectable()
export class SimuladorDoChatbot {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passos: PassosService,
    private readonly fluxos: FluxosChatbotService,
  ) {}

  async iniciar(
    usuario: UsuarioAutenticado,
    fluxoId: string,
    dto: IniciarSimulacaoChatbotDto,
  ): Promise<EstadoDaSimulacao> {
    const fluxo = await this.fluxos.obter(usuario, fluxoId);
    let definicao: unknown = fluxo.rascunho;
    if (dto.origem === 'publicada') {
      const versao = fluxo.versaoPublicadaId
        ? await this.prisma.fluxoChatbotVersao.findUnique({
            where: { id: fluxo.versaoPublicadaId },
          })
        : null;
      if (!versao) {
        throw new RegraVioladaException(
          'R18',
          'O fluxo ainda não tem versão publicada.',
          { motivo: 'sem_versao_publicada' },
        );
      }
      definicao = versao.definicao;
    }
    const problemas = this.fluxos.problemasDaDefinicao(definicao, fluxo);
    if (problemas.length > 0) {
      throw new DadosInvalidosException(
        `Corrija o fluxo antes de simular: ${problemas[0].mensagem}`,
        { regra: 'R18', problemas },
      );
    }
    const canalTipo = dto.canalTipo ?? 'WHATSAPP';
    const contato = {
      nome: dto.contato?.nome ?? 'Contato de teste',
      email: dto.contato?.email ?? null,
      telefone: dto.contato?.telefone ?? null,
      cargo: null,
      etiquetas: dto.contato?.etiquetas ?? [],
      campos: dto.contato?.campos ?? {},
    };
    const { execucao } = await this.passos.iniciar(
      {
        tipo: 'CHATBOT',
        nome: fluxo.nome,
        fluxoId: fluxo.id,
        definicao: definicao as DefinicaoDePassos,
        teste: true,
        contexto: {
          simulador: true,
          usuarioId: usuario.id,
          contato,
          canal: {
            id: 'simulado',
            tipo: canalTipo,
            horarioAtendimento:
              dto.horarioAberto === false ? janelaFechadaEm() : null,
          },
        },
        variaveis: {
          canal: canalTipo,
          primeira_mensagem: dto.mensagem ?? '',
        },
      },
      { executarAgora: true },
    );
    return this.estado(usuario, fluxoId, execucao.id);
  }

  async estado(
    usuario: UsuarioAutenticado,
    fluxoId: string,
    execucaoId: string,
  ): Promise<EstadoDaSimulacao> {
    const execucao = await this.carregar(usuario, fluxoId, execucaoId);
    const variaveis = execucao.variaveis as Record<string, unknown>;
    let aguardando: EstadoDaSimulacao['aguardando'] = null;
    if (
      execucao.status === 'AGUARDANDO' &&
      execucao.aguardandoEntrada &&
      execucao.passoAtualId
    ) {
      const passo = new IndiceDePassos(
        execucao.definicao as unknown as DefinicaoDePassos,
      ).obter(execucao.passoAtualId);
      if (passo) {
        const opcoes =
          passo.tipo === 'pergunta.opcoes'
            ? (passo.config as unknown as ConfigDePerguntaComOpcoes).opcoes
            : undefined;
        aguardando = {
          passoId: passo.id,
          tipo: opcoes ? 'opcoes' : 'texto',
          ...(opcoes ? { opcoes } : {}),
          temTempo: execucao.aguardandoAte !== null,
        };
      }
    }
    return {
      execucaoId: execucao.id,
      status: execucao.status,
      motivoFim: execucao.motivoFim,
      erro: execucao.erro,
      aguardando,
      transcricao:
        (variaveis[VARIAVEL_DA_TRANSCRICAO] as ItemDaTranscricao[]) ?? [],
      variaveis: Object.fromEntries(
        Object.entries(variaveis).filter(([chave]) => !chave.startsWith('__')),
      ),
    };
  }

  /** A pessoa responde ao bot. */
  async responder(
    usuario: UsuarioAutenticado,
    fluxoId: string,
    execucaoId: string,
    texto: string,
  ): Promise<EstadoDaSimulacao> {
    const execucao = await this.carregar(usuario, fluxoId, execucaoId);
    if (execucao.status !== 'AGUARDANDO' || !execucao.aguardandoEntrada) {
      throw new ConflitoException(
        'O fluxo não está esperando uma resposta agora.',
        { status: execucao.status },
      );
    }
    await this.passos.retomarComEntrada(execucao.id, {
      texto,
      mensagemId: null,
    });
    return this.estado(usuario, fluxoId, execucaoId);
  }

  /** Deixa o tempo passar: dispara o lembrete ou o "sem resposta" da pergunta. */
  async silencio(
    usuario: UsuarioAutenticado,
    fluxoId: string,
    execucaoId: string,
  ): Promise<EstadoDaSimulacao> {
    const execucao = await this.carregar(usuario, fluxoId, execucaoId);
    if (execucao.status !== 'AGUARDANDO' || execucao.aguardandoAte === null) {
      throw new ConflitoException('Não há nenhum tempo de espera para pular.', {
        status: execucao.status,
      });
    }
    await this.passos.avancar(
      execucao.id,
      { motivo: 'tempo', simulada: true },
      execucao.esperaToken ?? undefined,
    );
    return this.estado(usuario, fluxoId, execucaoId);
  }

  async encerrar(
    usuario: UsuarioAutenticado,
    fluxoId: string,
    execucaoId: string,
  ): Promise<void> {
    await this.carregar(usuario, fluxoId, execucaoId);
    await this.passos.cancelar(execucaoId, MOTIVOS_DE_FIM.SIMULACAO_ENCERRADA);
  }

  private async carregar(
    usuario: UsuarioAutenticado,
    fluxoId: string,
    execucaoId: string,
  ) {
    const fluxo = await this.fluxos.obter(usuario, fluxoId);
    const execucao = await this.prisma.execucao.findFirst({
      where: { id: execucaoId, fluxoId, tipo: 'CHATBOT', teste: true },
    });
    const dono = (execucao?.contexto as { usuarioId?: string } | undefined)
      ?.usuarioId;
    if (
      !execucao ||
      (dono !== usuario.id &&
        !(ehDiretoria(usuario.papel) || podeGerenciarFluxo(usuario, fluxo)))
    ) {
      throw new NaoEncontradoException('Simulação não encontrada.');
    }
    return execucao;
  }
}
