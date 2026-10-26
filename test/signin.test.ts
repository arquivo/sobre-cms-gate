import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { after, before, beforeEach, describe, test } from 'node:test';
import { GitHub } from '../src/github.ts';
import { PAGE_CSP, POPUP_SCRIPT } from '../src/pages.ts';
import { CMS_ORIGIN, pageData, startApp, type App } from './helpers/app.ts';

/** Runs the popup page's script against a fake opener, as Decap would answer it; what it posted, and to which origin. */
function runPopup(html: string, answer: { origin: string; fromOpener?: boolean; data?: string }) {
  const posted: { message: unknown; target: string }[] = [];
  const listeners: ((e: unknown) => void)[] = [];
  const attrs = new Map(Object.entries(pageData(html)).filter(([, v]) => v !== null).map(([k, v]) => [`data-${k}`, v as string]));
  const opener = { postMessage: (message: unknown, target: string) => posted.push({ message, target }) };
  const element = { getAttribute: (n: string) => attrs.get(n) ?? null, removeAttribute: (n: string) => attrs.delete(n) };
  const window = { opener, addEventListener: (type: string, fn: (e: unknown) => void) => type === 'message' && listeners.push(fn) };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  vm.runInNewContext(script, { window, document: { getElementById: (id: string) => (id === 'cms-gate' ? element : null) } });
  const source = answer.fromOpener === false ? {} : opener;
  for (const fn of listeners) fn({ source, origin: answer.origin, data: answer.data ?? 'authorizing:github' });
  return posted;
}

describe('sign-in', () => {
  let app: App;
  before(async () => {
    app = await startApp({ env: { RATE_SIGNINS_PER_MINUTE: '1000' } });
  });
  after(() => app.close());
  beforeEach(() => {
    app.github.members.clear();
    app.github.failWith = {};
  });

  test('auth sets a state cookie and sends the popup to GitHub with it', async () => {
    const res = await fetch(`${app.url}/cms-api/auth?provider=github&site_id=cms.example.test`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location') ?? '');
    assert.equal(location.origin + location.pathname, `${app.github.url}/login/oauth/authorize`);
    assert.equal(location.searchParams.get('client_id'), 'Iv23liTestClientId');
    assert.equal(location.searchParams.get('redirect_uri'), `${CMS_ORIGIN}/cms-api/callback`);
    assert.equal(location.searchParams.get('allow_signup'), 'false');
    const state = location.searchParams.get('state') ?? '';
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.getSetCookie()[0] ?? '';
    assert.equal(cookie, `__Host-cms-gate-state=${state}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('auth refuses another provider', async () => {
    const res = await fetch(`${app.url}/cms-api/auth?provider=gitlab`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    assert.equal(res.headers.getSetCookie().length, 0);
  });

  test('a member gets the token, posted to the CMS origin only after the handshake', async () => {
    app.github.members.set('ana', 'active');
    const { response, html, token } = await app.signIn('ana');
    assert.equal(response.status, 200);
    assert.ok(token && app.github.tokens.get(token) === 'ana');
    assert.ok(!html.includes(app.github.refreshTokens.at(-1) ?? 'none'), 'the refresh token is not handed out');

    const message = `authorization:github:success:${JSON.stringify({ token, provider: 'github' })}`;
    assert.deepEqual(runPopup(html, { origin: CMS_ORIGIN }), [
      { message: 'authorizing:github', target: CMS_ORIGIN },
      { message, target: CMS_ORIGIN },
    ]);
    // Another origin, another window, or another message: the token is not posted.
    for (const answer of [{ origin: 'https://evil.example' }, { origin: CMS_ORIGIN, fromOpener: false }, { origin: CMS_ORIGIN, data: 'hello' }]) {
      assert.deepEqual(runPopup(html, answer), [{ message: 'authorizing:github', target: CMS_ORIGIN }]);
    }
  });

  test('the page is locked down: its CSP allows only its own script and style', async () => {
    app.github.members.set('ana', 'active');
    const { response, html } = await app.signIn('ana');
    assert.equal(response.headers.get('content-security-policy'), PAGE_CSP);
    assert.ok(html.includes(`<script>${POPUP_SCRIPT}</script>`));
    const hash = createHash('sha256').update(POPUP_SCRIPT).digest('base64');
    assert.ok(PAGE_CSP.includes(`script-src 'sha256-${hash}'`));
    assert.ok(PAGE_CSP.includes("default-src 'none'"));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('cross-origin-opener-policy'), null, 'COOP would cut the popup from its opener');
    assert.match(response.headers.getSetCookie()[0] ?? '', /^__Host-cms-gate-state=; .*Max-Age=0/);
  });

  test('the team check uses an installation token limited to Members: read', async () => {
    app.github.members.set('ana', 'active');
    await app.signIn('ana');
    assert.ok(app.github.installationTokens.length >= 1);
    for (const t of app.github.installationTokens) assert.deepEqual(t.permissions, { members: 'read' });
  });

  test('a non-member gets no token, and the token is revoked', async () => {
    const { response, html, token, message } = await app.signIn('mallory');
    assert.equal(response.status, 403);
    assert.equal(token, null);
    assert.match(message ?? '', /^authorization:github:error:/);
    const issued = [...app.github.tokens].filter(([, login]) => login === 'mallory').map(([t]) => t);
    assert.equal(issued.length, 1);
    assert.ok(!html.includes(issued[0] ?? 'none'));
    assert.deepEqual(app.github.revoked.filter((t) => issued.includes(t)), issued);
    // The refusal is posted too, so Decap shows it; still only to the CMS origin.
    assert.deepEqual(runPopup(html, { origin: CMS_ORIGIN }).map((p) => p.target), [CMS_ORIGIN, CMS_ORIGIN]);
  });

  test('a pending team invitation is not membership', async () => {
    app.github.members.set('pat', 'pending');
    const { response, token } = await app.signIn('pat');
    assert.equal(response.status, 403);
    assert.equal(token, null);
  });

  test('the callback refuses a missing or wrong state, and clears the cookie', async () => {
    app.github.members.set('ana', 'active');
    const auth = await fetch(`${app.url}/cms-api/auth`, { redirect: 'manual' });
    const cookie = auth.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const state = new URL(auth.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const before = app.github.calls.length;
    for (const [query, headers] of [
      [`code=abc&state=${state}`, {}], // no cookie (e.g. a link sent to an editor)
      [`code=abc&state=${state}x`, { cookie }],
      ['code=abc', { cookie }],
      [`code=abc&state=`, { cookie: '__Host-cms-gate-state=' }],
    ] as const) {
      const res = await fetch(`${app.url}/cms-api/callback?${query}`, { headers });
      assert.equal(res.status, 400, query);
      const { message } = pageData(await res.text());
      assert.match(message ?? '', /^authorization:github:error:/);
      assert.match(res.headers.getSetCookie()[0] ?? '', /Max-Age=0/);
    }
    assert.equal(app.github.calls.length, before, 'no code was exchanged');
  });

  test('a sign-in cancelled on GitHub is refused', async () => {
    const auth = await fetch(`${app.url}/cms-api/auth`, { redirect: 'manual' });
    const cookie = auth.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const state = new URL(auth.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const res = await fetch(`${app.url}/cms-api/callback?error=access_denied&state=${state}`, { headers: { cookie } });
    assert.equal(res.status, 403);
  });

  test('GitHub failures give an error page without a token', async () => {
    app.github.members.set('ana', 'active');
    for (const failure of ['token', 'check', 'membership'] as const) {
      for (const answer of [500, 'not-json'] as const) {
        app.github.failWith = { [failure]: answer };
        const { response, token, message } = await app.signIn('ana');
        assert.equal(response.status, 502, `${failure} ${answer}`);
        assert.equal(token, null);
        assert.match(message ?? '', /^authorization:github:error:/);
        assert.match(response.headers.getSetCookie()[0] ?? '', /Max-Age=0/);
      }
    }
  });

  test('an unexpected error gives an error page too', async () => {
    const exchange = GitHub.prototype.exchangeCode;
    GitHub.prototype.exchangeCode = () => Promise.reject(new TypeError('unexpected'));
    try {
      const { response, token, message } = await app.signIn('ana');
      assert.equal(response.status, 500);
      assert.equal(token, null);
      assert.match(message ?? '', /^authorization:github:error:/);
      assert.match(response.headers.getSetCookie()[0] ?? '', /Max-Age=0/);
      assert.equal(response.headers.get('content-security-policy'), PAGE_CSP);
    } finally {
      GitHub.prototype.exchangeCode = exchange;
    }
  });
});

describe('sign-in without an installation token', () => {
  for (const answer of [500, 'not-json'] as const) {
    test(`a failed installation token request (${answer}) gives an error page`, async () => {
      const app = await startApp();
      try {
        app.github.members.set('ana', 'active');
        app.github.failWith = { installation: answer };
        const { response, token } = await app.signIn('ana');
        assert.equal(response.status, 502);
        assert.equal(token, null);
      } finally {
        await app.close();
      }
    });
  }
});

describe('sign-in rate limit', () => {
  test('sign-ins are limited per address', async () => {
    const app = await startApp({ env: { RATE_SIGNINS_PER_MINUTE: '2' } });
    try {
      const start = (ip: string) => fetch(`${app.url}/cms-api/auth`, { redirect: 'manual', headers: { 'x-forwarded-for': `203.0.113.9, ${ip}` } });
      assert.equal((await start('192.0.2.1')).status, 302);
      assert.equal((await start('192.0.2.1')).status, 302);
      const limited = await start('192.0.2.1');
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      assert.equal((await start('192.0.2.2')).status, 302, 'another address is not affected');
    } finally {
      await app.close();
    }
  });

  test('an X-Forwarded-For entry that is not an address counts as the peer', async () => {
    const app = await startApp({ env: { RATE_SIGNINS_PER_MINUTE: '2' } });
    try {
      const start = (xff: string) => fetch(`${app.url}/cms-api/auth`, { redirect: 'manual', headers: { 'x-forwarded-for': xff } });
      assert.equal((await start('unknown')).status, 302);
      assert.equal((await start('192.0.2.1, ')).status, 302);
      assert.equal((await start('192.0.2.1, 192.0.2.300')).status, 429, 'all three are the peer');
      assert.equal((await start('192.0.2.1')).status, 302);
      const ip = app.events().find((e) => e.event === 'rate-limited')?.ip;
      assert.ok(ip === '127.0.0.1' || ip === '::ffff:127.0.0.1', String(ip));
    } finally {
      await app.close();
    }
  });
});
