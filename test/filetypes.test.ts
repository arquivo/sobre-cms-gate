import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkFile, TYPES } from '../src/filetypes.ts';
import { splitName } from '../src/keys.ts';
import { ALLOWED, REFUSED } from './helpers/fixtures.ts';

const ext = (name: string) => splitName(name)?.ext ?? '';

describe('file types', () => {
  test('the allowed list is exactly the spec table', () => {
    assert.deepEqual(Object.keys(TYPES).sort(), ['csv', 'docx', 'gif', 'jpeg', 'jpg', 'odp', 'ods', 'odt', 'pdf', 'png', 'pptx', 'txt', 'webp', 'xlsx']);
    assert.deepEqual([...new Set(ALLOWED.map((f) => ext(f.name)))].sort(), Object.keys(TYPES).sort(), 'one fixture per allowed type');
  });

  for (const file of ALLOWED) {
    test(`accepts ${file.name} as ${file.contentType}`, async () => {
      assert.deepEqual(await checkFile(ext(file.name), file.data), { ok: true, contentType: file.contentType });
    });
  }

  for (const file of REFUSED) {
    test(`refuses ${file.label} (${file.reason})`, async () => {
      assert.deepEqual(await checkFile(ext(file.name), file.data), { ok: false, reason: file.reason });
    });
  }

  test('inherited object keys are not types', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.deepEqual(await checkFile(name, Buffer.from('x')), { ok: false, reason: 'type-not-allowed' });
    }
  });
});
