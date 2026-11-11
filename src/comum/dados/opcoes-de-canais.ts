import type { TipoCanal } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Area } from '../dominio/setores';

/**
 * Listas enxutas de canais e filas para os seletores de Disparos, Chatbot e
 * Automações. Cada módulo as expõe numa rota própria, protegida pela permissão
 * dele (e não pela do Atendimento, R12): só id, nome e o estado que a tela
 * precisa, sem configuração nem segredos.
 */
export interface CanalDeOpcao {
  id: string;
  tipo: TipoCanal;
  nome: string;
  ativo: boolean;
  /** O tipo de canal está ativo no sistema (o estado do número vai em `status` e `pausado`). */
  disponivel: boolean;
  /** WhatsApp: status do número (`CONECTADO`…); outros tipos: nulo. */
  status: string | null;
  pausado: boolean;
}

export interface FilaDeOpcao {
  id: string;
  nome: string;
  area: Area;
  ativa: boolean;
}

export async function listarCanaisDeOpcao(
  prisma: PrismaService,
  tipos?: readonly TipoCanal[],
): Promise<CanalDeOpcao[]> {
  const canais = await prisma.canal.findMany({
    where: { excluidoEm: null, ...(tipos ? { tipo: { in: [...tipos] } } : {}) },
    include: { whatsappNumero: true },
    orderBy: [{ tipo: 'asc' }, { nome: 'asc' }, { id: 'asc' }],
  });
  return canais.map((canal) => {
    const numero = canal.whatsappNumero;
    const pausado = numero?.pausadoEm != null;
    return {
      id: canal.id,
      tipo: canal.tipo,
      nome: canal.nome,
      ativo: canal.ativo,
      disponivel: canal.ativo,
      status: numero ? numero.status : null,
      pausado,
    };
  });
}

export async function listarFilasDeOpcao(
  prisma: PrismaService,
): Promise<FilaDeOpcao[]> {
  const filas = await prisma.filaAtendimento.findMany({
    where: { excluidoEm: null },
    orderBy: [{ setor: { ordem: 'asc' } }, { nome: 'asc' }],
  });
  return filas.map((f) => ({
    id: f.id,
    nome: f.nome,
    area: f.area,
    ativa: f.ativa,
  }));
}
