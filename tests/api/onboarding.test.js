import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, patchEnv, importProject } from '../helpers/server.js';
import { startCaptureServer } from '../helpers/capture.js';
import { startObtraMock, startEmptraMock } from '../helpers/mock-products.js';
import { invoke } from '../helpers/invoke.js';
import { approvedAccess, demoPurchase, onboardingInput, decodeToken, signTokenAt, CPF_DIGITS } from '../helpers/fixtures.js';

let srv;
let cap;
before(async () => {
  cap = await startCaptureServer();
  srv = await startServer({ env: { AQTA_NOTIFY_WEBHOOK: cap.url, AQTA_WHATSAPP: '5521988887777' } });
});
after(async () => { await srv.close(); await cap.close(); });
beforeEach(() => cap.clear());

const post = (body) => srv.request('/api/onboarding', { method: 'POST', body });
const get = (token) => srv.request(`/api/onboarding?token=${encodeURIComponent(token)}`);

describe('token', () => {
  test('GET com accessToken válido (antes do onboarding) ⇒ dados públicos, onboarded=false', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const r = await get(accessToken);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.onboarded, false);
    assert.equal(r.body.product, 'obtra');
    assert.equal(r.body.productName, 'Obtra');
    assert.equal(r.body.mode, null);
    assert.equal(r.body.loginUrl, 'https://obtra.vercel.app/entrar');
    assert.equal(r.body.loginEmail, 'maria.teste@example.com');
    assert.match(r.body.supportWhatsappUrl, /^https:\/\/wa\.me\/5521988887777\?text=/);
  });

  test('GET Emptra ⇒ loginUrl do Emptra terminando em /entrar', async () => {
    const { accessToken } = await approvedAccess(srv, 'emptra');
    const r = await get(accessToken);
    assert.equal(r.body.loginUrl, 'https://emptra.srv1848886.hstgr.cloud/entrar');
  });

  test('GET sem token / inválido / adulterado ⇒ 401 invalid_token', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const p = decodeToken(accessToken); p.product = 'emptra';
    const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${accessToken.split('.')[1]}`;
    for (const t of ['', 'abc', 'a.b', forged]) {
      const r = await get(t);
      assert.equal(r.status, 401, t.slice(0, 10));
      assert.equal(r.body.error, 'invalid_token');
    }
  });

  test('token expirado ⇒ 401 expired_token (GET e POST com mensagem)', async () => {
    const expired = await signTokenAt(-8 * 86400, { t: 'access', paymentId: 'x1', product: 'obtra', plan: 'basico', customer: {} }, 7 * 86400);
    const g = await get(expired);
    assert.equal(g.status, 401);
    assert.equal(g.body.error, 'expired_token');
    const p = await post(onboardingInput(expired));
    assert.equal(p.status, 401);
    assert.equal(p.body.error, 'expired_token');
    assert.match(p.body.message, /expirou/);
  });

  test('token de outro tipo (checkout demo, pagamento demo) ⇒ 401 invalid_token', async () => {
    const pur = await demoPurchase(srv, 'obtra', 'approved');
    const { signToken } = await importProject('lib/token.js');
    const unknownProduct = signToken({ t: 'access', paymentId: 'p', product: 'xpto', plan: 'basico' }, 600);
    for (const t of [pur.checkoutToken, pur.paymentId.slice(5), pur.paymentId, unknownProduct]) {
      const r = await post(onboardingInput(t));
      assert.equal(r.status, 401, t.slice(0, 15));
      assert.equal(r.body.error, 'invalid_token');
    }
  });
});

describe('validação', () => {
  let token;
  let tokenEmptra;
  before(async () => {
    token = (await approvedAccess(srv, 'obtra')).accessToken;
    tokenEmptra = (await approvedAccess(srv, 'emptra')).accessToken;
  });
  const cases = [
    ['company', { company: '' }], ['company', { company: 'X' }], ['company', { company: 'E'.repeat(121) }],
    ['document', { document: '' }], ['document', { document: '12345678900' }], ['document', { document: '11222333000180' }], ['document', { document: '123' }],
    ['responsible', { responsible: 'Al' }], ['responsible', { responsible: '123456' }],
    ['loginEmail', { loginEmail: 'x' }], ['loginEmail', { loginEmail: 'a@b' }],
    ['whatsapp', { whatsapp: '123' }], ['whatsapp', { whatsapp: '21887654321' }],
    ['extra.cidade', { extra: { obrasAtivas: '1-3', uf: 'RJ' } }],
    ['extra.uf', { extra: { cidade: 'Niterói', uf: 'XX' } }],
  ];
  for (const [field, patch] of cases) {
    test(`${field} inválido ⇒ 400 fields["${field}"]`, async () => {
      const r = await post(onboardingInput(token, 'obtra', patch));
      assert.equal(r.status, 400, r.text);
      assert.equal(r.body.error, 'validation');
      assert.ok(r.body.fields[field], r.text);
    });
  }

  test('Emptra sem perfil / perfil inválido ⇒ 400 extra.perfil', async () => {
    for (const extra of [{ cidade: 'Niterói', uf: 'RJ' }, { perfil: 'admin', cidade: 'Niterói', uf: 'RJ' }]) {
      const r = await post(onboardingInput(tokenEmptra, 'emptra', { extra }));
      assert.equal(r.status, 400);
      assert.ok(r.body.fields['extra.perfil'], r.text);
    }
  });

  test('extra como array/string não derruba ⇒ 400 extra.cidade', async () => {
    for (const extra of [[1, 2], 'x', null]) {
      const r = await post(onboardingInput(token, 'obtra', { extra }));
      assert.equal(r.status, 400);
      assert.ok(r.body.fields['extra.cidade']);
    }
  });

  test('corpo grande ⇒ 413; PUT ⇒ 405', async () => {
    const r = await post(onboardingInput(token, 'obtra', { junk: 'x'.repeat(9000) }));
    assert.equal(r.status, 413);
    const m = await srv.request('/api/onboarding', { method: 'PUT', body: {} });
    assert.equal(m.status, 405);
  });
});

describe('modo manual (sem credenciais de provisionamento)', () => {
  test('Obtra ⇒ 200 manual, prazo 1 dia útil, sem senha, token onboarded, equipe notificada', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const input = onboardingInput(accessToken, 'obtra');
    const r = await post(input);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.mode, 'manual');
    assert.equal(r.body.product, 'obtra');
    assert.equal(r.body.loginUrl, 'https://obtra.vercel.app/entrar');
    assert.equal(r.body.loginEmail, input.loginEmail);
    assert.equal(r.body.manualDeadline, 'até 1 dia útil');
    assert.equal(r.body.tempPassword, undefined);
    assert.equal(r.body.company, 'Construtora Teste Ltda');
    const t = decodeToken(r.body.accessToken);
    assert.equal(t.t, 'access');
    assert.equal(t.onboarded, true);
    assert.equal(t.onboarding.mode, 'manual');
    assert.equal(t.exp - t.iat, 30 * 86400);
    const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed')).body;
    assert.equal(ev.mode, 'manual');
    assert.equal(ev.manualActionRequired, true);
    assert.equal(ev.loginEmail, input.loginEmail);
    assert.equal(ev.document, input.document);
    assert.deepEqual(ev.extra, { cidade: 'Niterói', uf: 'RJ', obrasAtivas: '4-10' });
    assert.match(ev.text, /LIBERAÇÃO MANUAL PENDENTE/);

    const g = await get(r.body.accessToken);
    assert.equal(g.status, 200);
    assert.equal(g.body.onboarded, true);
    assert.equal(g.body.mode, 'manual');
    assert.equal(g.body.loginEmail, input.loginEmail);
  });

  test('Emptra (fornecedor via chave "profile") ⇒ 200 manual com profile', async () => {
    const { accessToken } = await approvedAccess(srv, 'emptra');
    const r = await post(onboardingInput(accessToken, 'emptra', { extra: { profile: 'Fornecedor', city: 'Niterói/RJ' } }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.mode, 'manual');
    assert.equal(r.body.profile, 'fornecedor');
    assert.equal(r.body.loginUrl, 'https://emptra.srv1848886.hstgr.cloud/entrar');
  });

  test('OBTRA_APP_URL / EMPTRA_APP_URL mudam o loginUrl (sempre /entrar)', async () => {
    const restore = patchEnv({ OBTRA_APP_URL: 'https://app.obtra.com.br/', EMPTRA_APP_URL: 'https://app.emptra.com.br' });
    try {
      const a = await approvedAccess(srv, 'obtra');
      assert.equal((await post(onboardingInput(a.accessToken))).body.loginUrl, 'https://app.obtra.com.br/entrar');
      const b = await approvedAccess(srv, 'emptra');
      assert.equal((await post(onboardingInput(b.accessToken, 'emptra'))).body.loginUrl, 'https://app.emptra.com.br/entrar');
    } finally { restore(); }
  });
});

describe('idempotência', () => {
  test('segundo POST com o mesmo token ⇒ alreadyDone com o mesmo accessToken (sem novo provisionamento)', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const first = await post(onboardingInput(accessToken));
    assert.equal(first.status, 200);
    cap.clear();
    const second = await post(onboardingInput(accessToken, 'obtra', { loginEmail: 'outro@example.com' }));
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyDone, true);
    assert.equal(second.body.accessToken, first.body.accessToken);
    assert.equal(second.body.loginEmail, first.body.loginEmail, 'não troca o e-mail já ativado');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(cap.events('onboarding.completed').length, 0, 'não notifica de novo');
  });

  test('POST com o token já "onboarded" ⇒ alreadyDone', async () => {
    const { accessToken } = await approvedAccess(srv, 'obtra');
    const first = await post(onboardingInput(accessToken));
    const again = await post({ accessToken: first.body.accessToken });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyDone, true);
    assert.equal(again.body.mode, 'manual');
  });
});

describe('provisionamento automático — Obtra (Supabase mock)', () => {
  let obtra;
  let restore;
  before(async () => {
    obtra = await startObtraMock();
  });
  after(() => obtra.close());
  beforeEach(() => { obtra.state.opts.failRpc = null; });
  const withObtra = (extra = {}) => patchEnv({ OBTRA_SUPABASE_URL: obtra.url + '/', OBTRA_SUPABASE_SERVICE_KEY: obtra.serviceKey, ...extra });

  test('cria empresa + usuário admin e devolve senha temporária forte (só na resposta)', async () => {
    restore = withObtra();
    try {
      const { accessToken } = await approvedAccess(srv, 'obtra');
      const input = onboardingInput(accessToken, 'obtra', { loginEmail: 'Novo.Admin@Example.com' });
      const r = await post(input);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.mode, 'auto');
      assert.equal(r.body.loginEmail, 'novo.admin@example.com');
      assert.equal(r.body.loginUrl, 'https://obtra.vercel.app/entrar');
      const pwd = r.body.tempPassword;
      assert.equal(typeof pwd, 'string');
      assert.equal(pwd.length, 14);
      assert.match(pwd, /[A-Z]/); assert.match(pwd, /[a-z]/); assert.match(pwd, /[2-9]/); assert.match(pwd, /[@#$%&*!?]/);
      assert.doesNotMatch(pwd, /[0O1lI]/);

      const [empresaCall] = obtra.state.calls.filter((c) => c.path === '/rest/v1/empresas' && c.method === 'POST');
      assert.equal(empresaCall.body.nome, 'Construtora Teste Ltda');
      assert.equal(empresaCall.body.cnpj, '11.222.333/0001-81');
      assert.equal(empresaCall.body.cidade, 'Niterói');
      assert.equal(empresaCall.body.uf, 'RJ');
      assert.equal(empresaCall.body.telefone, '(21) 98765-4321');
      assert.equal(empresaCall.body.ativa, true);
      assert.match(empresaCall.headers.prefer, /return=representation/);
      assert.equal(empresaCall.headers.authorization, undefined, 'chave sb_secret_ não vai como Bearer');
      const user = obtra.state.usuarios.at(-1);
      assert.equal(user.p_email, 'novo.admin@example.com');
      assert.equal(user.p_papel, 'admin');
      assert.equal(user.p_senha, pwd);
      assert.equal(user.p_nome, 'Maria Teste da Silva');

      // A senha não vai para o token, nem para a equipe, nem para o GET.
      assert.doesNotMatch(Buffer.from(r.body.accessToken.split('.')[0], 'base64url').toString(), new RegExp(pwd.replace(/[$*?]/g, '\\$&')));
      const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed')).body;
      assert.equal(ev.mode, 'auto');
      assert.ok(!JSON.stringify(ev).includes(pwd), 'senha vazou para a notificação');
      const g = await get(r.body.accessToken);
      assert.ok(!g.text.includes(pwd));
      assert.equal(g.body.mode, 'auto');
    } finally { restore(); }
  });

  test('chave legada JWT (eyJ...) também vai no Authorization: Bearer', async () => {
    const jwtMock = await startObtraMock({ serviceKey: 'eyJhbGciOi.test.key' });
    restore = patchEnv({ OBTRA_SUPABASE_URL: jwtMock.url, OBTRA_SUPABASE_SERVICE_KEY: 'eyJhbGciOi.test.key' });
    try {
      const { accessToken } = await approvedAccess(srv, 'obtra');
      const r = await post(onboardingInput(accessToken));
      assert.equal(r.body.mode, 'auto', r.text);
      assert.ok(jwtMock.state.calls.every((c) => c.headers.authorization === 'Bearer eyJhbGciOi.test.key'));
    } finally { restore(); await jwtMock.close(); }
  });

  test('e-mail já cadastrado ⇒ fallback manual sem criar empresa, com aviso à equipe', async () => {
    restore = withObtra();
    try {
      obtra.state.perfis.add('ja.existe@example.com');
      const before = obtra.state.empresas.size;
      const { accessToken } = await approvedAccess(srv, 'obtra');
      const r = await post(onboardingInput(accessToken, 'obtra', { loginEmail: 'ja.existe@example.com' }));
      assert.equal(r.status, 200);
      assert.equal(r.body.mode, 'manual');
      assert.equal(r.body.tempPassword, undefined);
      assert.match(r.body.notes, /já tem cadastro/);
      assert.equal(obtra.state.empresas.size, before);
      const ev = (await cap.waitFor((b) => b.event === 'onboarding.completed')).body;
      assert.match(ev.provisionError, /já cadastrado/);
    } finally { restore(); }
  });

  test('falha na RPC ⇒ desfaz a empresa (sem órfã), cai para manual e NÃO vaza a senha', async () => {
    restore = withObtra();
    obtra.state.opts.failRpc = { status: 500, body: { message: 'erro interno do banco' } };
    try {
      const before = obtra.state.empresas.size;
      const { accessToken } = await approvedAccess(srv, 'obtra');
      const r = await post(onboardingInput(accessToken));
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.mode, 'manual');
      assert.equal(r.body.tempPassword, undefined);
      assert.ok(obtra.state.calls.some((c) => c.method === 'DELETE' && c.path === '/rest/v1/empresas'), 'rollback não chamado');
      assert.equal(obtra.state.empresas.size, before, 'empresa órfã ficou no banco');
      const sent = obtra.state.calls.filter((c) => c.path === '/rest/v1/rpc/admin_criar_usuario').at(-1).body.p_senha;
      assert.ok(!r.text.includes(sent), 'senha vazou na resposta');
      const ev = await cap.waitFor((b) => b.event === 'onboarding.completed');
      assert.ok(!JSON.stringify(ev.body).includes(sent), 'senha vazou na notificação');
      assert.equal(ev.body.mode, 'manual');
      assert.ok(ev.body.provisionError);
    } finally { restore(); }
  });

  test('Supabase fora do ar (rede) ⇒ fallback manual', async () => {
    restore = patchEnv({ OBTRA_SUPABASE_URL: 'http://127.0.0.1:9', OBTRA_SUPABASE_SERVICE_KEY: 'x' });
    try {
      const { accessToken } = await approvedAccess(srv, 'obtra');
      const r = await post(onboardingInput(accessToken));
      assert.equal(r.status, 200);
      assert.equal(r.body.mode, 'manual');
    } finally { restore(); }
  });

  test('duplo clique (2 POSTs simultâneos) ⇒ um único usuário criado', async () => {
    restore = withObtra();
    try {
      const { accessToken } = await approvedAccess(srv, 'obtra');
      const before = obtra.state.usuarios.length;
      const input = onboardingInput(accessToken);
      const [a, b] = await Promise.all([post(input), post(input)]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      assert.equal(obtra.state.usuarios.length, before + 1);
      assert.ok(a.body.alreadyDone || b.body.alreadyDone);
    } finally { restore(); }
  });

  test('um pagamento não pode criar duas contas, mesmo em outra instância serverless (sem cache em memória)', async () => {
    // Na Vercel cada instância tem seu próprio Map `done`. O accessToken original continua válido por 7 dias,
    // então reenviar o formulário (outra instância, deploy ou cold start) com outro e-mail cria outra conta.
    restore = withObtra();
    try {
      const { accessToken } = await approvedAccess(srv, 'obtra');
      const first = await post(onboardingInput(accessToken, 'obtra', { loginEmail: 'conta1@example.com' }));
      assert.equal(first.body.mode, 'auto');
      const fresh = await importProject('api/onboarding.js', { fresh: true });
      const second = await invoke(fresh.default, { method: 'POST', body: onboardingInput(accessToken, 'obtra', { loginEmail: 'conta2@example.com' }) });
      const created = obtra.state.usuarios.filter((u) => ['conta1@example.com', 'conta2@example.com'].includes(u.p_email)).length;
      assert.equal(created, 1, `BUG: o mesmo pagamento criou ${created} contas (2ª resposta: mode=${second.body?.mode}, alreadyDone=${second.body?.alreadyDone})`);
    } finally { restore(); }
  });
});

describe('provisionamento automático — Emptra (API mock)', () => {
  let emptra;
  let restore;
  before(async () => { emptra = await startEmptraMock(); });
  after(() => emptra.close());
  beforeEach(() => { emptra.state.opts.failUser = null; emptra.state.opts.adminRole = 'ADMIN'; emptra.state.loggedOut = false; });
  const withEmptra = (extra = {}) => patchEnv({ EMPTRA_API_URL: emptra.url, EMPTRA_ADMIN_EMAIL: emptra.adminEmail, EMPTRA_ADMIN_PASSWORD: emptra.adminPassword, ...extra });

  test('comprador com CNPJ ⇒ empresa BUYER + usuário ACTIVE, senha temporária, logout do admin', async () => {
    restore = withEmptra();
    try {
      const { accessToken } = await approvedAccess(srv, 'emptra');
      const r = await post(onboardingInput(accessToken, 'emptra', { loginEmail: 'comprador@example.com' }));
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.mode, 'auto');
      assert.equal(r.body.profile, 'comprador');
      assert.equal(r.body.loginUrl, 'https://emptra.srv1848886.hstgr.cloud/entrar');
      assert.equal(r.body.tempPassword.length, 14);
      const company = [...emptra.state.companies.values()].at(-1);
      assert.equal(company.type, 'BUYER');
      assert.equal(company.cnpj, '11222333000181');
      assert.equal(company.city, 'Niterói');
      assert.equal(company.state, 'RJ');
      assert.equal(company.active, true);
      const user = emptra.state.users.at(-1);
      assert.equal(user.email, 'comprador@example.com');
      assert.equal(user.role, 'BUYER');
      assert.equal(user.status, 'ACTIVE');
      assert.equal(user.password, r.body.tempPassword);
      assert.equal(emptra.state.loggedOut, true, 'sessão do admin não foi encerrada');
      const ev = await cap.waitFor((b) => b.event === 'onboarding.completed');
      assert.ok(!JSON.stringify(ev.body).includes(r.body.tempPassword));
    } finally { restore(); }
  });

  test('fornecedor com CPF ⇒ empresa SUPPLIER, cnpj null (CPF não vai no campo cnpj)', async () => {
    restore = withEmptra();
    try {
      const { accessToken } = await approvedAccess(srv, 'emptra');
      const r = await post(onboardingInput(accessToken, 'emptra', { document: CPF_DIGITS, extra: { perfil: 'fornecedor', cidade: 'Maricá', uf: 'RJ' } }));
      assert.equal(r.body.mode, 'auto', r.text);
      assert.equal(r.body.profile, 'fornecedor');
      const company = [...emptra.state.companies.values()].at(-1);
      assert.equal(company.type, 'SUPPLIER');
      assert.equal(company.cnpj, null);
      assert.deepEqual(company.profile, { categories: [] });
      assert.equal(emptra.state.users.at(-1).role, 'SUPPLIER');
    } finally { restore(); }
  });

  test('falha ao criar usuário ⇒ rollback da empresa, fallback manual, sem senha, logout feito', async () => {
    restore = withEmptra();
    emptra.state.opts.failUser = { status: 500, body: { error: { code: 'INTERNAL', message: 'falhou' } } };
    try {
      const before = emptra.state.companies.size;
      const { accessToken } = await approvedAccess(srv, 'emptra');
      const r = await post(onboardingInput(accessToken, 'emptra'));
      assert.equal(r.status, 200);
      assert.equal(r.body.mode, 'manual');
      assert.equal(r.body.tempPassword, undefined);
      assert.equal(r.body.profile, 'comprador');
      assert.equal(emptra.state.companies.size, before, 'empresa órfã');
      assert.equal(emptra.state.loggedOut, true);
      const sent = emptra.state.calls.filter((c) => c.path === '/admin/users' && c.method === 'POST').at(-1).body.password;
      assert.ok(!r.text.includes(sent));
    } finally { restore(); }
  });

  test('conta configurada não é ADMIN / senha de admin errada / e-mail já existe ⇒ manual', async () => {
    restore = withEmptra();
    try {
      emptra.state.opts.adminRole = 'BUYER';
      let r = await post(onboardingInput((await approvedAccess(srv, 'emptra')).accessToken, 'emptra'));
      assert.equal(r.body.mode, 'manual');
      emptra.state.opts.adminRole = 'ADMIN';
      const r2 = patchEnv({ EMPTRA_ADMIN_PASSWORD: 'errada' });
      r = await post(onboardingInput((await approvedAccess(srv, 'emptra')).accessToken, 'emptra'));
      r2();
      assert.equal(r.body.mode, 'manual');
      emptra.state.users.push({ id: 'u-x', email: 'ja.emptra@example.com' });
      r = await post(onboardingInput((await approvedAccess(srv, 'emptra')).accessToken, 'emptra', { loginEmail: 'ja.emptra@example.com' }));
      assert.equal(r.body.mode, 'manual');
      assert.match(r.body.notes, /já tem cadastro/);
    } finally { restore(); }
  });
});
