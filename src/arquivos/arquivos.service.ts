import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  CorpoMuitoGrandeException,
  DadosInvalidosException,
  ErroApi,
  NaoEncontradoException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { FilaService } from '../fila/fila.service';
import type {
  Arquivo,
  ContextoArquivo,
  Prisma,
} from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  ConteudoNaoEncontradoError,
  DRIVER_DE_ARQUIVOS,
  type DriverDeArquivos,
} from './drivers/driver-de-arquivos';
import type { FaixaDeBytes } from './faixa';
import {
  avaliarTipo,
  conferirConteudo,
  descreverTamanho,
  resolverMime,
  sanitizarNomeDeArquivo,
} from './politica';

/** Fila que apaga o conteúdo do bucket depois que a remoção do registro confirma. */
export const FILA_APAGAR_CONTEUDO = 'arquivos.apagar-conteudo';

/** Bytes lidos antes de conferir o conteúdo contra o tipo declarado. */
const BYTES_DO_CABECALHO = 512;

/** Dados de um arquivo novo (`ArquivosService.salvar`). */
export interface DadosDoArquivo {
  /** Nome original (é limpo antes de gravar). */
  nome: string;
  /** Tipo MIME declarado. `application/octet-stream` → o da extensão do nome. */
  mime: string;
  /** Tamanho declarado, em bytes, se conhecido: recusa cedo o que passa do limite. */
  tamanho?: number;
  contexto: ContextoArquivo;
  /** Quem enviou (nulo: mídia recebida de um canal, visitante do chat do site). */
  criadoPorId?: string | null;
  largura?: number | null;
  altura?: number | null;
  duracaoSegundos?: number | null;
  /**
   * Só para código do servidor (nunca vem do HTTP): limite de tamanho maior que o da
   * política do contexto, como as gravações de ligação (R30), que têm limite próprio.
   */
  limiteBytes?: number;
}

/**
 * Decide se o usuário pode baixar um arquivo do contexto (R11): a mesma
 * permissão do item a que ele pertence. Registrado pelo módulo dono do item:
 *
 * ```ts
 * // no onModuleInit do AtendimentoModule
 * this.arquivos.registrarVerificadorDeAcesso('MENSAGEM', (usuario, arquivo) =>
 *   this.podeVerArquivoDeMensagem(usuario, arquivo.id));
 * ```
 */
export type VerificadorDeAcesso = (
  usuario: UsuarioAutenticado,
  arquivo: Arquivo,
) => Promise<boolean>;

/** 415 — tipo de arquivo recusado pela política (R11). */
export class TipoDeArquivoRecusadoException extends ErroApi {
  constructor(mensagem: string, detalhes?: Record<string, unknown>) {
    super(415, 'tipo_nao_suportado', mensagem, { regra: 'R11', ...detalhes });
  }
}

/** Conteúdo lido de um arquivo (`abrirLeitura`). */
export interface LeituraDeArquivo {
  readonly arquivo: Arquivo;
  readonly stream: Readable;
}

/**
 * Arquivos (R11): guarda no MinIO/S3 (ou na memória, nos testes) e registra na
 * tabela `arquivos`.
 *
 * - `salvar(conteudo, dados)`: confere o tipo (lista de aceitos; SVG e HTML
 *   recusados), o limite do contexto (25 MB; documentos 100 MB; foto 5 MB) e
 *   os primeiros bytes contra o tipo declarado, calcula o SHA-256 lendo uma vez
 *   só (sem guardar o arquivo inteiro na memória no driver S3) e grava.
 * - `abrirLeitura(id, faixa?)`: o conteúdo (ou um pedaço, para o player).
 * - `remover(id)`: marca `removidoEm` e apaga o conteúdo do bucket depois que a
 *   transação confirma (job `arquivos.apagar-conteudo`), com auditoria.
 * - Download pela API (`GET /api/v1/arquivos/:id`): `podeLer(usuario, arquivo)`
 *   consulta o verificador registrado para o contexto.
 *
 * ```ts
 * const arquivo = await this.arquivos.salvar(buffer, {
 *   nome: 'foto.jpg', mime: 'image/jpeg', contexto: 'MENSAGEM',
 * });
 * const { stream } = await this.arquivos.abrirLeitura(arquivo.id);
 * ```
 */
@Injectable()
export class ArquivosService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ArquivosService.name);
  private readonly verificadores = new Map<
    ContextoArquivo,
    VerificadorDeAcesso[]
  >();
  private temporizador?: NodeJS.Timeout;
  private parando = false;
  private bucketPronto = false;

  constructor(
    @Inject(DRIVER_DE_ARQUIVOS) private readonly driver: DriverDeArquivos,
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly fila: FilaService,
    private readonly logs: LogsTecnicosService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ chave: string }>(
      FILA_APAGAR_CONTEUDO,
      async (trabalho) => {
        await this.driver.remover(trabalho.dados.chave);
      },
      {
        tentativas: 5,
        intervaloEntreTentativasSegundos: 60,
        esperaExponencial: true,
      },
    );
  }

  /** Cria o bucket se faltar. Com o MinIO fora do ar, a API sobe e tenta de novo depois. */
  async onApplicationBootstrap(): Promise<void> {
    await this.prepararArmazenamento(1);
  }

  onModuleDestroy(): void {
    this.parando = true;
    clearTimeout(this.temporizador);
  }

  /** O bucket já foi conferido/criado nesta subida? */
  get armazenamentoPronto(): boolean {
    return this.bucketPronto;
  }

  /**
   * Registra quem decide o acesso aos arquivos de um contexto. Vários módulos
   * podem registrar o mesmo contexto (ex.: `RELATORIO` de importações e de
   * campanhas): o acesso é liberado se algum verificador liberar. Sem
   * verificador, `MENSAGEM` e `CHAT` ficam restritos a quem enviou.
   */
  registrarVerificadorDeAcesso(
    contexto: ContextoArquivo,
    verificador: VerificadorDeAcesso,
  ): void {
    this.verificadores.set(contexto, [
      ...(this.verificadores.get(contexto) ?? []),
      verificador,
    ]);
  }

  /**
   * O usuário pode baixar o arquivo? Quem enviou, sempre. Depois, o
   * verificador do contexto; sem verificador: `AVATAR` qualquer usuário
   * logado, `IMPORTACAO` e `OUTRO` só o Admin, `MENSAGEM` e `CHAT` ninguém.
   */
  async podeLer(
    usuario: UsuarioAutenticado,
    arquivo: Arquivo,
  ): Promise<boolean> {
    if (arquivo.criadoPorId && arquivo.criadoPorId === usuario.id) {
      return true;
    }
    const verificadores = this.verificadores.get(arquivo.contexto);
    if (verificadores?.length) {
      for (const verificador of verificadores) {
        if (await verificador(usuario, arquivo)) {
          return true;
        }
      }
      return false;
    }
    switch (arquivo.contexto) {
      case 'AVATAR':
        return true;
      case 'IMPORTACAO':
      case 'OUTRO':
        return usuario.papel === 'ADMIN';
      default:
        return false;
    }
  }

  /** O arquivo (não removido), se o usuário pode vê-lo; senão 404 (não revela que existe). */
  async obterParaUsuario(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<Arquivo> {
    const arquivo = await this.prisma.arquivo.findUnique({ where: { id } });
    if (
      !arquivo ||
      arquivo.removidoEm ||
      !(await this.podeLer(usuario, arquivo))
    ) {
      throw new NaoEncontradoException('Arquivo não encontrado.');
    }
    return arquivo;
  }

  /** O registro do arquivo (não removido); 404 se não existir. */
  async obter(id: string, tx: Tx = this.prisma): Promise<Arquivo> {
    const arquivo = await tx.arquivo.findUnique({ where: { id } });
    if (!arquivo || arquivo.removidoEm) {
      throw new NaoEncontradoException('Arquivo não encontrado.');
    }
    return arquivo;
  }

  /**
   * Guarda um arquivo novo e devolve o registro. Lança 415 (tipo recusado ou
   * conteúdo que não bate com o tipo), 413 (acima do limite do contexto) ou 400
   * (vazio). Com `tx`, o registro entra na transação de quem chama (o conteúdo
   * vai para o bucket antes; se a transação desfizer, sobra só o objeto).
   */
  async salvar(
    conteudo: Buffer | Readable | AsyncIterable<Buffer | Uint8Array>,
    dados: DadosDoArquivo,
    opcoes: { tx?: Tx } = {},
  ): Promise<Arquivo> {
    const nome = sanitizarNomeDeArquivo(dados.nome);
    const mime = resolverMime(dados.mime, nome);
    const politica = avaliarTipo(mime, dados.contexto);
    if (!politica.aceito) {
      descartar(conteudo);
      throw new TipoDeArquivoRecusadoException(politica.motivo, { mime });
    }
    const limite = dados.limiteBytes ?? politica.limiteBytes;
    if (dados.tamanho !== undefined && dados.tamanho > limite) {
      descartar(conteudo);
      throw this.limiteEstourado(limite);
    }

    const id = randomUUID();
    const agora = new Date();
    const chave = [
      dados.contexto.toLowerCase(),
      agora.getUTCFullYear(),
      String(agora.getUTCMonth() + 1).padStart(2, '0'),
      id,
    ].join('/');
    const hash = createHash('sha256');
    const medida = { tamanho: 0 };
    try {
      await this.driver.gravar(
        chave,
        this.medir(paraIteravel(conteudo), { limite, mime, hash, medida }),
        { mime },
      );
    } catch (erro) {
      if (erro instanceof ErroApi) {
        throw erro;
      }
      throw await this.falhaDoArmazenamento('guardar', erro, { chave });
    }

    try {
      return await (opcoes.tx ?? this.prisma).arquivo.create({
        data: {
          id,
          chave,
          nome,
          mime,
          tamanho: medida.tamanho,
          sha256: hash.digest('hex'),
          contexto: dados.contexto,
          criadoPorId: dados.criadoPorId ?? null,
          largura: positivoOuNulo(dados.largura),
          altura: positivoOuNulo(dados.altura),
          duracaoSegundos:
            dados.duracaoSegundos === undefined ||
            dados.duracaoSegundos === null
              ? null
              : Math.max(0, Math.round(dados.duracaoSegundos)),
        },
      });
    } catch (erro) {
      await this.driver.remover(chave).catch(() => undefined);
      throw erro;
    }
  }

  /**
   * Abre o conteúdo para leitura (ou só a faixa de bytes pedida). 404 se o
   * arquivo não existe ou foi removido; 503 se o armazenamento não responde.
   */
  async abrirLeitura(
    id: string,
    faixa?: FaixaDeBytes,
  ): Promise<LeituraDeArquivo> {
    const arquivo = await this.obter(id);
    return { arquivo, stream: await this.abrirConteudo(arquivo, faixa) };
  }

  /** O conteúdo de um registro já carregado (o controller confere a permissão antes). */
  async abrirConteudo(
    arquivo: Arquivo,
    faixa?: FaixaDeBytes,
  ): Promise<Readable> {
    try {
      return await this.driver.abrir(arquivo.chave, faixa);
    } catch (erro) {
      if (erro instanceof ConteudoNaoEncontradoError) {
        throw new NaoEncontradoException(
          'O conteúdo deste arquivo não está mais disponível.',
        );
      }
      throw await this.falhaDoArmazenamento('abrir', erro, {
        arquivoId: arquivo.id,
      });
    }
  }

  /** O conteúdo inteiro num `Buffer` (anexos de e-mail, envio pelo WhatsApp). */
  async lerConteudo(
    id: string,
  ): Promise<{ arquivo: Arquivo; conteudo: Buffer }> {
    const { arquivo, stream } = await this.abrirLeitura(id);
    const pedacos: Buffer[] = [];
    for await (const pedaco of stream) {
      pedacos.push(
        Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(pedaco as Uint8Array),
      );
    }
    return { arquivo, conteudo: Buffer.concat(pedacos) };
  }

  /**
   * Remove o arquivo (R11): marca `removidoEm`, audita `arquivo.removido` e
   * agenda a exclusão do conteúdo no bucket — o job só nasce se a transação
   * confirmar. Idempotente: remover de novo não faz nada.
   */
  async remover(
    id: string,
    opcoes: { tx?: Tx; motivo?: string } = {},
  ): Promise<void> {
    const executar = async (tx: Tx): Promise<void> => {
      const arquivo = await tx.arquivo.findUnique({ where: { id } });
      if (!arquivo) {
        throw new NaoEncontradoException('Arquivo não encontrado.');
      }
      if (arquivo.removidoEm) {
        return;
      }
      await tx.arquivo.update({
        where: { id },
        data: { removidoEm: new Date() },
      });
      await this.auditoria.registrar(tx, {
        acao: 'arquivo.removido',
        entidade: 'arquivo',
        entidadeId: id,
        resumo: `Arquivo "${arquivo.nome}" removido`,
        dados: {
          contexto: arquivo.contexto,
          mime: arquivo.mime,
          tamanho: arquivo.tamanho,
          ...(opcoes.motivo ? { motivo: opcoes.motivo } : {}),
        },
      });
      await this.fila.enviar(
        FILA_APAGAR_CONTEUDO,
        { chave: arquivo.chave },
        { tx },
      );
    };
    if (opcoes.tx) {
      await executar(opcoes.tx);
    } else {
      await this.prisma.$transaction(executar);
    }
  }

  /**
   * Para o upload que falhou depois de salvar (outro arquivo do mesmo pedido
   * recusado): apaga o registro e o conteúdo na hora. Só para arquivos que
   * ainda não foram ligados a nada.
   */
  async descartarNovo(id: string): Promise<void> {
    const arquivo = await this.prisma.arquivo.findUnique({ where: { id } });
    if (!arquivo) {
      return;
    }
    await this.prisma.arquivo.delete({ where: { id } }).catch(() => undefined);
    await this.driver.remover(arquivo.chave).catch(() => undefined);
  }

  /** Lê o conteúdo uma vez: tamanho, hash, limite e conferência dos primeiros bytes. */
  private async *medir(
    fonte: AsyncIterable<Buffer | Uint8Array>,
    estado: {
      limite: number;
      mime: string;
      hash: ReturnType<typeof createHash>;
      medida: { tamanho: number };
    },
  ): AsyncGenerator<Buffer> {
    const iniciais: Buffer[] = [];
    let bytesIniciais = 0;
    let conferido = false;
    const conferir = (): void => {
      const motivo = conferirConteudo(Buffer.concat(iniciais), estado.mime);
      if (motivo) {
        throw new TipoDeArquivoRecusadoException(motivo, { mime: estado.mime });
      }
      conferido = true;
    };
    for await (const bruto of fonte) {
      const pedaco = Buffer.isBuffer(bruto) ? bruto : Buffer.from(bruto);
      if (pedaco.length === 0) {
        continue;
      }
      estado.medida.tamanho += pedaco.length;
      if (estado.medida.tamanho > estado.limite) {
        throw this.limiteEstourado(estado.limite);
      }
      estado.hash.update(pedaco);
      if (conferido) {
        yield pedaco;
        continue;
      }
      iniciais.push(pedaco);
      bytesIniciais += pedaco.length;
      if (bytesIniciais >= BYTES_DO_CABECALHO) {
        conferir();
        yield* iniciais.splice(0);
      }
    }
    if (estado.medida.tamanho === 0) {
      throw new DadosInvalidosException('O arquivo está vazio.', {
        regra: 'R11',
      });
    }
    if (!conferido) {
      conferir();
      yield* iniciais.splice(0);
    }
  }

  private limiteEstourado(limite: number): CorpoMuitoGrandeException {
    return new CorpoMuitoGrandeException(
      `O arquivo passa do limite de ${descreverTamanho(limite)}.`,
      { regra: 'R11', limiteBytes: limite },
    );
  }

  private async falhaDoArmazenamento(
    operacao: 'guardar' | 'abrir',
    erro: unknown,
    dados: Record<string, unknown>,
  ): Promise<ServicoIndisponivelException> {
    await this.logs.erro(
      'Arquivos',
      `Falha ao ${operacao} no armazenamento (${this.driver.nome}).`,
      erro,
      dados,
    );
    return new ServicoIndisponivelException(
      operacao === 'guardar'
        ? 'Não foi possível guardar o arquivo agora. Tente de novo em instantes.'
        : 'Não foi possível abrir o arquivo agora. Tente de novo em instantes.',
    );
  }

  private async prepararArmazenamento(tentativa: number): Promise<void> {
    if (this.parando) {
      return;
    }
    try {
      await this.driver.preparar();
      this.bucketPronto = true;
      if (tentativa > 1 || this.driver.nome === 's3') {
        this.logger.log(
          `Armazenamento de arquivos pronto (${this.driver.nome}).`,
        );
      }
    } catch (erro) {
      const esperaMs = Math.min(60_000, 2_000 * 2 ** (tentativa - 1));
      this.logger.warn(
        `Armazenamento de arquivos indisponível (${mensagemDe(erro)}); tentando de novo em ${Math.round(esperaMs / 1000)} s.`,
      );
      this.temporizador = setTimeout(() => {
        void this.prepararArmazenamento(tentativa + 1);
      }, esperaMs);
      this.temporizador.unref();
    }
  }
}

function paraIteravel(
  conteudo: Buffer | Readable | AsyncIterable<Buffer | Uint8Array>,
): AsyncIterable<Buffer | Uint8Array> {
  if (Buffer.isBuffer(conteudo)) {
    return Readable.from([conteudo]);
  }
  return conteudo;
}

/** Deixa a fonte correr para o lixo (sem ela, quem a alimenta pode ficar esperando). */
function descartar(
  conteudo: Buffer | Readable | AsyncIterable<Buffer | Uint8Array>,
): void {
  if (conteudo instanceof Readable) {
    conteudo.resume();
  }
}

function positivoOuNulo(valor: number | null | undefined): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0
    ? Math.round(valor)
    : null;
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/** Para `Prisma.ArquivoWhereInput` em consultas de outros módulos: só os não removidos. */
export const ARQUIVO_DISPONIVEL: Prisma.ArquivoWhereInput = {
  removidoEm: null,
};
