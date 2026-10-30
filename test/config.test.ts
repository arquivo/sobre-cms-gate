import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';
import { testEnv } from './helpers/app.ts';

const dir = mkdtempSync(join(tmpdir(), 'cms-gate-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const secrets = { clientSecret: 'client-secret-value', s3AccessKeyId: 'AKIDVALUE', s3SecretAccessKey: 's3-secret-value' };
const env = (extra: Record<string, string> = {}) => testEnv(dir, secrets, { S3_ENDPOINT: 'https://rgw.example.test', ...extra });

/** The problems loadConfig reports for an environment. */
function problems(e: Record<string, string | undefined>): string[] {
  try {
    loadConfig(e);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected a ConfigError');
}

describe('config', () => {
  test('a complete environment loads, with the defaults', () => {
    const { config, warnings } = loadConfig(env());
    assert.equal(config.cmsOrigin, 'https://cms.example.test');
    assert.equal(config.callbackUrl, 'https://cms.example.test/cms-api/callback');
    assert.equal(config.github.clientSecret, 'client-secret-value');
    assert.equal(config.s3.secretAccessKey, 's3-secret-value');
    assert.equal(config.s3.prefix, 'media/');
    assert.equal(config.s3.region, 'us-east-1');
    assert.equal(config.s3.acl, 'public-read');
    assert.deepEqual(config.listen, { host: '127.0.0.1', port: 8787 });
    assert.equal(config.maxUploadBytes, 50 * 1024 * 1024);
    assert.equal(config.trustProxy, true);
    assert.equal(config.github.webUrl, 'http://127.0.0.1:9');
    assert.deepEqual(warnings, []);
  });

  test('the GitHub URLs default to github.com', () => {
    const e = env();
    delete e.GITHUB_URL;
    delete e.GITHUB_API_URL;
    const { config } = loadConfig(e);
    assert.equal(config.github.webUrl, 'https://github.com');
    assert.equal(config.github.apiUrl, 'https://api.github.com');
  });

  test('every missing variable is reported at once', () => {
    const found = problems({});
    for (const name of ['GITHUB_APP_ID', 'GITHUB_CLIENT_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_ORG', 'GITHUB_TEAM', 'GITHUB_CLIENT_SECRET_FILE', 'GITHUB_PRIVATE_KEY_FILE', 'CMS_ORIGIN', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_PREFIX', 'S3_ACCESS_KEY_ID_FILE', 'S3_SECRET_ACCESS_KEY_FILE']) {
      assert.ok(found.some((p) => p.startsWith(`${name} is required`)), `${name} not reported in ${found.join('; ')}`);
    }
  });

  test('secrets in plain variables are refused', () => {
    const found = problems(env({ GITHUB_CLIENT_SECRET: 'x', S3_SECRET_ACCESS_KEY: 'y' }));
    assert.ok(found.some((p) => p.startsWith('GITHUB_CLIENT_SECRET must not be set')));
    assert.ok(found.some((p) => p.startsWith('S3_SECRET_ACCESS_KEY must not be set')));
  });

  test('unreadable or empty secret files are reported without their content', () => {
    const empty = join(dir, 'empty');
    writeFileSync(empty, '\n');
    const found = problems(env({ GITHUB_CLIENT_SECRET_FILE: join(dir, 'missing'), S3_ACCESS_KEY_ID_FILE: empty }));
    assert.ok(found.includes("GITHUB_CLIENT_SECRET_FILE can't be read"));
    assert.ok(found.includes('S3_ACCESS_KEY_ID_FILE is empty'));
  });

  test('the App key must be an RSA private key', () => {
    const ec = join(dir, 'ec.pem');
    writeFileSync(ec, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.ok(problems(env({ GITHUB_PRIVATE_KEY_FILE: ec })).includes('GITHUB_PRIVATE_KEY_FILE must hold an RSA private key'));
    const junk = join(dir, 'junk.pem');
    writeFileSync(junk, 'not a key');
    assert.ok(problems(env({ GITHUB_PRIVATE_KEY_FILE: junk })).includes('GITHUB_PRIVATE_KEY_FILE is not a PEM private key'));
  });

  test('CMS_ORIGIN must be an exact https origin', () => {
    for (const bad of ['https://cms.example.test/', 'https://cms.example.test/admin', 'http://cms.example.test', 'cms.example.test', 'https://u:p@cms.example.test']) {
      assert.ok(problems(env({ CMS_ORIGIN: bad })).some((p) => p.startsWith('CMS_ORIGIN')), bad);
    }
  });

  test('remote endpoints must use https; http is for loopback stubs only', () => {
    assert.ok(problems(env({ S3_ENDPOINT: 'http://rgw.example.test' })).some((p) => p.startsWith('S3_ENDPOINT must use https')));
    assert.ok(problems(env({ GITHUB_API_URL: 'http://api.example.test' })).some((p) => p.startsWith('GITHUB_API_URL must use https')));
    assert.ok(problems(env({ S3_ENDPOINT: 'https://rgw.example.test/bucket' })).some((p) => p.startsWith('S3_ENDPOINT must be a bare origin')));
  });

  test('the upload ACL is public-read, private or none', () => {
    for (const bad of ['public-read-write', 'authenticated-read', 'Public-Read', 'bucket-owner-full-control']) {
      assert.ok(problems(env({ S3_ACL: bad })).includes('S3_ACL is not valid'), bad);
    }
    assert.equal(loadConfig(env({ S3_ACL: 'private' })).config.s3.acl, 'private');
    assert.equal(loadConfig(env({ S3_ACL: 'none' })).config.s3.acl, null);
  });

  test('the prefix must be a plain folder ending in a slash', () => {
    for (const bad of ['media', '/media/', '../media/', 'media//', 'Media/', 'media/*/']) {
      assert.ok(problems(env({ S3_PREFIX: bad })).includes('S3_PREFIX is not valid'), bad);
    }
    assert.equal(loadConfig(env({ S3_PREFIX: 'media/sub-dir/' })).config.s3.prefix, 'media/sub-dir/');
  });

  test('the CA file must be a certificate, and needs an https endpoint', () => {
    const notCert = join(dir, 'ca.pem');
    writeFileSync(notCert, 'nope');
    assert.ok(problems(env({ S3_CA_FILE: notCert })).includes('S3_CA_FILE is not a readable PEM certificate'));
    assert.ok(problems(env({ S3_CA_FILE: notCert, S3_ENDPOINT: 'http://127.0.0.1:9000' })).includes('S3_CA_FILE is set but S3_ENDPOINT is not https'));
  });

  test('numbers are checked against their ranges', () => {
    assert.ok(problems(env({ MAX_UPLOAD_BYTES: '10' })).some((p) => p.startsWith('MAX_UPLOAD_BYTES')));
    assert.ok(problems(env({ MAX_UPLOAD_BYTES: '5e6' })).some((p) => p.startsWith('MAX_UPLOAD_BYTES')));
    assert.ok(problems(env({ LISTEN_PORT: '70000' })).some((p) => p.startsWith('LISTEN_PORT')));
    assert.ok(problems(env({ RATE_UPLOAD_BYTES_PER_HOUR: '1024' })).includes('RATE_UPLOAD_BYTES_PER_HOUR is below MAX_UPLOAD_BYTES'));
    assert.ok(problems(env({ TRUST_PROXY: 'maybe' })).includes('TRUST_PROXY must be true or false'));
  });

  test('listening beyond loopback is allowed with a warning; host names are not', () => {
    const { config, warnings } = loadConfig(env({ LISTEN_HOST: '0.0.0.0' }));
    assert.equal(config.listen.host, '0.0.0.0');
    assert.equal(warnings.length, 1);
    assert.ok(problems(env({ LISTEN_HOST: 'example.test' })).includes('LISTEN_HOST must be an IP address or localhost'));
  });

  test('problems never quote secret values', () => {
    const found = problems(env({ GITHUB_APP_ID: 'abc', MAX_UPLOAD_BYTES: '1' })).join('\n');
    for (const value of Object.values(secrets)) assert.ok(!found.includes(value));
  });
});
