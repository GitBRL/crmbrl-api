# Historico de mudancas — crmbrl-api

Registro gerado por `tools/doc-updater`. Cada entrada reune os commits novos,
os arquivos alterados e o impacto deles na arquitetura. Entradas mais recentes no topo.

<!-- doc-updater:historico — novas entradas entram aqui -->

## 2026-11-17 — 83 commits

### Commits

| Commit | Data | Autor | Mensagem |
| --- | --- | --- | --- |
| `ac24fb8` | 2026-11-12 | Git_BRL | Merge pull request #15 from GitBRL/dev |
| `9828fad` | 2026-11-12 | luis | Merge branch 'main' into dev |
| `905f6c3` | 2026-11-12 | Git_BRL | Merge pull request #14 from GitBRL/fase-1 |
| `03979db` | 2026-11-12 | luis | Merge branch 'dev' into fase-1 |
| `fecc0de` | 2026-11-12 | victor | Primeira interação com horário truncado no segundo; teste da saúde pública mínima |
| `fe1fc43` | 2026-11-12 | victor | Indicador "Mensagens enviadas" e "Time comercial" completo para o time comercial (R33) |
| `530109d` | 2026-11-12 | victor | Correções da revisão de segurança (U4): IP real atrás do proxy, força bruta, permissões, zip e segredos |
| `ab9eb83` | 2026-11-12 | victor | Verificação em duas etapas opcional (TOTP) com códigos de recuperação (R2.11) (U2) |
| `c41d869` | 2026-11-12 | victor | Correções da revisão da Onda T: vazamentos, 3C+ seguro, primeira interação real e indicadores |
| `7201a7c` | 2026-11-12 | victor | Ajuda: ligações pelo 3C+ (conectar, ligar, qualificar, discador e lacunas da conta real) (T4b) |
| `44dccde` | 2026-11-12 | victor | Ligações pelo 3C+ na API (R34) e 3C+ simulado (T4a) |
| `e1657bd` | 2026-11-12 | victor | Indicadores: tipos dos testes da T3 (tsc completo limpo) |
| `7a8b19d` | 2026-11-12 | victor | Indicadores configuráveis (R33): catálogo, painéis, metas e quem vê (T3) |
| `dc6577d` | 2026-11-12 | victor | socket.io-client em dependencies (aprovado pelo usuário em 11/11 para ouvir os eventos do 3C+ na T4) |
| `2b672a4` | 2026-11-12 | victor | Resultado da reunião (R6.6) e primeira interação do negócio (R6.7) (T2) |
| `d1f3479` | 2026-11-12 | victor | Ações em massa nos negócios (R5.16): POST /negocios/em-massa (T1) |
| `0ee46a7` | 2026-11-11 | victor | Foto de perfil pela própria pessoa (R2.10) e cargo reconhecido nos webhooks (R8.8) |
| `d0c4b98` | 2026-11-11 | Git_BRL | Merge pull request #13 from GitBRL/dev |
| `e6b5736` | 2026-11-11 | luis | Merge branch 'main' into dev |
| `45501a4` | 2026-11-11 | luis | Merge branch 'fase-1' into dev |
| `5db8cb3` | 2026-11-10 | victor | Correções da revisão de setores e visibilidade; busca de pessoas para acessos |
| `8b2c341` | 2026-11-10 | victor | Quem vê um funil: visibilidade, acessos por funil e por setor com níveis (S2) |
| `c8d69ce` | 2026-11-10 | victor | Setores dinâmicos: tabela setores, papel = nível + setor da pessoa (S1) |
| `115bee0` | 2026-11-10 | victor | Importação do Clint: organization_name tem prioridade sobre a coluna company na empresa |
| `56510b9` | 2026-11-10 | victor | Importação compatível com o Clint: status, datas, ID externo e conferência de funis (R16.14–R16.17) |
| `db30e2e` | 2026-11-10 | victor | Importação v2: filtro da planilha, negócio por importação, sem cabeçalho e DDI (R16.11–R16.13) |
| `7155225` | 2026-11-09 | Git_BRL | Merge pull request #12 from GitBRL/dev |
| `3c97d70` | 2026-11-09 | Git_BRL | Merge pull request #11 from GitBRL/fase-1 |
| `9b26230` | 2026-11-09 | victor | Importação: planilha modelo para baixar (R16.10) |
| `ebea3c9` | 2026-11-06 | victor | Merge de origin/fase-1 (merges do dev e do main, sem mudança de arquivos) |
| `2d62814` | 2026-11-05 | victor | Onda H (H4): login facilitado — apps de login, janela e OAuth do Typeform e do RD Station |
| `6e7f1a4` | 2026-11-04 | Git_BRL | Merge pull request #10 from GitBRL/dev |
| `bf4fade` | 2026-11-04 | luis | Merge branch 'dev' of https://github.com/GitBRL/crmbrl-api into dev |
| `beeefd9` | 2026-11-04 | Git_BRL | Merge pull request #9 from GitBRL/fase-1 |
| `174c622` | 2026-11-04 | luis | Merge branch 'dev' into fase-1 |
| `9517fb1` | 2026-11-04 | victor | Onda H (H3b): token de verificação do webhook por conexão do Facebook |
| `f594e4c` | 2026-11-04 | victor | Onda H (H3): fechamento — integração, ajuda, revisão e correções |
| `92c5c99` | 2026-11-04 | victor | Onda H (H2): Facebook Lead Ads, Hotmart, Kiwify e Eduzz |
| `fed1c15` | 2026-11-04 | victor | Onda H (H1): integrações por aplicativo no modelo do Clint |
| `63de267` | 2026-11-03 | victor | Onda G (G3): BI, webhooks e automações do SDR; correções da revisão |
| `0f7eaea` | 2026-11-03 | victor | Onda G (G2): artigos de ajuda do SDR com IA |
| `e4337ea` | 2026-11-03 | victor | Onda G (G1): SDR com IA — configuração, motor, qualificação e passagem ao Comercial (R31) |
| `3404eb6` | 2026-11-03 | victor | DEPLOY-RAILWAY: problemas encontrados na primeira instalação e como corrigir |
| `b28f9ae` | 2026-11-03 | victor | Ignora todos os .env.railway* (variáveis do Railway com segredos) |
| `70556c6` | 2026-11-03 | Git_BRL | Merge pull request #8 from GitBRL/fase-1 |
| `41ec663` | 2026-11-03 | victor | Testes: horário de criação crescente nos usuários da fábrica (rodízio instável na CI) |
| `ef70d48` | 2026-11-03 | Git_BRL | Merge pull request #7 from GitBRL/dev |
| `075f018` | 2026-11-03 | luis | Merge branch 'main' into dev |
| `f59bd21` | 2026-11-03 | Git_BRL | Merge pull request #5 from GitBRL/fase-1 |
| `3e6d33d` | 2026-11-03 | victor | Ignora o .env.railway (variáveis com segredos para o Railway) |
| `55198a2` | 2026-11-03 | victor | Dockerfile do serviço de transcrição para o Railway |
| `7d064c6` | 2026-11-02 | victor | Onda E (ajustes): canal mudo não derruba a transcrição; testes que dependiam da hora |
| `9eec26c` | 2026-11-02 | victor | Onda E (E4): histórico das ligações, BI, webhooks e automações; correções da revisão |
| `a7f2033` | 2026-11-02 | victor | Onda E (E3): gravação das ligações, transcrição com whisper.cpp e resumo pelo Claude (R30) |
| `6387870` | 2026-11-02 | victor | Onda E (E2): ligações pelo WhatsApp oficial — sinalização, toque e permissão (R29) |
| `5b9495f` | 2026-11-02 | victor | Onda E (E1): canal WhatsApp oficial pela Cloud API da Meta (R28) |
| `8321903` | 2026-11-02 | victor | Guia de deploy no Railway (docs/DEPLOY-RAILWAY.md) |
| `b9b2059` | 2026-11-02 | Git_BRL | Merge pull request #4 from GitBRL/fase-1 |
| `7580c76` | 2026-11-02 | victor | Formata src/logs com o Prettier (antes ignorado pelo .gitignore) |
| `3ea4670` | 2026-11-02 | victor | Versiona src/logs: o .gitignore ignorava qualquer pasta "logs" |
| `2846d04` | 2026-11-02 | Git_BRL | Merge pull request #3 from GitBRL/dev |
| `748e864` | 2026-11-02 | Git_BRL | Merge pull request #2 from GitBRL/fase-1 |
| `11452ed` | 2026-11-02 | victor | Onda D — ajustes finais: desligar remove os aparelhos de push (R26.1) |
| `4310b10` | 2026-11-02 | victor | Onda D — fechamento (D4): R25–R27, Financeiro em SQL, LGPD e correções da revisão |
| `4ea69c8` | 2026-11-02 | victor | Onda D — push, saúde do sistema, backups, CI e endurecimento de produção (D2–D3) |
| `09bcb65` | 2026-10-31 | victor | Dependência aprovada para a Onda D: web-push (notificações push do PWA) |
| `498b67e` | 2026-10-31 | victor | Onda D — assistente de ajuda com IA e chamados no TicketHub (D1) |
| `642adee` | 2026-10-31 | victor | Onda C — fechamento (C4): R20–R24, concorrência da régua e ajustes do BI |
| `0859e8b` | 2026-10-31 | victor | Onda C (C2): análise do BI por IA, só para o Admin |
| `3e72103` | 2026-10-31 | victor | Onda C (C1): BI — métricas por painel, painel financeiro e 12 meses de demonstração |
| `0255463` | 2026-10-31 | victor | Onda C (C3): financeiro — contratos, parcelas, indicadores e régua de cobrança |
| `68b9fc6` | 2026-10-30 | victor | Onda C: dependência aprovada @anthropic-ai/sdk |
| `daf8371` | 2026-10-30 | victor | Onda B: ajustes finais (automação de Marketing nasce como marketing, guia de testes) |
| `5382e13` | 2026-10-30 | victor | Onda B (B6): regras R16–R19, integração, revisão e correções |
| `40964e7` | 2026-10-30 | victor | Onda B (B5): automações e cadências, ambiente com dados da Onda B |
| `d43ff6e` | 2026-10-30 | victor | Onda B (B4): chatbot em passos com versões |
| `83b7a26` | 2026-10-30 | victor | Onda B (B3): disparos de WhatsApp e e-mail |
| `92a75cb` | 2026-10-30 | victor | Onda B (B2): importação de contatos e empresas por CSV/XLSX |
| `6d2c3c7` | 2026-10-30 | victor | Onda B (B1): schema e peças compartilhadas de automação |
| `f28ed80` | 2026-10-30 | victor | Onda A: integração, revisão e publicação do atendimento |
| `831f81f` | 2026-10-26 | victor | Onda A (parcial): gateway de WhatsApp, atendimento, canais e chat interno |
| `97d129e` | 2026-10-22 | victor | Script de dados de demonstração do BRL CRM |
| `1042185` | 2026-10-21 | victor | Base da API e regras de negócio da Fase 1 do BRL CRM |


### Arquivos alterados (1055 · +291725 / -291)

- `prisma/schema.prisma` (+4203 / -0)
- `scripts/semear-demonstracao.mjs` (+3529 / -0)
- `docs/REGRAS-DE-NEGOCIO.md` (+3526 / -0)
- `test/onda-e-ligacoes.e2e-spec.ts` (+2270 / -0)
- `test/tresc-plus.e2e-spec.ts` (+2246 / -0)
- `test/integracoes-aplicativos.e2e-spec.ts` (+2106 / -0)
- `test/onda-e-whatsapp-oficial.e2e-spec.ts` (+2010 / -0)
- `docs/ARQUITETURA.md` (+1935 / -46)
- `test/importacao.e2e-spec.ts` (+1946 / -0)
- `test/sdr.e2e-spec.ts` (+1912 / -0)
- `test/login-facilitado.e2e-spec.ts` (+1856 / -0)
- `scripts/semear-onda-c.mjs` (+1773 / -0)
- `test/onda-e-gravacao.e2e-spec.ts` (+1735 / -0)
- `test/facebook-lead-ads.e2e-spec.ts` (+1723 / -0)
- `test/chatbot.e2e-spec.ts` (+1603 / -0)
- `src/sdr/motor-sdr.service.ts` (+1580 / -0)
- `test/automacoes.e2e-spec.ts` (+1567 / -0)
- `src/whatsapp/gerenciador-de-numeros.service.ts` (+1563 / -0)
- `src/config/ambiente.ts` (+1500 / -0)
- `src/webhooks/entrada/webhooks-entrada.service.ts` (+1476 / -0)
- `test/integracoes-cursos.e2e-spec.ts` (+1463 / -0)
- `src/importacao/importacao-processador.service.ts` (+1460 / -0)
- `test/indicadores.e2e-spec.ts` (+1451 / -0)
- `src/disparos/campanhas.service.ts` (+1431 / -0)
- `src/importacao/importacao.service.ts` (+1416 / -0)


### Impacto na arquitetura

**Modulos**

- **+** `ArquivosModule`
- **+** `ArquivosHttpModule`
- **+** `AssistenteModule`
- **+** `AtendimentoModule`
- **+** `AutomacoesModule`
- **+** `AnaliseModule`
- **+** `BiModule`
- **+** `RegistroCanaisModule`
- **+** `CanaisModule`
- **+** `CanaisComumModule`
- **+** `EmailCanalModule`
- **+** `MetaModule`
- **+** `WebchatNucleoModule`
- **+** `WebchatModule`
- **+** `WhatsappCanalModule`
- **+** `WhatsappOficialModule`
- **+** `ChatInternoModule`
- **+** `ChatbotModule`
- **+** `AutomacaoComumModule`
- **+** `DisparosModule`
- **+** `FinanceiroModule`
- **+** `ImportacaoModule`
- **+** `IndicadoresModule`
- **+** `GravacaoModule`
- **+** `LigacoesModule`
- **+** `PushModule`
- **+** `MonitoramentoModule`
- **+** `SdrModule`
- **+** `SetoresModule`
- **+** `TempoRealModule`
- **+** `TranscricaoModule`
- **+** `TrescPlusModule`
- **+** `GatewayWhatsappModule`


**Controllers**

- **+** `ArquivosController`
- **+** `AssistenteAdminController`
- **+** `AssistenteController`
- **+** `FilasController`
- **+** `RespostasRapidasController`
- **+** `CanaisDoAtendimentoController`
- **+** `MetricasDoAtendimentoController`
- **+** `ConversasController`
- **+** `DoisFatoresController`
- **+** `AutomacoesController`
- **+** `AnaliseController`
- **+** `BiController`
- **+** `EmailCanaisController`
- **+** `MetaCanaisController`
- **+** `WebhookMetaController`
- **+** `WebchatCanaisController`
- **+** `WebchatPublicoController`
- **+** `NumerosWhatsappController`
- **+** `WhatsappOficialCanaisController`
- **+** `ChatInternoController`
- **+** `ChatbotController`
- **+** `ModelosController`
- **+** `SegmentosController`
- **+** `DisparosController`
- **+** `ModelosMensagemController`
- **+** `FinanceiroController`
- **+** `ImportacaoController`
- **+** `IndicadoresController`
- **+** `GravacaoController`
- **+** `LigacoesController`
- **+** `ConfiguracaoLigacoesController`
- **+** `PushController`
- **+** `SaudeDoSistemaController`
- **+** `SdrConfiguracaoController`
- **+** `SdrConversasController`
- **+** `SetoresController`
- **+** `ConexaoTrescPlusController`
- **+** `VinculoTrescPlusController`
- **+** `AgenteTrescPlusController`
- **+** `DiscadorTrescPlusController`
- **+** `FotoDePerfilController`
- **+** `AplicativosController`
- **+** `HistoricoDeRecebimentosController`
- **+** `FacebookController`
- **+** `FacebookPublicoController`
- **+** `AppsDeLoginController`
- **+** `ConexoesAplicativoController`
- **+** `ConexoesAplicativoPublicoController`
- **+** `GatewayController`


**Servicos**

- **+** `ArquivosService`
- **+** `AssistenteService`
- **+** `BaseDeConhecimentoService`
- **+** `ChamadosAssistenteService`
- **+** `ConectorChamadosService`
- **+** `ConfiguracaoAssistenteService`
- **+** `HistoricoAssistenteService`
- **+** `AcessoAtendimentoService`
- **+** `AtendimentoService`
- **+** `AvisoDeMensagem`
- **+** `CanaisDoAtendimentoService`
- **+** `ContagensDoAtendimento`
- **+** `ConversasService`
- **+** `DesligamentoNoAtendimento`
- **+** `DistribuicaoDaFila`
- **+** `EnvioDoAtendimento`
- **+** `FilasService`
- **+** `GanchosDoAtendimento`
- **+** `MensagensService`
- **+** `MetricasDoAtendimentoService`
- **+** `MotorDoAtendimento`
- **+** `RespostasRapidasService`
- **+** `SlaDoAtendimento`
- **+** `DoisFatoresService`
- **+** `AcoesDeAutomacao`
- **+** `AgendasDeAutomacao`
- **+** `AutomacoesService`
- **+** `EnvioDeMensagemDaAutomacao`
- **+** `ExecucoesDeAutomacao`
- **+** `GatilhosDeAutomacao`
- **+** `IniciadorDeExecucao`
- **+** `AnaliseService`
- **+** `ChamadaClaudeService`
- **+** `BiService`
- **+** `ExportacaoBiService`
- **+** `FiltrosBiService`
- **+** `PainelAtendimentoService`
- **+** `PainelComercialService`
- **+** `PainelCsService`
- **+** `PainelFinanceiroService`
- **+** `PainelMarketingService`
- **+** `PainelSdrService`
- **+** `ArquivosPublicos`
- **+** `ConfiguracaoDeCanais`
- **+** `LimitadorDeRequisicoes`
- **+** `SegredosDoCanal`
- **+** `AdaptadorEmail`
- **+** `EmailCanaisService`
- **+** `LeitorDeEmail`
- **+** `AdaptadorMeta`
- **+** `AdaptadorInstagram`
- **+** `AdaptadorMessenger`
- **+** `GraphApi`
- **+** `MetaCanaisService`
- **+** `WebhookMetaService`
- **+** `RegistroCanais`
- **+** `AcessoDoWidgetGuard`
- **+** `AdaptadorWebchat`
- **+** `WebchatCanaisService`
- **+** `WebchatTempoReal`
- **+** `WebchatService`
- **+** `WidgetDoSite`
- **+** `AdaptadorWhatsapp`
- **+** `ClienteGatewayWhatsapp`
- **+** `DigitandoWhatsappService`
- **+** `EventosWhatsappService`
- **+** `NumerosWhatsappService`
- **+** `AdaptadorWhatsappOficial`
- **+** `EntradaWhatsappOficialService`
- **+** `GraphWhatsappOficial`
- **+** `TemplatesOficiaisService`
- **+** `WebhookWhatsappOficialService`
- **+** `WhatsappOficialCanaisService`
- **+** `AcessoChatService`
- **+** `CanaisChatService`
- **+** `MensagensChatService`
- **+** `MontagemChatService`
- **+** `PublicacaoChatService`
- **+** `SincronizacaoChatService`
- **+** `TempoRealChatService`
- **+** `AcessoChatbot`
- **+** `AcoesDoBot`
- **+** `EntradaDoBot`
- **+** `FluxosChatbotService`
- **+** `MensagensDoBot`
- **+** `PassosDoChatbot`
- **+** `SimuladorDoChatbot`
- **+** `TransferenciaDoBot`
- **+** `GatilhosService`
- **+** `ModelosService`
- **+** `PassosService`
- **+** `SegmentosService`
- **+** `AcessoDisparos`
- **+** `AgendadorDeEnvio`
- **+** `CampanhasService`
- **+** `CanaisDaCampanha`
- **+** `CicloDaCampanha`
- **+** `ConfiguracaoDisparosService`
- **+** `EntregaDeCampanha`
- **+** `EnvioDeCampanha`
- **+** `ModelosMensagemService`
- **+** `ProgressoDaCampanha`
- **+** `PublicoDaCampanha`
- **+** `RelatorioDeCampanha`
- **+** `RespostasDeCampanha`
- **+** `SincronizacaoDaCampanha`
- **+** `ContratosService`
- **+** `ImportacaoDeParcelasService`
- **+** `IndicadoresFinanceirosService`
- **+** `ParcelasService`
- **+** `ReguaConfiguracaoService`
- **+** `ReguaConsultaService`
- **+** `ReguaEnvioService`
- **+** `ReguaLigacoesService`
- **+** `ReguaService`
- **+** `RiscoDeChurnService`
- **+** `SugestaoDeContratoService`
- **+** `TempoRealFinanceiro`
- **+** `NegociosEmMassaService`
- **+** `ImportacaoProcessadorService`
- **+** `ImportacaoService`
- **+** `ModelosDeImportacaoService`
- **+** `CalculoIndicadoresService`
- **+** `FiltrosIndicadoresService`
- **+** `IndicadoresService`
- **+** `PaineisIndicadoresService`
- **+** `ConfiguracaoDeLigacoesService`
- **+** `EventosDeLigacaoService`
- **+** `GraphLigacoes`
- **+** `GravacaoService`
- **+** `LeituraDaGravacaoService`
- **+** `ReprocessamentoDaGravacaoService`
- **+** `RetencaoDeGravacoesService`
- **+** `SugestoesDeAtividadeService`
- **+** `HistoricoDeLigacoesService`
- **+** `LigacoesFeitasService`
- **+** `LigacoesRecebidasService`
- **+** `LigacoesService`
- **+** `PermissoesDeLigacaoService`
- **+** `WebhookDeLigacoesService`
- **+** `OuvintesDeNotificacao`
- **+** `PushService`
- **+** `ServicoWebPush`
- **+** `AlertasDeSaudeService`
- **+** `SaudeDoSistemaService`
- **+** `ConfiguracaoSdrService`
- **+** `ConversasSdrService`
- **+** `EfeitosSdrService`
- **+** `MotorSdr`
- **+** `OrcamentoSdrService`
- **+** `QualificacaoSdrService`
- **+** `SimuladorSdrService`
- **+** `TransicoesSdrService`
- **+** `SetoresService`
- **+** `OuvinteDoBanco`
- **+** `TempoRealPublicador`
- **+** `TempoRealService`
- **+** `ClienteWhisper`
- **+** `ProcessadorFfmpeg`
- **+** `TranscricaoService`
- **+** `AgenteTrescPlusService`
- **+** `ConexaoTrescPlusService`
- **+** `DiscadorTrescPlusService`
- **+** `LigacoesTrescService`
- **+** `OuvinteDeEventosTrescPlus`
- **+** `ReconciliacaoTrescPlusService`
- **+** `VinculosTrescPlusService`
- **+** `FotoDePerfilService`
- **+** `AplicacaoDoRecebimento`
- **+** `AplicativosService`
- **+** `ConexoesFacebookService`
- **+** `FacebookLeadAdsService`
- **+** `AppsDeLoginService`
- **+** `ConexoesAplicativoService`
- **+** `ParseAplicativoDeLoginPipe`
- **+** `RdStationService`
- **+** `GerenciadorDeNumeros`
- **+** `TokenInternoGuard`


**Endpoints HTTP**

- **+** `POST /arquivos`
- **+** `GET /arquivos/:id`
- **+** `GET /assistente/admin/configuracao`
- **+** `PUT /assistente/admin/configuracao`
- **+** `POST /assistente/admin/configuracao/testar`
- **+** `GET /assistente/admin/historico`
- **+** `POST /assistente/admin/historico/exportar`
- **+** `GET /assistente/admin/temas`
- **+** `GET /assistente/admin/chamados`
- **+** `POST /assistente/admin/chamados/:id/reenviar`
- **+** `GET /assistente/estado`
- **+** `POST /assistente/perguntas`
- **+** `GET /assistente/conversas`
- **+** `GET /assistente/conversas/:id`
- **+** `PUT /assistente/perguntas/:id/avaliacao`
- **+** `POST /assistente/perguntas/:id/chamado`
- **+** `GET /assistente/chamados/:id`
- **+** `GET /atendimento/filas`
- **+** `POST /atendimento/filas`
- **+** `GET /atendimento/filas/:id`
- **+** `PATCH /atendimento/filas/:id`
- **+** `DELETE /atendimento/filas/:id`
- **+** `PUT /atendimento/filas/:id/participantes/:usuarioId`
- **+** `DELETE /atendimento/filas/:id/participantes/:usuarioId`
- **+** `GET /atendimento/respostas-rapidas`
- **+** `GET /atendimento/respostas-rapidas/variaveis`
- **+** `POST /atendimento/respostas-rapidas`
- **+** `GET /atendimento/respostas-rapidas/:id`
- **+** `PATCH /atendimento/respostas-rapidas/:id`
- **+** `DELETE /atendimento/respostas-rapidas/:id`
- **+** `POST /atendimento/respostas-rapidas/:id/aplicar`
- **+** `GET /atendimento/canais`
- **+** `GET /atendimento/canais/:id`
- **+** `PATCH /atendimento/canais/:id`
- **+** `GET /atendimento/metricas`
- **+** `GET /atendimento/conversas`
- **+** `POST /atendimento/conversas`
- **+** `GET /atendimento/nao-lidas`
- **+** `GET /atendimento/etiquetas`
- **+** `GET /atendimento/atendentes`
- **+** `GET /atendimento/conversas/:id`
- **+** `GET /atendimento/conversas/:id/templates`
- **+** `PATCH /atendimento/conversas/:id`
- **+** `POST /atendimento/conversas/:id/assumir`
- **+** `POST /atendimento/conversas/:id/transferir`
- **+** `POST /atendimento/conversas/:id/resolver`
- **+** `POST /atendimento/conversas/:id/reabrir`
- **+** `POST /atendimento/conversas/:id/lida`
- **+** `POST /atendimento/conversas/:id/negocio`
- **+** `GET /atendimento/conversas/:id/atribuicoes`
- **+** `GET /atendimento/conversas/:id/mensagens`
- **+** `POST /atendimento/conversas/:id/mensagens`
- **+** `POST /atendimento/conversas/:id/notas`
- **+** `POST /atendimento/conversas/:id/mensagens/:mensagemId/reenviar`
- **+** `POST /auth/entrar/dois-fatores`
- **+** `POST /auth/sessoes/encerrar-outras`
- **+** `GET /auth/dois-fatores`
- **+** `POST /auth/dois-fatores/ativar`
- **+** `POST /auth/dois-fatores/confirmar`
- **+** `POST /auth/dois-fatores/codigos`
- **+** `POST /auth/dois-fatores/desativar`
- **+** `GET /automacoes/opcoes`
- **+** `GET /automacoes`
- **+** `POST /automacoes`
- **+** `GET /automacoes/catalogo`
- **+** `GET /automacoes/modelos-prontos`
- **+** `POST /automacoes/modelos-prontos/:chave`
- **+** `POST /automacoes/validar`
- **+** `GET /automacoes/execucoes`
- **+** `GET /automacoes/execucoes/:execucaoId`
- **+** `POST /automacoes/execucoes/:execucaoId/reexecutar`
- **+** `POST /automacoes/execucoes/:execucaoId/cancelar`
- **+** `GET /automacoes/:id`
- **+** `PATCH /automacoes/:id`
- **+** `POST /automacoes/:id/ativar`
- **+** `POST /automacoes/:id/pausar`
- **+** `POST /automacoes/:id/duplicar`
- **+** `POST /automacoes/:id/testar`
- **+** `DELETE /automacoes/:id`
- **+** `GET /bi/analise/estado`
- **+** `PUT /bi/analise/configuracao`
- **+** `POST /bi/analise`
- **+** `POST /bi/analise/:id/perguntas`
- **+** `GET /bi/analise/historico`
- **+** `GET /bi/analise/:id`
- **+** `GET /bi/paineis`
- **+** `GET /bi/:painel`
- **+** `POST /bi/:painel/exportar`
- **+** `GET /email/canais`
- **+** `POST /email/canais/testar`
- **+** `GET /email/canais/:id`
- **+** `POST /email/canais`
- **+** `PATCH /email/canais/:id`
- **+** `POST /email/canais/:id/testar`
- **+** `DELETE /email/canais/:id`
- **+** `GET /meta/canais`
- **+** `GET /meta/canais/:id`
- **+** `POST /meta/canais`
- **+** `PATCH /meta/canais/:id`
- **+** `POST /meta/canais/:id/testar`
- **+** `POST /meta/canais/:id/token-verificacao`
- **+** `DELETE /meta/canais/:id`
- **+** `GET /publico/meta/webhook`
- **+** `POST /publico/meta/webhook`
- **+** `GET /publico/meta/arquivos/:id`
- **+** `GET /webchat/canais`
- **+** `GET /webchat/canais/:id`
- **+** `POST /webchat/canais`
- **+** `PATCH /webchat/canais/:id`
- **+** `DELETE /webchat/canais/:id`
- **+** `GET /publico/webchat/widget.js`
- **+** `GET /publico/webchat/:chave/configuracao`
- **+** `POST /publico/webchat/:chave/visitantes`
- **+** `POST /publico/webchat/:chave/sessao`
- **+** `POST /publico/webchat/:chave/historico`
- **+** `POST /publico/webchat/:chave/mensagens`
- **+** `POST /publico/webchat/:chave/anexos`
- **+** `POST /publico/webchat/:chave/sair`
- **+** `GET /publico/webchat/:chave/arquivos/:id`
- **+** `GET /whatsapp/numeros`
- **+** `POST /whatsapp/numeros`
- **+** `GET /whatsapp/numeros/:id`
- **+** `PATCH /whatsapp/numeros/:id`
- **+** `DELETE /whatsapp/numeros/:id`
- **+** `POST /whatsapp/numeros/:id/conectar`
- **+** `POST /whatsapp/numeros/:id/desconectar`
- **+** `GET /whatsapp/numeros/:id/status`
- **+** `POST /whatsapp/numeros/:id/verificar`
- **+** `POST /whatsapp/numeros/:id/pausar`
- **+** `POST /whatsapp/numeros/:id/retomar`
- **+** `GET /whatsapp/numeros/:id/envios`
- **+** `GET /whatsapp-oficial/canais`
- **+** `GET /whatsapp-oficial/canais/:id`
- **+** `POST /whatsapp-oficial/canais`
- **+** `PATCH /whatsapp-oficial/canais/:id`
- **+** `POST /whatsapp-oficial/canais/:id/testar`
- **+** `POST /whatsapp-oficial/canais/:id/token-verificacao`
- **+** `GET /whatsapp-oficial/canais/:id/templates`
- **+** `POST /whatsapp-oficial/canais/:id/templates/sincronizar`
- **+** `DELETE /whatsapp-oficial/canais/:id`
- **+** `GET /chat/canais`
- **+** `GET /chat/canais/:id`
- **+** `PATCH /chat/canais/:id`
- **+** `POST /chat/canais/:id/arquivar`
- **+** `POST /chat/canais/:id/desarquivar`
- **+** `POST /chat/canais/:id/sair`
- **+** `PUT /chat/canais/:id/preferencias`
- **+** `POST /chat/canais/:id/leitura`
- **+** `GET /chat/canais/:id/membros`
- **+** `POST /chat/canais/:id/membros`
- **+** `PATCH /chat/canais/:id/membros/:usuarioId`
- **+** `DELETE /chat/canais/:id/membros/:usuarioId`
- **+** `POST /chat/grupos`
- **+** `POST /chat/diretas`
- **+** `GET /chat/canais/:id/mensagens`
- **+** `POST /chat/canais/:id/mensagens`
- **+** `GET /chat/mensagens/busca`
- **+** `PATCH /chat/mensagens/:id`
- **+** `DELETE /chat/mensagens/:id`
- **+** `GET /chat/nao-lidas`
- **+** `GET /chat/pessoas`
- **+** `GET /chatbot/opcoes`
- **+** `GET /chatbot/passos`
- **+** `GET /chatbot/fluxos`
- **+** `POST /chatbot/fluxos`
- **+** `GET /chatbot/fluxos/:id`
- **+** `PATCH /chatbot/fluxos/:id`
- **+** `PUT /chatbot/fluxos/:id/rascunho`
- **+** `POST /chatbot/fluxos/:id/validar`
- **+** `POST /chatbot/fluxos/:id/publicar`
- **+** `POST /chatbot/fluxos/:id/ativar`
- **+** `POST /chatbot/fluxos/:id/desativar`
- **+** `POST /chatbot/fluxos/:id/duplicar`
- **+** `DELETE /chatbot/fluxos/:id`
- **+** `GET /chatbot/fluxos/:id/versoes`
- **+** `GET /chatbot/fluxos/:id/versoes/:numero`
- **+** `POST /chatbot/fluxos/:id/versoes/:numero/restaurar`
- **+** `GET /chatbot/fluxos/:id/execucoes`
- **+** `GET /chatbot/fluxos/:id/execucoes/:execucaoId`
- **+** `POST /chatbot/fluxos/:id/simulador`
- **+** `GET /chatbot/fluxos/:id/simulador/:execucaoId`
- **+** `POST /chatbot/fluxos/:id/simulador/:execucaoId/mensagens`
- **+** `POST /chatbot/fluxos/:id/simulador/:execucaoId/silencio`
- **+** `DELETE /chatbot/fluxos/:id/simulador/:execucaoId`
- **+** `GET /modelos/variaveis`
- **+** `POST /modelos/previa`
- **+** `GET /segmentos/campos`
- **+** `POST /segmentos/previa`
- **+** `GET /contatos/:id/dados-pessoais`
- **+** `GET /disparos/canais`
- **+** `GET /disparos/campanhas`
- **+** `POST /disparos/campanhas`
- **+** `POST /disparos/previa-publico`
- **+** `POST /disparos/estimativa`
- **+** `GET /disparos/configuracao`
- **+** `PUT /disparos/configuracao`
- **+** `GET /disparos/campanhas/:id`
- **+** `PATCH /disparos/campanhas/:id`
- **+** `DELETE /disparos/campanhas/:id`
- **+** `POST /disparos/campanhas/:id/duplicar`
- **+** `GET /disparos/campanhas/:id/revisao`
- **+** `POST /disparos/campanhas/:id/previa`
- **+** `POST /disparos/campanhas/:id/teste`
- **+** `POST /disparos/campanhas/:id/iniciar`
- **+** `POST /disparos/campanhas/:id/aprovar`
- **+** `POST /disparos/campanhas/:id/reprovar`
- **+** `POST /disparos/campanhas/:id/pausar`
- **+** `POST /disparos/campanhas/:id/retomar`
- **+** `POST /disparos/campanhas/:id/cancelar`
- **+** `POST /disparos/campanhas/:id/reenviar-falhas`
- **+** `GET /disparos/campanhas/:id/destinatarios`
- **+** `GET /disparos/campanhas/:id/relatorio`
- **+** `POST /disparos/campanhas/:id/exportar`
- **+** `GET /modelos-mensagem`
- **+** `POST /modelos-mensagem`
- **+** `GET /modelos-mensagem/:id`
- **+** `PATCH /modelos-mensagem/:id`
- **+** `DELETE /modelos-mensagem/:id`
- **+** `GET /financeiro/contratos`
- **+** `POST /financeiro/contratos`
- **+** `GET /financeiro/contratos/:id`
- **+** `PATCH /financeiro/contratos/:id`
- **+** `POST /financeiro/contratos/:id/suspender`
- **+** `POST /financeiro/contratos/:id/reativar`
- **+** `POST /financeiro/contratos/:id/cancelar`
- **+** `POST /financeiro/contratos/:id/parcelas`
- **+** `GET /financeiro/negocios/sem-contrato`
- **+** `GET /financeiro/negocios/:id/sugestao-de-contrato`
- **+** `GET /financeiro/parcelas`
- **+** `GET /financeiro/parcelas/totais`
- **+** `POST /financeiro/parcelas/exportar`
- **+** `POST /financeiro/parcelas`
- **+** `GET /financeiro/parcelas/:id`
- **+** `PATCH /financeiro/parcelas/:id`
- **+** `POST /financeiro/parcelas/:id/baixa`
- **+** `POST /financeiro/parcelas/:id/cancelar`
- **+** `POST /financeiro/parcelas/:id/renegociar`
- **+** `GET /financeiro/parcelas/:id/linha-do-tempo`
- **+** `GET /financeiro/indicadores/resumo`
- **+** `GET /financeiro/indicadores/mrr`
- **+** `GET /financeiro/indicadores/inadimplencia`
- **+** `GET /financeiro/indicadores/previsto-realizado`
- **+** `GET /financeiro/risco-churn`
- **+** `GET /financeiro/risco-churn/contatos/:id`
- **+** `GET /financeiro/risco-churn/negocios/:id`
- **+** `GET /financeiro/regua/configuracao`
- **+** `PATCH /financeiro/regua/configuracao`
- **+** `POST /financeiro/regua/pausar`
- **+** `POST /financeiro/regua/retomar`
- **+** `GET /financeiro/regua/etapas`
- **+** `POST /financeiro/regua/etapas`
- **+** `PUT /financeiro/regua/etapas/:id`
- **+** `DELETE /financeiro/regua/etapas/:id`
- **+** `POST /financeiro/regua/previa`
- **+** `POST /financeiro/regua/executar`
- **+** `GET /financeiro/regua/execucoes`
- **+** `GET /financeiro/regua/resumo`
- **+** `GET /financeiro/regua/envios`
- **+** `POST /financeiro/regua/reenviar`
- **+** `GET /financeiro/regua/ligacoes`
- **+** `POST /financeiro/regua/ligacoes/:id/resultado`
- **+** `GET /funis/:id/acessos`
- **+** `PUT /funis/:id/acessos`
- **+** `POST /negocios/em-massa`
- **+** `GET /importacoes`
- **+** `GET /importacoes/campos`
- **+** `GET /importacoes/planilha-modelo`
- **+** `GET /importacoes/modelos`
- **+** `POST /importacoes/modelos`
- **+** `PATCH /importacoes/modelos/:id`
- **+** `DELETE /importacoes/modelos/:id`
- **+** `POST /importacoes`
- **+** `GET /importacoes/:id`
- **+** `PATCH /importacoes/:id`
- **+** `GET /importacoes/:id/previa`
- **+** `GET /importacoes/:id/funis-da-planilha`
- **+** `POST /importacoes/:id/iniciar`
- **+** `POST /importacoes/:id/retomar`
- **+** `POST /importacoes/:id/cancelar`
- **+** `DELETE /importacoes/:id`
- **+** `GET /importacoes/:id/linhas`
- **+** `GET /importacoes/:id/relatorio`
- **+** `GET /indicadores/catalogo`
- **+** `GET /indicadores/paineis`
- **+** `POST /indicadores/paineis`
- **+** `GET /indicadores/paineis/:id`
- **+** `PATCH /indicadores/paineis/:id`
- **+** `POST /indicadores/paineis/:id/duplicar`
- **+** `DELETE /indicadores/paineis/:id`
- **+** `POST /indicadores/calcular`
- **+** `POST /indicadores/exportar`
- **+** `POST /ligacoes/:id/gravacao/partes/:sequencia`
- **+** `POST /ligacoes/:id/gravacao/finalizar`
- **+** `GET /ligacoes/:id/transcricao`
- **+** `GET /ligacoes/:id/audio`
- **+** `GET /ligacoes/:id/audio/baixar`
- **+** `POST /ligacoes/:id/reprocessar`
- **+** `POST /ligacoes/:id/resumo/sugestoes/:sugestaoId/confirmar`
- **+** `POST /ligacoes/:id/resumo/sugestoes/:sugestaoId/descartar`
- **+** `GET /ligacoes/canais/:canalId/aviso`
- **+** `GET /ligacoes/configuracao-webrtc`
- **+** `GET /ligacoes/canais`
- **+** `GET /ligacoes/ativas`
- **+** `GET /ligacoes/permissoes`
- **+** `POST /ligacoes/permissoes/pedir`
- **+** `GET /ligacoes`
- **+** `POST /ligacoes`
- **+** `GET /ligacoes/:id`
- **+** `POST /ligacoes/:id/atender`
- **+** `POST /ligacoes/:id/recusar`
- **+** `POST /ligacoes/:id/encerrar`
- **+** `PATCH /ligacoes/:id`
- **+** `GET /whatsapp-oficial/canais/:canalId/ligacoes`
- **+** `PATCH /whatsapp-oficial/canais/:canalId/ligacoes`
- **+** `GET /push/chave-publica`
- **+** `POST /push/inscricoes`
- **+** `GET /push/inscricoes`
- **+** `DELETE /push/inscricoes/:id`
- **+** `GET /push/preferencias`
- **+** `PUT /push/preferencias`
- **+** `POST /push/teste`
- **+** `GET /administracao/saude-do-sistema`
- **+** `GET /sdr/configuracao`
- **+** `PUT /sdr/configuracao`
- **+** `GET /sdr/canais`
- **+** `PUT /sdr/canais/:canalId`
- **+** `GET /sdr/artigos`
- **+** `POST /sdr/artigos`
- **+** `PUT /sdr/artigos/:id`
- **+** `DELETE /sdr/artigos/:id`
- **+** `GET /sdr/artigos/:id/versoes`
- **+** `POST /sdr/artigos/:id/versoes/:numero/restaurar`
- **+** `GET /sdr/criterios`
- **+** `POST /sdr/criterios`
- **+** `PUT /sdr/criterios/ordem`
- **+** `POST /sdr/criterios/modelo-captacao`
- **+** `PUT /sdr/criterios/:id`
- **+** `DELETE /sdr/criterios/:id`
- **+** `GET /sdr/campos-disponiveis`
- **+** `GET /sdr/uso`
- **+** `GET /sdr/decisoes`
- **+** `POST /sdr/simulador/turno`
- **+** `GET /sdr/conversas/:id`
- **+** `POST /sdr/conversas/:id/assumir`
- **+** `POST /sdr/conversas/:id/devolver`
- **+** `POST /sdr/sugestoes/:id/aprovar`
- **+** `POST /sdr/sugestoes/:id/descartar`
- **+** `GET /sdr/contatos/:id/qualificacao`
- **+** `GET /sdr/negocios/:id/qualificacao`
- **+** `GET /setores`
- **+** `POST /setores`
- **+** `GET /setores/:chave`
- **+** `PATCH /setores/:chave`
- **+** `GET /setores/:chave/acessos`
- **+** `PUT /setores/:chave/acessos`
- **+** `POST /setores/:chave/desativar`
- **+** `POST /setores/:chave/reativar`
- **+** `GET /tresc-plus/conexao`
- **+** `PATCH /tresc-plus/conexao`
- **+** `POST /tresc-plus/conexao/testar`
- **+** `POST /tresc-plus/reconciliar`
- **+** `GET /tresc-plus/vinculos`
- **+** `DELETE /tresc-plus/vinculos/:usuarioId`
- **+** `GET /tresc-plus/vinculo`
- **+** `POST /tresc-plus/vinculo`
- **+** `DELETE /tresc-plus/vinculo`
- **+** `GET /tresc-plus/agente`
- **+** `GET /tresc-plus/agente/campanhas`
- **+** `POST /tresc-plus/agente/entrar`
- **+** `POST /tresc-plus/agente/sair`
- **+** `GET /tresc-plus/agente/pausas`
- **+** `POST /tresc-plus/agente/pausa`
- **+** `DELETE /tresc-plus/agente/pausa`
- **+** `POST /tresc-plus/ligacoes`
- **+** `POST /tresc-plus/ligacoes/:id/desligar`
- **+** `GET /tresc-plus/ligacoes/:id/qualificacoes`
- **+** `GET /tresc-plus/qualificacoes`
- **+** `POST /tresc-plus/ligacoes/:id/qualificar`
- **+** `GET /tresc-plus/campanhas`
- **+** `GET /tresc-plus/campanhas/:id/listas`
- **+** `POST /tresc-plus/discador/enviar`
- **+** `PUT /usuarios/eu/foto`
- **+** `DELETE /usuarios/eu/foto`
- **+** `GET /usuarios/opcoes`
- **+** `POST /usuarios/:id/dois-fatores/redefinir`
- **+** `POST /webhooks/entradas/testar-credencial`
- **+** `GET /webhooks/entradas/:id/endereco`
- **+** `POST /webhooks/entradas/:id/testar-credencial`
- **+** `POST /webhooks/entradas/:id/buscar-campos`
- **+** `GET /webhooks/entradas/:id/campos-recebidos`
- **+** `GET /webhooks/entradas/:id/formularios`
- **+** `GET /webhooks/entradas/:id/formularios/:formularioId/campos`
- **+** `POST /webhooks/entradas/:id/sincronizar`
- **+** `GET /webhooks/aplicativos`
- **+** `GET /webhooks/recebimentos`
- **+** `GET /webhooks/recebimentos/:id`
- **+** `POST /webhooks/recebimentos/:id/reprocessar`
- **+** `GET /webhooks/facebook/configuracao`
- **+** `GET /webhooks/facebook/canais`
- **+** `POST /webhooks/facebook/oauth/iniciar`
- **+** `POST /webhooks/facebook/conexoes/token-de-pagina`
- **+** `GET /webhooks/facebook/conexoes`
- **+** `GET /webhooks/facebook/conexoes/:id`
- **+** `DELETE /webhooks/facebook/conexoes/:id`
- **+** `POST /webhooks/facebook/conexoes/:id/atualizar-paginas`
- **+** `GET /webhooks/facebook/conexoes/:id/paginas`
- **+** `GET /webhooks/facebook/conexoes/:id/paginas/:paginaId/formularios`
- **+** `GET /webhooks/facebook/conexoes/:id/paginas/:paginaId/formularios/:formularioId/perguntas`
- **+** `GET /publico/facebook/oauth/retorno`
- **+** `GET /configuracoes/apps-de-login`
- **+** `PUT /configuracoes/apps-de-login/:aplicativo`
- **+** `DELETE /configuracoes/apps-de-login/:aplicativo`
- **+** `GET /conexoes-aplicativo`
- **+** `POST /conexoes-aplicativo/oauth/iniciar`
- **+** `GET /conexoes-aplicativo/:id`
- **+** `DELETE /conexoes-aplicativo/:id`
- **+** `GET /publico/conexoes/oauth/retorno`
- **+** `GET /webhooks/saidas/formato-clint`
- **+** `POST /numeros/:id/conectar`
- **+** `POST /numeros/:id/desconectar`
- **+** `GET /numeros/:id/status`
- **+** `POST /numeros/:id/verificar`
- **+** `POST /numeros/:id/digitando`
- **+** `POST /simulador/receber`


**Testes**

- **+** `src/arquivos/politica.spec.ts`
- **+** `src/assistente/chamados/modelo-corpo.spec.ts`
- **+** `src/assistente/configuracao-assistente.spec.ts`
- **+** `src/assistente/esquema-assistente.spec.ts`
- **+** `src/assistente/prompt-assistente.spec.ts`
- **+** `src/atendimento/distribuicao-fila.spec.ts`
- **+** `src/atendimento/entrada.spec.ts`
- **+** `src/atendimento/horario.spec.ts`
- **+** `src/atendimento/satisfacao.spec.ts`
- **+** `src/atendimento/sla.spec.ts`
- **+** `src/atendimento/variaveis.spec.ts`
- **+** `src/atendimento/visibilidade.spec.ts`
- **+** `src/auth/dois-fatores/totp.spec.ts`
- **+** `src/auth/senhas-comuns.spec.ts`
- **+** `src/automacoes/acoes-validacao.spec.ts`
- **+** `src/automacoes/condicoes.spec.ts`
- **+** `src/automacoes/gatilho-config.spec.ts`
- **+** `src/automacoes/permissoes-automacoes.spec.ts`
- **+** `src/bi/analise/chamada-claude.service.spec.ts`
- **+** `src/bi/analise/entrada-analise.spec.ts`
- **+** `src/bi/analise/esquema-analise.spec.ts`
- **+** `src/bi/analise/links-analise.spec.ts`
- **+** `src/bi/cache-bi.spec.ts`
- **+** `src/bi/escopo-bi.spec.ts`
- **+** `src/bi/formatos-bi.spec.ts`
- **+** `src/bi/periodo.spec.ts`
- **+** `src/canais/comum/limitador.spec.ts`
- **+** `src/canais/email/interpretacao-email.spec.ts`
- **+** `src/canais/meta/adaptadores-meta.spec.ts`
- **+** `src/canais/meta/eventos-meta.spec.ts`
- **+** `src/canais/registro-canais.spec.ts`
- **+** `src/canais/webchat/botoes-da-mensagem.spec.ts`
- **+** `src/canais/webchat/configuracao-webchat.spec.ts`
- **+** `src/canais/webchat/widget.service.spec.ts`
- **+** `src/canais/whatsapp/contrato-gateway.spec.ts`
- **+** `src/canais/whatsapp/protecoes.spec.ts`
- **+** `src/canais/whatsapp-oficial/eventos-oficial.spec.ts`
- **+** `src/canais/whatsapp-oficial/formato-meta.spec.ts`
- **+** `src/chat-interno/regras-chat.spec.ts`
- **+** `src/chatbot/condicoes.spec.ts`
- **+** `src/chatbot/configuracao-dos-passos.spec.ts`
- **+** `src/chatbot/permissoes-chatbot.spec.ts`
- **+** `src/chatbot/respostas.spec.ts`
- **+** `src/chatbot/seletor-de-fluxo.spec.ts`
- **+** `src/comum/dados/textos.spec.ts`
- **+** `src/comum/gatilhos/gatilhos.spec.ts`
- **+** `src/comum/http/cabecalhos-de-seguranca.spec.ts`
- **+** `src/comum/modelos/modelos.spec.ts`
- **+** `src/comum/passos/definicao.spec.ts`
- **+** `src/comum/segmentos/segmentos.spec.ts`
- **+** `src/config/ambiente-producao.spec.ts`
- **+** `src/disparos/configuracao-disparos.spec.ts`
- **+** `src/disparos/ritmo.spec.ts`
- **+** `src/financeiro/campos-de-parcela.spec.ts`
- **+** `src/financeiro/datas.spec.ts`
- **+** `src/financeiro/permissoes-financeiro.spec.ts`
- **+** `src/financeiro/regua-padrao.spec.ts`
- **+** `src/financeiro/risco-de-churn.spec.ts`
- **+** `src/funis/acessos-extras.spec.ts`
- **+** `src/funis/acessos-no-banco.spec.ts`
- **+** `src/funis/negocios-em-massa.dados.spec.ts`
- **+** `src/importacao/campos.spec.ts`
- **+** `src/importacao/dados-do-negocio.spec.ts`
- **+** `src/importacao/ddi.spec.ts`
- **+** `src/importacao/filtro-de-linhas.spec.ts`
- **+** `src/importacao/importacao-processador.service.spec.ts`
- **+** `src/importacao/leitor-planilha.spec.ts`
- **+** `src/importacao/negocio-da-importacao.spec.ts`
- **+** `src/importacao/planilha-modelo.spec.ts`
- **+** `src/indicadores/calculo-indicadores.spec.ts`
- **+** `src/indicadores/catalogo.spec.ts`
- **+** `src/indicadores/formulas.spec.ts`
- **+** `src/indicadores/periodos.spec.ts`
- **+** `src/indicadores/validacao-widgets.spec.ts`
- **+** `src/ligacoes/formato-chamadas.spec.ts`
- **+** `src/ligacoes/gravacao/sugestoes-de-atividade.spec.ts`
- **+** `src/ligacoes/maquina-de-estados.spec.ts`
- **+** `src/ligacoes/permissoes.spec.ts`
- **+** `src/push/mapeamento.spec.ts`
- **+** `src/saude/monitoramento/avaliacao.spec.ts`
- **+** `src/sdr/categoria-passagem.spec.ts`
- **+** `src/sdr/esquema-sdr.spec.ts`
- **+** `src/sdr/prompt-sdr.spec.ts`
- **+** `src/sdr/qualificacao.spec.ts`
- **+** `src/transcricao/cliente-whisper.spec.ts`
- **+** `src/transcricao/esquema-resumo.spec.ts`
- **+** `src/transcricao/processador-de-audio.spec.ts`
- **+** `src/transcricao/trechos.spec.ts`
- **+** `src/tresc-plus/cliente-tresc-plus.spec.ts`
- **+** `src/tresc-plus/erros-tresc-plus.spec.ts`
- **+** `src/tresc-plus/eventos.spec.ts`
- **+** `src/tresc-plus/hosts-permitidos.spec.ts`
- **+** `src/tresc-plus/ouvinte-eventos.service.spec.ts`
- **+** `src/tresc-plus/telefone.spec.ts`
- **+** `src/usuarios/dominio/divisao-de-negocios.spec.ts`
- **+** `src/webhooks/aplicativos/aplicativos.spec.ts`
- **+** `src/webhooks/aplicativos/chamadas-http.spec.ts`
- **+** `src/webhooks/aplicativos/cursos.spec.ts`
- **+** `src/webhooks/aplicativos/formulario.spec.ts`
- **+** `src/webhooks/aplicativos/rd-station-api.spec.ts`
- **+** `src/webhooks/entrada/atualizacoes.spec.ts`
- **+** `src/webhooks/entrada/campos-recebidos.spec.ts`
- **+** `src/webhooks/entrada/mapeamento-aplicativos.spec.ts`
- **+** `src/webhooks/facebook/conexoes-facebook.service.spec.ts`
- **+** `src/webhooks/facebook/graph-facebook.spec.ts`
- **+** `src/webhooks/facebook/lead-facebook.spec.ts`
- **+** `src/webhooks/login/clientes-oauth.spec.ts`
- **+** `src/webhooks/login/estado-do-login.spec.ts`
- **+** `src/webhooks/login/retorno-de-login.spec.ts`
- **+** `src/webhooks/saida/formato-clint.spec.ts`
- **+** `src/whatsapp/midia/conversor-de-midia.spec.ts`
- **+** `src/whatsapp/transporte/mensagens-baileys.spec.ts`
- **+** `src/whatsapp/transporte/transporte-baileys.spec.ts`
- **+** `src/whatsapp/transporte/transporte-simulado.spec.ts`
- **+** `test/assistente.e2e-spec.ts`
- **+** `test/atendimento-configuracao.e2e-spec.ts`
- **+** `test/atendimento-conversas.e2e-spec.ts`
- **+** `test/atendimento-entrada.e2e-spec.ts`
- **+** `test/atendimento-mensagens.e2e-spec.ts`
- **+** `test/atividades-reuniao.e2e-spec.ts`
- **+** `test/automacoes-agenda.e2e-spec.ts`
- **+** `test/automacoes.e2e-spec.ts`
- **+** `test/bi-acesso.e2e-spec.ts`
- **+** `test/bi-analise.e2e-spec.ts`
- **+** `test/bi-atendimento.e2e-spec.ts`
- **+** `test/bi-comercial.e2e-spec.ts`
- **+** `test/bi-cs.e2e-spec.ts`
- **+** `test/bi-financeiro.e2e-spec.ts`
- **+** `test/bi-marketing.e2e-spec.ts`
- **+** `test/chatbot.e2e-spec.ts`
- **+** `test/cookie-seguro.e2e-spec.ts`
- **+** `test/disparos-respostas.e2e-spec.ts`
- **+** `test/disparos.e2e-spec.ts`
- **+** `test/dois-fatores.e2e-spec.ts`
- **+** `test/facebook-lead-ads.e2e-spec.ts`
- **+** `test/financeiro-regua.e2e-spec.ts`
- **+** `test/financeiro-sql.e2e-spec.ts`
- **+** `test/financeiro.e2e-spec.ts`
- **+** `test/foto-de-perfil.e2e-spec.ts`
- **+** `test/funis-visibilidade.e2e-spec.ts`
- **+** `test/importacao.e2e-spec.ts`
- **+** `test/indicadores.e2e-spec.ts`
- **+** `test/integracao-onda-a.e2e-spec.ts`
- **+** `test/integracoes-acesso.e2e-spec.ts`
- **+** `test/integracoes-aplicativos.e2e-spec.ts`
- **+** `test/integracoes-cursos.e2e-spec.ts`
- **+** `test/login-facilitado.e2e-spec.ts`
- **+** `test/negocios-em-massa.e2e-spec.ts`
- **+** `test/onda-a-arquivos-s3.e2e-spec.ts`
- **+** `test/onda-a-arquivos.e2e-spec.ts`
- **+** `test/onda-a-atendimento-base.e2e-spec.ts`
- **+** `test/onda-a-canais-email.e2e-spec.ts`
- **+** `test/onda-a-canais-meta.e2e-spec.ts`
- **+** `test/onda-a-canais-webchat.e2e-spec.ts`
- **+** `test/onda-a-chat-interno.e2e-spec.ts`
- **+** `test/onda-a-tempo-real.e2e-spec.ts`
- **+** `test/onda-a-whatsapp-gateway.e2e-spec.ts`
- **+** `test/onda-b-base.e2e-spec.ts`
- **+** `test/onda-e-gravacao.e2e-spec.ts`
- **+** `test/onda-e-historico.e2e-spec.ts`
- **+** `test/onda-e-ligacoes.e2e-spec.ts`
- **+** `test/onda-e-whatsapp-oficial.e2e-spec.ts`
- **+** `test/primeira-interacao.e2e-spec.ts`
- **+** `test/producao-limites.e2e-spec.ts`
- **+** `test/push.e2e-spec.ts`
- **+** `test/saude-do-sistema.e2e-spec.ts`
- **+** `test/sdr-correcoes.e2e-spec.ts`
- **+** `test/sdr-integracoes.e2e-spec.ts`
- **+** `test/sdr.e2e-spec.ts`
- **+** `test/setores.e2e-spec.ts`
- **+** `test/tresc-plus.e2e-spec.ts`
- **+** `test/whatsapp-estado-autenticacao.e2e-spec.ts`
- **+** `test/whatsapp-gateway.e2e-spec.ts`
- **+** `test/whatsapp-numeros.e2e-spec.ts`
- **+** `test/whatsapp-processo.e2e-spec.ts`


**Variaveis de ambiente**

- **+** `ARQUIVOS_TESTE_S3_CHAVE`
- **+** `ARQUIVOS_TESTE_S3_ENDPOINT`
- **+** `ARQUIVOS_TESTE_S3_SEGREDO`
- **+** `EMAIL_TESTE_HOST`
- **+** `EMAIL_TESTE_IMAP_PORTA`
- **+** `EMAIL_TESTE_SMTP_PORTA`
- **+** `PATH`


**Dependencias**

- **+** `@anthropic-ai/sdk ^1.3.0`
- **+** `@aws-sdk/client-s3 3.1145.0`
- **+** `@nestjs/platform-socket.io ^12.2.0`
- **+** `@nestjs/websockets ^12.2.0`
- **+** `baileys 7.0.0-rc14`
- **+** `exceljs ^4.4.0`
- **+** `imapflow 2.2.11`
- **+** `mailparser 3.9.37`
- **+** `qrcode ^1.5.4`
- **+** `socket.io 4.8.4`
- **+** `socket.io-client 4.8.4`
- **+** `web-push ^3.6.7`


**Dependencias de desenvolvimento**

- **+** `@types/mailparser ^3.9.0`
- **+** `@types/multer ^2.1.0`
- **+** `@types/qrcode ^1.5.6`
- **+** `@types/web-push ^3.6.4`


**Scripts npm**

- **+** `start:whatsapp node dist/whatsapp/main`


### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 269 | 981 | +712 |
| Linhas | 54010 | 271253 | +217243 |


---

## 2026-10-21 — sem commits novos

**O que foi feito:** Fase 1: regras de negócio do núcleo do BRL CRM

### Impacto na arquitetura

**Modulos**

- **+** `AdministracaoModule`
- **+** `AtividadesModule`
- **+** `AuditoriaModule`
- **+** `AuditoriaConsultaModule`
- **+** `AuthModule`
- **+** `ComumModule`
- **+** `ContatosModule`
- **+** `EmailModule`
- **+** `EventosModule`
- **+** `FilaModule`
- **+** `FunisModule`
- **+** `LogsModule`
- **+** `NotificacoesModule`
- **+** `SeedsModule`
- **+** `UsuariosModule`
- **+** `WebhooksModule`


**Controllers**

- **+** `AdministracaoController`
- **+** `AtividadesController`
- **+** `AuditoriaConsultaController`
- **+** `AuthController`
- **+** `ContatosController`
- **+** `EmpresasController`
- **+** `DistribuicaoController`
- **+** `FunisController`
- **+** `NegociosController`
- **+** `PassagensController`
- **+** `NotificacoesController`
- **+** `DesligamentoController`
- **+** `UsuariosController`
- **+** `WebhooksEntradaController`
- **+** `WebhookEntradaPublicoController`
- **+** `WebhooksSaidaController`


**Servicos**

- **+** `LogsTecnicosConsultaService`
- **+** `ResumoAdministracaoService`
- **+** `RetencaoService`
- **+** `AtividadesService`
- **+** `LembretesAtividadesService`
- **+** `AuditoriaService`
- **+** `AuditoriaConsultaService`
- **+** `ParseIdSequencialPipe`
- **+** `AuthService`
- **+** `ForcaBrutaService`
- **+** `OrigemGuard`
- **+** `PapeisGuard`
- **+** `SessaoGuard`
- **+** `SenhasService`
- **+** `SessoesService`
- **+** `CriptografiaService`
- **+** `ParseIdPipe`
- **+** `ContatosService`
- **+** `EmpresasService`
- **+** `LinhaDoTempoService`
- **+** `PermissoesContatosService`
- **+** `EmailService`
- **+** `EventosDominioService`
- **+** `FilaService`
- **+** `DistribuicaoService`
- **+** `FunisService`
- **+** `MetricasService`
- **+** `MotorDeNegociosService`
- **+** `NegociosConsultaService`
- **+** `NegociosService`
- **+** `ParseAreaPipe`
- **+** `PassagensService`
- **+** `LogsTecnicosService`
- **+** `NotificacoesService`
- **+** `SeedsService`
- **+** `DesligamentoService`
- **+** `UsuariosService`
- **+** `ProcessamentoEntradaService`
- **+** `RecebimentosService`
- **+** `WebhooksEntradaService`
- **+** `EntregasService`
- **+** `WebhooksSaidaService`


**Endpoints HTTP**

- **+** `GET /administracao/resumo`
- **+** `GET /administracao/logs-tecnicos`
- **+** `GET /administracao/logs-tecnicos/:id`
- **+** `POST /atividades`
- **+** `GET /atividades`
- **+** `GET /atividades/agrupadas`
- **+** `GET /atividades/:id`
- **+** `PATCH /atividades/:id`
- **+** `POST /atividades/:id/concluir`
- **+** `POST /atividades/:id/cancelar`
- **+** `POST /atividades/:id/reabrir`
- **+** `GET /auditoria`
- **+** `GET /auditoria/filtros`
- **+** `GET /auditoria/:id`
- **+** `POST /auth/entrar`
- **+** `POST /auth/sair`
- **+** `GET /auth/eu`
- **+** `POST /auth/senha`
- **+** `POST /auth/senha/esqueci`
- **+** `POST /auth/senha/token`
- **+** `POST /auth/senha/redefinir`
- **+** `GET /contatos`
- **+** `GET /contatos/etiquetas`
- **+** `POST /contatos`
- **+** `GET /contatos/:id`
- **+** `PATCH /contatos/:id`
- **+** `POST /contatos/:id/anonimizar`
- **+** `GET /contatos/:id/linha-do-tempo`
- **+** `GET /empresas`
- **+** `GET /empresas/etiquetas`
- **+** `POST /empresas`
- **+** `GET /empresas/:id`
- **+** `PATCH /empresas/:id`
- **+** `GET /empresas/:id/linha-do-tempo`
- **+** `GET /regras-distribuicao`
- **+** `GET /regras-distribuicao/:area`
- **+** `PATCH /regras-distribuicao/:area`
- **+** `PUT /regras-distribuicao/:area/participantes/:usuarioId`
- **+** `DELETE /regras-distribuicao/:area/participantes/:usuarioId`
- **+** `GET /funis`
- **+** `POST /funis`
- **+** `GET /funis/:id`
- **+** `PATCH /funis/:id`
- **+** `DELETE /funis/:id`
- **+** `POST /funis/:id/etapas`
- **+** `POST /funis/:id/etapas/reordenar`
- **+** `PATCH /funis/:id/etapas/:etapaId`
- **+** `DELETE /funis/:id/etapas/:etapaId`
- **+** `GET /funis/:id/quadro`
- **+** `GET /funis/:id/metricas`
- **+** `GET /negocios`
- **+** `POST /negocios`
- **+** `GET /negocios/:id`
- **+** `PATCH /negocios/:id`
- **+** `DELETE /negocios/:id`
- **+** `POST /negocios/:id/mover`
- **+** `POST /negocios/:id/reabrir`
- **+** `POST /negocios/:id/assumir`
- **+** `GET /negocios/:id/movimentacoes`
- **+** `GET /negocios/:id/linha-do-tempo`
- **+** `GET /passagens`
- **+** `POST /passagens`
- **+** `GET /passagens/:id`
- **+** `PATCH /passagens/:id`
- **+** `DELETE /passagens/:id`
- **+** `GET /notificacoes`
- **+** `GET /notificacoes/nao-lidas/contagem`
- **+** `POST /notificacoes/marcar-todas-lidas`
- **+** `POST /notificacoes/:id/marcar-lida`
- **+** `GET /usuarios/:id/desligamento/previa`
- **+** `POST /usuarios/:id/desligar`
- **+** `POST /usuarios/:id/reativar`
- **+** `GET /usuarios`
- **+** `GET /usuarios/equipes`
- **+** `GET /usuarios/:id`
- **+** `POST /usuarios`
- **+** `PATCH /usuarios/:id`
- **+** `POST /usuarios/:id/senha-temporaria`
- **+** `POST /usuarios/:id/convite`
- **+** `GET /webhooks/entradas/modelos`
- **+** `POST /webhooks/entradas/previa`
- **+** `GET /webhooks/entradas`
- **+** `POST /webhooks/entradas`
- **+** `GET /webhooks/entradas/:id`
- **+** `PATCH /webhooks/entradas/:id`
- **+** `DELETE /webhooks/entradas/:id`
- **+** `POST /webhooks/entradas/:id/regenerar-token`
- **+** `POST /webhooks/entradas/:id/segredo`
- **+** `DELETE /webhooks/entradas/:id/segredo`
- **+** `POST /webhooks/entradas/:id/previa`
- **+** `GET /webhooks/entradas/:id/recebimentos`
- **+** `GET /webhooks/entradas/:id/recebimentos/:recebimentoId`
- **+** `POST /webhooks/entradas/:id/recebimentos/:recebimentoId/reprocessar`
- **+** `POST /webhooks/entrada/:token`
- **+** `GET /webhooks/saidas/eventos`
- **+** `GET /webhooks/saidas`
- **+** `POST /webhooks/saidas`
- **+** `GET /webhooks/saidas/:id`
- **+** `PATCH /webhooks/saidas/:id`
- **+** `DELETE /webhooks/saidas/:id`
- **+** `POST /webhooks/saidas/:id/regenerar-segredo`
- **+** `POST /webhooks/saidas/:id/testar`
- **+** `GET /webhooks/saidas/:id/entregas`
- **+** `GET /webhooks/saidas/:id/entregas/:entregaId`
- **+** `POST /webhooks/saidas/:id/entregas/:entregaId/reenviar`


**Testes**

- **+** `src/atividades/dto/transformacoes.spec.ts`
- **+** `src/atividades/fuso-horario.spec.ts`
- **+** `src/atividades/lembretes-atividades.spec.ts`
- **+** `src/atividades/regras-atividades.spec.ts`
- **+** `src/auditoria/consulta/alteracoes.spec.ts`
- **+** `src/auditoria/consulta/auditoria-consulta.dto.spec.ts`
- **+** `src/auditoria/consulta/consulta-comum.spec.ts`
- **+** `src/comum/contexto/contexto-requisicao.spec.ts`
- **+** `src/comum/criptografia/criptografia.service.spec.ts`
- **+** `src/comum/dados/sanitizar.spec.ts`
- **+** `src/comum/dominio/normalizacoes.spec.ts`
- **+** `src/comum/dominio/papeis.spec.ts`
- **+** `src/comum/erros/filtro-de-erros.spec.ts`
- **+** `src/comum/validacao/validacao.spec.ts`
- **+** `src/contatos/contatos.service.spec.ts`
- **+** `src/contatos/deduplicacao.spec.ts`
- **+** `src/documentacao.spec.ts`
- **+** `src/funis/acesso-funis.spec.ts`
- **+** `src/funis/metricas-calculo.spec.ts`
- **+** `src/funis/negocio-completo.spec.ts`
- **+** `src/funis/posicao.spec.ts`
- **+** `src/funis/rodizio.spec.ts`
- **+** `src/usuarios/dominio/destinatario.spec.ts`
- **+** `src/usuarios/dominio/encaminhamento.spec.ts`
- **+** `src/usuarios/dominio/hierarquia.spec.ts`
- **+** `src/usuarios/dominio/visibilidade.spec.ts`
- **+** `src/usuarios/repeticao.spec.ts`
- **+** `src/webhooks/entrada/mapeamento.spec.ts`
- **+** `src/webhooks/saida/envelope.spec.ts`
- **+** `src/webhooks/saida/envio-http.spec.ts`
- **+** `src/webhooks/saida/protecao-ssrf.spec.ts`
- **+** `test/atividades-lembretes.e2e-spec.ts`
- **+** `test/atividades.e2e-spec.ts`
- **+** `test/auditoria-administracao.e2e-spec.ts`
- **+** `test/auditoria-consulta.e2e-spec.ts`
- **+** `test/base-auth.e2e-spec.ts`
- **+** `test/base-infraestrutura.e2e-spec.ts`
- **+** `test/contatos-empresas.e2e-spec.ts`
- **+** `test/contatos-linha-do-tempo.e2e-spec.ts`
- **+** `test/contatos.e2e-spec.ts`
- **+** `test/funis-configuracao.e2e-spec.ts`
- **+** `test/funis-distribuicao.e2e-spec.ts`
- **+** `test/funis-metricas.e2e-spec.ts`
- **+** `test/funis-negocios.e2e-spec.ts`
- **+** `test/funis-passagens.e2e-spec.ts`
- **+** `test/integracao.e2e-spec.ts`
- **+** `test/usuarios-desligamento.e2e-spec.ts`
- **+** `test/usuarios.e2e-spec.ts`
- **+** `test/webhooks-entrada.e2e-spec.ts`
- **+** `test/webhooks-saida-ssrf.e2e-spec.ts`
- **+** `test/webhooks-saida.e2e-spec.ts`


**Variaveis de ambiente**

- **+** `DATABASE_URL_TESTE`
- **−** `CORS_ORIGENS`
- **−** `NODE_ENV`
- **−** `OBSERVE_APP_KEY`
- **−** `OBSERVE_APP_SECRET`
- **−** `PORT`


**Dependencias**

- **+** `@nestjs/swagger ^12.0.2`
- **+** `class-transformer ^0.5.1`
- **+** `class-validator ^0.15.1`
- **+** `nodemailer ^10.1.7`
- **+** `pg-boss 12.35.1`


**Scripts npm**

- **+** `format:verificar prettier --check "src/**/*.ts" "test/**/*.ts"`


### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 38 | 269 | +231 |
| Linhas | 1433 | 54010 | +52577 |


---

## 2026-10-20 — 2 commits

**O que foi feito:** Base da API: Prisma 7.10.1 com @prisma/adapter-pg e PostgreSQL 17, migration inicial (usuários com papéis e liderança), configuração validada por variável de ambiente sem bibliotecas, endpoint GET /api/saude (200/503), prefixo /api, trust proxy, CORS opcional, @nestjs/observe só com as duas chaves, Dockerfile multi-stage, docker-entrypoint com migrate deploy e docker-compose completo (banco, api e web). Scaffold Hello World removido.

### Commits

| Commit | Data | Autor | Mensagem |
| --- | --- | --- | --- |
| `8ea7e65` | 2026-10-20 | luishdsg | Merge pull request #1 from GitBRL/dev |
| `951c255` | 2026-10-20 | luis | update |


### Arquivos alterados (11 · +1577 / -0)

- `tools/doc-updater/gerar.mjs` (+376 / -0)
- `tools/doc-updater/escanear.mjs` (+297 / -0)
- `tools/doc-updater/index.mjs` (+226 / -0)
- `docs/ARQUITETURA.md` (+198 / -0)
- `docs/.estado-docs.json` (+118 / -0)
- `tools/doc-updater/comparar.mjs` (+110 / -0)
- `tools/doc-updater/README.md` (+97 / -0)
- `docs/HISTORICO.md` (+71 / -0)
- `.claude/commands/atualizar-docs.md` (+67 / -0)
- `README.md` (+16 / -0)
- `package.json` (+1 / -0)


### Impacto na arquitetura

**Modulos**

- **+** `AmbienteModule`
- **+** `PrismaModule`
- **+** `SaudeModule`


**Controllers**

- **+** `SaudeController`
- **−** `AppController`


**Servicos**

- **+** `PrismaService`
- **+** `SaudeService`
- **−** `AppService`


**Endpoints HTTP**

- **+** `GET /saude`
- **−** `GET /`


**Testes**

- **+** `src/config/ambiente.spec.ts`
- **+** `src/observabilidade.spec.ts`
- **+** `src/saude/falha-do-banco.spec.ts`
- **+** `src/saude/saude.service.spec.ts`
- **+** `test/saude.e2e-spec.ts`
- **−** `src/app.controller.spec.ts`
- **−** `test/app.e2e-spec.ts`


**Variaveis de ambiente**

- **+** `CORS_ORIGENS`
- **+** `DATABASE_URL`
- **+** `NODE_ENV`
- **+** `OBSERVE_APP_KEY`
- **+** `OBSERVE_APP_SECRET`


**Dependencias**

- **+** `@prisma/adapter-pg 7.10.1`
- **+** `@prisma/client 7.10.1`
- **+** `pg ^8.23.1`
- **+** `prisma 7.10.1`


**Scripts npm**

- **+** `prisma:gerar prisma generate`
- **+** `prisma:migrar prisma migrate dev`
- **+** `postprisma:migrar prisma generate`
- **+** `prisma:aplicar prisma migrate deploy`
- **+** `prelint prisma generate`
- **+** `pretest prisma generate`
- **+** `pretest:e2e prisma generate`
- **~** `build: nest build -> prisma generate && nest build`


### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 18 | 38 | +20 |
| Linhas | 139 | 1433 | +1294 |


---

## 2026-10-20 — sem commits novos

**O que foi feito:** Script 'docs' adicionado ao package.json para rodar a atualizacao da documentacao.

### Impacto na arquitetura

**Scripts npm**

- **+** `docs node tools/doc-updater/index.mjs`


### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 18 | 18 | 0 |
| Linhas | 139 | 139 | 0 |


---

## 2026-10-20 — sem commits novos

**O que foi feito:** Ferramenta de documentacao e comando /atualizar-docs movidos para dentro do repositorio (tools/doc-updater e .claude/commands).

### Impacto na arquitetura

Nenhuma mudanca estrutural detectada desde a ultima atualizacao.

### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 18 | 18 | 0 |
| Linhas | 139 | 139 | 0 |


---

## 2026-10-20 — crmbrl-api (1 commit)

**O que foi feito:** Documentacao inicial: scaffolds do front-end Angular 22 e da API NestJS 12.

### Commits

| Commit | Data | Autor | Mensagem |
| --- | --- | --- | --- |
| `b28fd4c` | 2026-10-20 | luis | update |


### Impacto na arquitetura

Primeira execucao da ferramenta: inventario inicial registrado.

### Metricas

| Metrica | Antes | Agora | Delta |
| --- | --- | --- | --- |
| Arquivos | 0 | 18 | +18 |
| Linhas | 0 | 139 | +139 |


---

