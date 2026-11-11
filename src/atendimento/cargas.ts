/**
 * Para quem vão as emissões de tempo real de uma conversa (`conversa.nova`,
 * `conversa.atualizada`, `mensagem.nova`, `mensagem.status`). Os dados são os
 * DTOs da API (`ConversaResumoDto`, `MensagemDaConversaDto`).
 */
import { salas } from '../tempo-real/catalogo';
import type { Area } from '../comum/dominio/setores';

/**
 * Salas que acompanham a conversa (R12): Admin e C-level sempre; o
 * responsável e os líderes do setor da fila quando há responsável; o setor
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
      lista.push(salas.lideres(conversa.area));
    }
  } else if (conversa.area) {
    lista.push(salas.area(conversa.area));
  }
  return lista;
}
