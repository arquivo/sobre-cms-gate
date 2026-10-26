// A local S3 (path-style) for the tests: HEAD, conditional PUT, ListObjectsV2. It checks that requests are signed
// with the expected key and that the payload hash matches, and records every call. DELETE is never expected.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readBody, listen } from './net.ts';

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface StubS3 {
  url: string;
  objects: Map<string, StoredObject>;
  calls: { method: string; key: string | null; headers: http.IncomingHttpHeaders }[];
  /** What HEAD answers for a missing key: 404, or 403 as an RGW may without ListBucket. */
  missingStatus: 404 | 403;
  /** Called between a HEAD and the PUT of a key, e.g. to make another upload take it first. */
  beforePut: ((key: string) => void) | undefined;
  /** A status to answer every request with (a broken RGW). */
  failWith: number | undefined;
  close(): Promise<void>;
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startStubS3(o: { bucket: string; accessKeyId: string }): Promise<StubS3> {
  const stub: Omit<StubS3, 'url' | 'close'> = {
    objects: new Map(),
    calls: [],
    missingStatus: 404,
    beforePut: undefined,
    failWith: undefined,
  };

  const server = http.createServer(async (req, res) => {
    const [path = '', search = ''] = (req.url ?? '').split('?');
    const body = await readBody(req);
    const bucketPath = `/${o.bucket}`;
    const key = path.startsWith(`${bucketPath}/`) ? path.slice(bucketPath.length + 1).split('/').map(decodeURIComponent).join('/') : null;
    stub.calls.push({ method: req.method ?? '', key, headers: req.headers });
    const end = (status: number, xml = '') => {
      res.writeHead(status, xml ? { 'content-type': 'application/xml' } : {});
      res.end(xml);
    };

    if (!req.headers.authorization?.startsWith(`AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/`)) return end(403);
    if (stub.failWith) return end(stub.failWith);

    if (req.method === 'HEAD' && key) {
      return end(stub.objects.has(key) ? 200 : stub.missingStatus);
    }
    if (req.method === 'PUT' && key) {
      if (req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) return end(400);
      stub.beforePut?.(key);
      if (req.headers['if-none-match'] === '*' && stub.objects.has(key)) return end(412);
      stub.objects.set(key, { body, contentType: req.headers['content-type'] ?? '' });
      return end(200);
    }
    if (req.method === 'GET' && path === bucketPath) {
      const q = new URLSearchParams(search);
      if (q.get('list-type') !== '2') return end(400);
      const prefix = q.get('prefix') ?? '';
      const max = Number(q.get('max-keys') ?? 1000);
      const after = q.get('continuation-token') ? Buffer.from(q.get('continuation-token') ?? '', 'base64url').toString() : '';
      const keys = [...stub.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      const contents = page
        .map((k) => `<Contents><Key>${escapeXml(k)}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><Size>${stub.objects.get(k)?.body.length}</Size></Contents>`)
        .join('');
      const next = truncated ? `<NextContinuationToken>${Buffer.from(page.at(-1) ?? '').toString('base64url')}</NextContinuationToken>` : '';
      return end(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${o.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`);
    }
    end(405);
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
