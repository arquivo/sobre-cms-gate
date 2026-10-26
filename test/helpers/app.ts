// A running cms-gate wired to the local stubs, with throwaway secrets in a temporary directory.
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { createServer } from '../../src/server.ts';
import { listen } from './net.ts';
import { startStubGitHub, type StubGitHub } from './stub-github.ts';
import { startStubS3, type StubS3 } from './stub-s3.ts';

export const CMS_ORIGIN = 'https://cms.example.test';
export const ORG = 'arquivo';
export const TEAM = 'sobre-editors';

let keys: { privateKey: KeyObject; publicKey: KeyObject } | undefined;
/** One RSA key pair per test process: generating them is slow. */
export const appKeys = () => (keys ??= generateKeyPairSync('rsa', { modulusLength: 2048 }));

/** Environment for loadConfig, with the secrets written to files in `dir`. */
export function testEnv(dir: string, secrets: Secrets, extra: Record<string, string> = {}): Record<string, string> {
  const file = (name: string, data: string) => {
    const path = join(dir, name);
    writeFileSync(path, data);
    return path;
  };
  return {
    GITHUB_APP_ID: '123456',
    GITHUB_CLIENT_ID: 'Iv23liTestClientId',
    GITHUB_INSTALLATION_ID: '7890',
    GITHUB_ORG: ORG,
    GITHUB_TEAM: TEAM,
    GITHUB_CLIENT_SECRET_FILE: file('client-secret', `${secrets.clientSecret}\n`),
    GITHUB_PRIVATE_KEY_FILE: file('app.pem', appKeys().privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    GITHUB_URL: 'http://127.0.0.1:9',
    GITHUB_API_URL: 'http://127.0.0.1:9',
    CMS_ORIGIN,
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_BUCKET: 'sobre-media',
    S3_PREFIX: 'media/',
    S3_ACCESS_KEY_ID_FILE: file('s3-access-key-id', secrets.s3AccessKeyId),
    S3_SECRET_ACCESS_KEY_FILE: file('s3-secret-access-key', secrets.s3SecretAccessKey),
    ...extra,
  };
}

export interface Secrets {
  clientSecret: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

export interface App {
  url: string;
  github: StubGitHub;
  s3: StubS3;
  logs: string[];
  secrets: Secrets;
  /** The parsed log lines. */
  events(): Record<string, unknown>[];
  /** The whole popup flow, as a browser would follow it: auth, GitHub's authorize, callback. */
  signIn(login: string): Promise<{ response: Response; html: string; token: string | null; message: string | null }>;
  /** POST /cms-api/media with one file, from the CMS origin unless `origin` says otherwise. */
  upload(token: string | null, name: string, data: Buffer, o?: { origin?: string | null; type?: string; headers?: Record<string, string> }): Promise<Response>;
  /** GET /cms-api/media. */
  list(token: string | null, query?: string, headers?: Record<string, string>): Promise<Response>;
  close(): Promise<void>;
}

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The data- attributes of the popup page's #cms-gate element. */
export function pageData(html: string): { origin: string | null; message: string | null } {
  const el = html.match(/<main id="cms-gate"([^>]*)>/)?.[1] ?? '';
  const attr = (name: string) => {
    const v = el.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    return v === undefined ? null : unescapeHtml(v);
  };
  return { origin: attr('data-origin'), message: attr('data-message') };
}

export async function startApp(o: { env?: Record<string, string>; now?: () => Date } = {}): Promise<App> {
  const secrets: Secrets = {
    clientSecret: `cs_${randomBytes(20).toString('hex')}`,
    s3AccessKeyId: `AK${randomBytes(8).toString('hex').toUpperCase()}`,
    s3SecretAccessKey: randomBytes(30).toString('base64url'),
  };
  const dir = mkdtempSync(join(tmpdir(), 'cms-gate-test-'));
  const env = testEnv(dir, secrets);
  const github = await startStubGitHub({
    appId: env.GITHUB_APP_ID ?? '',
    clientId: env.GITHUB_CLIENT_ID ?? '',
    clientSecret: secrets.clientSecret,
    installationId: env.GITHUB_INSTALLATION_ID ?? '',
    publicKey: appKeys().publicKey,
    org: ORG,
    team: TEAM,
  });
  const s3 = await startStubS3({ bucket: 'sobre-media', accessKeyId: secrets.s3AccessKeyId });
  const { config } = loadConfig({ ...env, GITHUB_URL: github.url, GITHUB_API_URL: github.url, S3_ENDPOINT: s3.url, ...o.env });
  const logs: string[] = [];
  const server = createServer(config, { log: (e) => logs.push(JSON.stringify(e)), ...(o.now ? { now: o.now } : {}) });
  const url = await listen(server);

  const app: App = {
    url,
    github,
    s3,
    logs,
    secrets,
    events: () => logs.map((l) => JSON.parse(l) as Record<string, unknown>),

    async signIn(login) {
      github.nextLogin = login;
      const auth = await fetch(`${url}/cms-api/auth?provider=github&site_id=cms.example.test`, { redirect: 'manual' });
      const cookie = auth.headers.getSetCookie()[0]?.split(';')[0] ?? '';
      const toGitHub = await fetch(auth.headers.get('location') ?? '', { redirect: 'manual' });
      const back = (toGitHub.headers.get('location') ?? '').replace(CMS_ORIGIN, url);
      const response = await fetch(back, { headers: { cookie } });
      const html = await response.text();
      const { message } = pageData(html);
      const token = message?.startsWith('authorization:github:success:')
        ? (JSON.parse(message.slice('authorization:github:success:'.length)) as { token: string }).token
        : null;
      return { response, html, token, message };
    },

    upload(token, name, data, u = {}) {
      const form = new FormData();
      form.append('file', new File([data], name, { type: u.type ?? 'application/octet-stream' }));
      const origin = u.origin === undefined ? CMS_ORIGIN : u.origin;
      return fetch(`${url}/cms-api/media`, {
        method: 'POST',
        body: form,
        headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...u.headers },
      });
    },

    list(token, query = '', headers = {}) {
      return fetch(`${url}/cms-api/media${query}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    },

    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await Promise.all([github.close(), s3.close()]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}
