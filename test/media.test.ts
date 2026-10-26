import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { CMS_ORIGIN, startApp, type App } from './helpers/app.ts';
import { ALLOWED, REFUSED } from './helpers/fixtures.ts';

const NOW = new Date('2026-05-15T12:00:00Z');
const png = ALLOWED.find((f) => f.name.endsWith('.png'))?.data ?? Buffer.alloc(0);
const pdf = ALLOWED.find((f) => f.name.endsWith('.pdf'))?.data ?? Buffer.alloc(0);

describe('media uploads', () => {
  let app: App;
  let token: string;
  before(async () => {
    app = await startApp({ now: () => NOW, env: { MAX_UPLOAD_BYTES: '65536' } });
    app.github.members.set('ana', 'active');
    token = app.github.tokenFor('ana');
  });
  after(() => app.close());
  beforeEach(() => {
    app.s3.objects.clear();
    app.s3.missingStatus = 404;
    app.s3.beforePut = undefined;
    app.s3.failWith = undefined;
  });

  for (const file of ALLOWED) {
    test(`stores ${file.name} as ${file.contentType}`, async () => {
      const res = await app.upload(token, file.name, file.data);
      assert.equal(res.status, 201);
      const body = (await res.json()) as Record<string, unknown>;
      const key = String(body.path).slice(1);
      assert.match(key, /^media\/2026\/05\/[a-z0-9-]+\.[a-z]+$/);
      assert.deepEqual(body, {
        path: `/${key}`,
        name: key.split('/').pop(),
        size: file.data.length,
        contentType: file.contentType,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      });
      const stored = app.s3.objects.get(key);
      assert.ok(stored);
      assert.ok(stored.body.equals(file.data));
      assert.equal(stored.contentType, file.contentType);
    });
  }

  test('the key comes from the file name', async () => {
    const res = await app.upload(token, 'Relatório Anual 2025 (versão final).PDF', pdf);
    assert.equal(((await res.json()) as { path: string }).path, '/media/2026/05/relatorio-anual-2025-versao-final.pdf');
  });

  for (const file of REFUSED) {
    test(`refuses ${file.label}`, async () => {
      const res = await app.upload(token, file.name, file.data);
      assert.equal(res.status, file.reason === 'type-not-allowed' ? 415 : 422);
      assert.equal(((await res.json()) as { error: string }).error, file.reason);
      assert.equal(app.s3.objects.size, 0);
    });
  }

  test("the client's Content-Type is ignored", async () => {
    const res = await app.upload(token, 'logo.png', png, { type: 'text/html' });
    assert.equal(res.status, 201);
    assert.equal(app.s3.objects.get('media/2026/05/logo.png')?.contentType, 'image/png');
    const put = app.s3.calls.findLast((c) => c.method === 'PUT');
    assert.equal(put?.headers['content-type'], 'image/png');
    assert.equal(put?.headers['if-none-match'], '*');
    for (const name of Object.keys(put?.headers ?? {})) {
      assert.ok(!name.startsWith('x-amz-meta-') && name !== 'x-amz-acl' && name !== 'content-disposition', name);
    }
  });

  test('an existing key is never overwritten: a suffix is added', async () => {
    app.s3.objects.set('media/2026/05/logo.png', { body: Buffer.from('old'), contentType: 'image/png' });
    app.s3.objects.set('media/2026/05/logo-2.png', { body: Buffer.from('old 2'), contentType: 'image/png' });
    const res = await app.upload(token, 'logo.png', png);
    assert.equal(((await res.json()) as { path: string }).path, '/media/2026/05/logo-3.png');
    assert.equal(app.s3.objects.get('media/2026/05/logo.png')?.body.toString(), 'old');
    assert.equal(app.s3.objects.get('media/2026/05/logo-2.png')?.body.toString(), 'old 2');
  });

  test('a key taken between the HEAD and the PUT is not overwritten either', async () => {
    app.s3.beforePut = (key) => {
      if (key === 'media/2026/05/logo.png') app.s3.objects.set(key, { body: Buffer.from('racer'), contentType: 'image/png' });
    };
    const res = await app.upload(token, 'logo.png', png);
    assert.equal(((await res.json()) as { path: string }).path, '/media/2026/05/logo-2.png');
    assert.equal(app.s3.objects.get('media/2026/05/logo.png')?.body.toString(), 'racer');
  });

  test('a HEAD answered with 403 (no ListBucket on the key) counts as absent', async () => {
    app.s3.missingStatus = 403;
    assert.equal((await app.upload(token, 'logo.png', png)).status, 201);
    const res = await app.upload(token, 'logo.png', png);
    assert.equal(((await res.json()) as { path: string }).path, '/media/2026/05/logo-2.png');
  });

  test('files over the size limit are refused', async () => {
    const big = Buffer.concat([pdf, Buffer.alloc(65536)]);
    const res = await app.upload(token, 'big.pdf', big);
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: string }).error, 'too-large');
    const exact = Buffer.concat([pdf, Buffer.alloc(65536 - pdf.length)]);
    assert.equal((await app.upload(token, 'exact.pdf', exact)).status, 201, 'the limit itself is allowed');
    assert.equal(app.s3.objects.size, 1);
  });

  test('a body far over the limit is cut off', async () => {
    const res = await app.upload(token, 'huge.pdf', Buffer.concat([pdf, Buffer.alloc(512 * 1024)]));
    assert.equal(res.status, 413);
  });

  test('a declared Content-Length over the limit is refused before the body is read', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${app.url}/cms-api/media`, {
        method: 'POST',
        headers: {
          origin: CMS_ORIGIN,
          authorization: `Bearer ${token}`,
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(10 * 1024 * 1024),
        },
      });
      req.on('response', (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        req.destroy();
      });
      req.on('error', reject);
      req.write('--x\r\n');
    });
    assert.equal(status, 413);
  });

  test('the request must come from the CMS origin', async () => {
    for (const origin of [null, 'https://evil.example', 'null', `${CMS_ORIGIN}.evil.example`, 'http://cms.example.test']) {
      const res = await app.upload(token, 'logo.png', png, { origin });
      assert.equal(res.status, 403, String(origin));
      assert.equal(((await res.json()) as { error: string }).error, 'bad-origin');
    }
    const crossSite = await app.upload(token, 'logo.png', png, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    assert.equal(app.s3.objects.size, 0);
  });

  test('a missing or unknown token is refused', async () => {
    for (const t of [null, 'ghu_unknown']) {
      const res = await app.upload(t, 'logo.png', png);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    }
    const basic = await app.upload(null, 'logo.png', png, { headers: { authorization: 'Basic YTpi' } });
    assert.equal(basic.status, 401);
    assert.equal(app.s3.objects.size, 0);
  });

  test("a non-member's upload is refused and their token revoked", async () => {
    const outsider = app.github.tokenFor('mallory');
    const res = await app.upload(outsider, 'logo.png', png);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'not-member');
    assert.ok(app.github.revoked.includes(outsider));
    assert.equal(app.s3.objects.size, 0);
  });

  test('the team check is cached briefly per token', async () => {
    const bea = app.github.tokenFor('bea');
    app.github.members.set('bea', 'active');
    const users = () => app.github.calls.filter((c) => c === 'GET /user').length;
    assert.equal((await app.upload(bea, 'a.png', png)).status, 201);
    const after = users();
    assert.equal((await app.upload(bea, 'b.png', png)).status, 201);
    assert.equal(users(), after, 'second request answered from the cache');
  });

  test('the form must hold one file, in the field "file"', async () => {
    const send = (form: FormData) =>
      fetch(`${app.url}/cms-api/media`, { method: 'POST', body: form, headers: { origin: CMS_ORIGIN, authorization: `Bearer ${token}` } });
    const two = new FormData();
    two.append('file', new File([png], 'a.png'));
    two.append('file', new File([png], 'b.png'));
    assert.equal((await send(two)).status, 400);
    const other = new FormData();
    other.append('upload', new File([png], 'a.png'));
    assert.equal((await send(other)).status, 400);
    const text = new FormData();
    text.append('file', 'not a file');
    assert.equal((await send(text)).status, 400);
    const json = await fetch(`${app.url}/cms-api/media`, {
      method: 'POST',
      body: '{}',
      headers: { origin: CMS_ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    assert.equal(json.status, 415);
    assert.equal(app.s3.objects.size, 0);
  });

  test('a storage failure is reported without details', async () => {
    app.s3.failWith = 500;
    const res = await app.upload(token, 'logo.png', png);
    assert.equal(res.status, 502);
    assert.deepEqual(Object.keys((await res.json()) as object).sort(), ['error', 'message']);
  });

  test('an answer from GitHub that is not JSON is reported as GitHub unavailable', async () => {
    app.github.failWith = { user: 'not-json' };
    try {
      const res = await app.upload(app.github.tokenFor('ana'), 'logo.png', png);
      assert.equal(res.status, 502);
      assert.equal(((await res.json()) as { error: string }).error, 'github-unavailable');
      assert.equal(app.s3.objects.size, 0);
    } finally {
      app.github.failWith = {};
    }
  });

  test('there is no delete, and nothing else is routed', async () => {
    const del = await fetch(`${app.url}/cms-api/media`, { method: 'DELETE', headers: { origin: CMS_ORIGIN, authorization: `Bearer ${token}` } });
    assert.equal(del.status, 405);
    assert.equal(del.headers.get('allow'), 'GET, POST');
    assert.equal((await fetch(`${app.url}/cms-api/media/2026/05/logo.png`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`${app.url}/cms-api/`)).status, 404);
    assert.equal((await fetch(`${app.url}/cms-api/health/`)).status, 404);
    assert.ok(!app.s3.calls.some((c) => c.method === 'DELETE'));
  });

  test('JSON answers carry the strict headers', async () => {
    const res = await app.upload(token, 'logo.png', png);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

describe('media listing', () => {
  let app: App;
  let token: string;
  before(async () => {
    app = await startApp();
    app.github.members.set('ana', 'active');
    token = app.github.tokenFor('ana');
    for (const name of ['a.png', 'b.pdf', 'c.txt', 'd.png', 'e.png']) {
      app.s3.objects.set(`media/2026/05/${name}`, { body: Buffer.from(name), contentType: 'x' });
    }
    app.s3.objects.set('other/secret.txt', { body: Buffer.from('x'), contentType: 'x' });
  });
  after(() => app.close());

  test('lists media/ in pages, following the cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Response = await app.list(token, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { files: { path: string; name: string; size: number; lastModified: string }[]; cursor: string | null };
      assert.ok(body.files.length <= 2);
      for (const f of body.files) {
        assert.equal(f.name, f.path.split('/').pop());
        assert.equal(f.size, f.name.length);
        seen.push(f.path);
      }
      cursor = body.cursor;
    } while (cursor);
    assert.deepEqual(seen, ['a.png', 'b.pdf', 'c.txt', 'd.png', 'e.png'].map((n) => `/media/2026/05/${n}`));
  });

  test('listing needs a member token, and no foreign origin', async () => {
    assert.equal((await app.list(null)).status, 401);
    assert.equal((await app.list(app.github.tokenFor('mallory'))).status, 403);
    assert.equal((await app.list(token, '', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await app.list(token, '', { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await app.list(token, '', { origin: CMS_ORIGIN, 'sec-fetch-site': 'same-origin' })).status, 200);
  });

  test('bad parameters are refused', async () => {
    for (const q of ['?limit=0', '?limit=1001', '?limit=abc', `?cursor=${'x'.repeat(2000)}`]) {
      assert.equal((await app.list(token, q)).status, 400, q);
    }
  });
});

describe('upload limits', () => {
  test('uploads are limited per user per hour, in number and in bytes', async () => {
    const app = await startApp({ env: { RATE_UPLOADS_PER_HOUR: '2', MAX_UPLOAD_BYTES: '4096' } });
    try {
      app.github.members.set('ana', 'active');
      app.github.members.set('bea', 'active');
      const ana = app.github.tokenFor('ana');
      assert.equal((await app.upload(ana, 'a.png', png)).status, 201);
      assert.equal((await app.upload(ana, 'b.png', png)).status, 201);
      const limited = await app.upload(ana, 'c.png', png);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 60);
      assert.equal((await app.upload(app.github.tokenFor('bea'), 'c.png', png)).status, 201, 'another editor is not affected');
    } finally {
      await app.close();
    }

    const bytes = await startApp({ env: { RATE_UPLOAD_BYTES_PER_HOUR: '4096', MAX_UPLOAD_BYTES: '4096' } });
    try {
      bytes.github.members.set('ana', 'active');
      const ana = bytes.github.tokenFor('ana');
      const file = Buffer.concat([pdf, Buffer.alloc(3000)]);
      assert.equal((await bytes.upload(ana, 'a.pdf', file)).status, 201);
      assert.equal((await bytes.upload(ana, 'b.pdf', file)).status, 429);
    } finally {
      await bytes.close();
    }
  });

  test('requests are limited per address', async () => {
    const app = await startApp({ env: { RATE_REQUESTS_PER_MINUTE: '3' } });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await app.list(null)).status);
      assert.deepEqual(statuses, [401, 401, 401, 429]);
      assert.equal((await fetch(`${app.url}/cms-api/health`)).status, 200, 'the health check is not limited');
    } finally {
      await app.close();
    }
  });
});

describe('health', () => {
  test('answers ok, with nothing else in it', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/cms-api/health`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { status: 'ok' });
      for (const value of Object.values(app.secrets)) assert.ok(!text.includes(value));
      assert.equal(app.github.calls.length + app.s3.calls.length, 0, 'no outbound calls');
      const head = await fetch(`${app.url}/cms-api/health`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    } finally {
      await app.close();
    }
  });
});
