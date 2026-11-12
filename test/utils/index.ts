/**
 * Utilitários dos testes de integração (contra o Postgres de `DATABASE_URL_TESTE`).
 *
 * ```ts
 * import { criarAppTeste, criarUsuario, entrarComo, type AppTeste } from './utils';
 *
 * describe('Contatos (e2e)', () => {
 *   let t: AppTeste;
 *   beforeAll(async () => { t = await criarAppTeste(); });
 *   beforeEach(() => t.limparBanco());
 *   afterAll(() => t.fechar());
 *
 *   it('R4.2 — não duplica contato com o mesmo e-mail', async () => {
 *     const admin = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
 *     await admin.post('/api/v1/contatos', { nome: 'Ana', email: 'ana@x.com' }).expect(201);
 *   });
 * });
 * ```
 */
export * from './ambiente-teste';
export * from './app-teste';
export * from './banco';
export * from './clientes';
export * from './contexto';
export * from './drenar';
export * from './email-falso';
export * from './fabricas';
export * from './gateway-whatsapp';
export * from './tempo-real';
export * from './onda-b';
export * from './servicos-de-login';
