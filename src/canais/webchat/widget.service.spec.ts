import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  embrulharWidget,
  TAMANHO_MAXIMO_DO_WIDGET,
  transpilarWidget,
  WidgetDoSite,
} from './widget.service';

const FONTE = readFileSync(
  join(__dirname, 'widget', 'widget-do-site.ts'),
  'utf8',
);

describe('WidgetDoSite', () => {
  it('embrulha o CommonJS do build num script de página (exports local, sem source map)', () => {
    const compilado =
      '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nwindow.ok = typeof exports;\n//# sourceMappingURL=widget-do-site.js.map\n';
    const js = embrulharWidget(compilado);
    expect(js).not.toContain('sourceMappingURL');
    const janela: Record<string, unknown> = {};
    runInNewContext(js, { window: janela });
    expect(janela.ok).toBe('object');
  });

  it('com as opções do build, o widget transpilado roda como script de página', () => {
    const js = embrulharWidget(transpilarWidget(FONTE));
    expect(js).not.toMatch(/\brequire\(/);
    const avisos: unknown[] = [];
    expect(() =>
      runInNewContext(js, {
        window: {},
        document: {
          currentScript: { dataset: {}, src: 'https://crm.test/w.js' },
        },
        console: { warn: (...args: unknown[]) => avisos.push(args) },
      }),
    ).not.toThrow();
    expect(avisos).toHaveLength(1);
  });

  it('serve o widget com ETag estável e abaixo de 40 KB', () => {
    const widget = new WidgetDoSite();
    const primeiro = widget.obter();
    expect(primeiro.bytes).toBeLessThan(TAMANHO_MAXIMO_DO_WIDGET);
    expect(primeiro.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(widget.obter()).toBe(primeiro);
    expect(new WidgetDoSite().obter().etag).toBe(primeiro.etag);
  });
});
