// Servidor local (emulação da Vercel): rotas estáticas, cleanUrls, 404 e arquivos privados.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, ROOT } from '../helpers/server.js';

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

for (const [p, title] of [['/', /Aqta/], ['/obrigado', /Pagamento/], ['/acesso', /acesso/i], ['/checkout-demo', /demonstra/i]]) {
  test(`GET ${p} ⇒ 200 HTML`, async () => {
    const r = await srv.request(p, { json: false });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.text, /<html lang="pt-BR">/);
    assert.match(r.text.match(/<title>(.*?)<\/title>/)[1], title);
  });
}

test('rota inexistente ⇒ 404 com a página 404.html', async () => {
  const r = await srv.request('/pagina-que-nao-existe', { json: false });
  assert.equal(r.status, 404);
  assert.match(r.text, /Página não encontrada/);
});

test('/api inexistente ⇒ 404 JSON', async () => {
  for (const p of ['/api/nada', '/api/../server', '/api/CHECKOUT', '/api/']) {
    const r = await srv.request(p);
    assert.equal(r.status, 404, p);
  }
});

test('arquivos privados não são servidos (lib, tests, docs, server.js, package.json, .env)', async () => {
  for (const p of ['/lib/token.js', '/lib/catalog.js', '/tests/helpers/server.js', '/docs/ARQUITETURA.md',
    '/server.js', '/package.json', '/.env', '/.env.example', '/.git/config', '/api/checkout.js']) {
    const r = await srv.request(p, { json: false });
    assert.equal(r.status, 404, `${p} deveria ser 404, veio ${r.status}`);
  }
});

test('path traversal não escapa da raiz', async () => {
  for (const p of ['/..%2f..%2fetc%2fpasswd', '/assets/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const r = await srv.request(p, { json: false });
    assert.ok([403, 404].includes(r.status), `${p} ⇒ ${r.status}`);
    assert.doesNotMatch(r.text, /root:/);
  }
});

test('assets referenciados nas páginas existem e têm Content-Type correto', async () => {
  const html = ['index.html', 'obrigado.html', 'acesso.html', 'checkout-demo.html', '404.html']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const refs = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"#?]+)"/g)].map((m) => m[1]));
  assert.ok(refs.size > 5);
  for (const ref of refs) {
    const r = await srv.request(ref, { json: false });
    assert.equal(r.status, 200, ref);
    const ext = path.extname(ref);
    const expected = { '.css': /text\/css/, '.js': /javascript/, '.svg': /image\/svg\+xml/, '.png': /image\/png/, '.jpg': /image\/jpeg/ }[ext];
    if (expected) assert.match(r.headers.get('content-type'), expected, ref);
  }
});
