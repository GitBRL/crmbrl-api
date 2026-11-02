import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import type { RequisicaoHttp } from '../comum/http/requisicao-http';
import { ContextoArquivo, type Arquivo } from '../generated/prisma/client';
import type { ArquivosService } from './arquivos.service';

/** Arquivo recebido pelo multer com o armazenamento da API: já salvo e registrado. */
export interface ArquivoRecebido extends Express.Multer.File {
  /** O registro criado por `ArquivosService.salvar`. */
  arquivoSalvo: Arquivo;
}

/** Como o armazenamento decide o contexto e o autor de cada envio. */
export interface OpcoesDoArmazenamento {
  /** Contexto do envio. Padrão: `?contexto=` da URL (obrigatório). */
  contexto?: (requisicao: RequisicaoHttp) => ContextoArquivo;
  /** Quem enviou. Padrão: o usuário da sessão (nulo em rota pública). */
  criadoPorId?: (requisicao: RequisicaoHttp) => string | null;
}

/**
 * `StorageEngine` do multer (o do `@nestjs/platform-express`) que entrega o
 * arquivo em streaming ao `ArquivosService.salvar`: nada vai para o disco, e no
 * driver S3 a memória fica em uma parte de 8 MB. A política (tipos, limites,
 * conteúdo) é a mesma de qualquer outro `salvar`.
 *
 * O contexto vem da query (`?contexto=MENSAGEM`), que chega antes do corpo — um
 * campo do formulário poderia vir depois do arquivo.
 *
 * Para um upload em outra rota (ex.: o chat do site, público):
 *
 * ```ts
 * MulterModule.registerAsync({
 *   inject: [ArquivosService],
 *   useFactory: (arquivos: ArquivosService) => ({
 *     storage: new ArmazenamentoDaApi(arquivos, { contexto: () => 'MENSAGEM', criadoPorId: () => null }),
 *     limits: LIMITES_DO_UPLOAD,
 *   }),
 * })
 * ```
 */
export class ArmazenamentoDaApi implements StorageEngine {
  constructor(
    private readonly arquivos: ArquivosService,
    private readonly opcoes: OpcoesDoArmazenamento = {},
  ) {}

  _handleFile(
    req: Request,
    file: Express.Multer.File,
    callback: (erro?: unknown, info?: Partial<ArquivoRecebido>) => void,
  ): void {
    const requisicao = req as RequisicaoHttp;
    let contexto: ContextoArquivo;
    try {
      contexto = (this.opcoes.contexto ?? contextoDaQuery)(requisicao);
    } catch (erro) {
      file.stream.resume();
      callback(erro);
      return;
    }
    const criadoPorId = this.opcoes.criadoPorId
      ? this.opcoes.criadoPorId(requisicao)
      : (requisicao.usuarioAutenticado?.id ?? null);
    this.arquivos
      .salvar(file.stream, {
        nome: decodificarNome(file.originalname),
        mime: file.mimetype,
        contexto,
        criadoPorId,
      })
      .then((arquivo) =>
        callback(null, { arquivoSalvo: arquivo, size: arquivo.tamanho }),
      )
      .catch((erro: unknown) => {
        file.stream.resume();
        callback(erro);
      });
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (erro: Error | null) => void,
  ): void {
    const salvo = (file as Partial<ArquivoRecebido>).arquivoSalvo;
    if (!salvo) {
      callback(null);
      return;
    }
    this.arquivos
      .descartarNovo(salvo.id)
      .then(() => callback(null))
      .catch(() => callback(null));
  }
}

/** `?contexto=` da URL; ausente ou inválido → 400. */
export function contextoDaQuery(requisicao: RequisicaoHttp): ContextoArquivo {
  const valor = requisicao.query?.contexto;
  const contextos = Object.values(ContextoArquivo) as string[];
  if (typeof valor === 'string' && contextos.includes(valor.toUpperCase())) {
    return valor.toUpperCase() as ContextoArquivo;
  }
  throw new DadosInvalidosException('Informe o contexto do arquivo.', {
    campos: [
      {
        campo: 'contexto',
        mensagens: [`deve ser um destes: ${contextos.join(', ')}`],
      },
    ],
  });
}

/**
 * O busboy entrega o nome do arquivo como latin1 quando o navegador manda UTF-8
 * sem `filename*`; desfaz isso quando o resultado é UTF-8 válido.
 */
export function decodificarNome(nome: string): string {
  if (!/[\u0080-ÿ]/.test(nome)) {
    return nome;
  }
  const bytes = Buffer.from(nome, 'latin1');
  const utf8 = bytes.toString('utf8');
  return utf8.includes('�') ? nome : utf8;
}
