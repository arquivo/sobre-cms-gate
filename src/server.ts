// The HTTP service behind Caddy: the sign-in popup (`/cms-api/auth`, `/cms-api/callback`), the media API
// (`/cms-api/media`) and a health check. No session is kept: every media request carries the editor's GitHub token.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import { Editors } from './editors.ts';
import { checkFile, type Refusal } from './filetypes.ts';
import { GitHub, GitHubError } from './github.ts';
import { candidateKey, slugify, splitName } from './keys.ts';
import type { Logger } from './log.ts';
import { errorPage, MESSAGES, PAGE_CSP, successPage } from './pages.ts';
import { RateLimit } from './ratelimit.ts';
import { S3, S3Error } from './s3.ts';

const STATE_COOKIE = '__Host-cms-gate-state';
const STATE_TTL_SECONDS = 600;
/** Room for the multipart boundaries and part headers around the file. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** How much of a too-large body is read and dropped, so the client gets the 413, before the connection is cut. */
const DRAIN_LIMIT = 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_KEY_ATTEMPTS = 100;
const LIST_DEFAULT = 100;
const LIST_MAX = 1000;
const MAX_CURSOR = 1024;
const TOKEN = /^Bearer ([\x21-\x7e]{1,512})$/;
/** `multipart/form-data` with its boundary as the only parameter, quoted or not (RFC 2046). */
const BOUNDARY = /^multipart\/form-data\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,./:=? -]{0,69}[0-9A-Za-z'()+_,./:=?-])"|([0-9A-Za-z!#$%&'*+.^_`|~-]{1,70}))\s*$/i;
/** The form holds one part: its opening and closing delimiters. */
const MAX_DELIMITERS = 2;

const ROUTES: Record<string, string[]> = {
  '/cms-api/health': ['GET', 'HEAD'],
  '/cms-api/auth': ['GET'],
  '/cms-api/callback': ['GET'],
  '/cms-api/media': ['GET', 'POST'],
};

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

type Res = http.ServerResponse;
type Headers = Record<string, string | number>;

function send(res: Res, status: number, contentType: string, body: string, headers: Headers): void {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': contentType, 'content-length': Buffer.byteLength(body), ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}
const sendJson = (res: Res, status: number, data: unknown, headers: Headers = {}) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data), { 'content-security-policy': API_CSP, ...headers });
const sendPage = (res: Res, status: number, html: string, headers: Headers = {}) =>
  send(res, status, 'text/html; charset=utf-8', html, { 'content-security-policy': PAGE_CSP, ...headers });

/** The editor-facing errors of the API: a stable code, and a message in Portuguese. */
const ERRORS = {
  'not-found': [404, 'Endereço desconhecido.'],
  'method-not-allowed': [405, 'Método não permitido.'],
  'bad-origin': [403, 'Pedido recusado: só o editor pode usar este serviço.'],
  'invalid-token': [401, 'Sessão inválida ou expirada. Inicie sessão de novo.'],
  'not-member': [403, 'Esta conta GitHub não tem acesso ao editor.'],
  'rate-limited': [429, 'Demasiados pedidos. Aguarde e tente de novo.'],
  busy: [503, 'O serviço está ocupado. Tente de novo dentro de momentos.'],
  'bad-request': [400, 'Pedido inválido.'],
  'bad-form': [400, 'O pedido deve ter um só campo, "file", com o ficheiro.'],
  'unsupported-media-type': [415, 'O pedido deve ser multipart/form-data.'],
  'too-large': [413, 'O ficheiro é demasiado grande.'],
  'type-not-allowed': [415, 'Este tipo de ficheiro não é aceite.'],
  'content-mismatch': [422, 'O conteúdo do ficheiro não corresponde à extensão.'],
  macro: [422, 'O ficheiro tem macros ou objetos incorporados, que não são aceites.'],
  'not-text': [422, 'O ficheiro não é texto UTF-8.'],
  empty: [422, 'O ficheiro está vazio.'],
  'no-free-name': [409, 'Já existem demasiados ficheiros com este nome este mês. Mude o nome do ficheiro.'],
  'github-unavailable': [502, 'Não foi possível contactar o GitHub. Tente de novo.'],
  'storage-unavailable': [502, 'Não foi possível guardar o ficheiro. Tente de novo.'],
  internal: [500, 'Erro interno.'],
} as const satisfies Record<string, readonly [number, string]>;
type ErrorCode = keyof typeof ERRORS;

const fail = (res: Res, code: ErrorCode, headers: Headers = {}) => {
  const [status, message] = ERRORS[code];
  sendJson(res, status, { error: code, message }, headers);
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** How many times `delimiter` occurs in `body`, counted up to `max + 1`. */
function count(body: Buffer, delimiter: Buffer, max: number): number {
  let n = 0;
  for (let i = body.indexOf(delimiter); i >= 0 && n <= max; i = body.indexOf(delimiter, i + delimiter.length)) n++;
  return n;
}

/** The body, up to `max` bytes; null if it is longer (the rest is read and dropped, up to DRAIN_LIMIT). */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (over) {
        if (size > max + DRAIN_LIMIT) req.destroy();
      } else if (size > max) {
        over = true;
        chunks.length = 0;
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks, size)));
    req.on('close', () => resolve(null));
    req.on('error', reject);
  });
}

export interface Deps {
  log: Logger;
  /** The clock for the keys' year and month. */
  now?: () => Date;
}

export function createServer(config: Config, deps: Deps): http.Server {
  const { log } = deps;
  const now = deps.now ?? (() => new Date());
  const github = new GitHub(config.github, config.callbackUrl);
  const editors = new Editors(github, config.limits.teamCacheSeconds);
  const s3 = new S3(config.s3);
  const limits = {
    requests: new RateLimit(60_000, config.limits.requestsPerMinute),
    signIns: new RateLimit(60_000, config.limits.signInsPerMinute),
    uploads: new RateLimit(3_600_000, config.limits.uploadsPerHour),
    uploadBytes: new RateLimit(3_600_000, config.limits.uploadBytesPerHour),
  };
  let uploading = 0;

  /** The client's address, for the rate limits: the last X-Forwarded-For entry is the one Caddy added. */
  const clientAddress = (req: http.IncomingMessage): string => {
    if (config.trustProxy) {
      const header = req.headers['x-forwarded-for'];
      const last = (Array.isArray(header) ? header.join(',') : header)?.split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  /** Media requests come from the CMS page only: its `Origin` if the browser sends one (always on POST). */
  const fromCms = (req: http.IncomingMessage, requireOrigin: boolean): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined ? requireOrigin : origin !== config.cmsOrigin) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin';
  };

  // --- Sign-in ---

  const clearState = `${STATE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

  const auth = (res: Res, query: URLSearchParams, ip: string) => {
    if (!limits.signIns.take(ip)) {
      log({ event: 'rate-limited', limit: 'sign-ins', ip });
      return sendPage(res, 429, errorPage(config.cmsOrigin, ...MESSAGES.rateLimited), { 'retry-after': limits.signIns.retryAfter(ip) });
    }
    const provider = query.get('provider');
    if (provider !== null && provider !== 'github') return sendPage(res, 400, errorPage(config.cmsOrigin, ...MESSAGES.badRequest));
    const state = randomBytes(32).toString('base64url');
    res.writeHead(302, {
      ...BASE_HEADERS,
      'content-security-policy': API_CSP,
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/; Max-Age=${STATE_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
      location: github.authorizeUrl(state),
      'content-length': 0,
    });
    res.end();
  };

  const callback = async (req: http.IncomingMessage, res: Res, query: URLSearchParams) => {
    const page = (status: number, html: string) => sendPage(res, status, html, { 'set-cookie': clearState });
    const refuse = (status: number, [title, text]: readonly [string, string]) => page(status, errorPage(config.cmsOrigin, title, text));

    // Whatever goes wrong, the popup ends on an error page, with the state cookie cleared.
    try {
      const expected = readCookie(req, STATE_COOKIE);
      const state = query.get('state');
      if (!expected || !state || !safeEqual(expected, state)) {
        log({ event: 'sign-in', result: 'bad-state' });
        return refuse(400, MESSAGES.badState);
      }
      if (query.has('error')) {
        log({ event: 'sign-in', result: 'denied' });
        return refuse(403, MESSAGES.denied);
      }
      const code = query.get('code');
      if (!code || code.length > 512) {
        log({ event: 'sign-in', result: 'bad-request' });
        return refuse(400, MESSAGES.badRequest);
      }
      const token = await github.exchangeCode(code);
      const verdict = await editors.check(token);
      if (verdict.ok) {
        log({ event: 'sign-in', result: 'ok', login: verdict.login });
        return page(200, successPage(config.cmsOrigin, token, verdict.login));
      }
      log({ event: 'sign-in', result: verdict.reason, login: verdict.login ?? null, revoked: verdict.revoked ?? null });
      return refuse(verdict.reason === 'not-member' ? 403 : 502, verdict.reason === 'not-member' ? MESSAGES.notMember : MESSAGES.github);
    } catch (e) {
      const known = e instanceof GitHubError;
      log({ event: 'sign-in', result: 'error', error: known ? e.message : e instanceof Error ? e.name : 'unknown' });
      if (res.headersSent) throw e;
      return known ? refuse(502, MESSAGES.github) : refuse(500, MESSAGES.internal);
    }
  };

  // --- Media ---

  /** The signed-in editor's login, or null once the refusal has been sent. */
  const editor = async (req: http.IncomingMessage, res: Res): Promise<string | null> => {
    const token = req.headers.authorization?.match(TOKEN)?.[1];
    if (!token) {
      fail(res, 'invalid-token', { 'www-authenticate': 'Bearer' });
      return null;
    }
    const verdict = await editors.check(token);
    if (verdict.ok) return verdict.login;
    if (verdict.reason === 'invalid-token') {
      fail(res, 'invalid-token', { 'www-authenticate': 'Bearer' });
    } else {
      log({ event: 'refused', reason: 'not-member', login: verdict.login ?? null, revoked: verdict.revoked ?? null });
      fail(res, 'not-member');
    }
    return null;
  };

  const list = async (req: http.IncomingMessage, res: Res, query: URLSearchParams) => {
    if (!fromCms(req, false)) return fail(res, 'bad-origin');
    const cursor = query.get('cursor') || undefined;
    const rawLimit = query.get('limit');
    const max = rawLimit === null ? LIST_DEFAULT : Number(rawLimit);
    if ((cursor && cursor.length > MAX_CURSOR) || !Number.isInteger(max) || max < 1 || max > LIST_MAX) return fail(res, 'bad-request');
    if (!(await editor(req, res))) return;
    const { objects, next } = await s3.list(cursor, max);
    const files = objects
      .filter((o) => o.key.startsWith(config.s3.prefix))
      .map((o) => ({ path: `/${o.key}`, name: o.key.slice(o.key.lastIndexOf('/') + 1), size: o.size, lastModified: o.lastModified }));
    sendJson(res, 200, { files, cursor: next });
  };

  const upload = async (req: http.IncomingMessage, res: Res) => {
    if (!fromCms(req, true)) return fail(res, 'bad-origin');
    const login = await editor(req, res);
    if (!login) return;
    const contentType = req.headers['content-type'] ?? '';
    if (!/^multipart\/form-data\s*;/i.test(contentType)) return fail(res, 'unsupported-media-type');
    const boundary = contentType.match(BOUNDARY);
    if (!boundary) return fail(res, 'bad-form');
    const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
    const maxBody = config.maxUploadBytes + MULTIPART_OVERHEAD;
    if (Number(req.headers['content-length'] ?? 0) > maxBody) return fail(res, 'too-large', { connection: 'close' });
    if (limits.uploadBytes.remaining(login) <= 0 || !limits.uploads.take(login)) {
      log({ event: 'rate-limited', limit: 'uploads', login });
      return fail(res, 'rate-limited', { 'retry-after': limits.uploads.retryAfter(login) });
    }
    if (uploading >= MAX_CONCURRENT_UPLOADS) return fail(res, 'busy', { 'retry-after': 5 });

    uploading++;
    try {
      const body = await readBody(req, maxBody);
      if (!body) return fail(res, 'too-large', { connection: 'close' });
      // Counted before the form is parsed, so a body of many small parts costs no more than one file: any occurrence of
      // the delimiter counts, wherever it is, as no parser sees more parts than that.
      if (count(body, delimiter, MAX_DELIMITERS) > MAX_DELIMITERS) return fail(res, 'bad-form');
      let form: FormData;
      try {
        form = await new Request('http://cms-gate.invalid/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
      } catch {
        return fail(res, 'bad-form');
      }
      const entries = [...form.entries()];
      const file = entries.length === 1 && entries[0]?.[0] === 'file' && entries[0][1] instanceof File ? entries[0][1] : null;
      if (!file) return fail(res, 'bad-form');

      const refused = (reason: Refusal | 'too-large', ext: string | null) => {
        log({ event: 'upload', result: 'refused', reason, login, ext: ext?.slice(0, 16) ?? null, size: file.size });
        fail(res, reason);
      };
      if (file.size > config.maxUploadBytes) return refused('too-large', null);
      if (!limits.uploadBytes.take(login, file.size)) {
        log({ event: 'rate-limited', limit: 'upload-bytes', login });
        return fail(res, 'rate-limited', { 'retry-after': limits.uploadBytes.retryAfter(login) });
      }
      const name = splitName(file.name);
      if (!name) return refused('type-not-allowed', null);
      const data = Buffer.from(await file.arrayBuffer());
      const check = await checkFile(name.ext, data);
      if (!check.ok) return refused(check.reason, name.ext);

      const sha256 = createHash('sha256').update(data).digest('hex');
      const slug = slugify(name.base);
      const date = now();
      for (let n = 1; n <= MAX_KEY_ATTEMPTS; n++) {
        const key = candidateKey(config.s3.prefix, date, slug, name.ext, n);
        if (await s3.exists(key)) continue;
        if ((await s3.put(key, data, check.contentType, sha256)) === 'exists') continue;
        log({ event: 'upload', result: 'created', login, key, size: data.length, sha256 });
        return sendJson(res, 201, {
          path: `/${key}`,
          name: key.slice(key.lastIndexOf('/') + 1),
          size: data.length,
          contentType: check.contentType,
          sha256,
        });
      }
      log({ event: 'upload', result: 'no-free-name', login, size: data.length, sha256 });
      return fail(res, 'no-free-name');
    } finally {
      uploading--;
    }
  };

  // --- Dispatch ---

  const handle = async (req: http.IncomingMessage, res: Res, path: string, search: string) => {
    const methods = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (!methods) return fail(res, 'not-found');
    if (!methods.includes(req.method ?? '')) return fail(res, 'method-not-allowed', { allow: methods.join(', ') });
    if (path === '/cms-api/health') return sendJson(res, 200, { status: 'ok' });

    const ip = clientAddress(req);
    if (!limits.requests.take(ip)) {
      log({ event: 'rate-limited', limit: 'requests', ip });
      return fail(res, 'rate-limited', { 'retry-after': limits.requests.retryAfter(ip) });
    }
    const query = new URLSearchParams(search);
    if (path === '/cms-api/auth') return auth(res, query, ip);
    if (path === '/cms-api/callback') return callback(req, res, query);
    return req.method === 'POST' ? upload(req, res) : list(req, res, query);
  };

  const server = http.createServer((req, res) => {
    const started = performance.now();
    const url = req.url ?? '';
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    // Only the path, and only a known one: queries hold codes and states.
    const logPath = Object.hasOwn(ROUTES, path) ? path : '-';
    res.on('finish', () => {
      if (path === '/cms-api/health' && res.statusCode === 200) return;
      log({ event: 'request', method: req.method?.slice(0, 16) ?? null, path: logPath, status: res.statusCode, ms: Math.round(performance.now() - started) });
    });
    handle(req, res, path, q < 0 ? '' : url.slice(q + 1)).catch((e: unknown) => {
      const known = e instanceof GitHubError || e instanceof S3Error;
      log({ event: 'error', path: logPath, error: known ? e.message : e instanceof Error ? e.name : 'unknown' });
      if (res.headersSent) res.destroy();
      else if (e instanceof GitHubError) fail(res, 'github-unavailable');
      else if (e instanceof S3Error) fail(res, 'storage-unavailable');
      else fail(res, 'internal');
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
