import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startApp, type App } from './helpers/app.ts';

describe('logs', () => {
  let app: App;
  const marker = 'SECRET-FILE-CONTENT-7f3a';
  before(async () => {
    app = await startApp();
    app.github.members.set('ana', 'active');
    // A whole session: sign-ins (member and not), uploads accepted and refused, a listing, a bad state.
    const { token } = await app.signIn('ana');
    assert.ok(token);
    await app.signIn('mallory');
    await app.upload(token, 'nota.txt', Buffer.from(`${marker}\n`));
    await app.upload(token, 'nota.svg', Buffer.from(`<svg>${marker}</svg>`));
    await app.upload(app.github.tokenFor('mallory'), 'nota.txt', Buffer.from(`${marker}\n`));
    await app.upload('ghu_not-a-real-token-123', 'nota.txt', Buffer.from(`${marker}\n`));
    await app.list(token);
    await fetch(`${app.url}/cms-api/callback?code=code-not-to-log-42&state=state-not-to-log-42`);
  });
  after(() => app.close());

  test('hold no token, code, state, secret or file content', () => {
    const text = app.logs.join('\n');
    const forbidden = [
      ...app.github.tokens.keys(),
      ...app.github.installationTokens.map((t) => t.token),
      ...app.github.codes,
      ...app.github.refreshTokens,
      ...Object.values(app.secrets),
      marker,
      'ghu_not-a-real-token-123',
      'code-not-to-log-42',
      'state-not-to-log-42',
    ];
    assert.ok(forbidden.length > 8);
    for (const value of forbidden) assert.ok(!text.includes(value), `log holds ${value.slice(0, 6)}…`);
    assert.ok(!/ghu_|ghs_|ghr_|Bearer|Basic /.test(text));
  });

  test('are one JSON object per line', () => {
    for (const line of app.logs) {
      assert.ok(!line.includes('\n'));
      assert.equal(typeof (JSON.parse(line) as { event: unknown }).event, 'string');
    }
  });

  test('record each upload: login, key, size, SHA-256 and result', () => {
    const uploads = app.events().filter((e) => e.event === 'upload');
    const created = uploads.find((e) => e.result === 'created');
    assert.deepEqual(Object.keys(created ?? {}).sort(), ['event', 'key', 'login', 'result', 'sha256', 'size']);
    assert.equal(created?.login, 'ana');
    assert.match(String(created?.key), /^media\/\d{4}\/\d{2}\/nota\.txt$/);
    assert.match(String(created?.sha256), /^[0-9a-f]{64}$/);
    const refused = uploads.find((e) => e.result === 'refused');
    assert.equal(refused?.reason, 'type-not-allowed');
    assert.equal(refused?.login, 'ana');
  });

  test('record sign-ins and refusals with the login only', () => {
    const events = app.events();
    assert.ok(events.some((e) => e.event === 'sign-in' && e.result === 'ok' && e.login === 'ana'));
    assert.ok(events.some((e) => e.event === 'sign-in' && e.result === 'not-member' && e.login === 'mallory' && e.revoked === true));
    assert.ok(events.some((e) => e.event === 'refused' && e.reason === 'not-member' && e.login === 'mallory'));
    assert.ok(events.some((e) => e.event === 'sign-in' && e.result === 'bad-state'));
  });

  test('requests are logged by path only', () => {
    const paths = new Set(app.events().filter((e) => e.event === 'request').map((e) => e.path));
    assert.deepEqual([...paths].sort(), ['/cms-api/auth', '/cms-api/callback', '/cms-api/media']);
  });
});
