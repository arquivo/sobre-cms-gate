// GitHub, for the sign-in and the team check: the App's web flow (code for user token), the token check (a user token
// of this App, and its user), the team membership (with an installation token limited to Members: read), and the
// revocation of a non-member's token.
// Errors carry the endpoint and status only, never a token or a response body.
import { createHash, createSign } from 'node:crypto';
import type { Config } from './config.ts';

const TIMEOUT_MS = 10_000;
const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'sobre-cms-gate',
};
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export class GitHubError extends Error {}

export interface GitHubUser {
  login: string;
  id: number;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** The JSON object of an answer; a GitHubError if the body can't be read or is anything else. */
async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const data: unknown = await res.json().catch(() => null);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new GitHubError(`${what} returned no JSON object (${res.status})`);
  return data as Record<string, unknown>;
}

export class GitHub {
  readonly #config: Config['github'];
  readonly #callbackUrl: string;
  #installation: { token: string; expires: number } | undefined;

  constructor(config: Config['github'], callbackUrl: string) {
    this.#config = config;
    this.#callbackUrl = callbackUrl;
  }

  /** Where the popup goes to sign in. GitHub Apps ignore scopes: the App's permissions apply. */
  authorizeUrl(state: string): string {
    const url = new URL('/login/oauth/authorize', this.#config.webUrl);
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return url.href;
  }

  /** The user token for a code. The refresh token GitHub also sends is dropped: the browser never gets it. */
  async exchangeCode(code: string): Promise<string> {
    const res = await this.#fetch(new URL('/login/oauth/access_token', this.#config.webUrl), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': API_HEADERS['user-agent'] },
      body: JSON.stringify({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        code,
        redirect_uri: this.#callbackUrl,
      }),
    });
    const data = res.ok ? await readJson(res, 'code exchange') : null;
    if (typeof data?.access_token !== 'string' || !data.access_token) {
      throw new GitHubError(`code exchange failed (${res.status})`);
    }
    return data.access_token;
  }

  /** The token's user, if it is a user token of this App (checked with the App's client id and secret); null if
   * GitHub doesn't know the token, or it belongs to another App or OAuth app. */
  async tokenUser(token: string): Promise<GitHubUser | null> {
    const res = await this.#fetch(this.#tokenUrl(), {
      method: 'POST',
      headers: { ...API_HEADERS, authorization: this.#basic(), 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw new GitHubError(`token check failed (${res.status})`);
    const data = await readJson(res, 'token check');
    const app = data.app as { client_id?: unknown } | null | undefined;
    const user = data.user as { login?: unknown; id?: unknown } | null | undefined;
    if (app?.client_id !== this.#config.clientId) return null;
    if (typeof user?.login !== 'string' || !LOGIN.test(user.login) || typeof user.id !== 'number') {
      throw new GitHubError('token check returned an unexpected user');
    }
    return { login: user.login, id: user.id };
  }

  /** Whether the user is an active member of the team (a pending invitation is not). */
  async isTeamMember(login: string): Promise<boolean> {
    if (!LOGIN.test(login)) return false;
    const { org, team } = this.#config;
    const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`;
    const res = await this.#fetch(new URL(path, this.#config.apiUrl), {
      headers: { ...API_HEADERS, authorization: `Bearer ${await this.#installationToken()}` },
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new GitHubError(`team membership check failed (${res.status})`);
    const data = await readJson(res, 'team membership check');
    return data.state === 'active';
  }

  /** Revokes a user token of the App. Best effort: false if GitHub didn't confirm it. */
  async revoke(token: string): Promise<boolean> {
    try {
      const res = await this.#fetch(this.#tokenUrl(), {
        method: 'DELETE',
        headers: { ...API_HEADERS, authorization: this.#basic(), 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });
      return res.status === 204;
    } catch {
      return false;
    }
  }

  /** An installation token with Members: read only, cached until five minutes before it expires. */
  async #installationToken(): Promise<string> {
    if (this.#installation && this.#installation.expires - 5 * 60_000 > Date.now()) return this.#installation.token;
    const res = await this.#fetch(new URL(`/app/installations/${this.#config.installationId}/access_tokens`, this.#config.apiUrl), {
      method: 'POST',
      headers: { ...API_HEADERS, authorization: `Bearer ${this.#appJwt()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: { members: 'read' } }),
    });
    const data = res.ok ? await readJson(res, 'installation token request') : null;
    const expires = typeof data?.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
    if (typeof data?.token !== 'string' || !data.token || Number.isNaN(expires)) {
      throw new GitHubError(`installation token request failed (${res.status})`);
    }
    this.#installation = { token: data.token, expires };
    return data.token;
  }

  /** The App's endpoint for its user tokens (check, revoke), and its client credentials for it. */
  #tokenUrl(): URL {
    return new URL(`/applications/${encodeURIComponent(this.#config.clientId)}/token`, this.#config.apiUrl);
  }

  #basic(): string {
    return `Basic ${Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString('base64')}`;
  }

  /** The App's JWT (RS256), valid for nine minutes, backdated one minute for clock drift. */
  #appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.#config.appId }),
    )}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.#config.privateKey);
    return `${unsigned}.${b64url(signature)}`;
  }

  async #fetch(url: URL, init: RequestInit): Promise<Response> {
    try {
      // No redirects: a moved endpoint is a configuration error, and tokens must not follow it.
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new GitHubError(`${init.method ?? 'GET'} ${url.pathname.replace(/\/memberships\/.*/, '/memberships/…')} failed: ${(e as Error).name}`);
    }
  }
}

/** The key for caching a token's check: its hash, so the token itself is never held longer than a request. */
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
