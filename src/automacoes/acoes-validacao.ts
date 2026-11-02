/**
 * Validação (ao salvar a automação) da configuração de cada tipo de passo.
 * Funções puras: devolvem a mensagem do problema, ou nulo.
 */
import { validarModelo } from '../comum/modelos/modelos';
import type { Passo, ValidadorDeConfig } from '../comum/passos/definicao';
import { problemasDoSegmento } from '../comum/segmentos/segmentos';
import { TIPOS_DE_PASSO_DE_AUTOMACAO as T } from './automacoes.constantes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TIPOS_DE_ATIVIDADE_DA_ACAO = [
  'TAREFA',
  'LIGACAO',
  'EMAIL',
  'WHATSAPP',
] as const;
export const UNIDADES_DE_PRAZO = ['minutos', 'horas', 'dias'] as const;
const PRIORIDADES = ['BAIXA', 'MEDIA', 'ALTA'];
const ESTRATEGIAS = ['RESPONSAVEL_FIXO', 'RODIZIO', 'LIDER_DA_AREA'];
const AREAS = ['MARKETING', 'COMERCIAL', 'CS'];

type Config = Record<string, unknown>;

const ehUuid = (v: unknown): boolean => typeof v === 'string' && UUID.test(v);
const ehTexto = (v: unknown, max = 5_000): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max;

function textoDoModelo(texto: string, rotulo: string): string | null {
  const validacao = validarModelo(texto, { permitirVariaveisDaExecucao: true });
  return validacao.valido
    ? null
    : `${rotulo}: ${validacao.erros[0]?.mensagem ?? 'modelo inválido'}`;
}

function mensagem(canal: 'WHATSAPP' | 'EMAIL'): ValidadorDeConfig {
  return (c: Config) => {
    if (
      c.modeloId !== undefined &&
      c.modeloId !== null &&
      !ehUuid(c.modeloId)
    ) {
      return 'Escolha um modelo de mensagem válido.';
    }
    if (c.canalId !== undefined && c.canalId !== null && !ehUuid(c.canalId)) {
      return 'Escolha um canal válido.';
    }
    const temModelo = ehUuid(c.modeloId);
    if (!temModelo && !ehTexto(c.texto, 4_096)) {
      return 'Escolha um modelo ou escreva a mensagem.';
    }
    if (c.texto !== undefined && c.texto !== null && !temModelo) {
      const problema = textoDoModelo(c.texto as string, 'Mensagem');
      if (problema) {
        return problema;
      }
    }
    if (canal === 'EMAIL') {
      if (!temModelo && !ehTexto(c.assunto, 300)) {
        return 'Informe o assunto do e-mail.';
      }
      if (typeof c.assunto === 'string') {
        return textoDoModelo(c.assunto, 'Assunto');
      }
    }
    return null;
  };
}

function prazoInvalido(prazo: unknown): string | null {
  if (prazo === undefined || prazo === null) {
    return null;
  }
  const p = prazo as Config;
  if (
    typeof p !== 'object' ||
    !Number.isInteger(p.quantidade) ||
    (p.quantidade as number) < 0 ||
    (p.quantidade as number) > 3_650 ||
    !(UNIDADES_DE_PRAZO as readonly unknown[]).includes(p.unidade)
  ) {
    return 'Informe o prazo (quantidade e unidade).';
  }
  return null;
}

export const VALIDADORES_DE_ACAO: Readonly<Record<string, ValidadorDeConfig>> =
  {
    [T.WHATSAPP]: mensagem('WHATSAPP'),
    [T.EMAIL]: mensagem('EMAIL'),
    [T.ATIVIDADE]: (c: Config) => {
      if (
        !(TIPOS_DE_ATIVIDADE_DA_ACAO as readonly unknown[]).includes(c.tipo)
      ) {
        return 'Escolha o tipo da atividade (tarefa, ligação, e-mail ou WhatsApp).';
      }
      if (!ehTexto(c.titulo, 200)) {
        return 'Informe o título da atividade.';
      }
      if (
        c.prioridade !== undefined &&
        !PRIORIDADES.includes(c.prioridade as string)
      ) {
        return 'Prioridade inválida.';
      }
      if (
        c.responsavelId !== undefined &&
        c.responsavelId !== null &&
        !ehUuid(c.responsavelId)
      ) {
        return 'Escolha um responsável válido.';
      }
      return (
        prazoInvalido(c.prazo) ?? textoDoModelo(String(c.titulo), 'Título')
      );
    },
    [T.MOVER_ETAPA]: (c: Config) =>
      ehUuid(c.etapaId) ? null : 'Escolha a etapa de destino.',
    [T.ATRIBUIR]: (c: Config) => {
      if (!ESTRATEGIAS.includes(c.estrategia as string)) {
        return 'Escolha como atribuir (pessoa fixa, rodízio ou líder da área).';
      }
      if (c.estrategia === 'RESPONSAVEL_FIXO' && !ehUuid(c.responsavelId)) {
        return 'Escolha a pessoa responsável.';
      }
      if (
        c.area !== undefined &&
        c.area !== null &&
        !AREAS.includes(c.area as string)
      ) {
        return 'Área inválida.';
      }
      return null;
    },
    [T.ETIQUETAR]: (c: Config) => {
      const lista = (v: unknown) =>
        Array.isArray(v) &&
        v.every((i) => typeof i === 'string' && i.trim() !== '');
      if (c.adicionar !== undefined && !lista(c.adicionar)) {
        return 'As etiquetas a adicionar devem ser uma lista de textos.';
      }
      if (c.remover !== undefined && !lista(c.remover)) {
        return 'As etiquetas a remover devem ser uma lista de textos.';
      }
      const total =
        ((c.adicionar as unknown[] | undefined)?.length ?? 0) +
        ((c.remover as unknown[] | undefined)?.length ?? 0);
      return total > 0 ? null : 'Informe ao menos uma etiqueta.';
    },
    [T.CRIAR_NEGOCIO]: (c: Config) => {
      if (!ehUuid(c.funilId)) {
        return 'Escolha o funil do novo negócio.';
      }
      if (c.etapaId !== undefined && c.etapaId !== null && !ehUuid(c.etapaId)) {
        return 'Escolha uma etapa válida.';
      }
      if (
        c.estrategia !== undefined &&
        !ESTRATEGIAS.includes(c.estrategia as string)
      ) {
        return 'Estratégia de atribuição inválida.';
      }
      if (
        c.valor !== undefined &&
        c.valor !== null &&
        !/^\d{1,13}(\.\d{1,2})?$/.test(`${c.valor as string | number}`)
      ) {
        return 'O valor deve ser um número, como 1500.00.';
      }
      return null;
    },
    [T.NOTIFICAR]: (c: Config) => {
      if (!['responsavel', 'usuarios', 'lider'].includes(c.para as string)) {
        return 'Escolha quem notificar.';
      }
      if (
        c.para === 'usuarios' &&
        !(
          Array.isArray(c.usuarioIds) &&
          c.usuarioIds.length > 0 &&
          c.usuarioIds.every(ehUuid)
        )
      ) {
        return 'Escolha as pessoas a notificar.';
      }
      if (!ehTexto(c.titulo, 200)) {
        return 'Informe o título da notificação.';
      }
      return textoDoModelo(String(c.titulo), 'Título');
    },
    [T.WEBHOOK]: (c: Config) =>
      ehUuid(c.webhookId) ? null : 'Escolha o webhook de saída.',
    [T.CHATBOT]: (c: Config) =>
      ehUuid(c.fluxoId) ? null : 'Escolha o fluxo do chatbot.',
    [T.CONDICAO]: (c: Config, passo: Passo) => {
      if (c.segmento === undefined || c.segmento === null) {
        return 'Informe a condição (o público).';
      }
      const problemas = problemasDoSegmento(c.segmento);
      if (problemas.length > 0) {
        return `Condição: ${problemas[0].mensagem}`;
      }
      const ramos = passo.ramos ?? [];
      return ramos.every((r) => r.id === 'sim' || r.id === 'nao')
        ? null
        : 'Os ramos da condição são "sim" e "nao".';
    },
  };

/** Tipos de passo que mandam algo ao contato ou mudam o cadastro: honram opt-out e horário. */
export const TIPOS_QUE_AGEM_NO_CONTATO: readonly string[] = [
  T.WHATSAPP,
  T.EMAIL,
];
