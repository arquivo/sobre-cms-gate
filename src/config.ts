// Configuration, from the environment only. Secrets come from files (`*_FILE`, e.g. Docker secrets), never from
// variables or arguments. Anything missing or inconsistent stops the service before it listens.
import { readFileSync } from 'node:fs';
import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

export interface Config {
  github: {
    appId: string;
    clientId: string;
    installationId: string;
    clientSecret: string;
    privateKey: KeyObject;
    org: string;
    team: string;
    /** https://github.com and https://api.github.com; a local stub in the tests. */
    webUrl: string;
    apiUrl: string;
  };
  /**
   * The CMS's origin, the environment's site (`https://<site-host>`): the only target of postMessage and the only
   * `Origin` accepted.
   */
  cmsOrigin: string;
  /** `<cmsOrigin>/cms-api/callback`, as registered on the GitHub App. */
  callbackUrl: string;
  listen: { host: string; port: number };
  /** Take the client address, for the rate limits, from the last `X-Forwarded-For` entry if it is an IP address (Caddy
   * sets the header to the client address alone). */
  trustProxy: boolean;
  s3: {
    endpoint: URL;
    region: string;
    bucket: string;
    /** Key prefix of the uploads, e.g. `media/`; served at `/<prefix>`. */
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** PEM bundle that replaces the system CAs for the RGW, when it has a private CA. */
    ca: Buffer | undefined;
  };
  maxUploadBytes: number;
  limits: {
    signInsPerMinute: number;
    requestsPerMinute: number;
    uploadsPerHour: number;
    uploadBytesPerHour: number;
    teamCacheSeconds: number;
  };
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => Buffer;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const isLoopbackHost = (host: string) => LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Reads and checks the configuration; throws a ConfigError listing every problem. */
export function loadConfig(env: Env, readFile: ReadFile = (p) => readFileSync(p)): { config: Config; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  const str = (name: string, pattern: RegExp, fallback?: string): string => {
    const value = env[name]?.trim() || fallback;
    if (value === undefined) problems.push(`${name} is required`);
    else if (!pattern.test(value)) problems.push(`${name} is not valid`);
    return value ?? '';
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) problems.push(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    problems.push(`${name} must be true or false`);
    return fallback;
  };
  const secret = (name: string): Buffer | undefined => {
    if (env[name] !== undefined) problems.push(`${name} must not be set: put the secret in a file and set ${name}_FILE`);
    const path = env[`${name}_FILE`]?.trim();
    if (!path) {
      problems.push(`${name}_FILE is required`);
      return undefined;
    }
    try {
      const data = readFile(path);
      if (data.toString('utf8').trim() === '') problems.push(`${name}_FILE is empty`);
      return data;
    } catch {
      // The path only: the error could quote the file.
      problems.push(`${name}_FILE can't be read`);
      return undefined;
    }
  };
  const text = (data: Buffer | undefined) => data?.toString('utf8').trim() ?? '';
  /** An http(s) base URL without path, query or credentials; http only for loopback (local stubs). */
  const baseUrl = (name: string, fallback: string, allowPath = false): URL => {
    const raw = env[name]?.trim() || fallback;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${name} is not a URL`);
      return new URL(fallback);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      problems.push(`${name} must use https (http only for a loopback address)`);
    }
    if (url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== '/')) {
      problems.push(`${name} must be a bare origin (no path, query or credentials)`);
    }
    return url;
  };

  const appId = str('GITHUB_APP_ID', /^\d{1,12}$/);
  const clientId = str('GITHUB_CLIENT_ID', /^[A-Za-z0-9._-]{1,64}$/);
  const installationId = str('GITHUB_INSTALLATION_ID', /^\d{1,12}$/);
  const org = str('GITHUB_ORG', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
  const team = str('GITHUB_TEAM', /^[a-z0-9](?:[a-z0-9_-]{0,99})$/);
  const clientSecret = text(secret('GITHUB_CLIENT_SECRET'));
  const keyPem = secret('GITHUB_PRIVATE_KEY');
  let privateKey: KeyObject | undefined;
  if (keyPem) {
    try {
      privateKey = createPrivateKey(keyPem);
      if (privateKey.asymmetricKeyType !== 'rsa') problems.push('GITHUB_PRIVATE_KEY_FILE must hold an RSA private key');
    } catch {
      problems.push('GITHUB_PRIVATE_KEY_FILE is not a PEM private key');
    }
  }
  const webUrl = baseUrl('GITHUB_URL', 'https://github.com').origin;
  const apiUrl = baseUrl('GITHUB_API_URL', 'https://api.github.com').origin;

  const cms = baseUrl('CMS_ORIGIN', 'https://cms-origin.invalid');
  if (!env.CMS_ORIGIN?.trim()) problems.push('CMS_ORIGIN is required');
  else if (env.CMS_ORIGIN.trim() !== cms.origin) problems.push(`CMS_ORIGIN must be an origin, written as ${cms.origin}`);

  const host = str('LISTEN_HOST', /^[0-9A-Za-z.:-]+$/, '127.0.0.1');
  if (host && host !== 'localhost' && !isIP(host)) problems.push('LISTEN_HOST must be an IP address or localhost');
  else if (host && !isLoopbackHost(host)) {
    warnings.push(`listening on ${host}, not a loopback address: only do this inside a container whose port is published on 127.0.0.1`);
  }
  const port = int('LISTEN_PORT', 8787, 1, 65535);

  const endpoint = baseUrl('S3_ENDPOINT', 'https://s3-endpoint.invalid');
  if (!env.S3_ENDPOINT?.trim()) problems.push('S3_ENDPOINT is required');
  const region = str('S3_REGION', /^[a-z0-9-]{1,64}$/, 'us-east-1');
  const bucket = str('S3_BUCKET', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  const prefix = str('S3_PREFIX', /^(?:[a-z0-9][a-z0-9_-]*\/)+$/);
  const accessKeyId = text(secret('S3_ACCESS_KEY_ID'));
  const secretAccessKey = text(secret('S3_SECRET_ACCESS_KEY'));
  let ca: Buffer | undefined;
  const caFile = env.S3_CA_FILE?.trim();
  if (caFile) {
    if (endpoint.protocol !== 'https:') problems.push('S3_CA_FILE is set but S3_ENDPOINT is not https');
    try {
      ca = readFile(caFile);
      new X509Certificate(ca);
    } catch {
      problems.push('S3_CA_FILE is not a readable PEM certificate');
    }
  }

  const maxUploadBytes = int('MAX_UPLOAD_BYTES', 50 * 1024 * 1024, 1024, 512 * 1024 * 1024);
  const limits = {
    signInsPerMinute: int('RATE_SIGNINS_PER_MINUTE', 10, 1, 10_000),
    requestsPerMinute: int('RATE_REQUESTS_PER_MINUTE', 120, 1, 100_000),
    uploadsPerHour: int('RATE_UPLOADS_PER_HOUR', 100, 1, 100_000),
    uploadBytesPerHour: int('RATE_UPLOAD_BYTES_PER_HOUR', 1024 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER),
    teamCacheSeconds: int('TEAM_CACHE_SECONDS', 300, 0, 3600),
  };
  if (limits.uploadBytesPerHour < maxUploadBytes) problems.push('RATE_UPLOAD_BYTES_PER_HOUR is below MAX_UPLOAD_BYTES');
  const trustProxy = bool('TRUST_PROXY', true);

  if (problems.length || !privateKey) throw new ConfigError(problems.length ? problems : ['GITHUB_PRIVATE_KEY_FILE is required']);
  return {
    config: {
      github: { appId, clientId, installationId, clientSecret, privateKey, org, team, webUrl, apiUrl },
      cmsOrigin: cms.origin,
      callbackUrl: `${cms.origin}/cms-api/callback`,
      listen: { host, port },
      trustProxy,
      s3: { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, ca },
      maxUploadBytes,
      limits,
    },
    warnings,
  };
}
