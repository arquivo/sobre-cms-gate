// A local GitHub for the tests: the web flow (authorize, code for token), the App's token check, team memberships,
// installation tokens (with the App's JWT checked) and token revocation. It records what it was asked, for the assertions.
import http from 'node:http';
import { createVerify, randomBytes, type KeyObject } from 'node:crypto';
import { readBody, listen } from './net.ts';

export interface StubGitHubOptions {
  appId: string;
  clientId: string;
  clientSecret: string;
  installationId: string;
  publicKey: KeyObject;
  org: string;
  team: string;
}

export interface StubGitHub {
  url: string;
  /** Team members, by login; anyone else is not in the team. */
  members: Map<string, 'active' | 'pending'>;
  /** User tokens issued, by token. */
  tokens: Map<string, string>;
  /** User tokens revoked. */
  revoked: string[];
  /** Installation tokens issued, and the permissions asked for each. */
  installationTokens: { token: string; permissions: unknown }[];
  /** "METHOD /path" of every request, without the query. */
  calls: string[];
  /** Codes and refresh tokens issued, so the tests can look for them in logs. */
  codes: string[];
  refreshTokens: string[];
  /** The login that the next authorize will sign in. */
  nextLogin: string;
  /** Status codes to answer instead, by endpoint; `not-json` is a 200 with an HTML body. */
  failWith: Partial<Record<'token' | 'check' | 'membership' | 'installation' | 'revoke', number | 'not-json'>>;
  /** The client id the token check answers with, if not the App's. */
  checkClientId: string | undefined;
  /** A user token, as if the user had signed in: to this App, or to another App (which this App can't check). */
  tokenFor(login: string, o?: { otherApp?: boolean }): string;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

/** Answers the failure asked for, if any. */
const failed = (res: http.ServerResponse, failure: number | 'not-json' | undefined) => {
  if (failure === undefined) return false;
  if (failure === 'not-json') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>Unicorn!</body></html>');
  } else {
    json(res, failure, { message: 'stub failure' });
  }
  return true;
};

function verifyJwt(jwt: string, key: KeyObject, appId: string): boolean {
  const [header, payload, signature] = jwt.split('.');
  if (!header || !payload || !signature) return false;
  const ok = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(key, Buffer.from(signature, 'base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iss?: unknown; exp?: unknown; iat?: unknown };
  const now = Date.now() / 1000;
  return ok && claims.iss === appId && typeof claims.exp === 'number' && claims.exp > now && claims.exp - now <= 600;
}

export async function startStubGitHub(o: StubGitHubOptions): Promise<StubGitHub> {
  const ids = new Map<string, number>();
  const codes = new Map<string, string>();
  const installation = new Set<string>();
  const otherApp = new Set<string>();

  const stub: Omit<StubGitHub, 'url' | 'close'> = {
    members: new Map(),
    tokens: new Map(),
    revoked: [],
    installationTokens: [],
    calls: [],
    codes: [],
    refreshTokens: [],
    nextLogin: 'editor',
    failWith: {},
    checkClientId: undefined,
    tokenFor(login, t = {}) {
      const token = `ghu_${randomBytes(18).toString('base64url')}`;
      this.tokens.set(token, login);
      if (t.otherApp) otherApp.add(token);
      if (!ids.has(login)) ids.set(login, ids.size + 1000);
      return token;
    },
  };

  const server = http.createServer(async (req, res) => {
    const [path = '', search = ''] = (req.url ?? '').split('?');
    const query = new URLSearchParams(search);
    const body = await readBody(req);
    stub.calls.push(`${req.method} ${path}`);
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];

    if (req.method === 'GET' && path === '/login/oauth/authorize') {
      if (query.get('client_id') !== o.clientId) return json(res, 404, { error: 'unknown client' });
      const code = randomBytes(10).toString('hex');
      codes.set(code, stub.nextLogin);
      stub.codes.push(code);
      const back = new URL(query.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', query.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      return res.end();
    }

    if (req.method === 'POST' && path === '/login/oauth/access_token') {
      if (failed(res, stub.failWith.token)) return;
      const data = JSON.parse(body.toString() || '{}') as Record<string, string>;
      const login = data.code ? codes.get(data.code) : undefined;
      if (data.client_id !== o.clientId || data.client_secret !== o.clientSecret || !login) {
        return json(res, 200, { error: 'bad_verification_code' });
      }
      codes.delete(data.code ?? '');
      const refresh = `ghr_${randomBytes(18).toString('base64url')}`;
      stub.refreshTokens.push(refresh);
      return json(res, 200, { access_token: stub.tokenFor(login), token_type: 'bearer', expires_in: 28800, refresh_token: refresh });
    }

    const membership = path.match(/^\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/([^/]+)$/);
    if (req.method === 'GET' && membership) {
      if (!bearer || !installation.has(bearer)) return json(res, 401, { message: 'Bad credentials' });
      if (failed(res, stub.failWith.membership)) return;
      const [, org, team, login = ''] = membership;
      const state = org === o.org && team === o.team ? stub.members.get(decodeURIComponent(login)) : undefined;
      return state ? json(res, 200, { state, role: 'member' }) : json(res, 404, { message: 'Not Found' });
    }

    if (req.method === 'POST' && path === `/app/installations/${o.installationId}/access_tokens`) {
      if (!bearer || !verifyJwt(bearer, o.publicKey, o.appId)) return json(res, 401, { message: 'bad JWT' });
      if (failed(res, stub.failWith.installation)) return;
      const token = `ghs_${randomBytes(18).toString('base64url')}`;
      installation.add(token);
      stub.installationTokens.push({ token, permissions: (JSON.parse(body.toString() || '{}') as { permissions?: unknown }).permissions });
      return json(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    // The App's own tokens, with its client id and secret: GitHub answers 404 for a token it doesn't know, a revoked
    // one, or another App's.
    if ((req.method === 'POST' || req.method === 'DELETE') && path === `/applications/${o.clientId}/token`) {
      const basic = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64');
      if (req.headers.authorization !== `Basic ${basic}`) return json(res, 401, { message: 'Bad credentials' });
      if (failed(res, req.method === 'POST' ? stub.failWith.check : stub.failWith.revoke)) return;
      const token = (JSON.parse(body.toString() || '{}') as { access_token?: string }).access_token ?? '';
      const login = stub.tokens.get(token);
      if (!login || otherApp.has(token) || stub.revoked.includes(token)) return json(res, 404, { message: 'Not Found' });
      if (req.method === 'POST') {
        const app = { client_id: stub.checkClientId ?? o.clientId, name: 'sobre-cms', url: 'https://github.com/apps/sobre-cms' };
        return json(res, 200, { token, app, user: { login, id: ids.get(login) }, scopes: [] });
      }
      stub.revoked.push(token);
      res.writeHead(204);
      return res.end();
    }

    json(res, 404, { message: 'Not Found' });
  });

  const url = await listen(server);
  return Object.assign(stub, {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
}
