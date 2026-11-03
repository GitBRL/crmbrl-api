import type { WhatsappOficialTemplate } from '../../generated/prisma/client';
import type { TemplateDoCanalDto } from '../templates-canal.dto';
import { estruturaDoTemplate } from './formato-meta';

/** O template do cache como o front o recebe (estrutura e variáveis já separadas). */
export function templateParaDto(
  template: WhatsappOficialTemplate,
): TemplateDoCanalDto {
  const estrutura = estruturaDoTemplate(template.componentes);
  const aprovado = template.status === 'APPROVED';
  const semSuporte = estrutura.cabecalho?.formato === 'LOCATION';
  return {
    id: template.id,
    nome: template.nome,
    idioma: template.idioma,
    categoria: template.categoria,
    status: template.status,
    usavel: aprovado && !semSuporte,
    motivoIndisponivel: !aprovado
      ? `O template não está aprovado pela Meta (situação: ${template.status}).`
      : semSuporte
        ? 'Templates com localização no cabeçalho ainda não são suportados.'
        : null,
    cabecalho: estrutura.cabecalho,
    corpo: estrutura.corpo,
    rodape: estrutura.rodape,
    botoes: estrutura.botoes.map((botao) => ({
      ...botao,
      tipo: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE'].includes(
        botao.tipo,
      )
        ? botao.tipo
        : 'OTHER',
    })),
    sincronizadoEm: template.sincronizadoEm.toISOString(),
  };
}
