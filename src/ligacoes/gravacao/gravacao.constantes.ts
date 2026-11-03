/** Gravação das ligações (R30): filas, limites e tolerâncias. */

/** Fila que junta as partes que o navegador não finalizou (aba fechada, rede caída). */
export const FILA_FINALIZAR_GRAVACAO = 'ligacoes.gravacao.finalizar';
/** Fila diária que apaga as gravações e transcrições vencidas pela guarda do canal. */
export const FILA_REMOVER_GRAVACOES = 'ligacoes.gravacao.remover-vencidas';
/** Remoção diária às 03:30 (fuso de São Paulo). */
export const AGENDA_DA_REMOCAO = '30 3 * * *';

/** Depois de a ligação encerrar, partes e o "finalizar" do navegador ainda são aceitos por este tempo. */
export const TOLERANCIA_APOS_ENCERRAR_S = 120;
/** Se o navegador não finalizar, a API junta o que subiu depois deste tempo do fim da ligação. */
export const ESPERA_PARA_FINALIZAR_SOZINHO_S = 90;

/** Reprodução já auditada: os `Range` seguintes do mesmo player (que não recomeçam do byte 0) não geram outro registro por este tempo. */
export const JANELA_DA_REPRODUCAO_MS = 5 * 60 * 1000;

/** Uma parte de ~5 s em opus tem poucas dezenas de KB: 4 MB é muito acima do razoável. */
export const MAX_BYTES_POR_PARTE = 4 * 1024 * 1024;
/** Maior número de sequência aceito (5 s por parte x 20 000 = mais de 27 h). */
export const MAX_SEQUENCIA_DA_PARTE = 20_000;

/** Guarda da gravação e da transcrição: padrão e limites, em dias. */
export const RETENCAO_PADRAO_DIAS = 365;
export const RETENCAO_MINIMA_DIAS = 1;
export const RETENCAO_MAXIMA_DIAS = 3650;

/** Quantas ligações vencidas a limpeza diária trata por rodada. */
export const LOTE_DA_REMOCAO = 200;

/** Cabeçalho de todo arquivo webm/Matroska (EBML). */
export const ASSINATURA_WEBM = [0x1a, 0x45, 0xdf, 0xa3] as const;

/** Tamanho máximo do áudio de aviso (o limite do contexto LIGACAO na política de arquivos). */
export const MIME_DA_GRAVACAO = 'audio/webm';
