/**
 * Catálogo dos tipos de passo do chatbot para o editor (`GET /chatbot/passos`):
 * rótulo, grupo, como os ramos funcionam e um exemplo de `config`.
 */
export type RamosDoPasso =
  /** Sem ramos. */
  | 'nenhum'
  /** Um ramo por opção (`ramo.id` = `opcao.id`) + `sem_resposta` e `invalida` opcionais. */
  | 'opcoes'
  /** Só os ramos `sem_resposta` e `invalida`, opcionais. */
  | 'excecoes'
  /** Ramos com condição em `ramo.config` (`condicao`/`condicoes`); o sem condição é o "senão". */
  | 'condicoes';

export interface PassoDoCatalogo {
  tipo: string;
  rotulo: string;
  grupo: 'conversa' | 'logica' | 'acao' | 'fim';
  descricao: string;
  ramos: RamosDoPasso;
  /** O fluxo espera o contato responder neste passo. */
  esperaResposta: boolean;
  exemplo: Record<string, unknown>;
}

export const CATALOGO_DE_PASSOS: readonly PassoDoCatalogo[] = [
  {
    tipo: 'mensagem',
    rotulo: 'Enviar mensagem',
    grupo: 'conversa',
    descricao:
      'Texto (com {{contato.primeiro_nome}}, {{variaveis.x}}…) e/ou mídia (arquivo de contexto CAMPANHA).',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: {
      texto:
        'Olá, {{contato.primeiro_nome|tudo bem}}! Sou o assistente da BRL.',
    },
  },
  {
    tipo: 'pergunta.opcoes',
    rotulo: 'Perguntar com opções',
    grupo: 'conversa',
    descricao:
      'Opções numeradas no WhatsApp e no e-mail; botões no chat do site (`metadados.botoes`). Cada opção pode ter um ramo (id do ramo = id da opção).',
    ramos: 'opcoes',
    esperaResposta: true,
    exemplo: {
      texto: 'Com o que posso ajudar?',
      opcoes: [
        { id: 'vendas', rotulo: 'Quero comprar' },
        { id: 'suporte', rotulo: 'Preciso de suporte' },
      ],
      variavel: 'assunto',
      tentativas: 3,
      tempoSemResposta: {
        lembreteAposMinutos: 10,
        lembrete: 'Ainda está por aí? Responda com o número da opção.',
        encerrarAposMinutos: 30,
      },
    },
  },
  {
    tipo: 'pergunta.aberta',
    rotulo: 'Perguntar (resposta livre)',
    grupo: 'conversa',
    descricao:
      'Guarda a resposta em `variavel` e, se quiser, no contato (`campoContato`: nome, email, telefone, cargo ou campos.<chave>). Validação: texto, email, telefone, numero, data (dd/mm/aaaa).',
    ramos: 'excecoes',
    esperaResposta: true,
    exemplo: {
      texto: 'Qual é o seu e-mail?',
      variavel: 'email',
      validacao: 'email',
      campoContato: 'email',
      tentativas: 3,
    },
  },
  {
    tipo: 'condicao',
    rotulo: 'Se… então',
    grupo: 'logica',
    descricao:
      'Cada ramo tem uma condição em `ramo.config` (`{ condicao }` ou `{ condicoes: [...] }`, todas valem). Tipos: variavel, campo_contato, horario, etiqueta, canal. O ramo sem condição é o "senão".',
    ramos: 'condicoes',
    esperaResposta: false,
    exemplo: {},
  },
  {
    tipo: 'acao.etiquetar',
    rotulo: 'Etiquetar o contato',
    grupo: 'acao',
    descricao: 'Adiciona e/ou remove etiquetas do contato.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: { adicionar: ['Lead do chatbot'], remover: [] },
  },
  {
    tipo: 'acao.definir_campo',
    rotulo: 'Definir campo do contato',
    grupo: 'acao',
    descricao:
      'Grava o valor (com variáveis) em nome, email, telefone, cargo ou campos.<chave>.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: { campo: 'campos.interesse', valor: '{{variaveis.assunto}}' },
  },
  {
    tipo: 'acao.mover_fila',
    rotulo: 'Mover para a fila',
    grupo: 'acao',
    descricao:
      'Muda a conversa de fila e distribui pela estratégia da fila (`distribuir`, padrão true).',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: { filaId: '<id da fila>', distribuir: true },
  },
  {
    tipo: 'acao.atribuir',
    rotulo: 'Atribuir a uma pessoa',
    grupo: 'acao',
    descricao: 'Atribui a conversa a um usuário ativo.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: { usuarioId: '<id do usuário>' },
  },
  {
    tipo: 'acao.criar_negocio',
    rotulo: 'Criar negócio',
    grupo: 'acao',
    descricao:
      'Cria (ou reconverte) o negócio do contato no funil/etapa (padrão: funil base da área da fila, primeira etapa aberta) e liga à conversa.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: {
      funilId: '<id do funil>',
      etapaId: '<id da etapa>',
      titulo: '{{contato.nome}} — chatbot',
    },
  },
  {
    tipo: 'acao.criar_atividade',
    rotulo: 'Criar atividade',
    grupo: 'acao',
    descricao:
      'Cria uma atividade para o responsável da conversa (ou do contato); `prazoHoras` padrão 24.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: {
      tipo: 'LIGACAO',
      titulo: 'Ligar para {{contato.nome}}',
      prazoHoras: 4,
    },
  },
  {
    tipo: 'acao.webhook',
    rotulo: 'Chamar webhook',
    grupo: 'acao',
    descricao:
      'POST JSON para a URL (mesma proteção contra rede interna dos webhooks de saída). `salvarEm` guarda o começo da resposta numa variável.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: {
      url: 'https://exemplo.com/gancho',
      cabecalhos: { Authorization: 'Bearer …' },
    },
  },
  {
    tipo: 'transferir',
    rotulo: 'Transferir para a equipe',
    grupo: 'fim',
    descricao:
      'Avisa o contato (opcional), deixa o resumo das respostas como nota interna, move/atribui e encerra o fluxo.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: {
      mensagem: 'Vou chamar um atendente. Um momento!',
      filaId: '<id da fila>',
      incluirResumo: true,
    },
  },
  {
    tipo: 'acao.passar_para_ia',
    rotulo: 'Passar para a IA (SDR)',
    grupo: 'fim',
    descricao:
      'Encerra o fluxo e entrega a conversa ao SDR com IA do canal (R31): a IA continua a partir daqui, apresenta-se e conduz a qualificação. Sem efeito se o SDR estiver desligado no canal (a conversa segue com a equipe).',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: {},
  },
  {
    tipo: 'aguardar',
    rotulo: 'Aguardar',
    grupo: 'logica',
    descricao: '`{ quantidade, unidade: minutos|horas|dias }` ou `{ ate }`.',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: { quantidade: 5, unidade: 'minutos' },
  },
  {
    tipo: 'encerrar',
    rotulo: 'Encerrar',
    grupo: 'fim',
    descricao: 'Termina o fluxo (a conversa segue com a equipe).',
    ramos: 'nenhum',
    esperaResposta: false,
    exemplo: { motivo: 'concluida' },
  },
];
