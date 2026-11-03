/**
 * Regras do painel "Saúde do sistema" (R27): a partir dos fatos coletados,
 * decidem o que é alerta. Funções puras, sem banco, disco ou rede.
 */

export type GravidadeDoAlerta = 'aviso' | 'critico';

export interface Alerta {
  /** Identifica a ocorrência (ex.: `numero:<id>`); a antirrepetição usa esta chave. */
  chave: string;
  /** Tipo do alerta (`numero_desconectado`, `fila_travada`, `backup_falhou`…). */
  codigo: string;
  gravidade: GravidadeDoAlerta;
  titulo: string;
  detalhe: string;
  /** O que o Admin deve fazer. */
  dica: string;
  /** Também vai por e-mail ao Admin. */
  porEmail: boolean;
}

/** Uma fila vira "travada" quando o job pronto mais antigo espera há mais que isto. */
export const LIMITE_FILA_PARADA_SEGUNDOS = 10 * 60;
/** Ou quando um job está ativo há mais que isto. */
export const LIMITE_JOB_ATIVO_SEGUNDOS = 60 * 60;
/** Um número recém-caído tem este tempo para a reconexão automática. */
export const CARENCIA_DESCONEXAO_SEGUNDOS = 2 * 60;
/** Sem backup concluído há mais que isto, o backup está atrasado (diário + folga). */
export const LIMITE_BACKUP_ATRASADO_HORAS = 36;
/** Espaço livre abaixo destes percentuais. */
export const DISCO_AVISO_PERCENTUAL = 15;
export const DISCO_CRITICO_PERCENTUAL = 5;

export interface FatosDeFila {
  nome: string;
  pendentes: number;
  ativas: number;
  falhasRecentes: number;
  /** Desde quando o job pronto mais antigo espera. */
  maisAntigaDesde: Date | null;
  /** Desde quando o job ativo mais antigo roda. */
  ativaDesde: Date | null;
}

export interface FilaAvaliada {
  nome: string;
  pendentes: number;
  ativas: number;
  falhasRecentes: number;
  /** Há quantos segundos o job pronto mais antigo espera; `null` sem pendentes. */
  maisAntigaParadaSegundos: number | null;
  travada: boolean;
  motivoDaTrava: string | null;
}

export function avaliarFila(fato: FatosDeFila, agora: Date): FilaAvaliada {
  const parada =
    fato.maisAntigaDesde === null
      ? null
      : Math.max(0, Math.floor((+agora - +fato.maisAntigaDesde) / 1000));
  const ativaHa =
    fato.ativaDesde === null
      ? null
      : Math.max(0, Math.floor((+agora - +fato.ativaDesde) / 1000));
  let motivo: string | null = null;
  if (parada !== null && parada > LIMITE_FILA_PARADA_SEGUNDOS) {
    motivo = `há trabalho esperando há ${duracaoEmTexto(parada)}`;
  } else if (ativaHa !== null && ativaHa > LIMITE_JOB_ATIVO_SEGUNDOS) {
    motivo = `um trabalho está em execução há ${duracaoEmTexto(ativaHa)}`;
  }
  return {
    nome: fato.nome,
    pendentes: fato.pendentes,
    ativas: fato.ativas,
    falhasRecentes: fato.falhasRecentes,
    maisAntigaParadaSegundos: parada,
    travada: motivo !== null,
    motivoDaTrava: motivo,
  };
}

export function alertasDeFilas(filas: readonly FilaAvaliada[]): Alerta[] {
  return filas
    .filter((fila) => fila.travada)
    .map((fila) => ({
      chave: `fila:${fila.nome}`,
      codigo: 'fila_travada',
      gravidade: 'critico' as const,
      titulo: `Fila "${fila.nome}" travada`,
      detalhe: `Na fila "${fila.nome}", ${fila.motivoDaTrava ?? 'o processamento parou'}.`,
      dica: 'Confira se a API está de pé e se há erros recentes abaixo. Reiniciar a API costuma destravar; se voltar a travar, veja os logs técnicos.',
      porEmail: true,
    }));
}

export type StatusDoNumero =
  | 'DESCONECTADO'
  | 'AGUARDANDO_QR'
  | 'CONECTANDO'
  | 'CONECTADO'
  | 'ERRO'
  | 'BANIDO';

export interface FatosDeNumero {
  id: string;
  nome: string;
  telefone: string | null;
  status: StatusDoNumero;
  motivo: string | null;
  canalAtivo: boolean;
  pausado: boolean;
  conectadoEm: Date | null;
  desconectadoEm: Date | null;
  ultimoEventoEm: Date | null;
}

/** O número caiu e precisa de atenção do Admin? */
export function numeroDesconectado(
  numero: FatosDeNumero,
  agora: Date,
): boolean {
  if (!numero.canalAtivo) {
    return false;
  }
  if (numero.status === 'ERRO' || numero.status === 'BANIDO') {
    return true;
  }
  if (numero.status !== 'DESCONECTADO' && numero.status !== 'AGUARDANDO_QR') {
    return false;
  }
  // Número que nunca conectou ainda está sendo configurado.
  if (numero.conectadoEm === null) {
    return false;
  }
  const desde = numero.desconectadoEm ?? numero.ultimoEventoEm;
  if (desde === null) {
    return true;
  }
  return +agora - +desde > CARENCIA_DESCONEXAO_SEGUNDOS * 1000;
}

export function alertasDeNumeros(
  numeros: readonly FatosDeNumero[],
  agora: Date,
): Alerta[] {
  return numeros
    .filter((numero) => numeroDesconectado(numero, agora))
    .map((numero) => {
      const banido = numero.status === 'BANIDO';
      const quem = numero.telefone
        ? `${numero.nome} (${numero.telefone})`
        : numero.nome;
      return {
        chave: `numero:${numero.id}`,
        codigo: banido ? 'numero_banido' : 'numero_desconectado',
        gravidade: 'critico' as const,
        titulo: banido
          ? `Número ${quem} banido`
          : `Número ${quem} desconectado`,
        detalhe: `${banido ? 'O WhatsApp bloqueou o número' : 'O número saiu do ar'}${numero.motivo ? `: ${numero.motivo}` : '.'}`,
        dica: banido
          ? 'Um número banido não volta. Cadastre outro número em Configurações > Canais > WhatsApp e redirecione as filas.'
          : 'Abra Configurações > Canais > WhatsApp, escolha o número e leia o QR de novo (celular com internet e WhatsApp aberto).',
        porEmail: true,
      };
    });
}

export interface UltimoBackup {
  inicio: string;
  fim: string;
  arquivo: string | null;
  tamanhoBytes: number | null;
  ok: boolean;
  erro: string | null;
}

export type SituacaoDoBackup =
  'ok' | 'falhou' | 'atrasado' | 'nenhum' | 'ilegivel';

export interface BackupAvaliado {
  situacao: SituacaoDoBackup;
  ultimo: UltimoBackup | null;
  /** Horas desde o fim do último backup. */
  idadeHoras: number | null;
}

/** Lê o conteúdo de `ultimo.json`; `null` quando o texto não é um registro válido. */
export function lerUltimoBackup(texto: string): UltimoBackup | null {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return null;
  }
  if (typeof bruto !== 'object' || bruto === null) {
    return null;
  }
  const r = bruto as Record<string, unknown>;
  const data = (valor: unknown): string | null =>
    typeof valor === 'string' && !Number.isNaN(Date.parse(valor))
      ? valor
      : null;
  const fim = data(r.fim);
  const inicio = data(r.inicio) ?? fim;
  if (fim === null || inicio === null || typeof r.ok !== 'boolean') {
    return null;
  }
  return {
    inicio,
    fim,
    arquivo: typeof r.arquivo === 'string' ? r.arquivo : null,
    tamanhoBytes:
      typeof r.tamanhoBytes === 'number' && r.tamanhoBytes >= 0
        ? r.tamanhoBytes
        : null,
    ok: r.ok,
    erro:
      typeof r.erro === 'string' && r.erro.trim() ? r.erro.slice(0, 500) : null,
  };
}

/** `texto` é o conteúdo de `ultimo.json`, ou `null` se o arquivo não existe. */
export function avaliarBackup(
  texto: string | null,
  agora: Date,
): BackupAvaliado {
  if (texto === null) {
    return { situacao: 'nenhum', ultimo: null, idadeHoras: null };
  }
  const ultimo = lerUltimoBackup(texto);
  if (ultimo === null) {
    return { situacao: 'ilegivel', ultimo: null, idadeHoras: null };
  }
  const idadeHoras = Math.max(0, (+agora - Date.parse(ultimo.fim)) / 3_600_000);
  let situacao: SituacaoDoBackup = 'ok';
  if (!ultimo.ok) {
    situacao = 'falhou';
  } else if (idadeHoras > LIMITE_BACKUP_ATRASADO_HORAS) {
    situacao = 'atrasado';
  }
  return { situacao, ultimo, idadeHoras: Math.round(idadeHoras * 10) / 10 };
}

export function alertasDeBackup(backup: BackupAvaliado): Alerta[] {
  if (backup.situacao === 'falhou') {
    return [
      {
        chave: 'backup',
        codigo: 'backup_falhou',
        gravidade: 'critico',
        titulo: 'O último backup falhou',
        detalhe: `O backup terminou com erro${backup.ultimo?.erro ? `: ${backup.ultimo.erro}` : '.'}`,
        dica: 'Veja o registro do serviço de backup (docker compose logs backup) e confira o espaço do volume de backups. Rode um backup manual depois de corrigir.',
        porEmail: true,
      },
    ];
  }
  if (backup.situacao === 'atrasado') {
    return [
      {
        chave: 'backup',
        codigo: 'backup_atrasado',
        gravidade: 'critico',
        titulo: 'Backup atrasado',
        detalhe: `O último backup concluído tem ${Math.floor(backup.idadeHoras ?? 0)} horas; o esperado é um por dia.`,
        dica: 'Confirme que o serviço de backup está ligado (docker compose ps) e veja o registro dele.',
        porEmail: true,
      },
    ];
  }
  if (backup.situacao === 'ilegivel') {
    return [
      {
        chave: 'backup',
        codigo: 'backup_ilegivel',
        gravidade: 'aviso',
        titulo: 'Registro do backup ilegível',
        detalhe:
          'O arquivo ultimo.json existe, mas não tem o formato esperado.',
        dica: 'Rode um backup manual e confira se o serviço de backup é da mesma versão do CRM.',
        porEmail: false,
      },
    ];
  }
  if (backup.situacao === 'nenhum') {
    return [
      {
        chave: 'backup',
        codigo: 'backup_nenhum',
        gravidade: 'aviso',
        titulo: 'Nenhum backup registrado',
        detalhe:
          'Não há registro de backup (arquivo ultimo.json) na pasta de backups.',
        dica: 'Em produção, ligue o serviço de backup do compose e monte o volume de backups na API (somente leitura). Em desenvolvimento isto é esperado.',
        porEmail: false,
      },
    ];
  }
  return [];
}

export interface DiscoAvaliado {
  caminho: string;
  totalBytes: number;
  livreBytes: number;
  livrePercentual: number;
  situacao: 'ok' | 'aviso' | 'critico';
}

export function avaliarDisco(
  caminho: string,
  totalBytes: number,
  livreBytes: number,
): DiscoAvaliado {
  const livrePercentual =
    totalBytes > 0 ? Math.round((livreBytes / totalBytes) * 1000) / 10 : 0;
  let situacao: DiscoAvaliado['situacao'] = 'ok';
  if (livrePercentual < DISCO_CRITICO_PERCENTUAL) {
    situacao = 'critico';
  } else if (livrePercentual < DISCO_AVISO_PERCENTUAL) {
    situacao = 'aviso';
  }
  return { caminho, totalBytes, livreBytes, livrePercentual, situacao };
}

export function alertasDeDisco(disco: DiscoAvaliado | null): Alerta[] {
  if (disco === null || disco.situacao === 'ok') {
    return [];
  }
  return [
    {
      chave: 'disco',
      codigo: 'disco_cheio',
      gravidade: disco.situacao === 'critico' ? 'critico' : 'aviso',
      titulo: 'Pouco espaço em disco',
      detalhe: `Restam ${disco.livrePercentual}% de espaço livre no volume.`,
      dica: 'Apague backups antigos, reduza a retenção ou aumente o disco. Sem espaço, o banco e os backups param.',
      porEmail: false,
    },
  ];
}

export interface FatosDeCanal {
  id: string;
  tipo: string;
  nome: string;
  ultimoErro: string | null;
  ultimoErroEm: Date | null;
}

/** Erro de canal recente (24 h) aparece como aviso. */
export const JANELA_ERRO_DE_CANAL_HORAS = 24;

export function canalComErroRecente(canal: FatosDeCanal, agora: Date): boolean {
  return (
    canal.ultimoErro !== null &&
    canal.ultimoErroEm !== null &&
    +agora - +canal.ultimoErroEm < JANELA_ERRO_DE_CANAL_HORAS * 3_600_000
  );
}

export function alertasDeCanais(
  canais: readonly FatosDeCanal[],
  agora: Date,
): Alerta[] {
  return canais
    .filter((canal) => canalComErroRecente(canal, agora))
    .map((canal) => ({
      chave: `canal:${canal.id}`,
      codigo: 'canal_com_erro',
      gravidade: 'aviso' as const,
      titulo: `Canal "${canal.nome}" com erro`,
      detalhe: canal.ultimoErro ?? '',
      dica: 'Abra Configurações > Canais, confira as credenciais do canal e salve de novo para testar a conexão.',
      porEmail: false,
    }));
}

export function alertaDoGateway(
  gatewayForaDoAr: boolean,
  numerosAtivos: number,
): Alerta[] {
  if (!gatewayForaDoAr || numerosAtivos === 0) {
    return [];
  }
  return [
    {
      chave: 'gateway',
      codigo: 'gateway_fora_do_ar',
      gravidade: 'critico',
      titulo: 'Gateway de WhatsApp fora do ar',
      detalhe:
        'A API não consegue falar com o gateway de WhatsApp; ninguém envia nem recebe mensagens.',
      dica: 'Confira se o serviço do gateway está ligado (docker compose ps) e reinicie-o se preciso. As mensagens esperam na fila e saem quando ele volta.',
      porEmail: true,
    },
  ];
}

/** O serviço de transcrição (whisper.cpp) está ligado na configuração mas não responde (R30). */
export function alertaDaTranscricao(foraDoAr: boolean): Alerta[] {
  if (!foraDoAr) {
    return [];
  }
  return [
    {
      chave: 'transcricao',
      codigo: 'transcricao_fora_do_ar',
      gravidade: 'aviso',
      titulo: 'Serviço de transcrição fora do ar',
      detalhe:
        'A API não consegue falar com o serviço de transcrição (whisper.cpp). As gravações das ligações esperam na fila e são transcritas quando ele voltar.',
      dica: 'Confira o serviço transcricao (docker compose ps transcricao). Na primeira subida ele baixa o modelo e leva alguns minutos; falta de memória também derruba o serviço.',
      porEmail: false,
    },
  ];
}

/** `3 min`, `2 h 5 min`, `1 d 4 h`. */
export function duracaoEmTexto(segundos: number): string {
  const minutos = Math.floor(segundos / 60);
  if (minutos < 1) {
    return `${segundos} s`;
  }
  if (minutos < 60) {
    return `${minutos} min`;
  }
  const horas = Math.floor(minutos / 60);
  if (horas < 24) {
    return `${horas} h ${minutos % 60} min`;
  }
  return `${Math.floor(horas / 24)} d ${horas % 24} h`;
}

export type SituacaoGeral = 'ok' | 'atencao' | 'critico';

export function situacaoGeral(alertas: readonly Alerta[]): SituacaoGeral {
  if (alertas.some((alerta) => alerta.gravidade === 'critico')) {
    return 'critico';
  }
  return alertas.length > 0 ? 'atencao' : 'ok';
}

// ---------------------------------------------------------------------------
// Antirrepetição dos e-mails
// ---------------------------------------------------------------------------

/** Enquanto o problema continua, o lembrete por e-mail sai no máximo a cada 6 horas. */
export const INTERVALO_DE_LEMBRETE_HORAS = 6;

/** Chave do alerta → último envio (ISO). */
export type RegistroDeEnvios = Record<string, string>;

export interface DecisaoDeEnvio {
  /** Alertas a enviar agora (novos ou com lembrete vencido). */
  enviar: Alerta[];
  /** Registro depois da rodada: sem os alertas que se resolveram. */
  registro: RegistroDeEnvios;
}

/**
 * Decide o que enviar: alerta novo sai na hora; o que continua só volta depois
 * de `INTERVALO_DE_LEMBRETE_HORAS`; o que se resolveu sai do registro (se
 * voltar, é novo e avisa de novo).
 */
export function decidirEnvios(
  ativos: readonly Alerta[],
  registro: RegistroDeEnvios,
  agora: Date,
): DecisaoDeEnvio {
  const novoRegistro: RegistroDeEnvios = {};
  const enviar: Alerta[] = [];
  for (const alerta of ativos) {
    if (!alerta.porEmail) {
      continue;
    }
    const ultimo = registro[alerta.chave];
    const vencido =
      ultimo === undefined ||
      Number.isNaN(Date.parse(ultimo)) ||
      +agora - Date.parse(ultimo) >= INTERVALO_DE_LEMBRETE_HORAS * 3_600_000;
    if (vencido) {
      enviar.push(alerta);
      novoRegistro[alerta.chave] = agora.toISOString();
    } else {
      novoRegistro[alerta.chave] = ultimo;
    }
  }
  return { enviar, registro: novoRegistro };
}
