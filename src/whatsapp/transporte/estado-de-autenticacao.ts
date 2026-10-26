/**
 * Estado de autenticação do Baileys no Postgres, cifrado (§2.3): as
 * credenciais (`creds`) e as chaves do Signal de cada número ficam em
 * `whatsapp_chaves`, uma linha por (tipo, id), com o valor em JSON (o
 * `BufferJSON` do Baileys) cifrado com AES-256-GCM e `CHAVE_CRIPTOGRAFIA`
 * (`CriptografiaService.cifrar`). Nada vai para o disco.
 *
 * É o equivalente do `useMultiFileAuthState` do Baileys, com três cuidados a
 * mais:
 *
 * - as gravações de um número são feitas uma de cada vez, na ordem em que o
 *   Baileys pediu (uma gravação seguida de uma remoção da mesma chave não se
 *   invertem), e as leituras esperam as gravações pendentes;
 * - depois de `desativar()` (sessão encerrada, logout) nada mais é gravado — o
 *   gerenciador apaga as chaves logo em seguida e um `creds.update` atrasado
 *   não as recria;
 * - um valor que não decifra (chave de criptografia trocada, linha adulterada)
 *   vira "chave ausente" para o Signal; nas credenciais, é erro (a sessão não
 *   tem como continuar sem elas).
 */
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from 'baileys' with { 'resolution-mode': 'import' };
import type { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import type { PrismaService } from '../../prisma/prisma.service';

/** Tipo da linha das credenciais (o `chave_id` dela é vazio). */
export const TIPO_DAS_CREDENCIAIS = 'creds';

/** O que o estado usa do pacote do Baileys (passado pelo transporte, que é quem o carrega). */
export interface ApoioDoBaileys {
  initAuthCreds(): AuthenticationCreds;
  BufferJSON: {
    replacer: (chave: string, valor: unknown) => unknown;
    reviver: (chave: string, valor: unknown) => unknown;
  };
  /** Converte as chaves `app-state-sync-key` de volta ao objeto do protobuf. */
  reviverChaveDeSincronizacao?: (
    valor: unknown,
  ) => SignalDataTypeMap['app-state-sync-key'];
}

/** As credenciais guardadas não decifram (chave de criptografia trocada, linha adulterada). */
export class CredenciaisIlegiveisError extends Error {
  constructor() {
    super(
      'Não foi possível ler as credenciais guardadas deste número (a CHAVE_CRIPTOGRAFIA mudou?). Desvincule o número e leia o QR de novo.',
    );
    this.name = 'CredenciaisIlegiveisError';
  }
}

/** Estado pronto para o `makeWASocket({ auth })`. */
export interface EstadoDeAutenticacao {
  readonly state: AuthenticationState;
  /** Grava as credenciais atuais (no `creds.update`). */
  salvarCredenciais(): Promise<void>;
  /** Credenciais já registradas (o QR já foi lido alguma vez)? */
  readonly registrado: boolean;
  /** A partir de agora, nada mais é gravado. */
  desativar(): void;
  /** Espera as gravações pendentes (testes e encerramento). */
  aguardarGravacoes(): Promise<void>;
}

interface Linha {
  tipo: string;
  chaveId: string;
  valorCifrado: string;
}

/**
 * Carrega (ou cria) o estado de autenticação do número. Lança
 * `CredenciaisIlegiveisError` se as credenciais gravadas não decifram.
 */
export async function carregarEstadoDeAutenticacao(
  numeroId: string,
  dependencias: {
    prisma: PrismaService;
    cripto: CriptografiaService;
    baileys: ApoioDoBaileys;
    /** Para avisos (chave que não decifrou, gravação que falhou). */
    avisar?: (mensagem: string) => void;
  },
): Promise<EstadoDeAutenticacao> {
  const { prisma, cripto, baileys } = dependencias;
  const avisar = dependencias.avisar ?? (() => undefined);
  const serializar = (valor: unknown): string =>
    cripto.cifrar(JSON.stringify(valor, baileys.BufferJSON.replacer));
  const desserializar = (cifrado: string): unknown =>
    JSON.parse(cripto.decifrar(cifrado), baileys.BufferJSON.reviver);

  const gravadas = await prisma.whatsappChave.findUnique({
    where: {
      numeroId_tipo_chaveId: {
        numeroId,
        tipo: TIPO_DAS_CREDENCIAIS,
        chaveId: '',
      },
    },
    select: { valorCifrado: true },
  });
  let creds: AuthenticationCreds;
  if (gravadas) {
    try {
      creds = desserializar(gravadas.valorCifrado) as AuthenticationCreds;
    } catch {
      throw new CredenciaisIlegiveisError();
    }
  } else {
    creds = baileys.initAuthCreds();
  }

  let ativo = true;
  let fila: Promise<void> = Promise.resolve();
  /** Enfileira uma gravação: uma de cada vez, na ordem; falhas só viram aviso. */
  const enfileirar = (gravacao: () => Promise<void>): Promise<void> => {
    const atual = fila.then(async () => {
      if (!ativo) {
        return;
      }
      try {
        await gravacao();
      } catch (erro) {
        avisar(
          `Falha ao gravar o estado de autenticação do número ${numeroId}: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
        throw erro;
      }
    });
    fila = atual.catch(() => undefined);
    return atual;
  };

  const gravarLinhas = async (linhas: Linha[]): Promise<void> => {
    if (linhas.length === 0) {
      return;
    }
    const tipos = linhas.map((linha) => linha.tipo);
    const ids = linhas.map((linha) => linha.chaveId);
    const valores = linhas.map((linha) => linha.valorCifrado);
    await prisma.$executeRaw`
      INSERT INTO "whatsapp_chaves" ("numero_id", "tipo", "chave_id", "valor_cifrado", "criado_em", "atualizado_em")
      SELECT ${numeroId}::uuid, novo.tipo, novo.chave_id, novo.valor, now(), now()
        FROM unnest(${tipos}::text[], ${ids}::text[], ${valores}::text[]) AS novo(tipo, chave_id, valor)
      ON CONFLICT ("numero_id", "tipo", "chave_id")
      DO UPDATE SET "valor_cifrado" = EXCLUDED."valor_cifrado", "atualizado_em" = now()`;
  };

  const removerLinhas = async (
    chaves: Array<{ tipo: string; chaveId: string }>,
  ): Promise<void> => {
    if (chaves.length === 0) {
      return;
    }
    const tipos = chaves.map((chave) => chave.tipo);
    const ids = chaves.map((chave) => chave.chaveId);
    await prisma.$executeRaw`
      DELETE FROM "whatsapp_chaves" AS chave
       USING unnest(${tipos}::text[], ${ids}::text[]) AS alvo(tipo, chave_id)
       WHERE chave."numero_id" = ${numeroId}::uuid
         AND chave."tipo" = alvo.tipo
         AND chave."chave_id" = alvo.chave_id`;
  };

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(
      tipo: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      await fila;
      const resultado: { [id: string]: SignalDataTypeMap[T] } = {};
      if (ids.length === 0) {
        return resultado;
      }
      const linhas = await prisma.whatsappChave.findMany({
        where: { numeroId, tipo, chaveId: { in: ids } },
        select: { chaveId: true, valorCifrado: true },
      });
      for (const linha of linhas) {
        let valor: unknown;
        try {
          valor = desserializar(linha.valorCifrado);
        } catch {
          avisar(
            `Chave "${tipo}" do número ${numeroId} não decifrou e foi ignorada.`,
          );
          continue;
        }
        if (
          tipo === 'app-state-sync-key' &&
          valor &&
          baileys.reviverChaveDeSincronizacao
        ) {
          valor = baileys.reviverChaveDeSincronizacao(valor);
        }
        resultado[linha.chaveId] = valor as SignalDataTypeMap[T];
      }
      return resultado;
    },
    set: (dados: SignalDataSet): Promise<void> => {
      const gravar: Linha[] = [];
      const remover: Array<{ tipo: string; chaveId: string }> = [];
      for (const [tipo, porId] of Object.entries(dados)) {
        for (const [chaveId, valor] of Object.entries(porId ?? {})) {
          if (valor === null || valor === undefined) {
            remover.push({ tipo, chaveId });
          } else {
            gravar.push({ tipo, chaveId, valorCifrado: serializar(valor) });
          }
        }
      }
      return enfileirar(async () => {
        await gravarLinhas(gravar);
        await removerLinhas(remover);
      });
    },
    clear: () =>
      enfileirar(async () => {
        await prisma.whatsappChave.deleteMany({
          where: { numeroId, tipo: { not: TIPO_DAS_CREDENCIAIS } },
        });
      }),
  };

  return {
    state: { creds, keys },
    get registrado() {
      return Boolean(creds.registered || creds.me?.id);
    },
    salvarCredenciais: () =>
      enfileirar(() =>
        gravarLinhas([
          {
            tipo: TIPO_DAS_CREDENCIAIS,
            chaveId: '',
            valorCifrado: serializar(creds),
          },
        ]),
      ),
    desativar: () => {
      ativo = false;
    },
    aguardarGravacoes: () => fila,
  };
}
