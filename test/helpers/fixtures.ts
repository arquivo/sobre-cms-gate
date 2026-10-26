// Test files, built in memory: small but well-formed enough for the checks (magic bytes, zip structure, parts).
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: string | Buffer;
  /** Stored instead of deflated. */
  store?: boolean;
}

/** A zip archive of the entries, in order. */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const name = Buffer.from(e.name);
    const packed = e.store ? data : deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.store ? 0 : 8, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.store ? 0 : 8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const OOXML = 'application/vnd.openxmlformats-officedocument';

const contentTypes = (overrides: [string, string][], defaults: [string, string][] = []) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('') +
  overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
  '</Types>';

export const OOXML_MAIN = {
  docx: { part: 'word/document.xml', type: `${OOXML}.wordprocessingml.document.main+xml` },
  xlsx: { part: 'xl/workbook.xml', type: `${OOXML}.spreadsheetml.sheet.main+xml` },
  pptx: { part: 'ppt/presentation.xml', type: `${OOXML}.presentationml.presentation.main+xml` },
} as const;

/** An Office Open XML file: [Content_Types].xml, the relationships and the main part, plus `extra` entries. */
export function ooxml(
  kind: keyof typeof OOXML_MAIN,
  o: { mainType?: string; defaults?: [string, string][]; overrides?: [string, string][]; extra?: ZipEntry[] } = {},
): Buffer {
  const main = OOXML_MAIN[kind];
  return zip([
    { name: '[Content_Types].xml', data: contentTypes([[`/${main.part}`, o.mainType ?? main.type], ...(o.overrides ?? [])], o.defaults) },
    { name: '_rels/.rels', data: `<Relationships><Relationship Id="rId1" Target="${main.part}"/></Relationships>` },
    { name: main.part, data: '<?xml version="1.0"?><root/>' },
    ...(o.extra ?? []),
  ]);
}

/** An OpenDocument file: the stored `mimetype` first, the manifest and the content, plus `extra` entries. */
export function odf(kind: 'text' | 'spreadsheet' | 'presentation', o: { mimetype?: string; storeMimetype?: boolean; extra?: ZipEntry[] } = {}): Buffer {
  return zip([
    { name: 'mimetype', data: o.mimetype ?? `application/vnd.oasis.opendocument.${kind}`, store: o.storeMimetype ?? true },
    { name: 'META-INF/manifest.xml', data: '<manifest:manifest/>' },
    { name: 'content.xml', data: '<office:document-content/>' },
    ...(o.extra ?? []),
  ]);
}

const filler = Buffer.from('cms-gate test file '.repeat(8));

export const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><circle r="1"/></svg>\n';

/** One valid file per allowed extension, with the Content-Type it must be stored with. */
export const ALLOWED: { name: string; data: Buffer; contentType: string }[] = [
  { name: 'Foto.jpg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler]), contentType: 'image/jpeg' },
  { name: 'foto.jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), filler]), contentType: 'image/jpeg' },
  { name: 'logo.png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), filler]), contentType: 'image/png' },
  { name: 'anim.gif', data: Buffer.concat([Buffer.from('GIF89a'), filler]), contentType: 'image/gif' },
  { name: 'img.webp', data: Buffer.concat([Buffer.from('RIFF\x40\x00\x00\x00WEBPVP8 ', 'latin1'), filler]), contentType: 'image/webp' },
  { name: 'Relatório 2025.pdf', data: Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'), contentType: 'application/pdf' },
  { name: 'doc.docx', data: ooxml('docx'), contentType: `${OOXML}.wordprocessingml.document` },
  { name: 'folha.xlsx', data: ooxml('xlsx'), contentType: `${OOXML}.spreadsheetml.sheet` },
  { name: 'slides.pptx', data: ooxml('pptx'), contentType: `${OOXML}.presentationml.presentation` },
  { name: 'texto.odt', data: odf('text'), contentType: 'application/vnd.oasis.opendocument.text' },
  { name: 'folha.ods', data: odf('spreadsheet'), contentType: 'application/vnd.oasis.opendocument.spreadsheet' },
  { name: 'slides.odp', data: odf('presentation'), contentType: 'application/vnd.oasis.opendocument.presentation' },
  { name: 'dados.csv', data: Buffer.from('ano;páginas\n2024;1\n2025;2\n'), contentType: 'text/csv; charset=utf-8' },
  { name: 'leia-me.txt', data: Buffer.from('Olá\tmundo\r\nSegunda linha\f\n'), contentType: 'text/plain; charset=utf-8' },
];

const macroXlsm = ooxml('xlsx', {
  mainType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  defaults: [['bin', 'application/vnd.ms-office.vbaProject']],
  extra: [{ name: 'xl/vbaProject.bin', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) }],
});

/** Files that must be refused, with the reason. */
export const REFUSED: { label: string; name: string; data: Buffer; reason: string }[] = [
  { label: 'an SVG', name: 'logo.svg', data: Buffer.from(SVG), reason: 'type-not-allowed' },
  { label: 'an SVG renamed .png', name: 'logo.png', data: Buffer.from(SVG), reason: 'content-mismatch' },
  { label: 'an SVG renamed .jpg', name: 'logo.jpg', data: Buffer.from(SVG), reason: 'content-mismatch' },
  { label: 'an SVG renamed .txt', name: 'logo.txt', data: Buffer.from(SVG), reason: 'content-mismatch' },
  { label: 'an SVG renamed .csv', name: 'logo.csv', data: Buffer.from(SVG), reason: 'content-mismatch' },
  { label: 'HTML', name: 'page.html', data: Buffer.from('<!doctype html><script>alert(1)</script>'), reason: 'type-not-allowed' },
  { label: 'HTML renamed .pdf', name: 'page.pdf', data: Buffer.from('<!doctype html><script>alert(1)</script>'), reason: 'content-mismatch' },
  { label: 'XML', name: 'data.xml', data: Buffer.from('<?xml version="1.0"?><a/>'), reason: 'type-not-allowed' },
  { label: 'JavaScript', name: 'app.js', data: Buffer.from('alert(1)'), reason: 'type-not-allowed' },
  { label: 'an executable', name: 'setup.exe', data: Buffer.from('MZ\x90\x00', 'latin1'), reason: 'type-not-allowed' },
  { label: 'an executable renamed .gif', name: 'setup.gif', data: Buffer.from('MZ\x90\x00', 'latin1'), reason: 'content-mismatch' },
  { label: 'a zip archive', name: 'files.zip', data: zip([{ name: 'a.txt', data: 'a' }]), reason: 'type-not-allowed' },
  { label: 'a zip renamed .docx', name: 'files.docx', data: zip([{ name: 'a.txt', data: 'a' }]), reason: 'content-mismatch' },
  { label: 'a docx renamed .xlsx', name: 'doc.xlsx', data: ooxml('docx'), reason: 'content-mismatch' },
  { label: 'an xlsm', name: 'macros.xlsm', data: macroXlsm, reason: 'type-not-allowed' },
  { label: 'a docm', name: 'macros.docm', data: ooxml('docx'), reason: 'type-not-allowed' },
  { label: 'a pptm', name: 'macros.pptm', data: ooxml('pptx'), reason: 'type-not-allowed' },
  { label: 'an xlsx with a macro (an xlsm renamed)', name: 'folha.xlsx', data: macroXlsm, reason: 'macro' },
  {
    label: 'an xlsx with a vbaProject.bin',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { extra: [{ name: 'xl/vbaProject.bin', data: Buffer.from([1, 2, 3]) }] }),
    reason: 'macro',
  },
  {
    label: 'an xlsx with a macro under another name',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { overrides: [['/xl/media/x.bin', 'application/vnd.ms-office.vbaProject']], extra: [{ name: 'xl/media/x.bin', data: 'x' }] }),
    reason: 'macro',
  },
  {
    label: 'an xlsx with an Excel 4.0 macro sheet',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { extra: [{ name: 'xl/macrosheets/sheet1.xml', data: '<xm:macrosheet/>' }] }),
    reason: 'macro',
  },
  {
    label: 'a docx with an ActiveX control',
    name: 'doc.docx',
    data: ooxml('docx', { extra: [{ name: 'word/activeX/activeX1.xml', data: '<ax:ocx/>' }] }),
    reason: 'macro',
  },
  {
    label: 'a pptx with an embedded OLE object',
    name: 'slides.pptx',
    data: ooxml('pptx', { extra: [{ name: 'ppt/embeddings/oleObject1.bin', data: 'ole' }] }),
    reason: 'macro',
  },
  {
    label: 'a docx with an embedded xlsm',
    name: 'doc.docx',
    data: ooxml('docx', { extra: [{ name: 'word/embeddings/Book1.xlsm', data: macroXlsm }] }),
    reason: 'macro',
  },
  { label: 'an odt with Basic macros', name: 'texto.odt', data: odf('text', { extra: [{ name: 'Basic/Standard/Module1.xml', data: 'Sub X' }] }), reason: 'macro' },
  { label: 'an ods with scripts', name: 'folha.ods', data: odf('spreadsheet', { extra: [{ name: 'Scripts/python/x.py', data: 'x' }] }), reason: 'macro' },
  { label: 'an odt claiming another type', name: 'texto.odt', data: odf('spreadsheet'), reason: 'content-mismatch' },
  { label: 'an odt with a deflated mimetype', name: 'texto.odt', data: odf('text', { storeMimetype: false }), reason: 'content-mismatch' },
  { label: 'an odt without a manifest', name: 'texto.odt', data: zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true }]), reason: 'content-mismatch' },
  { label: 'a corrupt docx', name: 'doc.docx', data: Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), filler]), reason: 'content-mismatch' },
  { label: 'a png renamed .jpg', name: 'logo.jpg', data: ALLOWED[2]?.data ?? Buffer.alloc(0), reason: 'content-mismatch' },
  { label: 'a txt with invalid UTF-8', name: 'a.txt', data: Buffer.from([0x61, 0xff, 0xfe, 0x62]), reason: 'not-text' },
  { label: 'a txt with a NUL byte', name: 'a.txt', data: Buffer.from('a\u0000b'), reason: 'not-text' },
  { label: 'a csv that is a binary file', name: 'a.csv', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), reason: 'not-text' },
  { label: 'an empty file', name: 'vazio.pdf', data: Buffer.alloc(0), reason: 'empty' },
  { label: 'a name without an extension', name: 'README', data: Buffer.from('text'), reason: 'type-not-allowed' },
  { label: 'a double extension ending in .html', name: 'foto.jpg.html', data: Buffer.from('<p>'), reason: 'type-not-allowed' },
];
