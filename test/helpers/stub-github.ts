// A local GitHub for the tests: the web flow (authorize, code for token), the user, team memberships, installation
// tokens (with the App's JWT checked) and token revocation. It records what it was asked, for the assertions.
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
  /** Status codes to answer instead, by endpoint. */
  failWith: Partial<Record<'token' | 'user' | 'membership' | 'installation' | 'revoke', number>>;
  /** A user token, as if the user had signed in. */
  tokenFor(login: string): string;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
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
    tokenFor(login) {
      const token = `ghu_${randomBytes(18).toString('base64url')}`;
      this.tokens.set(token, login);
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
      if (stub.failWith.token) return json(res, stub.failWith.token, { error: 'stub failure' });
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

    if (req.method === 'GET' && path === '/user') {
      if (stub.failWith.user) return json(res, stub.failWith.user, { message: 'stub failure' });
      const login = bearer ? stub.tokens.get(bearer) : undefined;
      if (!login || stub.revoked.includes(bearer ?? '')) return json(res, 401, { message: 'Bad credentials' });
      return json(res, 200, { login, id: ids.get(login) });
    }

    const membership = path.match(/^\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/([^/]+)$/);
    if (req.method === 'GET' && membership) {
      if (!bearer || !installation.has(bearer)) return json(res, 401, { message: 'Bad credentials' });
      if (stub.failWith.membership) return json(res, stub.failWith.membership, { message: 'stub failure' });
      const [, org, team, login = ''] = membership;
      const state = org === o.org && team === o.team ? stub.members.get(decodeURIComponent(login)) : undefined;
      return state ? json(res, 200, { state, role: 'member' }) : json(res, 404, { message: 'Not Found' });
    }

    if (req.method === 'POST' && path === `/app/installations/${o.installationId}/access_tokens`) {
      if (!bearer || !verifyJwt(bearer, o.publicKey, o.appId)) return json(res, 401, { message: 'bad JWT' });
      if (stub.failWith.installation) return json(res, stub.failWith.installation, { message: 'stub failure' });
      const token = `ghs_${randomBytes(18).toString('base64url')}`;
      installation.add(token);
      stub.installationTokens.push({ token, permissions: (JSON.parse(body.toString() || '{}') as { permissions?: unknown }).permissions });
      return json(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    if (req.method === 'DELETE' && path === `/applications/${o.clientId}/token`) {
      const basic = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64');
      if (req.headers.authorization !== `Basic ${basic}`) return json(res, 401, { message: 'Bad credentials' });
      if (stub.failWith.revoke) return json(res, stub.failWith.revoke, { message: 'stub failure' });
      const token = (JSON.parse(body.toString() || '{}') as { access_token?: string }).access_token ?? '';
      if (!stub.tokens.has(token)) return json(res, 404, { message: 'Not Found' });
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
