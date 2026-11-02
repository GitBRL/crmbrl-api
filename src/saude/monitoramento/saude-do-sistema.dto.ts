import { ApiProperty } from '@nestjs/swagger';

/** Corpo de `GET /api/v1/administracao/saude-do-sistema` (R27). Contrato com o front: mudou aqui, mude lá. */

export class AlertaDoPainelDto {
  @ApiProperty({ example: 'numero:3f2a…' }) chave!: string;
  @ApiProperty({ example: 'numero_desconectado' }) codigo!: string;
  @ApiProperty({ enum: ['aviso', 'critico'] }) gravidade!: 'aviso' | 'critico';
  @ApiProperty() titulo!: string;
  @ApiProperty() detalhe!: string;
  @ApiProperty({ description: 'O que fazer.' }) dica!: string;
  @ApiProperty({ description: 'Também sai por e-mail ao Admin.' })
  porEmail!: boolean;
}

export class FilaDoPainelDto {
  @ApiProperty() nome!: string;
  @ApiProperty() pendentes!: number;
  @ApiProperty() ativas!: number;
  @ApiProperty({ description: 'Falhas nas últimas 24 horas.' })
  falhasRecentes!: number;
  @ApiProperty({ type: Number, nullable: true })
  maisAntigaParadaSegundos!: number | null;
  @ApiProperty() travada!: boolean;
}

export class FilasDoPainelDto {
  @ApiProperty({ description: 'Falso se o pg-boss ainda não criou o schema.' })
  disponivel!: boolean;
  @ApiProperty({ type: [FilaDoPainelDto] }) itens!: FilaDoPainelDto[];
  @ApiProperty() totalPendentes!: number;
  @ApiProperty() totalAtivas!: number;
  @ApiProperty() totalFalhasRecentes!: number;
  @ApiProperty({ type: Number, nullable: true })
  maisAntigaParadaSegundos!: number | null;
}

export class GatewayDoPainelDto {
  @ApiProperty({ enum: ['ok', 'degradado', 'fora_do_ar'] })
  status!: 'ok' | 'degradado' | 'fora_do_ar';
  @ApiProperty() simulado!: boolean;
}

export class TranscricaoDoPainelDto {
  @ApiProperty({
    enum: ['ok', 'fora_do_ar', 'desativada'],
    description:
      '`desativada`: sem `TRANSCRICAO_URL` (a gravação continua, sem texto). `fora_do_ar`: o serviço `transcricao` (whisper.cpp) não responde.',
  })
  situacao!: 'ok' | 'fora_do_ar' | 'desativada';
  @ApiProperty({
    description: 'Modelo do Whisper configurado (`WHISPER_MODELO`).',
  })
  modelo!: string;
  @ApiProperty({
    description: 'Ligações esperando transcrição ou resumo na fila.',
  })
  pendentes!: number;
  @ApiProperty({ description: 'Em processamento agora.' }) ativas!: number;
  @ApiProperty({ description: 'Jobs que falharam nas últimas 24 h.' })
  falhasRecentes!: number;
}

export class NumeroDoPainelDto {
  @ApiProperty() id!: string;
  @ApiProperty() nome!: string;
  @ApiProperty({ type: String, nullable: true }) telefone!: string | null;
  @ApiProperty({
    enum: [
      'DESCONECTADO',
      'AGUARDANDO_QR',
      'CONECTANDO',
      'CONECTADO',
      'ERRO',
      'BANIDO',
    ],
  })
  status!: string;
  @ApiProperty({ type: String, nullable: true }) motivo!: string | null;
  @ApiProperty() canalAtivo!: boolean;
  @ApiProperty() pausado!: boolean;
  @ApiProperty({ description: 'Precisa de atenção (caiu, erro ou banido).' })
  comProblema!: boolean;
  @ApiProperty({ type: String, nullable: true }) desconectadoEm!: string | null;
}

export class CanalDoPainelDto {
  @ApiProperty() id!: string;
  @ApiProperty() tipo!: string;
  @ApiProperty() nome!: string;
  @ApiProperty() ativo!: boolean;
  @ApiProperty({ type: String, nullable: true }) ultimoErro!: string | null;
  @ApiProperty({ type: String, nullable: true }) ultimoErroEm!: string | null;
  @ApiProperty({ description: 'Erro nas últimas 24 horas.' })
  comErroRecente!: boolean;
}

export class ErroRecenteDoPainelDto {
  @ApiProperty({ description: 'Id do log técnico (texto).' }) id!: string;
  @ApiProperty() criadoEm!: string;
  @ApiProperty() contexto!: string;
  @ApiProperty() mensagem!: string;
}

export class ErrosDoPainelDto {
  @ApiProperty({ description: 'Erros nas últimas 24 horas.' })
  total24h!: number;
  @ApiProperty({ type: [ErroRecenteDoPainelDto] })
  recentes!: ErroRecenteDoPainelDto[];
}

export class DiscoDoPainelDto {
  @ApiProperty() caminho!: string;
  @ApiProperty() totalBytes!: number;
  @ApiProperty() livreBytes!: number;
  @ApiProperty() livrePercentual!: number;
  @ApiProperty({ enum: ['ok', 'aviso', 'critico'] }) situacao!:
    'ok' | 'aviso' | 'critico';
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Tamanho do banco de dados.',
  })
  bancoBytes!: number | null;
}

export class UltimoBackupDoPainelDto {
  @ApiProperty() inicio!: string;
  @ApiProperty() fim!: string;
  @ApiProperty({ type: String, nullable: true }) arquivo!: string | null;
  @ApiProperty({ type: Number, nullable: true }) tamanhoBytes!: number | null;
  @ApiProperty() ok!: boolean;
  @ApiProperty({ type: String, nullable: true }) erro!: string | null;
}

export class BackupDoPainelDto {
  @ApiProperty({ enum: ['ok', 'falhou', 'atrasado', 'nenhum', 'ilegivel'] })
  situacao!: 'ok' | 'falhou' | 'atrasado' | 'nenhum' | 'ilegivel';
  @ApiProperty({ type: UltimoBackupDoPainelDto, nullable: true })
  ultimo!: UltimoBackupDoPainelDto | null;
  @ApiProperty({ type: Number, nullable: true }) idadeHoras!: number | null;
}

export class SaudeDoSistemaDto {
  @ApiProperty() geradoEm!: string;
  @ApiProperty({ enum: ['ok', 'atencao', 'critico'] }) situacao!:
    'ok' | 'atencao' | 'critico';
  @ApiProperty({ type: [AlertaDoPainelDto] }) alertas!: AlertaDoPainelDto[];
  @ApiProperty({ type: FilasDoPainelDto }) filas!: FilasDoPainelDto;
  @ApiProperty({ type: GatewayDoPainelDto }) gateway!: GatewayDoPainelDto;
  @ApiProperty({ type: TranscricaoDoPainelDto })
  transcricao!: TranscricaoDoPainelDto;
  @ApiProperty({ type: [NumeroDoPainelDto] }) numeros!: NumeroDoPainelDto[];
  @ApiProperty({ type: [CanalDoPainelDto] }) canais!: CanalDoPainelDto[];
  @ApiProperty({ type: ErrosDoPainelDto }) erros!: ErrosDoPainelDto;
  @ApiProperty({ type: DiscoDoPainelDto, nullable: true })
  disco!: DiscoDoPainelDto | null;
  @ApiProperty({ type: BackupDoPainelDto }) backup!: BackupDoPainelDto;
  @ApiProperty({ description: 'A API tem SMTP para enviar os alertas.' })
  emailConfigurado!: boolean;
}
