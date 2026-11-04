import { randomUUID } from 'node:crypto';
import { ArquivosService } from '../../src/arquivos/arquivos.service';
import { CriptografiaService } from '../../src/comum/criptografia/criptografia.service';
import { normalizarEmail } from '../../src/comum/dominio/email';
import { liderDaArea, membroDaArea } from '../../src/comum/dominio/papeis';
import { normalizarTelefone } from '../../src/comum/dominio/telefone';
import {
  type Area,
  type Arquivo,
  type Atividade,
  type Canal,
  type ChatCanal,
  type ChatMensagem,
  type Contato,
  type ContatoIdentificador,
  type ContextoArquivo,
  type Conversa,
  type DirecaoMensagem,
  type Empresa,
  type EstrategiaFila,
  type Etapa,
  type FilaAtendimento,
  type Funil,
  type Mensagem,
  type Negocio,
  type OrigemContato,
  type Papel,
  Prisma,
  type PrioridadeAtividade,
  type PrioridadeConversa,
  type RespostaRapida,
  type StatusAtividade,
  type StatusConversa,
  type StatusMensagem,
  type StatusWhatsapp,
  type TipoAtividade,
  type TipoCanal,
  type TipoChatCanal,
  type TipoIdentificador,
  type TipoMensagem,
  type Usuario,
  type WebchatVisitante,
  type WhatsappNumero,
} from '../../src/generated/prisma/client';
import type { AppTeste } from './app-teste';

/**
 * Fábricas de dados para os testes. Gravam direto no banco (sem auditoria, sem
 * eventos, sem validar hierarquia), já normalizadas como a API gravaria. Para
 * testar a regra, chame o endpoint; para montar o cenário, use a fábrica.
 */

/** Senha de todo usuário criado pelas fábricas (salvo `senha`). */
export const SENHA_DE_TESTE = 'Senha@Teste123';

let sequencia = 0;
function proximo(): string {
  sequencia += 1;
  return `${sequencia}-${randomUUID().slice(0, 8)}`;
}

/** O hash scrypt é lento (≈ 0,2 s): o da senha padrão é calculado uma vez por arquivo. */
let hashDaSenhaPadrao: Promise<string> | undefined;
function hashDe(t: AppTeste, senha: string): Promise<string> {
  const cripto = t.get(CriptografiaService);
  if (senha === SENHA_DE_TESTE) {
    hashDaSenhaPadrao ??= cripto.hashSenha(SENHA_DE_TESTE);
    return hashDaSenhaPadrao;
  }
  return cripto.hashSenha(senha);
}

function idDe(
  valor: { id: string } | string | null | undefined,
): string | null | undefined {
  return typeof valor === 'object' && valor !== null ? valor.id : valor;
}

export interface DadosDeUsuario {
  papel?: Papel;
  nome?: string;
  email?: string;
  /** `null` = usuário sem senha (convidado). Padrão: `SENHA_DE_TESTE`. */
  senha?: string | null;
  lider?: Usuario | string | null;
  ativo?: boolean;
  deveTrocarSenha?: boolean;
  telefone?: string | null;
}

/** Cria um usuário (padrão: Admin ativo com `SENHA_DE_TESTE`). Não valida a hierarquia. */
/**
 * Horário de criação estritamente crescente entre os usuários criados pelos testes. O rodízio
 * (R5) ordena por `criadoEm` (timestamptz(3)) e, no empate, pelo id aleatório: dois usuários
 * criados no mesmo milissegundo, comum numa CI rápida, inverteriam a ordem de criação que os
 * testes supõem ("o primeiro membro recebe o primeiro negócio").
 */
let ultimoCriadoEm = 0;
function proximoCriadoEm(): Date {
  ultimoCriadoEm = Math.max(Date.now(), ultimoCriadoEm + 1);
  return new Date(ultimoCriadoEm);
}

export async function criarUsuario(
  t: AppTeste,
  dados: DadosDeUsuario = {},
): Promise<Usuario> {
  const id = proximo();
  const papel = dados.papel ?? 'ADMIN';
  const senha = dados.senha === undefined ? SENHA_DE_TESTE : dados.senha;
  return t.prisma.usuario.create({
    data: {
      nome: dados.nome ?? `${papel} ${id}`,
      email: normalizarEmail(dados.email ?? `usuario-${id}@teste.local`),
      papel,
      liderId: idDe(dados.lider) ?? null,
      ativo: dados.ativo ?? true,
      desligadoEm: dados.ativo === false ? new Date() : null,
      senhaHash: senha === null ? null : await hashDe(t, senha),
      deveTrocarSenha: dados.deveTrocarSenha ?? false,
      telefone: dados.telefone ?? null,
      criadoEm: proximoCriadoEm(),
    },
  });
}

export interface Equipe {
  cLevel: Usuario;
  lider: Usuario;
  membros: Usuario[];
}

/** Uma equipe com hierarquia válida (R1.2): C-level → líder da área → membros. */
export async function criarEquipe(
  t: AppTeste,
  area: Area = 'COMERCIAL',
  opcoes: { membros?: number; cLevel?: Usuario } = {},
): Promise<Equipe> {
  const cLevel = opcoes.cLevel ?? (await criarUsuario(t, { papel: 'C_LEVEL' }));
  const lider = await criarUsuario(t, {
    papel: liderDaArea(area),
    lider: cLevel,
  });
  const membros: Usuario[] = [];
  for (let indice = 0; indice < (opcoes.membros ?? 2); indice++) {
    membros.push(await criarUsuario(t, { papel: membroDaArea(area), lider }));
  }
  return { cLevel, lider, membros };
}

export interface DadosDeEmpresa {
  nome?: string;
  cnpj?: string | null;
  responsavel?: Usuario | string | null;
  etiquetas?: string[];
}

export function criarEmpresa(
  t: AppTeste,
  dados: DadosDeEmpresa = {},
): Promise<Empresa> {
  return t.prisma.empresa.create({
    data: {
      nome: dados.nome ?? `Empresa ${proximo()}`,
      cnpj: dados.cnpj ?? null,
      responsavelId: idDe(dados.responsavel) ?? null,
      etiquetas: dados.etiquetas ?? [],
    },
  });
}

export interface DadosDeContato {
  nome?: string;
  /** Padrão: um e-mail único. `null` = sem e-mail (aí informe o telefone). */
  email?: string | null;
  telefone?: string | null;
  responsavel?: Usuario | string | null;
  empresa?: Empresa | string | null;
  origem?: OrigemContato;
  etiquetas?: string[];
}

/** Cria um contato com e-mail único (salvo `email`); telefone normalizado para E.164. */
export function criarContato(
  t: AppTeste,
  dados: DadosDeContato = {},
): Promise<Contato> {
  const id = proximo();
  const email =
    dados.email === undefined ? `contato-${id}@teste.local` : dados.email;
  let telefone: string | null = null;
  if (dados.telefone) {
    const normalizado = normalizarTelefone(dados.telefone);
    if (!normalizado.valido) {
      throw new Error(`Telefone de teste inválido: ${normalizado.motivo}`);
    }
    telefone = normalizado.telefone;
  }
  const origem = dados.origem ?? 'MANUAL';
  return t.prisma.contato.create({
    data: {
      nome: dados.nome ?? `Contato ${id}`,
      email: email === null ? null : normalizarEmail(email),
      telefone,
      responsavelId: idDe(dados.responsavel) ?? null,
      empresaId: idDe(dados.empresa) ?? null,
      primeiraOrigem: origem,
      ultimaOrigem: origem,
      etiquetas: dados.etiquetas ?? [],
    },
  });
}

export type FunilComEtapas = Funil & { etapas: Etapa[] };

/** O funil-base da área, com as etapas em ordem. */
export async function funilBase(
  t: AppTeste,
  area: Area,
): Promise<FunilComEtapas> {
  return t.prisma.funil.findFirstOrThrow({
    where: { area, base: true },
    include: { etapas: { orderBy: { ordem: 'asc' } } },
  });
}

/** Uma etapa do funil-base pela `chave` (ex.: `('MARKETING', 'qualificado_mql')`). */
export async function etapaDoFunilBase(
  t: AppTeste,
  area: Area,
  chave: string,
): Promise<Etapa> {
  const funil = await funilBase(t, area);
  const etapa = funil.etapas.find((candidata) => candidata.chave === chave);
  if (!etapa) {
    throw new Error(`Etapa "${chave}" não existe no funil-base de ${area}.`);
  }
  return etapa;
}

export interface DadosDeNegocio {
  contato?: Contato | string;
  empresa?: Empresa | string | null;
  /** Área do funil-base (padrão `COMERCIAL`). */
  area?: Area;
  /** `chave` da etapa no funil-base (padrão: a primeira etapa aberta). */
  etapa?: string;
  responsavel?: Usuario | string | null;
  titulo?: string;
  /** Texto decimal, ex.: `'1500.00'`. */
  valor?: string;
  valorRecorrente?: string | null;
  origem?: OrigemContato;
  negocioOrigem?: Negocio | string | null;
}

/**
 * Cria um negócio num funil-base, com `status` derivado da etapa, data de
 * ganho/perda quando for o caso e a movimentação de entrada no funil.
 */
export async function criarNegocio(
  t: AppTeste,
  dados: DadosDeNegocio = {},
): Promise<Negocio> {
  const funil = await funilBase(t, dados.area ?? 'COMERCIAL');
  const etapa = dados.etapa
    ? funil.etapas.find((candidata) => candidata.chave === dados.etapa)
    : funil.etapas.find((candidata) => candidata.tipo === 'ABERTA');
  if (!etapa) {
    throw new Error(
      `Etapa "${dados.etapa ?? 'aberta'}" não existe no funil ${funil.nome}.`,
    );
  }
  const contatoId = idDe(dados.contato) ?? (await criarContato(t)).id;
  const agora = new Date();
  const status =
    etapa.tipo === 'ABERTA'
      ? 'ABERTO'
      : etapa.tipo === 'GANHO'
        ? 'GANHO'
        : 'PERDIDO';
  return t.prisma.negocio.create({
    data: {
      titulo: dados.titulo ?? `Negócio ${proximo()}`,
      contatoId,
      empresaId: idDe(dados.empresa) ?? null,
      funilId: funil.id,
      etapaId: etapa.id,
      responsavelId: idDe(dados.responsavel) ?? null,
      status,
      valor: new Prisma.Decimal(dados.valor ?? '0'),
      valorRecorrente:
        dados.valorRecorrente === undefined || dados.valorRecorrente === null
          ? null
          : new Prisma.Decimal(dados.valorRecorrente),
      ganhoEm: status === 'GANHO' ? agora : null,
      perdidoEm: status === 'PERDIDO' ? agora : null,
      motivoPerda:
        status === 'PERDIDO' ? 'Criado perdido pela fábrica de teste' : null,
      etapaDesde: agora,
      origem: dados.origem ?? 'MANUAL',
      negocioOrigemId: idDe(dados.negocioOrigem) ?? null,
      movimentacoes: {
        create: {
          funilId: funil.id,
          paraEtapaId: etapa.id,
          tipoAtor: 'SISTEMA',
          criadoEm: agora,
        },
      },
    },
  });
}

export interface DadosDeAtividade {
  responsavel: Usuario | string;
  tipo?: TipoAtividade;
  titulo?: string;
  status?: StatusAtividade;
  prioridade?: PrioridadeAtividade;
  venceEm?: Date | null;
  inicioEm?: Date | null;
  fimEm?: Date | null;
  criadoPor?: Usuario | string | null;
  contato?: Contato | string | null;
  empresa?: Empresa | string | null;
  negocio?: Negocio | string | null;
}

/**
 * Cria uma atividade como a API gravaria: nota já concluída (R6.2) e, na
 * reunião, `venceEm` = início quando não informado (é o que ordena a agenda e
 * dispara o lembrete, R6.5).
 */
export function criarAtividade(
  t: AppTeste,
  dados: DadosDeAtividade,
): Promise<Atividade> {
  const status =
    dados.status ?? (dados.tipo === 'NOTA' ? 'CONCLUIDA' : 'PENDENTE');
  const responsavelId = idDe(dados.responsavel) as string;
  const venceEm =
    dados.venceEm !== undefined
      ? dados.venceEm
      : dados.tipo === 'REUNIAO'
        ? (dados.inicioEm ?? null)
        : null;
  return t.prisma.atividade.create({
    data: {
      tipo: dados.tipo ?? 'TAREFA',
      titulo: dados.titulo ?? `Atividade ${proximo()}`,
      status,
      prioridade: dados.prioridade ?? 'MEDIA',
      venceEm,
      inicioEm: dados.inicioEm ?? null,
      fimEm: dados.fimEm ?? null,
      responsavelId,
      criadoPorId: idDe(dados.criadoPor) ?? responsavelId,
      concluidaEm: status === 'CONCLUIDA' ? new Date() : null,
      concluidaPorId: status === 'CONCLUIDA' ? responsavelId : null,
      canceladaEm: status === 'CANCELADA' ? new Date() : null,
      contatoId: idDe(dados.contato) ?? null,
      empresaId: idDe(dados.empresa) ?? null,
      negocioId: idDe(dados.negocio) ?? null,
    },
  });
}

// ===========================================================================
// Onda A — arquivos, atendimento, WhatsApp, chat do site e chat interno.
// Mesma ideia: gravam direto (sem auditoria nem eventos), já normalizados.
// ===========================================================================

/** PNG de 1×1 pixel (passa na conferência de assinatura do tipo). */
export const PNG_DE_TESTE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Início de um PDF válido o bastante para a conferência de assinatura. */
export const PDF_DE_TESTE = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);

export interface DadosDeArquivo {
  /** Padrão `MENSAGEM`. */
  contexto?: ContextoArquivo;
  /** Padrão `teste.txt` (ou `imagem.png` com `mime: 'image/png'`). */
  nome?: string;
  /** Padrão `text/plain`. */
  mime?: string;
  /** Padrão: um texto curto (ou `PNG_DE_TESTE` para `image/png`). */
  conteudo?: Buffer | string;
  criadoPor?: Usuario | string | null;
}

/**
 * Guarda um arquivo de verdade pelo `ArquivosService` (no driver em memória
 * dos testes): o registro e o conteúdo, prontos para o download.
 */
export function criarArquivo(
  t: AppTeste,
  dados: DadosDeArquivo = {},
): Promise<Arquivo> {
  const mime = dados.mime ?? 'text/plain';
  const conteudo =
    dados.conteudo === undefined
      ? mime === 'image/png'
        ? PNG_DE_TESTE
        : mime === 'application/pdf'
          ? PDF_DE_TESTE
          : Buffer.from(`conteúdo de teste ${proximo()}`)
      : typeof dados.conteudo === 'string'
        ? Buffer.from(dados.conteudo)
        : dados.conteudo;
  return t.get(ArquivosService).salvar(conteudo, {
    nome:
      dados.nome ??
      (mime === 'image/png'
        ? 'imagem.png'
        : mime === 'application/pdf'
          ? 'documento.pdf'
          : 'teste.txt'),
    mime,
    contexto: dados.contexto ?? 'MENSAGEM',
    criadoPorId: idDe(dados.criadoPor) ?? null,
  });
}

export interface DadosDeFila {
  nome?: string;
  /** Padrão `COMERCIAL`. */
  area?: Area;
  chave?: string | null;
  estrategia?: EstrategiaFila;
  slaPrimeiraRespostaMinutos?: number | null;
  slaResolucaoMinutos?: number | null;
  ativa?: boolean;
  /** Participantes explícitos (`participa = true`). Sem eles, vale a área inteira. */
  participantes?: Array<Usuario | string>;
}

export function criarFila(
  t: AppTeste,
  dados: DadosDeFila = {},
): Promise<FilaAtendimento> {
  return t.prisma.filaAtendimento.create({
    data: {
      nome: dados.nome ?? `Fila ${proximo()}`,
      area: dados.area ?? 'COMERCIAL',
      chave: dados.chave ?? null,
      estrategia: dados.estrategia ?? 'RODIZIO',
      slaPrimeiraRespostaMinutos: dados.slaPrimeiraRespostaMinutos ?? null,
      slaResolucaoMinutos: dados.slaResolucaoMinutos ?? null,
      ativa: dados.ativa ?? true,
      participantes: dados.participantes?.length
        ? {
            create: dados.participantes.map((usuario) => ({
              usuarioId: idDe(usuario) as string,
            })),
          }
        : undefined,
    },
  });
}

export interface DadosDeCanal {
  /** Padrão `WEBCHAT`. */
  tipo?: TipoCanal;
  nome?: string;
  ativo?: boolean;
  idExterno?: string | null;
  configuracao?: Prisma.InputJsonObject;
  /** Gravados cifrados em `segredosCifrados` (como a API faz). */
  segredos?: Record<string, unknown> | null;
  filaPadrao?: FilaAtendimento | string | null;
  horarioAtendimento?: Prisma.InputJsonObject | null;
  mensagemForaHorario?: string | null;
  pesquisaSatisfacao?: boolean;
  criadoPor?: Usuario | string | null;
}

export function criarCanal(
  t: AppTeste,
  dados: DadosDeCanal = {},
): Promise<Canal> {
  const tipo = dados.tipo ?? 'WEBCHAT';
  return t.prisma.canal.create({
    data: {
      tipo,
      nome: dados.nome ?? `Canal ${tipo} ${proximo()}`,
      ativo: dados.ativo ?? true,
      idExterno: dados.idExterno ?? null,
      configuracao: dados.configuracao ?? {},
      segredosCifrados: dados.segredos
        ? t.get(CriptografiaService).cifrar(JSON.stringify(dados.segredos))
        : null,
      filaPadraoId: idDe(dados.filaPadrao) ?? null,
      horarioAtendimento: dados.horarioAtendimento ?? undefined,
      mensagemForaHorario: dados.mensagemForaHorario ?? null,
      pesquisaSatisfacao: dados.pesquisaSatisfacao ?? false,
      criadoPorId: idDe(dados.criadoPor) ?? null,
    },
  });
}

export interface DadosDeNumeroWhatsapp extends Omit<DadosDeCanal, 'tipo'> {
  status?: StatusWhatsapp;
  /** Telefone conectado (E.164 só com dígitos). */
  telefone?: string | null;
  limiteDiario?: number;
  pausadoEm?: Date | null;
}

/** Um canal `WHATSAPP` com o seu número (padrão: `DESCONECTADO`, sem telefone). */
export async function criarCanalWhatsapp(
  t: AppTeste,
  dados: DadosDeNumeroWhatsapp = {},
): Promise<{ canal: Canal; numero: WhatsappNumero }> {
  const canal = await criarCanal(t, { ...dados, tipo: 'WHATSAPP' });
  const numero = await t.prisma.whatsappNumero.create({
    data: {
      canalId: canal.id,
      nome: canal.nome,
      status: dados.status ?? 'DESCONECTADO',
      telefone: dados.telefone ?? null,
      limiteDiario: dados.limiteDiario ?? 1000,
      pausadoEm: dados.pausadoEm ?? null,
      conectadoEm: dados.status === 'CONECTADO' ? new Date() : null,
    },
  });
  return { canal, numero };
}

export interface DadosDeIdentificador {
  contato: Contato | string;
  tipo: TipoIdentificador;
  /** Já normalizado (telefone E.164 só com dígitos, e-mail em minúsculas). */
  valor: string;
  canal?: Canal | string | null;
  nomeExibicao?: string | null;
}

export function criarIdentificador(
  t: AppTeste,
  dados: DadosDeIdentificador,
): Promise<ContatoIdentificador> {
  return t.prisma.contatoIdentificador.create({
    data: {
      contatoId: idDe(dados.contato) as string,
      tipo: dados.tipo,
      valor: dados.valor,
      canalId: idDe(dados.canal) ?? null,
      nomeExibicao: dados.nomeExibicao ?? null,
    },
  });
}

export interface DadosDeConversa {
  /** Padrão: um canal `WEBCHAT` novo. */
  canal?: Canal | string;
  /** Padrão: um contato novo. */
  contato?: Contato | string;
  fila?: FilaAtendimento | string | null;
  responsavel?: Usuario | string | null;
  status?: StatusConversa;
  prioridade?: PrioridadeConversa;
  assunto?: string | null;
  idExterno?: string | null;
  etiquetas?: string[];
  naoLidas?: number;
  ultimaEntradaEm?: Date | null;
  janelaAte?: Date | null;
  negocio?: Negocio | string | null;
}

/** Cria uma conversa (com canal e contato novos, se não informados). */
export async function criarConversa(
  t: AppTeste,
  dados: DadosDeConversa = {},
): Promise<Conversa> {
  const canalId = idDe(dados.canal) ?? (await criarCanal(t)).id;
  const contatoId = idDe(dados.contato) ?? (await criarContato(t)).id;
  const status = dados.status ?? 'ABERTA';
  const responsavelId = idDe(dados.responsavel) ?? null;
  return t.prisma.conversa.create({
    data: {
      canalId,
      contatoId,
      filaId: idDe(dados.fila) ?? null,
      responsavelId,
      atribuidaEm: responsavelId ? new Date() : null,
      status,
      prioridade: dados.prioridade ?? 'NORMAL',
      assunto: dados.assunto ?? null,
      idExterno: dados.idExterno ?? null,
      etiquetas: dados.etiquetas ?? [],
      naoLidas: dados.naoLidas ?? 0,
      ultimaEntradaEm: dados.ultimaEntradaEm ?? null,
      janelaAte: dados.janelaAte ?? null,
      negocioId: idDe(dados.negocio) ?? null,
      resolvidaEm: status === 'RESOLVIDA' ? new Date() : null,
    },
  });
}

export interface DadosDeMensagem {
  conversa: Conversa | string;
  /** Padrão `ENTRADA`. */
  direcao?: DirecaoMensagem;
  tipo?: TipoMensagem;
  texto?: string | null;
  arquivo?: Arquivo | string | null;
  /** Autor (saída e nota interna). */
  autor?: Usuario | string | null;
  /** Só na saída; padrão `PENDENTE` na saída. */
  status?: StatusMensagem | null;
  erro?: string | null;
  idExterno?: string | null;
  respostaA?: Mensagem | string | null;
  ocorridaEm?: Date;
}

/**
 * Grava uma mensagem e atualiza o resumo da conversa (última mensagem; na
 * entrada, também `ultimaEntradaEm`, `aguardandoDesde` e `naoLidas`).
 */
export async function criarMensagem(
  t: AppTeste,
  dados: DadosDeMensagem,
): Promise<Mensagem> {
  const conversaId = idDe(dados.conversa) as string;
  const conversa = await t.prisma.conversa.findUniqueOrThrow({
    where: { id: conversaId },
  });
  const direcao = dados.direcao ?? 'ENTRADA';
  const ocorridaEm = dados.ocorridaEm ?? new Date();
  const autorId = idDe(dados.autor) ?? null;
  const mensagem = await t.prisma.mensagem.create({
    data: {
      conversaId,
      canalId: conversa.canalId,
      direcao,
      tipo: dados.tipo ?? 'TEXTO',
      texto: dados.texto === undefined ? `Mensagem ${proximo()}` : dados.texto,
      arquivoId: idDe(dados.arquivo) ?? null,
      autorId,
      autorTipo: direcao === 'ENTRADA' ? null : autorId ? 'USUARIO' : 'SISTEMA',
      status:
        direcao === 'SAIDA'
          ? dados.status === undefined
            ? 'PENDENTE'
            : dados.status
          : null,
      erro: dados.erro ?? null,
      idExterno: dados.idExterno ?? null,
      respostaAId: idDe(dados.respostaA) ?? null,
      ocorridaEm,
    },
  });
  await t.prisma.conversa.update({
    where: { id: conversaId },
    data: {
      ultimaMensagemId: mensagem.id,
      ultimaMensagemEm: ocorridaEm,
      ...(direcao === 'ENTRADA'
        ? {
            ultimaEntradaEm: ocorridaEm,
            aguardandoDesde: conversa.aguardandoDesde ?? ocorridaEm,
            naoLidas: { increment: 1 },
          }
        : {}),
    },
  });
  return mensagem;
}

export interface DadosDeRespostaRapida {
  atalho?: string;
  titulo?: string;
  texto?: string;
  /** Nula = global. */
  area?: Area | null;
  arquivo?: Arquivo | string | null;
  ativa?: boolean;
  criadoPor?: Usuario | string | null;
}

export function criarRespostaRapida(
  t: AppTeste,
  dados: DadosDeRespostaRapida = {},
): Promise<RespostaRapida> {
  return t.prisma.respostaRapida.create({
    data: {
      atalho: dados.atalho ?? `atalho-${proximo()}`.toLowerCase(),
      titulo: dados.titulo ?? 'Resposta de teste',
      texto: dados.texto ?? 'Olá, {{contato.nome}}! Como posso ajudar?',
      area: dados.area ?? null,
      arquivoId: idDe(dados.arquivo) ?? null,
      ativa: dados.ativa ?? true,
      criadoPorId: idDe(dados.criadoPor) ?? null,
    },
  });
}

export interface DadosDeVisitanteWebchat {
  canal: Canal | string;
  contato?: Contato | string | null;
  conversa?: Conversa | string | null;
  consentimento?: boolean;
}

/** Visitante do chat do site, com o token anônimo em claro (o banco guarda só o SHA-256). */
export async function criarVisitanteWebchat(
  t: AppTeste,
  dados: DadosDeVisitanteWebchat,
): Promise<{ visitante: WebchatVisitante; token: string }> {
  const cripto = t.get(CriptografiaService);
  const token = cripto.gerarToken();
  const visitante = await t.prisma.webchatVisitante.create({
    data: {
      canalId: idDe(dados.canal) as string,
      tokenHash: cripto.sha256(token),
      contatoId: idDe(dados.contato) ?? null,
      conversaId: idDe(dados.conversa) ?? null,
      consentimentoEm: dados.consentimento === false ? null : new Date(),
    },
  });
  return { visitante, token };
}

export interface DadosDeChatCanal {
  /** Padrão `GRUPO`. */
  tipo?: TipoChatCanal;
  nome?: string | null;
  /** Obrigatória com `AREA` (CHECK). */
  area?: Area | null;
  chave?: string | null;
  membros?: Array<Usuario | string>;
  /** Membros com `administrador = true` (também entram como membros). */
  administradores?: Array<Usuario | string>;
  criadoPor?: Usuario | string | null;
}

/** Canal do chat interno com os membros (os de `GERAL`/`AREA` marcados `automatico`). */
export function criarChatCanal(
  t: AppTeste,
  dados: DadosDeChatCanal = {},
): Promise<ChatCanal> {
  const tipo = dados.tipo ?? 'GRUPO';
  const administradores = new Set(
    (dados.administradores ?? []).map((item) => idDe(item) as string),
  );
  const membros = new Set([
    ...(dados.membros ?? []).map((item) => idDe(item) as string),
    ...administradores,
  ]);
  return t.prisma.chatCanal.create({
    data: {
      tipo,
      nome:
        dados.nome === undefined
          ? tipo === 'DIRETO'
            ? null
            : `Grupo ${proximo()}`
          : dados.nome,
      area: dados.area ?? null,
      chave: dados.chave ?? null,
      criadoPorId: idDe(dados.criadoPor) ?? null,
      membros: {
        create: [...membros].map((usuarioId) => ({
          usuarioId,
          administrador: administradores.has(usuarioId),
          automatico: tipo === 'GERAL' || tipo === 'AREA',
        })),
      },
    },
  });
}

export interface DadosDeChatMensagem {
  canal: ChatCanal | string;
  autor?: Usuario | string | null;
  texto?: string | null;
  arquivo?: Arquivo | string | null;
  mencoes?: Array<Usuario | string>;
  referencias?: Array<{ tipo: 'negocio' | 'contato' | 'empresa'; id: string }>;
  criadoEm?: Date;
}

/** Mensagem do chat interno (e `ultimaMensagemEm` do canal). */
export async function criarChatMensagem(
  t: AppTeste,
  dados: DadosDeChatMensagem,
): Promise<ChatMensagem> {
  const canalId = idDe(dados.canal) as string;
  const criadoEm = dados.criadoEm ?? new Date();
  const mensagem = await t.prisma.chatMensagem.create({
    data: {
      canalId,
      autorId: idDe(dados.autor) ?? null,
      texto: dados.texto === undefined ? `Mensagem ${proximo()}` : dados.texto,
      arquivoId: idDe(dados.arquivo) ?? null,
      mencoes: (dados.mencoes ?? []).map((item) => idDe(item) as string),
      referencias: dados.referencias ?? [],
      criadoEm,
    },
  });
  await t.prisma.chatCanal.update({
    where: { id: canalId },
    data: { ultimaMensagemEm: criadoEm },
  });
  return mensagem;
}
