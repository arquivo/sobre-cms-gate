// The media bucket on the Ceph RGW, path-style, signed with SigV4 (aws4). Only what the `sobre-cms-gate` key may do:
// HEAD and PUT under the prefix, and ListObjectsV2 with the prefix. There is no delete.
import http from 'node:http';
import https from 'node:https';
import aws4 from 'aws4';
import type { Config } from './config.ts';

const TIMEOUT_MS = 120_000;
const MAX_LIST_RESPONSE = 8 * 1024 * 1024;

export class S3Error extends Error {}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

interface Response {
  status: number;
  body: Buffer;
}

/** A key as a URL path: each segment percent-encoded on its own. */
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16))
    : e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1), 10))
    : (XML_ENTITIES[e] ?? m));
const element = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

/** The parts of a ListObjectsV2 answer that the media library needs. */
export function parseList(xml: string): { objects: S3Object[]; next: string | null } {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c = '']) => ({
    key: unescapeXml(element(c, 'Key') ?? ''),
    size: Number(element(c, 'Size') ?? 0),
    lastModified: unescapeXml(element(c, 'LastModified') ?? ''),
  }));
  const truncated = element(xml, 'IsTruncated') === 'true';
  const next = element(xml, 'NextContinuationToken');
  return { objects: objects.filter((o) => o.key), next: truncated && next ? unescapeXml(next) : null };
}

export class S3 {
  readonly #config: Config['s3'];
  readonly #agent: http.Agent;

  constructor(config: Config['s3']) {
    this.#config = config;
    this.#agent = config.endpoint.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, ...(config.ca ? { ca: config.ca } : {}) })
      : new http.Agent({ keepAlive: true });
  }

  /** Whether the key exists. A 403 counts as absent: without s3:ListBucket on the key, the RGW may answer a missing
   * key with 403, and the PUT that follows is conditional anyway (If-None-Match), so nothing is overwritten. */
  async exists(key: string): Promise<boolean> {
    const res = await this.#request('HEAD', `/${encodeKey(key)}`);
    if (res.status === 200) return true;
    if (res.status === 404 || res.status === 403) return false;
    throw new S3Error(`HEAD failed (${res.status})`);
  }

  /**
   * Writes a new object, with the canned ACL if one is set; 'exists' if the key was taken in the meantime. Only the
   * headers set here are sent.
   */
  async put(key: string, body: Buffer, contentType: string, sha256: string): Promise<'created' | 'exists'> {
    const res = await this.#request('PUT', `/${encodeKey(key)}`, body, {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'X-Amz-Content-Sha256': sha256,
      'If-None-Match': '*',
      ...(this.#config.acl ? { 'x-amz-acl': this.#config.acl } : {}),
    });
    if (res.status === 200) return 'created';
    if (res.status === 412 || res.status === 409) return 'exists';
    throw new S3Error(`PUT failed (${res.status})`);
  }

  /** A page of the objects under the prefix, in key order. */
  async list(cursor: string | undefined, maxKeys: number): Promise<{ objects: S3Object[]; next: string | null }> {
    const query = new URLSearchParams({ 'list-type': '2', prefix: this.#config.prefix, 'max-keys': String(maxKeys) });
    if (cursor) query.set('continuation-token', cursor);
    const res = await this.#request('GET', `?${query.toString().replace(/\+/g, '%20')}`);
    if (res.status !== 200) throw new S3Error(`list failed (${res.status})`);
    return parseList(res.body.toString('utf8'));
  }

  #request(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Response> {
    const { endpoint, bucket, region, accessKeyId, secretAccessKey } = this.#config;
    const signed = aws4.sign(
      { host: endpoint.host, path: `/${bucket}${path}`, method, headers, service: 's3', region, ...(body ? { body } : {}) },
      { accessKeyId, secretAccessKey },
    );
    const transport = endpoint.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname.replace(/^\[|\]$/g, ''),
          port: endpoint.port || undefined,
          method,
          path: signed.path,
          headers: signed.headers as http.OutgoingHttpHeaders,
          agent: this.#agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_LIST_RESPONSE) res.destroy(new S3Error('response too large'));
            else chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new S3Error(`${method} timed out`)));
      req.on('error', (e) => reject(e instanceof S3Error ? e : new S3Error(`${method} failed: ${e.message}`)));
      req.end(body);
    });
  }
}
