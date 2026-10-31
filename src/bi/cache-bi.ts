/**
 * Cache curto em memória, por chave (painel + pessoa + filtros). Vence só por
 * tempo: nenhum evento o invalida, então o painel pode estar até `ttlMs`
 * atrasado. Guarda no máximo `maximo` respostas (as mais antigas saem).
 */
export class CacheBi<T> {
  private readonly itens = new Map<string, { expiraEm: number; valor: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maximo: number,
    private readonly relogio: () => number = Date.now,
  ) {}

  obter(chave: string): T | undefined {
    const item = this.itens.get(chave);
    if (!item) {
      return undefined;
    }
    if (item.expiraEm <= this.relogio()) {
      this.itens.delete(chave);
      return undefined;
    }
    return item.valor;
  }

  guardar(chave: string, valor: T): void {
    this.itens.delete(chave);
    this.itens.set(chave, { expiraEm: this.relogio() + this.ttlMs, valor });
    while (this.itens.size > this.maximo) {
      const maisAntiga = this.itens.keys().next().value;
      if (maisAntiga === undefined) {
        break;
      }
      this.itens.delete(maisAntiga);
    }
  }

  limpar(): void {
    this.itens.clear();
  }

  get tamanho(): number {
    return this.itens.size;
  }
}
