/**
 * Para quem vão as emissões de tempo real de uma conversa (`conversa.nova`,
 * `conversa.atualizada`, `mensagem.nova`, `mensagem.status`). Os dados são os
 * DTOs da API (`ConversaResumoDto`, `MensagemDaConversaDto`).
 */
import { liderDaArea } from '../comum/dominio/papeis';
import type { Area } from '../generated/prisma/client';
import { salas } from '../tempo-real/catalogo';

/**
 * Salas que acompanham a conversa (R12): Admin e C-level sempre; o
 * responsável e os líderes da área da fila quando há responsável; a área
 * inteira da fila quando ainda não há (quem atende a fila pode assumir). Mais
 * a sala da própria conversa (`conversa:<id>`).
 */
export function salasDaConversa(conversa: {
  id: string;
  responsavelId: string | null;
  area: Area | null;
}): string[] {
  const lista = [
    salas.conversa(conversa.id),
    salas.papel('ADMIN'),
    salas.papel('C_LEVEL'),
  ];
  if (conversa.responsavelId) {
    lista.push(salas.usuario(conversa.responsavelId));
    if (conversa.area) {
      lista.push(salas.papel(liderDaArea(conversa.area)));
    }
  } else if (conversa.area) {
    lista.push(salas.area(conversa.area));
  }
  return lista;
}
