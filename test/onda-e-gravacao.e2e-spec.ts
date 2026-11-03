import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { CLIENTE_ANTHROPIC } from '../src/bi/analise/cliente-anthropic';
import type { Ligacao, Usuario } from '../src/generated/prisma/client';
import { FILA_FINALIZAR_GRAVACAO } from '../src/ligacoes/gravacao/gravacao.constantes';
import { ClienteWhisper } from '../src/transcricao/cliente-whisper';
import { TranscricaoService } from '../src/transcricao/transcricao.service';
import { RetencaoDeGravacoesService } from '../src/ligacoes/gravacao/retencao-de-gravacoes.service';
import {
  type AudioConvertido,
  ProcessadorDeAudio,
} from '../src/transcricao/processador-de-audio';
import {
  FILA_PROCESSAR_LIGACAO,
  FILA_RESUMIR_LIGACAO,
} from '../src/transcricao/transcricao.constantes';
import {
  type AppTeste,
  type ClienteHttp,
  conectarTempoReal,
  criarAppTeste,
  criarCanal,
  criarContato,
  criarConversa,
  criarEquipe,
  criarFila,
  criarUsuario,
  drenarFilas,
  drenarTudo,
  entrarComo,
  esperarEvento,
  fecharSockets,
  ORIGEM_DE_TESTE,
} from './utils';
import { ClienteAnthropicFalso, erroDaApi } from './utils/anthropic-falso';

const WEBM = (corpo: string): Buffer =>
  Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(corpo)]);
const RESUMO = {
  assunto: 'Valor do plano anual',
  pontosPrincipais: ['Cliente pediu o valor do plano anual e desconto.'],
  combinados: ['Atendente envia a proposta amanhã.'],
  proximosPassos: ['Atendente retorna a ligação na sexta.'],
  sentimento: 'positivo',
  sentimentoMotivo: 'O cliente agradeceu o atendimento.',
  sugestoesDeAtividade: [
    {
      titulo: 'Enviar a proposta anual',
      descricao: 'Com o desconto combinado.',
      tipo: 'TAREFA',
      prazoEmDias: 1,
    },
    {
      titulo: 'Retornar a ligação na sexta',
      descricao: 'Confirmar o fechamento.',
      tipo: 'LIGACAO',
      prazoEmDias: 4,
    },
  ],
};

/** whisper-server falso em processo: responde por canal (esquerdo = atendente, direito = cliente). */
async function subirWhisperFalso() {
  const estado = {
    modo: 'ok' as 'ok' | '500' | 'fora',
    pedidos: [] as string[],
    saude: 200,
    atrasoMs: 0,
  };
  const servidor: Server = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (p: Buffer) => partes.push(p));
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(estado.saude).end('{"status":"ok"}');
        return;
      }
      const corpo = Buffer.concat(partes).toString('latin1');
      const canal = /filename="(esquerdo|direito)\.wav"/.exec(corpo)?.[1];
      estado.pedidos.push(canal ?? '?');
      if (estado.atrasoMs > 0) {
        setTimeout(() => responder(), estado.atrasoMs);
      } else {
        responder();
      }
      function responder() {
        if (estado.modo === '500') {
          res.writeHead(500).end('erro');
          return;
        }
        const segmentos =
          canal === 'esquerdo'
            ? [
                {
                  start: 0,
                  end: 3,
                  text: ' Bom dia, aqui é da BRL. Em que posso ajudar?',
                },
                {
                  start: 12,
                  end: 16,
                  text: ' Combinado, envio a proposta amanhã e retorno a ligação na sexta.',
                },
              ]
            : [
                {
                  start: 3.5,
                  end: 9,
                  text: ' Oi, queria saber o valor do plano anual, preciso de desconto.',
                },
                {
                  start: 16.5,
                  end: 20,
                  text: ' Fechado, obrigado pelo atendimento, muito bom.',
                },
                { start: 21, end: 22, text: ' [BLANK_AUDIO]' },
              ];
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ language: 'portuguese', segments: segmentos }));
      }
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  return {
    estado,
    url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
    fechar: () => new Promise<void>((ok) => servidor.close(() => ok())),
  };
}

/** ffmpeg falso: grava arquivos de mentira e devolve 2 canais e 42 s. */
class ProcessadorFalso extends ProcessadorDeAudio {
  falhar = false;
  mono = false;
  /** Roda depois de converter e antes de devolver (simula um processamento demorado). */
  aoConverter: (() => Promise<void>) | null = null;
  entradas: Buffer[] = [];
  async converter(entrada: string, pasta: string): Promise<AudioConvertido> {
    if (this.falhar) {
      throw new Error('ffmpeg falhou (erro)');
    }
    this.entradas.push(await readFile(entrada));
    const ogg = join(pasta, 'ouvir.ogg');
    const esquerdo = join(pasta, 'esquerdo.wav');
    const direito = join(pasta, 'direito.wav');
    await writeFile(ogg, Buffer.from('OggS-0123456789-abcdefghij-KLMNOP'));
    await writeFile(esquerdo, Buffer.from('RIFF-esquerdo'));
    await writeFile(direito, Buffer.from('RIFF-direito'));
    await this.aoConverter?.();
    return {
      duracaoSegundos: 42,
      canais: this.mono ? 1 : 2,
      ogg,
      esquerdo,
      direito: this.mono ? null : direito,
    };
  }
}

describe('Onda E — gravação, transcrição e resumo das ligações (R30)', () => {
  let t: AppTeste;
  let whisper: Awaited<ReturnType<typeof subirWhisperFalso>>;
  const claude = new ClienteAnthropicFalso();
  const audio = new ProcessadorFalso();

  let atendente: Usuario;
  let colega: Usuario;
  let lider: Usuario;
  let cLevel: Usuario;
  let admin: Usuario;
  let marketing: Usuario;
  let cs: Usuario;
  let canalId: string;
  let contatoId: string;
  let conversaId: string;
  let contador = 0;

  beforeAll(async () => {
    whisper = await subirWhisperFalso();
    t = await criarAppTeste({
      variaveis: {
        TRANSCRICAO_URL: whisper.url,
        WHISPER_MODELO: 'base',
        ANTHROPIC_API_KEY: 'chave-falsa-de-teste',
      },
      ajustar: (b) =>
        b
          .overrideProvider(CLIENTE_ANTHROPIC)
          .useValue(claude)
          .overrideProvider(ProcessadorDeAudio)
          .useValue(audio),
    });
  });
  afterAll(async () => {
    await t.fechar();
    await whisper.fechar();
  });

  beforeEach(async () => {
    await t.limparBanco();
    claude.limpar();
    claude.enfileirar({ tipo: 'resposta', corpo: RESUMO });
    audio.falhar = false;
    audio.mono = false;
    audio.aoConverter = null;
    audio.entradas = [];
    whisper.estado.modo = 'ok';
    whisper.estado.saude = 200;
    whisper.estado.pedidos = [];
    whisper.estado.atrasoMs = 0;
    admin = await criarUsuario(t, { papel: 'ADMIN' });
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    atendente = comercial.membros[0];
    colega = comercial.membros[1];
    lider = comercial.lider;
    cLevel = comercial.cLevel;
    const equipeMkt = await criarEquipe(t, 'MARKETING', {
      membros: 1,
      cLevel: comercial.cLevel,
    });
    marketing = equipeMkt.membros[0];
    cs = (await criarEquipe(t, 'CS', { membros: 1, cLevel: comercial.cLevel }))
      .membros[0];
    const fila = await criarFila(t, { nome: 'Comercial', area: 'COMERCIAL' });
    const canal = await criarCanal(t, {
      tipo: 'WHATSAPP_OFICIAL',
      nome: 'WhatsApp oficial',
      filaPadrao: fila,
    });
    canalId = canal.id;
    await t.prisma.canalLigacaoConfig.create({
      data: { canalId, ativa: true, gravar: true },
    });
    const contato = await criarContato(t, {
      nome: 'Maria da Silva',
      telefone: '5511999990001',
    });
    contatoId = contato.id;
    const conversa = await criarConversa(t, {
      canal,
      contato,
      fila,
      responsavel: atendente,
    });
    conversaId = conversa.id;
  });

  async function novaLigacao(
    dados: Partial<{
      estado: 'EM_ANDAMENTO' | 'ENCERRADA';
      gravar: boolean;
      encerradaHaSegundos: number;
      atendente: Usuario;
    }> = {},
  ): Promise<Ligacao> {
    contador++;
    const estado = dados.estado ?? 'EM_ANDAMENTO';
    // Só uma ligação ativa por atendente: a anterior terminou agora há pouco.
    await t.prisma.ligacao.updateMany({
      where: {
        atendenteId: (dados.atendente ?? atendente).id,
        estado: { in: ['CHAMANDO', 'TOCANDO', 'EM_ANDAMENTO'] },
      },
      data: { estado: 'ENCERRADA', encerradaEm: new Date(Date.now() - 5000) },
    });
    return t.prisma.ligacao.create({
      data: {
        canalId,
        contatoId,
        conversaId,
        direcao: 'RECEBIDA',
        estado,
        atendenteId: (dados.atendente ?? atendente).id,
        tocouPara: [(dados.atendente ?? atendente).id],
        idMeta: `wacid.GRAVACAO${contador}`,
        telefone: '5511999990001',
        atendidaEm: new Date(Date.now() - 60_000),
        encerradaEm:
          estado === 'ENCERRADA'
            ? new Date(Date.now() - (dados.encerradaHaSegundos ?? 5) * 1000)
            : null,
        duracaoSegundos: estado === 'ENCERRADA' ? 42 : null,
        gravar: dados.gravar ?? true,
      },
    });
  }

  const enviarParte = (
    cliente: ClienteHttp,
    ligacaoId: string,
    sequencia: number | string,
    corpo: Buffer,
    tipo = 'audio/webm',
  ) =>
    request(t.servidor)
      .post(`/api/v1/ligacoes/${ligacaoId}/gravacao/partes/${sequencia}`)
      .set('Origin', ORIGEM_DE_TESTE)
      .set('Cookie', cliente.cookie ?? '')
      .set('Content-Type', tipo)
      .send(corpo);

  /** Grava, finaliza e processa tudo (transcrição e resumo). */
  async function gravarEProcessar(cliente: ClienteHttp, ligacao: Ligacao) {
    await enviarParte(cliente, ligacao.id, 0, WEBM('AAAA')).expect(200);
    await enviarParte(cliente, ligacao.id, 1, Buffer.from('BBBB')).expect(200);
    await cliente
      .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {
        totalPartes: 2,
      })
      .expect(200);
    await drenarTudo(t);
  }

  const detalhe = async (cliente: ClienteHttp, id: string) =>
    (await cliente.get(`/api/v1/ligacoes/${id}`).expect(200)).body;

  describe('partes da gravação', () => {
    it('cenário 233 — R30.1 — guarda as partes, é idempotente por sequência e conta as partes', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      const primeira = await enviarParte(
        cliente,
        ligacao.id,
        0,
        WEBM('AAAA'),
      ).expect(200);
      expect(primeira.body).toEqual({
        sequencia: 0,
        duplicada: false,
        partes: 1,
      });
      const repetida = await enviarParte(
        cliente,
        ligacao.id,
        0,
        WEBM('AAAA'),
      ).expect(200);
      expect(repetida.body).toEqual({
        sequencia: 0,
        duplicada: true,
        partes: 1,
      });
      const segunda = await enviarParte(
        cliente,
        ligacao.id,
        1,
        Buffer.from('BBBB'),
      ).expect(200);
      expect(segunda.body.partes).toBe(2);
      // Outra parte com o mesmo número: a primeira vale e o navegador é avisado.
      const diferente = await enviarParte(
        cliente,
        ligacao.id,
        1,
        Buffer.from('CCCC'),
      ).expect(409);
      expect(diferente.body.detalhes).toMatchObject({
        regra: 'R30',
        motivo: 'parte_diferente',
      });
      const depois = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacao.id },
      });
      expect(depois.gravacaoSituacao).toBe('ENVIANDO');
      expect(
        await t.prisma.ligacaoGravacaoParte.count({
          where: { ligacaoId: ligacao.id },
        }),
      ).toBe(2);
      const dto = await detalhe(cliente, ligacao.id);
      expect(dto.gravacao).toMatchObject({
        situacao: 'enviando',
        disponivel: false,
        podeBaixar: false,
      });
      expect(dto.transcricao.situacao).toBeNull();
    });

    it('cenário 234 — R30.1 — recusa parte de outro atendente, fora da ligação, sem gravação, vazia, enorme ou sem cabeçalho webm', async () => {
      const dono = await entrarComo(t, atendente);
      const outro = await entrarComo(t, colega);
      const ligacao = await novaLigacao();
      // Quem não é o atendente nem sabe que a ligação existe.
      await enviarParte(outro, ligacao.id, 0, WEBM('A')).expect(404);
      await enviarParte(
        await entrarComo(t, admin),
        ligacao.id,
        0,
        WEBM('A'),
      ).expect(404);
      // Corpo vazio, grande demais, primeira parte que não é webm e sequência inválida.
      await enviarParte(dono, ligacao.id, 0, Buffer.alloc(0)).expect(400);
      await enviarParte(
        dono,
        ligacao.id,
        0,
        Buffer.alloc(4 * 1024 * 1024 + 1, 1),
      ).expect(413);
      await enviarParte(
        dono,
        ligacao.id,
        0,
        Buffer.from('texto qualquer'),
      ).expect(400);
      await enviarParte(dono, ligacao.id, 'abc', WEBM('A')).expect(400);
      await enviarParte(dono, ligacao.id, 20001, WEBM('A')).expect(400);
      // Canal sem gravação.
      const semGravar = await novaLigacao({ gravar: false });
      const r = await enviarParte(dono, semGravar.id, 0, WEBM('A')).expect(409);
      expect(r.body.detalhes.motivo).toBe('gravacao_desativada');
      // Ligação que ainda toca ou terminou há tempo demais.
      const tocando = await t.prisma.ligacao.update({
        where: { id: (await novaLigacao()).id },
        data: { estado: 'CHAMANDO' },
      });
      await enviarParte(dono, tocando.id, 0, WEBM('A')).expect(409);
      const antiga = await novaLigacao({
        estado: 'ENCERRADA',
        encerradaHaSegundos: 600,
      });
      const tarde = await enviarParte(dono, antiga.id, 0, WEBM('A')).expect(
        409,
      );
      expect(tarde.body.detalhes.motivo).toBe('ligacao_fora_de_andamento');
      // Recém-encerrada: ainda aceita (tolerância curta).
      const recente = await novaLigacao({
        estado: 'ENCERRADA',
        encerradaHaSegundos: 10,
      });
      await enviarParte(dono, recente.id, 0, WEBM('A')).expect(200);
      await request(t.servidor)
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/partes/0`)
        .set('Origin', ORIGEM_DE_TESTE)
        .send(WEBM('A'))
        .expect(401);
    });

    it('cenário 235 — R30.1 — respeita o tamanho máximo da gravação', async () => {
      const dono = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await enviarParte(dono, ligacao.id, 0, WEBM('A')).expect(200);
      // Simula uma gravação quase no limite de 200 MB.
      await t.prisma.ligacaoGravacaoParte.update({
        where: { ligacaoId_sequencia: { ligacaoId: ligacao.id, sequencia: 0 } },
        data: { tamanho: t.ambiente.transcricao.gravacaoMaxBytes - 2 },
      });
      const r = await enviarParte(
        dono,
        ligacao.id,
        1,
        Buffer.from('BBBBBB'),
      ).expect(413);
      expect(r.body.detalhes.regra).toBe('R30');
    });
  });

  describe('finalizar e processar', () => {
    it('cenário 236 — R30.2 — junta as partes na ordem, guarda o webm original e apaga as partes', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      // Fora de ordem: o que vale é a sequência.
      await enviarParte(cliente, ligacao.id, 2, Buffer.from('CC')).expect(200);
      await enviarParte(cliente, ligacao.id, 0, WEBM('AA')).expect(200);
      await enviarParte(cliente, ligacao.id, 1, Buffer.from('BB')).expect(200);
      const r = await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {
          totalPartes: 3,
        })
        .expect(200);
      expect(r.body).toEqual({
        gravacao: 'enviando',
        partes: 3,
        jaFinalizada: false,
      });
      const gravada = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacao.id },
      });
      expect(gravada.gravacaoTotalPartes).toBe(3);
      expect(gravada.transcricaoSituacao).toBe('PENDENTE');
      expect(gravada.resumoSituacao).toBe('PENDENTE');
      const arquivo = await t.prisma.arquivo.findUniqueOrThrow({
        where: { id: gravada.gravacaoOriginalArquivoId! },
      });
      expect(arquivo).toMatchObject({
        contexto: 'LIGACAO',
        mime: 'audio/webm',
      });
      expect(t.arquivos.conteudoDe(arquivo.chave)).toEqual(
        Buffer.concat([WEBM('AA'), Buffer.from('BBCC')]),
      );
      // As partes saíram do banco e do armazenamento.
      expect(await t.prisma.ligacaoGravacaoParte.count()).toBe(0);
      expect(
        t.arquivos.conteudoDe(`ligacoes/${ligacao.id}/partes/0`),
      ).toBeUndefined();
      // Segunda chamada (sendBeacon depois do fetch): nada muda.
      const repetida = await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar?totalPartes=3`)
        .expect(200);
      expect(repetida.body.jaFinalizada).toBe(true);
      expect(
        await t.prisma.arquivo.count({ where: { contexto: 'LIGACAO' } }),
      ).toBe(1);
      // Já finalizada: parte nova é recusada.
      await enviarParte(cliente, ligacao.id, 3, Buffer.from('DD')).expect(409);
      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'ligacao.gravacao-finalizada' },
      });
      expect(auditoria).toHaveLength(1);
    });

    it('R30.9 — o atendente não baixa o webm original por GET /arquivos/:id (só pelas rotas do áudio)', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const gravada = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacao.id },
      });
      for (const arquivoId of [
        gravada.gravacaoOriginalArquivoId,
        gravada.gravacaoArquivoId,
      ]) {
        expect(arquivoId).not.toBeNull();
        await cliente.get(`/api/v1/arquivos/${arquivoId}`).expect(404);
      }
      await cliente
        .get(`/api/v1/ligacoes/${ligacao.id}/audio?versao=original`)
        .expect(200);
    });

    it('cenário 237 — R30.2 — finalizar sem partes não grava nada; só o atendente finaliza', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      const r = await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {})
        .expect(200);
      expect(r.body).toMatchObject({ gravacao: 'sem', partes: 0 });
      expect(await t.prisma.arquivo.count()).toBe(0);
      await (
        await entrarComo(t, colega)
      )
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {})
        .expect(404);
      const sem = await novaLigacao({ gravar: false });
      await cliente
        .post(`/api/v1/ligacoes/${sem.id}/gravacao/finalizar`, {})
        .expect(409);
    });

    it('cenário 238 — R30.2 — sem a primeira parte não há cabeçalho: a gravação falha com mensagem clara', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await t.prisma.ligacaoGravacaoParte.create({
        data: {
          ligacaoId: ligacao.id,
          sequencia: 3,
          chave: 'ligacoes/x/partes/3',
          tamanho: 2,
          sha256: 'a'.repeat(64),
        },
      });
      const r = await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {})
        .expect(200);
      expect(r.body.gravacao).toBe('falhou');
      const dto = await detalhe(cliente, ligacao.id);
      expect(dto.gravacao.situacao).toBe('falhou');
      expect(dto.gravacao.erro).toContain('primeira parte');
    });

    it('cenário 239 — R30.2 — se a aba fechar, a fila finaliza sozinha com o que subiu', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao({
        estado: 'ENCERRADA',
        encerradaHaSegundos: 5,
      });
      await enviarParte(cliente, ligacao.id, 0, WEBM('AA')).expect(200);
      await enviarParte(cliente, ligacao.id, 1, Buffer.from('BB')).expect(200);
      await t.fila.enviar(FILA_FINALIZAR_GRAVACAO, { ligacaoId: ligacao.id });
      await drenarFilas(t, FILA_FINALIZAR_GRAVACAO);
      const gravada = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacao.id },
      });
      expect(gravada.gravacaoFinalizadaEm).not.toBeNull();
      expect(gravada.gravacaoOriginalArquivoId).not.toBeNull();
      expect(gravada.gravacaoTotalPartes).toBe(2);
      await drenarTudo(t);
      expect((await detalhe(cliente, ligacao.id)).gravacao.situacao).toBe(
        'pronta',
      );
    });

    it('R30.1 — a parte que chega depois da finalização é recusada e o objeto dela não fica no armazenamento', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await enviarParte(cliente, ligacao.id, 0, WEBM('AAAA')).expect(200);
      const gravar = t.arquivos.gravar.bind(t.arquivos);
      const espiao = jest
        .spyOn(t.arquivos, 'gravar')
        .mockImplementation(async (chave, partes, meta) => {
          await gravar(chave, partes, meta);
          if (chave.endsWith('/partes/1')) {
            espiao.mockRestore();
            // A aba fecha: o "finalizar" corre enquanto a parte 1 ainda é gravada.
            await cliente
              .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {
                totalPartes: 1,
              })
              .expect(200);
          }
        });
      const atrasada = await enviarParte(
        cliente,
        ligacao.id,
        1,
        Buffer.from('BBBB'),
      );
      espiao.mockRestore();
      expect(atrasada.status).toBe(409);
      expect(atrasada.body.detalhes.motivo).toBe('gravacao_finalizada');
      expect(
        await t.prisma.ligacaoGravacaoParte.count({
          where: { ligacaoId: ligacao.id },
        }),
      ).toBe(0);
      // Só o webm juntado ficou; nenhuma parte solta.
      expect(t.arquivos.quantidade).toBe(1);
    });

    it('cenário 240 — R30.3 — converte, transcreve cada canal, intercala por tempo e resume; avisa em tempo real', async () => {
      const cliente = await entrarComo(t, atendente);
      const socket = await conectarTempoReal(t, cliente);
      try {
        const ligacao = await novaLigacao();
        const transcricaoPronta = esperarEvento(
          socket,
          'ligacao.processada',
          5000,
        );
        await enviarParte(cliente, ligacao.id, 0, WEBM('AA')).expect(200);
        await cliente
          .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {
            totalPartes: 1,
          })
          .expect(200);
        await drenarFilas(t, FILA_PROCESSAR_LIGACAO);
        expect(await transcricaoPronta).toMatchObject({
          ligacaoId: ligacao.id,
          etapa: 'transcricao',
          gravacao: 'pronta',
          transcricao: 'pronta',
          resumo: 'pendente',
        });
        const resumoPronto = esperarEvento(socket, 'ligacao.processada', 5000);
        await drenarFilas(t, FILA_RESUMIR_LIGACAO);
        expect(await resumoPronto).toMatchObject({
          etapa: 'resumo',
          resumo: 'pronto',
        });
      } finally {
        fecharSockets(socket);
      }
      const ligacaoId = (await t.prisma.ligacao.findFirstOrThrow()).id;
      expect(audio.entradas[0]).toEqual(WEBM('AA'));
      expect(whisper.estado.pedidos.sort((a, b) => a.localeCompare(b))).toEqual(
        ['direito', 'esquerdo'],
      );

      const transcricao = (
        await cliente
          .get(`/api/v1/ligacoes/${ligacaoId}/transcricao`)
          .expect(200)
      ).body;
      expect(transcricao).toMatchObject({
        situacao: 'pronta',
        modelo: 'base',
        duracaoSegundos: 42,
      });
      expect(
        transcricao.trechos.map((x: { falante: string; inicio: number }) => [
          x.falante,
          x.inicio,
        ]),
      ).toEqual([
        ['atendente', 0],
        ['cliente', 3.5],
        ['atendente', 12],
        ['cliente', 16.5],
      ]);
      expect(transcricao.trechos[0].texto).toBe(
        'Bom dia, aqui é da BRL. Em que posso ajudar?',
      );
      // O ruído do Whisper ([BLANK_AUDIO]) não entra.
      expect(JSON.stringify(transcricao)).not.toContain('BLANK_AUDIO');

      const dto = await detalhe(cliente, ligacaoId);
      expect(dto.gravacao).toMatchObject({
        situacao: 'pronta',
        disponivel: true,
        duracaoSegundos: 42,
      });
      expect(dto.transcricao.situacao).toBe('pronta');
      expect(dto.resumo.situacao).toBe('pronto');
      expect(dto.resumo.conteudo).toMatchObject({
        assunto: 'Valor do plano anual',
        sentimento: 'positivo',
        modelo: 'claude-sonnet-5-5',
      });
      expect(dto.resumo.conteudo.sugestoes).toHaveLength(2);
      expect(dto.resumo.conteudo.sugestoes[0]).toMatchObject({
        atividadeId: null,
        descartadaEm: null,
      });

      // O Claude recebeu a conversa entre marcas, com o modelo configurável e saída estruturada.
      expect(claude.chamadas).toHaveLength(1);
      const chamada = claude.chamadas[0] as unknown as {
        model: string;
        output_config: { format: { type: string } };
        messages: { content: string }[];
      };
      expect(chamada.model).toBe('claude-sonnet-5-5');
      expect(chamada.output_config.format.type).toBe('json_schema');
      expect(chamada.messages[0].content).toContain('<transcricao>');
      expect(chamada.messages[0].content).toContain(
        '[0:03] Cliente:'.replace('0:03', '0:03'),
      );
      expect(chamada.messages[0].content).toContain('Atendente: Bom dia');
      // Nenhuma atividade nasce sozinha: só com a confirmação do usuário.
      expect(
        await t.prisma.atividade.count({
          where: { tipo: { in: ['TAREFA', 'EMAIL'] } },
        }),
      ).toBe(0);
    });

    it('cenário 241 — R30.3 — gravação mono: um canal só, falante "participante"', async () => {
      audio.mono = true;
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const transcricao = (
        await cliente
          .get(`/api/v1/ligacoes/${ligacao.id}/transcricao`)
          .expect(200)
      ).body;
      expect(
        new Set(transcricao.trechos.map((x: { falante: string }) => x.falante)),
      ).toEqual(new Set(['participante']));
      expect(whisper.estado.pedidos).toEqual(['esquerdo']);
    });

    it('cenário 242 — R30.4 — sem chave da Anthropic fica só a transcrição; conversa curta não é resumida', async () => {
      const cliente = await entrarComo(t, atendente);
      const sem = jest
        .spyOn(t.get(TranscricaoService), 'claudeConfigurado')
        .mockReturnValue(false);
      try {
        const ligacao = await novaLigacao();
        await gravarEProcessar(cliente, ligacao);
        const dto = await detalhe(cliente, ligacao.id);
        expect(dto.transcricao.situacao).toBe('pronta');
        expect(dto.resumo).toMatchObject({
          situacao: 'desativado',
          conteudo: null,
        });
        expect(dto.resumo.erro).toContain('Anthropic');
        expect(claude.chamadas).toHaveLength(0);
      } finally {
        sem.mockRestore();
      }
    });

    it('cenário 243 — R30.5 — falha transitória do whisper repete pela fila; ao esgotar, falha com mensagem e "Reprocessar" refaz', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      whisper.estado.modo = '500';
      await enviarParte(cliente, ligacao.id, 0, WEBM('AA')).expect(200);
      await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {})
        .expect(200);
      await drenarFilas(t, FILA_PROCESSAR_LIGACAO, { incluirAgendados: true });
      let dto = await detalhe(cliente, ligacao.id);
      expect(dto.gravacao.situacao).toBe('pronta'); // dá para ouvir mesmo sem texto
      expect(dto.transcricao.situacao).toBe('falhou');
      expect(dto.transcricao.erro).toContain('transcrição');
      expect(dto.resumo.situacao).toBe('desativado');
      expect(whisper.estado.pedidos.length).toBeGreaterThanOrEqual(2); // tentou de novo

      whisper.estado.modo = 'ok';
      await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, {})
        .expect(202);
      dto = await detalhe(cliente, ligacao.id);
      expect(dto.transcricao.situacao).toBe('pendente');
      await drenarTudo(t);
      dto = await detalhe(cliente, ligacao.id);
      expect(dto.transcricao.situacao).toBe('pronta');
      expect(dto.resumo.situacao).toBe('pronto');
      // O ogg antigo foi trocado (um só arquivo para ouvir).
      expect(
        await t.prisma.arquivo.count({
          where: { contexto: 'LIGACAO', mime: 'audio/ogg', removidoEm: null },
        }),
      ).toBe(1);
    });

    it('cenário 244 — R30.5 — se o ffmpeg não consegue ler a gravação, a gravação falha sem repetir à toa', async () => {
      audio.falhar = true;
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const dto = await detalhe(cliente, ligacao.id);
      expect(dto.gravacao).toMatchObject({
        situacao: 'falhou',
        disponivel: false,
      });
      expect(dto.gravacao.erro).toContain('converter');
      expect(whisper.estado.pedidos).toHaveLength(0);
    });

    it('cenário 245 — R30.5 — o resumo repete na falha transitória e vira "falhou" ao esgotar; "Reprocessar resumo" refaz só ele', async () => {
      const cliente = await entrarComo(t, atendente);
      claude.limpar();
      // 3 execuções do job x 2 tentativas internas da chamada = 8 pedidos com erro 529.
      for (let i = 0; i < 8; i++) {
        claude.enfileirar({ tipo: 'erro', erro: erroDaApi(529, 'sobrecarga') });
      }
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      let dto = await detalhe(cliente, ligacao.id);
      expect(dto.transcricao.situacao).toBe('pronta');
      await drenarFilas(t, FILA_RESUMIR_LIGACAO, { incluirAgendados: true });
      dto = await detalhe(cliente, ligacao.id);
      expect(dto.resumo.situacao).toBe('falhou');
      expect(dto.resumo.erro).toBeTruthy();

      claude.limpar();
      claude.enfileirar({ tipo: 'resposta', corpo: RESUMO });
      const pedidosAntes = whisper.estado.pedidos.length;
      await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, { etapa: 'resumo' })
        .expect(202);
      await drenarTudo(t, { incluirAgendados: true });
      dto = await detalhe(cliente, ligacao.id);
      expect(dto.resumo.situacao).toBe('pronto');
      expect(whisper.estado.pedidos.length).toBe(pedidosAntes); // não transcreveu de novo
    });

    it('cenário 246 — R30.6 — "Reprocessar": só o atendente, Admin e líderes; recusa o que está processando ou sem gravação', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      // O C-level vê tudo (R12), mas só o atendente, o Admin e os líderes reprocessam.
      const negado = await (
        await entrarComo(t, cLevel)
      )
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, {})
        .expect(403);
      expect(negado.body.detalhes.regra).toBe('R30');
      // Colega da fila que não é o responsável da conversa não a vê (R12): 404.
      await (
        await entrarComo(t, colega)
      )
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, {})
        .expect(404);
      // Quem não vê a ligação nem sabe que existe.
      await (
        await entrarComo(t, marketing)
      )
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, {})
        .expect(404);
      await (
        await entrarComo(t, lider)
      )
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, { etapa: 'resumo' })
        .expect(202);
      await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, { etapa: 'outra' })
        .expect(400);
      // Pendente (ainda na fila): o job registrado é o mesmo, sem duplicar.
      await drenarTudo(t);
      await t.prisma.ligacao.update({
        where: { id: ligacao.id },
        data: { transcricaoSituacao: 'PROCESSANDO' },
      });
      const emAndamento = await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, {})
        .expect(409);
      expect(emAndamento.body.detalhes.motivo).toBe('em_processamento');
      const sem = await novaLigacao();
      const semGravacao = await cliente
        .post(`/api/v1/ligacoes/${sem.id}/reprocessar`, {})
        .expect(409);
      expect(semGravacao.body.detalhes.motivo).toBe('sem_gravacao');
    });

    it('cenário 247 — R30.7 — com a transcrição desligada, só a versão para ouvir; "Reprocessar" não liga o que está desligado', async () => {
      const desligada = jest
        .spyOn(t.get(ClienteWhisper), 'ligado', 'get')
        .mockReturnValue(false);
      try {
        const cliente = await entrarComo(t, atendente);
        const ligacao = await novaLigacao();
        await gravarEProcessar(cliente, ligacao);
        const dto = await detalhe(cliente, ligacao.id);
        expect(dto.gravacao).toMatchObject({
          situacao: 'pronta',
          disponivel: true,
        });
        expect(dto.transcricao.situacao).toBe('desativada');
        expect(dto.resumo.situacao).toBe('desativado');
        expect(whisper.estado.pedidos).toHaveLength(0);
        expect(claude.chamadas).toHaveLength(0);
        await cliente.get(`/api/v1/ligacoes/${ligacao.id}/audio`).expect(200);
      } finally {
        desligada.mockRestore();
      }
    });
  });

  describe('apagar durante o processamento (correção E4)', () => {
    async function prepararFinalizada(): Promise<{
      cliente: ClienteHttp;
      ligacao: Ligacao;
    }> {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await enviarParte(cliente, ligacao.id, 0, WEBM('AAAA')).expect(200);
      await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {
          totalPartes: 1,
        })
        .expect(200);
      return { cliente, ligacao };
    }
    const anonimizar = async () =>
      (await entrarComo(t, admin))
        .post(`/api/v1/contatos/${contatoId}/anonimizar`, {})
        .expect(204);
    async function esperarAte(condicao: () => boolean): Promise<void> {
      for (let i = 0; i < 400 && !condicao(); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(condicao()).toBe(true);
    }
    async function conferirNadaRestou(ligacaoId: string): Promise<void> {
      const depois = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacaoId },
      });
      expect(depois).toMatchObject({
        gravacaoArquivoId: null,
        gravacaoOriginalArquivoId: null,
        gravacaoSituacao: 'SEM',
        transcricao: null,
        transcricaoSituacao: null,
        resumo: null,
        resumoSituacao: null,
      });
      expect(depois.gravacaoRemovidaEm).not.toBeNull();
      expect(
        await t.prisma.arquivo.count({
          where: { contexto: 'LIGACAO', removidoEm: null },
        }),
      ).toBe(0);
    }

    it('R30.12 — anonimizar durante a conversão do áudio: o ogg novo não é guardado e nada é transcrito', async () => {
      const { ligacao } = await prepararFinalizada();
      audio.aoConverter = async () => {
        audio.aoConverter = null;
        await anonimizar();
      };
      await drenarTudo(t);
      await conferirNadaRestou(ligacao.id);
      expect(whisper.estado.pedidos).toHaveLength(0);
      expect(claude.chamadas).toHaveLength(0);
    });

    it('R30.12 — anonimizar durante a transcrição: a transcrição pronta não volta e o resumo não é pedido', async () => {
      const { ligacao } = await prepararFinalizada();
      whisper.estado.atrasoMs = 300;
      const processando = drenarFilas(t, FILA_PROCESSAR_LIGACAO);
      await esperarAte(() => whisper.estado.pedidos.length > 0);
      await anonimizar();
      await processando;
      await drenarTudo(t);
      await conferirNadaRestou(ligacao.id);
      expect(claude.chamadas).toHaveLength(0);
    });

    it('R30.12 — anonimizar durante o resumo: o resumo do Claude não é gravado', async () => {
      const { ligacao } = await prepararFinalizada();
      await drenarFilas(t, FILA_PROCESSAR_LIGACAO);
      claude.atrasoMs = 100;
      const resumindo = drenarFilas(t, FILA_RESUMIR_LIGACAO);
      await esperarAte(() => claude.chamadas.length > 0);
      await anonimizar();
      await resumindo;
      await drenarTudo(t);
      await conferirNadaRestou(ligacao.id);
    });

    it('R30.11 — a guarda vencida durante o "Reprocessar": a gravação reprocessada não volta', async () => {
      const { cliente, ligacao } = await prepararFinalizada();
      await drenarTudo(t);
      await t.prisma.ligacao.update({
        where: { id: ligacao.id },
        data: {
          estado: 'ENCERRADA',
          encerradaEm: new Date(Date.now() - 400 * 86_400_000),
          duracaoSegundos: 42,
        },
      });
      await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/reprocessar`, {})
        .expect(202);
      audio.aoConverter = async () => {
        audio.aoConverter = null;
        expect(await t.get(RetencaoDeGravacoesService).executar()).toBe(1);
      };
      await drenarFilas(t, FILA_PROCESSAR_LIGACAO);
      await drenarTudo(t);
      const depois = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacao.id },
      });
      expect(depois).toMatchObject({
        gravacaoArquivoId: null,
        gravacaoOriginalArquivoId: null,
        transcricao: null,
        transcricaoSituacao: null,
        gravacaoSituacao: 'SEM',
      });
      expect(
        await t.prisma.arquivo.count({
          where: { contexto: 'LIGACAO', removidoEm: null },
        }),
      ).toBe(0);
    });
  });

  describe('leitura, privacidade e auditoria', () => {
    it('cenário 248 — R30.8 — áudio com Range (206/416), cabeçalhos seguros e auditoria só da reprodução inteira', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const url = `/api/v1/ligacoes/${ligacao.id}/audio`;
      const inteiro = await cliente.get(url).buffer(true).expect(200);
      expect(inteiro.headers['content-type']).toContain('audio/ogg');
      expect(inteiro.headers['accept-ranges']).toBe('bytes');
      expect(inteiro.headers['content-disposition']).toContain('inline');
      expect(inteiro.headers['cache-control']).toContain('no-store');
      expect(inteiro.headers['x-content-type-options']).toBe('nosniff');
      const conteudo = Buffer.from('OggS-0123456789-abcdefghij-KLMNOP');
      expect(inteiro.body).toEqual(conteudo);

      const faixa = await cliente
        .get(url)
        .set('Range', 'bytes=5-9')
        .buffer(true)
        .expect(206);
      expect(faixa.headers['content-range']).toBe(
        `bytes 5-9/${conteudo.length}`,
      );
      expect(faixa.body).toEqual(conteudo.subarray(5, 10));
      const aberta = await cliente
        .get(url)
        .set('Range', 'bytes=20-')
        .buffer(true)
        .expect(206);
      expect(aberta.body).toEqual(conteudo.subarray(20));
      const inicio = await cliente
        .get(url)
        .set('Range', 'bytes=0-3')
        .buffer(true)
        .expect(206);
      expect(inicio.body).toEqual(conteudo.subarray(0, 4));
      await cliente.get(url).set('Range', 'bytes=999-1000').expect(416);

      // Auditoria: a reprodução inteira e a que recomeça do byte 0, não cada Range do player.
      const reproducoes = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'ligacao.gravacao-reproduzida' },
      });
      expect(reproducoes).toHaveLength(2);
      expect(reproducoes[0].usuarioId).toBe(atendente.id);

      const versao = await cliente
        .get(`${url}?versao=original`)
        .buffer(true)
        .expect(200);
      expect(versao.headers['content-type']).toContain('audio/webm');
      await cliente.get(`${url}?versao=xyz`).expect(400);
    });

    it('R30.9 — um Range que pula o começo também é auditado (uma vez por janela); baixar audita todo pedido', async () => {
      const cliente = await entrarComo(t, atendente);
      const lideranca = await entrarComo(t, lider);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const url = `/api/v1/ligacoes/${ligacao.id}/audio`;
      const contar = (acao: string) =>
        t.prisma.eventoAuditoria.count({ where: { acao } });
      // Pedir "bytes=1-" para não começar no 0 não escapa do registro.
      await cliente.get(url).set('Range', 'bytes=1-').buffer(true).expect(206);
      expect(await contar('ligacao.gravacao-reproduzida')).toBe(1);
      // Os pedidos seguintes do mesmo player, dentro da janela, não repetem o registro.
      await cliente.get(url).set('Range', 'bytes=5-9').buffer(true).expect(206);
      expect(await contar('ligacao.gravacao-reproduzida')).toBe(1);
      // A versão original é outra reprodução.
      await cliente
        .get(`${url}?versao=original`)
        .set('Range', 'bytes=1-')
        .buffer(true)
        .expect(206);
      expect(await contar('ligacao.gravacao-reproduzida')).toBe(2);
      // Download: todo pedido, qualquer Range.
      const baixar = `${url}/baixar`;
      await lideranca
        .get(baixar)
        .set('Range', 'bytes=1-')
        .buffer(true)
        .expect(206);
      await lideranca
        .get(baixar)
        .set('Range', 'bytes=3-4')
        .buffer(true)
        .expect(206);
      expect(await contar('ligacao.gravacao-baixada')).toBe(2);
    });

    it('cenário 249 — R30.9 — quem vê a conversa ou o contato ouve e lê; os outros recebem 404; baixar só Admin e líderes', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const rotas = (id: string) => [
        `/api/v1/ligacoes/${id}`,
        `/api/v1/ligacoes/${id}/audio`,
        `/api/v1/ligacoes/${id}/transcricao`,
      ];
      // Atendente, líder da área, C-level e Admin: ouvem e leem.
      for (const quem of [atendente, lider, cLevel, admin]) {
        const http = await entrarComo(t, quem);
        for (const rota of rotas(ligacao.id)) {
          await http.get(rota).expect(200);
        }
      }
      // Marketing e CS não veem a conversa nem têm o contato: 404, sem revelar que existe.
      for (const quem of [marketing, cs, colega]) {
        const http = await entrarComo(t, quem);
        for (const rota of rotas(ligacao.id).slice(1)) {
          await http.get(rota).expect(404);
        }
      }
      // Quem tem o contato no alcance (responsável) lê, mesmo sem a conversa.
      await t.prisma.contato.update({
        where: { id: contatoId },
        data: { responsavelId: marketing.id },
      });
      const donoDoContato = await entrarComo(t, marketing);
      await donoDoContato
        .get(`/api/v1/ligacoes/${ligacao.id}/transcricao`)
        .expect(200);
      await donoDoContato
        .get(`/api/v1/ligacoes/${ligacao.id}/audio`)
        .expect(200);
      await donoDoContato
        .get(`/api/v1/ligacoes/${ligacao.id}/audio/baixar`)
        .expect(403);

      // Baixar: membro nem o atendente; líder e Admin sim, como anexo e auditado.
      const negado = await cliente
        .get(`/api/v1/ligacoes/${ligacao.id}/audio/baixar`)
        .expect(403);
      expect(negado.body.detalhes.regra).toBe('R30');
      expect((await detalhe(cliente, ligacao.id)).gravacao.podeBaixar).toBe(
        false,
      );
      const doLider = await entrarComo(t, lider);
      const baixado = await doLider
        .get(`/api/v1/ligacoes/${ligacao.id}/audio/baixar`)
        .buffer(true)
        .expect(200);
      expect(baixado.headers['content-disposition']).toContain('attachment');
      expect((await detalhe(doLider, ligacao.id)).gravacao.podeBaixar).toBe(
        true,
      );
      await (
        await entrarComo(t, admin)
      )
        .get(`/api/v1/ligacoes/${ligacao.id}/audio/baixar`)
        .expect(200);
      const downloads = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'ligacao.gravacao-baixada' },
      });
      expect(
        downloads
          .map((e) => String(e.usuarioId))
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([lider.id, admin.id].sort((a, b) => a.localeCompare(b)));
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'ligacao.transcricao-lida' },
        }),
      ).toBeGreaterThan(0);
    });

    it('cenário 250 — R30.10 — áudio e transcrição inexistentes ainda: 404 claro', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      const semAudio = await cliente
        .get(`/api/v1/ligacoes/${ligacao.id}/audio`)
        .expect(404);
      expect(semAudio.body.detalhes.motivo).toBe('sem_gravacao');
      await cliente
        .get(`/api/v1/ligacoes/${ligacao.id}/transcricao`)
        .expect(404);
      await cliente
        .get('/api/v1/ligacoes/00000000-0000-4000-8000-000000000000/audio')
        .expect(404);
    });

    it('cenário 251 — R30.11 — a guarda vencida apaga gravação e transcrição, mantém registro, duração e resumo; a recente fica', async () => {
      const cliente = await entrarComo(t, atendente);
      const velha = await novaLigacao();
      await gravarEProcessar(cliente, velha);
      const recente = await novaLigacao();
      await gravarEProcessar(cliente, recente);
      const dias = (n: number) => new Date(Date.now() - n * 86_400_000);
      await t.prisma.ligacao.update({
        where: { id: velha.id },
        data: {
          estado: 'ENCERRADA',
          encerradaEm: dias(400),
          duracaoSegundos: 42,
        },
      });
      await t.prisma.ligacao.update({
        where: { id: recente.id },
        data: { estado: 'ENCERRADA', encerradaEm: dias(30) },
      });

      const apagadas = await t.get(RetencaoDeGravacoesService).executar();
      expect(apagadas).toBe(1);
      const depois = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: velha.id },
      });
      expect(depois).toMatchObject({
        gravacaoArquivoId: null,
        gravacaoOriginalArquivoId: null,
        transcricao: null,
        transcricaoSituacao: null,
        gravacaoSituacao: 'SEM',
        duracaoSegundos: 42,
        resumoSituacao: 'PRONTO',
      });
      expect(depois.gravacaoRemovidaEm).not.toBeNull();
      expect(depois.resumo).not.toBeNull();
      expect(
        await t.prisma.arquivo.count({
          where: { contexto: 'LIGACAO', removidoEm: { not: null } },
        }),
      ).toBe(2);
      const dto = await detalhe(cliente, velha.id);
      expect(dto.gravacao).toMatchObject({
        situacao: 'sem',
        disponivel: false,
      });
      expect(dto.gravacao.removidaEm).not.toBeNull();
      expect(dto.resumo.conteudo.assunto).toBe('Valor do plano anual');
      const audio404 = await cliente
        .get(`/api/v1/ligacoes/${velha.id}/audio`)
        .expect(404);
      expect(audio404.body.detalhes.motivo).toBe('gravacao_removida');
      await cliente.get(`/api/v1/ligacoes/${velha.id}/transcricao`).expect(404);
      await cliente
        .post(`/api/v1/ligacoes/${velha.id}/reprocessar`, {})
        .expect(409);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'ligacao.gravacao-removida' },
        }),
      ).toBe(1);
      // A recente (30 dias, guarda de 365) segue intacta.
      await cliente.get(`/api/v1/ligacoes/${recente.id}/audio`).expect(200);
      // Rodar de novo não faz nada.
      expect(await t.get(RetencaoDeGravacoesService).executar()).toBe(0);
    });

    it('cenário 252 — R30.11 — o prazo de guarda é do canal (configurável) e partes abandonadas somem', async () => {
      const cliente = await entrarComo(t, atendente);
      const admHttp = await entrarComo(t, admin);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      await t.prisma.ligacao.update({
        where: { id: ligacao.id },
        data: {
          estado: 'ENCERRADA',
          encerradaEm: new Date(Date.now() - 20 * 86_400_000),
        },
      });
      expect(await t.get(RetencaoDeGravacoesService).executar()).toBe(0);
      const alterada = await admHttp
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          retencaoDias: 7,
        })
        .expect(200);
      expect(alterada.body.retencaoDias).toBe(7);
      await admHttp
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          retencaoDias: 0,
        })
        .expect(400);
      await admHttp
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          retencaoDias: 4000,
        })
        .expect(400);
      expect(await t.get(RetencaoDeGravacoesService).executar()).toBe(1);
      // Parte abandonada há 3 dias (a aba fechou e ninguém finalizou).
      const outra = await novaLigacao();
      await enviarParte(cliente, outra.id, 0, WEBM('AA')).expect(200);
      await t.prisma.ligacaoGravacaoParte.updateMany({
        where: { ligacaoId: outra.id },
        data: { recebidaEm: new Date(Date.now() - 3 * 86_400_000) },
      });
      await t.get(RetencaoDeGravacoesService).executar();
      expect(
        await t.prisma.ligacaoGravacaoParte.count({
          where: { ligacaoId: outra.id },
        }),
      ).toBe(0);
      expect(
        t.arquivos.conteudoDe(`ligacoes/${outra.id}/partes/0`),
      ).toBeUndefined();
    });

    it('cenário 253 — R30.12 — exportar os dados do titular inclui ligações e transcrições; anonimizar apaga gravações, transcrições e resumos', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const admHttp = await entrarComo(t, admin);
      const exportado = (
        await admHttp
          .get(`/api/v1/contatos/${contatoId}/dados-pessoais`)
          .expect(200)
      ).body;
      expect(exportado.ligacoes).toHaveLength(1);
      expect(exportado.ligacoes[0]).toMatchObject({
        id: ligacao.id,
        direcao: 'RECEBIDA',
        transcricaoSituacao: 'PRONTA',
        telefone: '5511999990001',
      });
      expect(exportado.ligacoes[0].transcricao.trechos.length).toBeGreaterThan(
        0,
      );
      expect(exportado.ligacoes[0].resumo.assunto).toBe('Valor do plano anual');

      await admHttp
        .post(`/api/v1/contatos/${contatoId}/anonimizar`, {})
        .expect(204);
      const depois = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacao.id },
      });
      expect(depois).toMatchObject({
        telefone: null,
        transcricao: null,
        resumo: null,
        gravacaoArquivoId: null,
        gravacaoOriginalArquivoId: null,
        transcricaoSituacao: null,
        resumoSituacao: null,
        gravacaoSituacao: 'SEM',
      });
      expect(depois.gravacaoRemovidaEm).not.toBeNull();
      expect(
        await t.prisma.arquivo.count({
          where: { contexto: 'LIGACAO', removidoEm: null },
        }),
      ).toBe(0);
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.anonimizado' },
      });
      expect(JSON.stringify(auditoria.dados)).toContain('gravacoesApagadas');
      expect(JSON.stringify(auditoria.dados)).not.toContain('Valor do plano');
    });
  });

  describe('sugestões de atividade', () => {
    it('cenário 254 — R30.13 — a atividade só nasce na confirmação; cada sugestão vale uma vez, mesmo com cliques juntos', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const resumo = (await detalhe(cliente, ligacao.id)).resumo.conteudo;
      const [tarefa, retorno] = resumo.sugestoes;
      expect(await t.prisma.atividade.count({ where: { contatoId } })).toBe(0);

      const [a, b] = await Promise.all([
        cliente.post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${tarefa.id}/confirmar`,
          { titulo: 'Enviar a proposta anual (ajustado)' },
        ),
        cliente.post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${tarefa.id}/confirmar`,
          {},
        ),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const ok = a.status === 200 ? a : b;
      expect(await t.prisma.atividade.count({ where: { contatoId } })).toBe(1);
      const atividade = await t.prisma.atividade.findFirstOrThrow({
        where: { contatoId },
      });
      expect(atividade).toMatchObject({
        tipo: 'TAREFA',
        responsavelId: atendente.id,
        status: 'PENDENTE',
      });
      expect(atividade.venceEm).not.toBeNull();
      expect(atividade.descricao).toContain('Sugerida pelo resumo da ligação');
      expect(ok.body.atividadeId).toBe(atividade.id);
      expect(ok.body.resumo.sugestoes[0].atividadeId).toBe(atividade.id);
      const repetida = await cliente
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${tarefa.id}/confirmar`,
          {},
        )
        .expect(409);
      expect(repetida.body.detalhes.motivo).toBe('sugestao_ja_tratada');

      // Descartar não cria nada, e o que foi descartado não pode ser confirmado.
      const descartada = await cliente
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${retorno.id}/descartar`,
        )
        .expect(200);
      expect(descartada.body.resumo.sugestoes[1].descartadaEm).not.toBeNull();
      await cliente
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${retorno.id}/confirmar`,
          {},
        )
        .expect(409);
      expect(await t.prisma.atividade.count({ where: { contatoId } })).toBe(1);
      await cliente
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/00000000-0000-4000-8000-000000000000/confirmar`,
          {},
        )
        .expect(404);
      // Quem não vê a ligação não confirma.
      await (
        await entrarComo(t, marketing)
      )
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${tarefa.id}/descartar`,
        )
        .expect(404);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: {
            acao: {
              in: [
                'ligacao.sugestao-confirmada',
                'ligacao.sugestao-descartada',
              ],
            },
          },
        }),
      ).toBe(2);
    });

    it('cenário 255 — R30.13 — o corpo ajusta tipo e vencimento (reunião ganha início e fim) e valida a data', async () => {
      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await gravarEProcessar(cliente, ligacao);
      const [tarefa, retorno] = (await detalhe(cliente, ligacao.id)).resumo
        .conteudo.sugestoes;
      const futuro = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const reuniao = await cliente
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${tarefa.id}/confirmar`,
          { tipo: 'REUNIAO', venceEm: futuro },
        )
        .expect(200);
      const criada = await t.prisma.atividade.findUniqueOrThrow({
        where: { id: reuniao.body.atividadeId },
      });
      expect(criada.tipo).toBe('REUNIAO');
      expect(criada.inicioEm?.toISOString()).toBe(futuro);
      expect(criada.fimEm!.getTime() - criada.inicioEm!.getTime()).toBe(
        3_600_000,
      );
      const invalida = await cliente
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${retorno.id}/confirmar`,
          { venceEm: 'ontem' },
        )
        .expect(400);
      expect(invalida.body.erro).toBeDefined();
      // A falha libera a sugestão para tentar de novo.
      await cliente
        .post(
          `/api/v1/ligacoes/${ligacao.id}/resumo/sugestoes/${retorno.id}/confirmar`,
          {},
        )
        .expect(200);
    });
  });

  describe('canal: aviso, saúde e documentação', () => {
    it('cenário 256 — R30.14 — áudio de aviso do canal: o Admin sobe e liga, quem atende toca; só áudio; trocar apaga o antigo', async () => {
      const admHttp = await entrarComo(t, admin);
      const atend = await entrarComo(t, atendente);
      const aviso = Buffer.from('OggS-aviso-gravado-por-nos');
      const envio = await admHttp
        .post('/api/v1/arquivos?contexto=LIGACAO')
        .attach('arquivo', aviso, {
          filename: 'aviso.ogg',
          contentType: 'audio/ogg',
        })
        .expect(201);
      const naoAudio = await admHttp
        .post('/api/v1/arquivos?contexto=LIGACAO')
        .attach('arquivo', Buffer.from('%PDF-1.4 teste'), {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        });
      expect(naoAudio.status).toBe(415);
      await atend.get(`/api/v1/ligacoes/canais/${canalId}/aviso`).expect(404);
      const grande = await admHttp
        .post('/api/v1/arquivos?contexto=LIGACAO')
        .attach('arquivo', Buffer.alloc(5 * 1024 * 1024 + 1), {
          filename: 'g.ogg',
          contentType: 'audio/ogg',
        });
      expect(grande.status).toBe(413);

      // Só o Admin configura; arquivo de outro contexto não serve de aviso.
      await atend
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          avisoArquivoId: envio.body.id,
        })
        .expect(403);
      const mensagem = await admHttp
        .post('/api/v1/arquivos?contexto=MENSAGEM')
        .attach('arquivo', aviso, {
          filename: 'm.ogg',
          contentType: 'audio/ogg',
        })
        .expect(201);
      await admHttp
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          avisoArquivoId: mensagem.body.id,
        })
        .expect(400);
      const ligado = await admHttp
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          avisoArquivoId: envio.body.id,
        })
        .expect(200);
      expect(ligado.body.avisoArquivoId).toBe(envio.body.id);

      const tocar = await atend
        .get(`/api/v1/ligacoes/canais/${canalId}/aviso`)
        .buffer(true)
        .expect(200);
      expect(tocar.body).toEqual(aviso);
      expect(tocar.headers['content-type']).toContain('audio/ogg');
      await atend
        .get(`/api/v1/ligacoes/canais/${canalId}/aviso`)
        .set('Range', 'bytes=0-3')
        .expect(206);
      await (
        await entrarComo(t, marketing)
      )
        .get(`/api/v1/ligacoes/canais/${canalId}/aviso`)
        .expect(403);

      // Trocar o aviso apaga o anterior; remover (null) também.
      const novo = await admHttp
        .post('/api/v1/arquivos?contexto=LIGACAO')
        .attach('arquivo', Buffer.from('OggS-novo'), {
          filename: 'novo.ogg',
          contentType: 'audio/ogg',
        })
        .expect(201);
      await admHttp
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          avisoArquivoId: novo.body.id,
        })
        .expect(200);
      expect(
        (
          await t.prisma.arquivo.findUniqueOrThrow({
            where: { id: envio.body.id },
          })
        ).removidoEm,
      ).not.toBeNull();
      const removido = await admHttp
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          avisoArquivoId: null,
        })
        .expect(200);
      expect(removido.body.avisoArquivoId).toBeNull();
      await atend.get(`/api/v1/ligacoes/canais/${canalId}/aviso`).expect(404);
    });

    it('cenário 257 — R30.15 — a tela Saúde do sistema mostra o serviço de transcrição e a fila', async () => {
      const admHttp = await entrarComo(t, admin);
      const API = '/api/v1/administracao/saude-do-sistema';
      let painel = (await admHttp.get(API).expect(200)).body;
      expect(painel.transcricao).toMatchObject({
        situacao: 'ok',
        modelo: 'base',
        pendentes: 0,
      });
      expect(
        painel.alertas.some(
          (a: { codigo: string }) => a.codigo === 'transcricao_fora_do_ar',
        ),
      ).toBe(false);

      const cliente = await entrarComo(t, atendente);
      const ligacao = await novaLigacao();
      await enviarParte(cliente, ligacao.id, 0, WEBM('AA')).expect(200);
      await cliente
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {})
        .expect(200);
      painel = (await admHttp.get(API).expect(200)).body;
      expect(painel.transcricao.pendentes).toBe(1);
      expect(
        painel.filas.itens.some(
          (f: { nome: string }) => f.nome === FILA_PROCESSAR_LIGACAO,
        ),
      ).toBe(true);

      whisper.estado.saude = 503;
      painel = (await admHttp.get(API).expect(200)).body;
      expect(painel.transcricao.situacao).toBe('fora_do_ar');
      expect(
        painel.alertas.find(
          (a: { codigo: string }) => a.codigo === 'transcricao_fora_do_ar',
        ),
      ).toMatchObject({ gravidade: 'aviso' });
    });

    it('cenário 258 — R30.15 — Saúde com a transcrição desligada: "desativada", sem alerta', async () => {
      const desligada = jest
        .spyOn(t.get(ClienteWhisper), 'saude')
        .mockResolvedValue('desativada');
      try {
        const painel = (
          await (
            await entrarComo(t, admin)
          )
            .get('/api/v1/administracao/saude-do-sistema')
            .expect(200)
        ).body;
        expect(painel.transcricao.situacao).toBe('desativada');
        expect(
          painel.alertas.some(
            (a: { codigo: string }) => a.codigo === 'transcricao_fora_do_ar',
          ),
        ).toBe(false);
      } finally {
        desligada.mockRestore();
      }
    });
  });
});
