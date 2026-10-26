import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { candidateKey, slugify, splitName } from '../src/keys.ts';

describe('keys', () => {
  test('the extension is the last one, lowercased; the base keeps the rest', () => {
    assert.deepEqual(splitName('Relatório Anual.PDF'), { base: 'Relatório Anual', ext: 'pdf' });
    assert.deepEqual(splitName('foto.jpg.html'), { base: 'foto.jpg', ext: 'html' });
    assert.deepEqual(splitName('C:\\Users\\x\\doc.docx'), { base: 'doc', ext: 'docx' });
    assert.deepEqual(splitName('../../etc/passwd.txt'), { base: 'passwd', ext: 'txt' });
    assert.equal(splitName('README'), null);
    assert.equal(splitName('trailing.'), null);
  });

  test('slugs are lowercase ASCII, digits and hyphens', () => {
    assert.equal(slugify('Relatório Anual 2025'), 'relatorio-anual-2025');
    assert.equal(slugify('Ação, Coração & Pão!'), 'acao-coracao-pao');
    assert.equal(slugify('  --hello__world--  '), 'hello-world');
    assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
    assert.equal(slugify('日本語'), 'file');
    assert.equal(slugify(''), 'file');
    assert.ok(slugify('a'.repeat(300)).length <= 80);
    assert.match(slugify(`${'a'.repeat(79)} b`), /^a+$/);
  });

  test('keys are <prefix>YYYY/MM/<slug>[-n].<ext>, in UTC', () => {
    const date = new Date('2025-03-31T23:30:00-02:00');
    assert.equal(candidateKey('media/', date, 'relatorio', 'pdf', 1), 'media/2025/04/relatorio.pdf');
    assert.equal(candidateKey('media/', date, 'relatorio', 'pdf', 2), 'media/2025/04/relatorio-2.pdf');
    assert.equal(candidateKey('media/', new Date('2026-12-01T00:00:00Z'), 'x', 'png', 10), 'media/2026/12/x-10.png');
  });
});
