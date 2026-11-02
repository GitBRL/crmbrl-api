/**
 * Configuração e validação dos tipos de passo do chatbot (R18). Os validadores
 * recebem `(config, passo)` do `PassosService` e devolvem a mensagem do
 * primeiro problema (em português, para o editor) ou nulo.
 */
import { validarModelo } from '../comum/modelos/modelos';
import type { Passo } from '../comum/passos/definicao';
import {
  OPCOES_MAXIMAS,
  OPCOES_MINIMAS,
  TAMANHO_MAXIMO_DO_TEXTO,
  TEMPO_MAXIMO_SEM_RESPOSTA_MINUTOS,
  TENTATIVAS_MAXIMAS_DA_PERGUNTA,
} from './chatbot.constantes';
import { condicoesDoRamo, problemaDaCondicao } from './condicoes';
import {
  type OpcaoDePergunta,
  TIPOS_DE_VALIDACAO,
  type TipoDeValidacao,
} from './respostas';

export interface TempoSemResposta {
  /** Manda o lembrete depois deste tempo sem resposta. */
  lembreteAposMinutos?: number;
  lembrete?: string;
  /** Encerra (ramo `sem_resposta` ou fim) depois deste tempo sem resposta. */
  encerrarAposMinutos?: number;
}

export interface ConfigDeMensagem {
  texto?: string;
  /** Mídia (arquivo de contexto `CAMPANHA`). */
  arquivoId?: string;
}

export interface ConfigDePerguntaComOpcoes {
  texto: string;
  opcoes: OpcaoDePergunta[];
  /** Variável que guarda o texto da opção (e `<variavel>_id` guarda o id). */
  variavel?: string;
  tentativas?: number;
  mensagemInvalida?: string;
  tempoSemResposta?: TempoSemResposta;
}

export interface ConfigDePerguntaAberta {
  texto: string;
  variavel: string;
  validacao?: TipoDeValidacao;
  /** Também grava no contato: `nome`, `email`, `telefone`, `cargo` ou `campos.<chave>`. */
  campoContato?: string;
  tentativas?: number;
  mensagemInvalida?: string;
  tempoSemResposta?: TempoSemResposta;
}

export const CAMPOS_DO_CONTATO_GRAVAVEIS = [
  'nome',
  'email',
  'telefone',
  'cargo',
] as const;

const NOME_DE_VARIAVEL = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const CHAVE_DE_CAMPO = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;

export function nomeDeVariavelValido(nome: unknown): nome is string {
  return typeof nome === 'string' && NOME_DE_VARIAVEL.test(nome);
}

export function campoDoContatoValido(campo: unknown): campo is string {
  if (typeof campo !== 'string') {
    return false;
  }
  if ((CAMPOS_DO_CONTATO_GRAVAVEIS as readonly string[]).includes(campo)) {
    return true;
  }
  return (
    campo.startsWith('campos.') &&
    CHAVE_DE_CAMPO.test(campo.slice('campos.'.length))
  );
}

function textoValido(
  texto: unknown,
  rotulo: string,
  obrigatorio = true,
): string | null {
  if (texto === undefined || texto === null || texto === '') {
    return obrigatorio ? `Escreva ${rotulo}.` : null;
  }
  if (typeof texto !== 'string') {
    return `${rotulo[0].toUpperCase()}${rotulo.slice(1)} precisa ser um texto.`;
  }
  if (texto.length > TAMANHO_MAXIMO_DO_TEXTO) {
    return `${rotulo[0].toUpperCase()}${rotulo.slice(1)} passa de ${TAMANHO_MAXIMO_DO_TEXTO} caracteres.`;
  }
  const modelo = validarModelo(texto, { permitirVariaveisDaExecucao: true });
  if (!modelo.valido) {
    return modelo.erros[0]?.mensagem ?? 'O texto tem uma variável inválida.';
  }
  return null;
}

function tempoValido(valor: unknown, rotulo: string): string | null {
  if (valor === undefined || valor === null) {
    return null;
  }
  if (
    typeof valor !== 'number' ||
    !Number.isInteger(valor) ||
    valor < 1 ||
    valor > TEMPO_MAXIMO_SEM_RESPOSTA_MINUTOS
  ) {
    return `${rotulo}: informe minutos de 1 a ${TEMPO_MAXIMO_SEM_RESPOSTA_MINUTOS}.`;
  }
  return null;
}

function problemaDoTempo(tempo: unknown): string | null {
  if (tempo === undefined || tempo === null) {
    return null;
  }
  if (typeof tempo !== 'object') {
    return 'O tempo sem resposta está incompleto.';
  }
  const t = tempo as TempoSemResposta;
  const problema =
    tempoValido(t.lembreteAposMinutos, 'Lembrete') ??
    tempoValido(t.encerrarAposMinutos, 'Encerramento') ??
    textoValido(t.lembrete, 'o texto do lembrete', false);
  if (problema) {
    return problema;
  }
  if (t.lembreteAposMinutos !== undefined && !t.lembrete?.trim()) {
    return 'Escreva o texto do lembrete.';
  }
  if (
    t.lembreteAposMinutos !== undefined &&
    t.encerrarAposMinutos !== undefined &&
    t.encerrarAposMinutos <= t.lembreteAposMinutos
  ) {
    return 'O encerramento precisa vir depois do lembrete.';
  }
  return null;
}

function problemaDasTentativas(valor: unknown): string | null {
  if (valor === undefined || valor === null) {
    return null;
  }
  return typeof valor === 'number' &&
    Number.isInteger(valor) &&
    valor >= 1 &&
    valor <= TENTATIVAS_MAXIMAS_DA_PERGUNTA
    ? null
    : `Tentativas: de 1 a ${TENTATIVAS_MAXIMAS_DA_PERGUNTA}.`;
}

/** Ramos que a pergunta aceita além das opções. */
export const RAMOS_DE_PERGUNTA = ['sem_resposta', 'invalida'] as const;

function problemaDosRamosDaPergunta(
  passo: Passo,
  idsPermitidos: readonly string[],
): string | null {
  for (const ramo of passo.ramos ?? []) {
    if (
      !idsPermitidos.includes(ramo.id) &&
      !(RAMOS_DE_PERGUNTA as readonly string[]).includes(ramo.id)
    ) {
      return `O ramo "${ramo.id}" não corresponde a nenhuma opção.`;
    }
  }
  return null;
}

export function validarMensagem(
  config: Record<string, unknown>,
): string | null {
  const c = config as ConfigDeMensagem;
  if (!c.texto?.toString().trim() && !c.arquivoId) {
    return 'Escreva o texto ou escolha uma mídia.';
  }
  if (c.arquivoId !== undefined && typeof c.arquivoId !== 'string') {
    return 'A mídia está inválida.';
  }
  return textoValido(c.texto, 'o texto', false);
}

export function validarPerguntaComOpcoes(
  config: Record<string, unknown>,
  passo: Passo,
): string | null {
  const c = config as unknown as ConfigDePerguntaComOpcoes;
  const problema = textoValido(c.texto, 'a pergunta');
  if (problema) {
    return problema;
  }
  if (
    !Array.isArray(c.opcoes) ||
    c.opcoes.length < OPCOES_MINIMAS ||
    c.opcoes.length > OPCOES_MAXIMAS
  ) {
    return `Use de ${OPCOES_MINIMAS} a ${OPCOES_MAXIMAS} opções.`;
  }
  const ids = new Set<string>();
  const rotulos = new Set<string>();
  for (const opcao of c.opcoes) {
    if (
      typeof opcao?.id !== 'string' ||
      opcao.id === '' ||
      typeof opcao.rotulo !== 'string' ||
      opcao.rotulo.trim() === ''
    ) {
      return 'Toda opção precisa de um texto.';
    }
    if (opcao.rotulo.length > 100) {
      return 'O texto da opção passa de 100 caracteres.';
    }
    const rotulo = opcao.rotulo.trim().toLowerCase();
    if (ids.has(opcao.id) || rotulos.has(rotulo)) {
      return 'As opções precisam ser diferentes entre si.';
    }
    ids.add(opcao.id);
    rotulos.add(rotulo);
  }
  if (c.variavel !== undefined && !nomeDeVariavelValido(c.variavel)) {
    return 'O nome da variável usa letras, números e _ (começa com letra).';
  }
  return (
    problemaDasTentativas(c.tentativas) ??
    textoValido(c.mensagemInvalida, 'a mensagem de resposta inválida', false) ??
    problemaDoTempo(c.tempoSemResposta) ??
    problemaDosRamosDaPergunta(passo, [...ids])
  );
}

export function validarPerguntaAberta(
  config: Record<string, unknown>,
  passo: Passo,
): string | null {
  const c = config as unknown as ConfigDePerguntaAberta;
  const problema = textoValido(c.texto, 'a pergunta');
  if (problema) {
    return problema;
  }
  if (!nomeDeVariavelValido(c.variavel)) {
    return 'Informe o nome da variável que guarda a resposta (letras, números e _).';
  }
  if (c.validacao !== undefined && !TIPOS_DE_VALIDACAO.includes(c.validacao)) {
    return 'Escolha uma validação: texto, e-mail, telefone, número ou data.';
  }
  if (c.campoContato !== undefined && !campoDoContatoValido(c.campoContato)) {
    return 'O campo do contato é inválido (nome, email, telefone, cargo ou campos.<chave>).';
  }
  return (
    problemaDasTentativas(c.tentativas) ??
    textoValido(c.mensagemInvalida, 'a mensagem de resposta inválida', false) ??
    problemaDoTempo(c.tempoSemResposta) ??
    problemaDosRamosDaPergunta(passo, [])
  );
}

export function validarCondicao(
  _config: Record<string, unknown>,
  passo: Passo,
): string | null {
  const ramos = passo.ramos ?? [];
  if (ramos.length === 0) {
    return 'Adicione ao menos um ramo.';
  }
  for (const ramo of ramos) {
    for (const condicao of condicoesDoRamo(ramo.config)) {
      const problema = problemaDaCondicao(condicao);
      if (problema) {
        return `Ramo "${ramo.rotulo ?? ramo.id}": ${problema}`;
      }
    }
  }
  return null;
}

export function validarEtiquetar(
  config: Record<string, unknown>,
): string | null {
  const lista = (valor: unknown) =>
    Array.isArray(valor) &&
    valor.every((e) => typeof e === 'string' && e.trim());
  const adicionar = config.adicionar ?? config.etiquetas;
  const remover = config.remover;
  if (adicionar !== undefined && !lista(adicionar)) {
    return 'As etiquetas a adicionar estão inválidas.';
  }
  if (remover !== undefined && !lista(remover)) {
    return 'As etiquetas a remover estão inválidas.';
  }
  const total =
    ((adicionar as unknown[] | undefined)?.length ?? 0) +
    ((remover as unknown[] | undefined)?.length ?? 0);
  return total > 0 ? null : 'Informe ao menos uma etiqueta.';
}

export function validarDefinirCampo(
  config: Record<string, unknown>,
): string | null {
  if (!campoDoContatoValido(config.campo)) {
    return 'Escolha o campo do contato (nome, email, telefone, cargo ou campos.<chave>).';
  }
  if (typeof config.valor !== 'string' || config.valor.trim() === '') {
    return 'Informe o valor do campo.';
  }
  return textoValido(config.valor, 'o valor');
}

export function validarMoverFila(
  config: Record<string, unknown>,
): string | null {
  return typeof config.filaId === 'string' && config.filaId
    ? null
    : 'Escolha a fila.';
}

export function validarAtribuir(
  config: Record<string, unknown>,
): string | null {
  return typeof config.usuarioId === 'string' && config.usuarioId
    ? null
    : 'Escolha a pessoa.';
}

export function validarCriarNegocio(
  config: Record<string, unknown>,
): string | null {
  if (typeof config.funilId !== 'string' || !config.funilId) {
    return 'Escolha o funil.';
  }
  if (config.etapaId !== undefined && typeof config.etapaId !== 'string') {
    return 'A etapa está inválida.';
  }
  return textoValido(config.titulo, 'o título', false);
}

export function validarCriarAtividade(
  config: Record<string, unknown>,
): string | null {
  const tipos = ['TAREFA', 'LIGACAO', 'REUNIAO', 'EMAIL', 'WHATSAPP'];
  if (config.tipo !== undefined && !tipos.includes(config.tipo as string)) {
    return 'Escolha o tipo da atividade.';
  }
  if (typeof config.titulo !== 'string' || config.titulo.trim() === '') {
    return 'Informe o título da atividade.';
  }
  if (
    config.prazoHoras !== undefined &&
    (typeof config.prazoHoras !== 'number' ||
      config.prazoHoras < 0 ||
      config.prazoHoras > 24 * 365)
  ) {
    return 'O prazo da atividade (em horas) está inválido.';
  }
  return textoValido(config.titulo, 'o título');
}

export function validarWebhook(config: Record<string, unknown>): string | null {
  if (typeof config.url !== 'string' || !URL.canParse(config.url)) {
    return 'Informe a URL do webhook.';
  }
  const url = new URL(config.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Use uma URL http:// ou https://.';
  }
  if (url.username || url.password) {
    return 'Não coloque usuário e senha na URL; use os cabeçalhos.';
  }
  if (
    config.cabecalhos !== undefined &&
    (typeof config.cabecalhos !== 'object' || config.cabecalhos === null)
  ) {
    return 'Os cabeçalhos estão inválidos.';
  }
  return null;
}

export function validarTransferir(
  config: Record<string, unknown>,
): string | null {
  if (config.filaId !== undefined && typeof config.filaId !== 'string') {
    return 'A fila está inválida.';
  }
  if (config.usuarioId !== undefined && typeof config.usuarioId !== 'string') {
    return 'A pessoa está inválida.';
  }
  return textoValido(config.mensagem, 'a mensagem de transferência', false);
}
