// Test files, built in memory: small but well-formed enough for the checks (magic bytes, zip structure, parts).
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: string | Buffer;
  /** Stored instead of deflated. */
  store?: boolean;
  /** The name in the local header, if not `name`. */
  localName?: string;
  /** The extra fields of the central directory entry. */
  extra?: Buffer;
}

/** A zip archive of the entries, in order. */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const name = Buffer.from(e.name);
    const localName = Buffer.from(e.localName ?? e.name);
    const extra = e.extra ?? Buffer.alloc(0);
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
    local.writeUInt16LE(localName.length, 26);
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
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    locals.push(local, localName, packed);
    centrals.push(central, name, extra);
    offset += 30 + localName.length + packed.length;
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

/** An Info-ZIP Unicode path extra field (0x7075) that gives the entry named `raw` the name `name`. */
export function unicodePath(raw: string, name: string): Buffer {
  const data = Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from(name)]);
  data.writeUInt32LE(crc32(Buffer.from(raw)), 1);
  const header = Buffer.alloc(4);
  header.writeUInt16LE(0x7075, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
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

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A relationships part: [type, target, external?]; types without a scheme are under the OOXML relationships URI. */
export const rels = (list: [string, string, boolean?][]) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  list
    .map(([type, target, external], i) =>
      `<Relationship Id="rId${i + 1}" Type="${type.includes(':') ? type : `${R}/${type}`}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('') +
  '</Relationships>';

/** The main part's relationships part, e.g. word/_rels/document.xml.rels. */
const relsOf = (part: string) => part.replace(/([^/]+)$/, '_rels/$1.rels');

/** An Office Open XML file: [Content_Types].xml, the relationships and the main part, plus `extra` entries; `rels`
 * become the main part's relationships. */
export function ooxml(
  kind: keyof typeof OOXML_MAIN,
  o: {
    mainType?: string;
    types?: string | Buffer;
    defaults?: [string, string][];
    overrides?: [string, string][];
    rels?: [string, string, boolean?][];
    extra?: ZipEntry[];
  } = {},
): Buffer {
  const main = OOXML_MAIN[kind];
  return zip([
    { name: '[Content_Types].xml', data: o.types ?? contentTypes([[`/${main.part}`, o.mainType ?? main.type], ...(o.overrides ?? [])], o.defaults) },
    { name: '_rels/.rels', data: `<Relationships><Relationship Id="rId1" Target="${main.part}"/></Relationships>` },
    { name: main.part, data: '<?xml version="1.0"?><root/>' },
    ...(o.rels ? [{ name: relsOf(main.part), data: rels(o.rels) }] : []),
    ...(o.extra ?? []),
  ]);
}

/** A manifest listing [path, media type] entries. */
export const manifest = (entries: [string, string][], doctype = false) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  (doctype ? '<!DOCTYPE manifest:manifest PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "Manifest.dtd">\n' : '') +
  '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">\n' +
  entries.map(([path, type]) => ` <manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"/>\n`).join('') +
  '</manifest:manifest>\n';

/** An OpenDocument file: the stored `mimetype` first, the manifest and the content, plus `extra` entries. */
export function odf(
  kind: 'text' | 'spreadsheet' | 'presentation',
  o: { mimetype?: string; storeMimetype?: boolean; manifest?: string; extra?: ZipEntry[] } = {},
): Buffer {
  return zip([
    { name: 'mimetype', data: o.mimetype ?? `application/vnd.oasis.opendocument.${kind}`, store: o.storeMimetype ?? true },
    { name: 'META-INF/manifest.xml', data: o.manifest ?? '<manifest:manifest/>' },
    { name: 'content.xml', data: '<office:document-content/>' },
    ...(o.extra ?? []),
  ]);
}

const filler = Buffer.from('cms-gate test file '.repeat(8));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), filler]);
const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root/>';
/** A docx as Word writes one: styles, theme, an image, links to web pages (one with `&amp;` in it). */
const fullDocx = ooxml('docx', {
  defaults: [['png', 'image/png']],
  overrides: [
    ['/word/styles.xml', `${OOXML}.wordprocessingml.styles+xml`],
    ['/word/settings.xml', `${OOXML}.wordprocessingml.settings+xml`],
    ['/word/theme/theme1.xml', `${OOXML}.theme+xml`],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ],
  rels: [
    ['styles', 'styles.xml'],
    ['settings', 'settings.xml'],
    ['theme', 'theme/theme1.xml'],
    ['image', 'media/image1.png'],
    ['hyperlink', 'https://arquivo.pt/?l=pt&amp;q=sobre', true],
    ['hyperlink', 'mailto:contacto@arquivo.pt', true],
  ],
  extra: [
    { name: 'word/styles.xml', data: xml },
    { name: 'word/settings.xml', data: xml },
    { name: 'word/theme/theme1.xml', data: xml },
    { name: 'word/media/image1.png', data: png },
    { name: 'docProps/core.xml', data: xml },
    { name: 'docProps/app.xml', data: xml },
  ],
});

/** An xlsx with a sheet, its printer settings and a link. */
const fullXlsx = ooxml('xlsx', {
  overrides: [['/xl/worksheets/sheet1.xml', `${OOXML}.spreadsheetml.worksheet+xml`]],
  defaults: [['bin', `${OOXML}.spreadsheetml.printerSettings`]],
  rels: [
    ['worksheet', 'worksheets/sheet1.xml'],
    ['theme', 'theme/theme1.xml'],
    ['styles', 'styles.xml'],
    ['sharedStrings', 'sharedStrings.xml'],
  ],
  extra: [
    { name: 'xl/worksheets/sheet1.xml', data: xml },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels([['printerSettings', '../printerSettings/printerSettings1.bin'], ['hyperlink', 'https://arquivo.pt/', true]]) },
    { name: 'xl/printerSettings/printerSettings1.bin', data: Buffer.from([0, 1, 2, 3]) },
    { name: 'xl/theme/theme1.xml', data: xml },
    { name: 'xl/styles.xml', data: xml },
    { name: 'xl/sharedStrings.xml', data: xml },
  ],
});

/** A pptx with a slide, its layout and master, an image and a link. */
const fullPptx = ooxml('pptx', {
  defaults: [['png', 'image/png']],
  overrides: [['/ppt/slides/slide1.xml', `${OOXML}.presentationml.slide+xml`]],
  rels: [
    ['slideMaster', 'slideMasters/slideMaster1.xml'],
    ['slide', 'slides/slide1.xml'],
    ['theme', 'theme/theme1.xml'],
  ],
  extra: [
    { name: 'ppt/slides/slide1.xml', data: xml },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: rels([['slideLayout', '../slideLayouts/slideLayout1.xml'], ['image', '../media/image1.png'], ['hyperlink', 'https://arquivo.pt/', true]]),
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: xml },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['slideMaster', '../slideMasters/slideMaster1.xml']]) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: xml },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['slideLayout', '../slideLayouts/slideLayout1.xml'], ['theme', '../theme/theme1.xml']]) },
    { name: 'ppt/theme/theme1.xml', data: xml },
    { name: 'ppt/media/image1.png', data: png },
  ],
});

/** An odt as LibreOffice writes one: its manifest lists every part, with an image, a chart and the UI settings. */
const fullOdt = odf('text', {
  manifest: manifest([
    ['/', 'application/vnd.oasis.opendocument.text'],
    ['Configurations2/', 'application/vnd.sun.xml.ui.configuration'],
    ['Pictures/1000000000000010.png', 'image/png'],
    ['Object 1/content.xml', 'text/xml'],
    ['Object 1/', 'application/vnd.oasis.opendocument.chart'],
    ['content.xml', 'text/xml'],
    ['styles.xml', 'text/xml'],
    ['meta.xml', 'text/xml'],
    ['settings.xml', 'text/xml'],
    ['Thumbnails/thumbnail.png', 'image/png'],
  ]),
  extra: [
    { name: 'styles.xml', data: xml },
    { name: 'meta.xml', data: xml },
    { name: 'settings.xml', data: xml },
    { name: 'Pictures/1000000000000010.png', data: png },
    { name: 'Object 1/content.xml', data: xml },
    { name: 'Thumbnails/thumbnail.png', data: png },
  ],
});

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
  { name: 'relatorio-completo.docx', data: fullDocx, contentType: `${OOXML}.wordprocessingml.document` },
  { name: 'folha-completa.xlsx', data: fullXlsx, contentType: `${OOXML}.spreadsheetml.sheet` },
  { name: 'slides-completos.pptx', data: fullPptx, contentType: `${OOXML}.presentationml.presentation` },
  { name: 'texto-completo.odt', data: fullOdt, contentType: 'application/vnd.oasis.opendocument.text' },
  {
    name: 'texto-antigo.odt',
    data: odf('text', { manifest: manifest([['/', 'application/vnd.oasis.opendocument.text'], ['content.xml', 'text/xml']], true) }),
    contentType: 'application/vnd.oasis.opendocument.text',
  },
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
  // Names that read differently in other zip readers.
  {
    label: 'an xlsx whose entry has a Unicode path field naming another part',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { extra: [{ name: 'xl/media/image1.png', data: 'x', extra: unicodePath('xl/media/image1.png', 'xl/media/image2.png') }] }),
    reason: 'content-mismatch',
  },
  {
    label: 'an xlsx whose local header names another part',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { extra: [{ name: 'xl/media/image1.png', localName: 'xl/vbaProject.bin', data: 'x' }] }),
    reason: 'content-mismatch',
  },
  {
    label: 'an xlsx with a percent-encoded part name',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { extra: [{ name: 'xl/vba%50roject.bin%2Exml', data: 'x' }] }),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx with two content types parts, in different case',
    name: 'doc.docx',
    data: ooxml('docx', { extra: [{ name: '[content_types].XML', data: '<Types/>' }] }),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx with a part twice',
    name: 'doc.docx',
    data: ooxml('docx', { extra: [{ name: 'Word/Document.xml', data: '<root/>' }] }),
    reason: 'content-mismatch',
  },
  // XML that says more than it shows.
  {
    label: 'an xlsm renamed, its macro type written with character references',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { overrides: [['/xl/vbaData.xml', 'application/vnd.ms-office.vb&#x61;Project']] }),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx whose content types use a named entity',
    name: 'doc.docx',
    data: ooxml('docx', { overrides: [['/word/x.xml', '&ct;']] }),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx whose content types are UTF-16, with a macro type',
    name: 'doc.docx',
    data: ooxml('docx', {
      types: Buffer.from(
        `\ufeff<?xml version="1.0" encoding="UTF-16"?><Types><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>` +
          `<Override PartName="/word/document.xml" ContentType="${OOXML_MAIN.docx.type}"/></Types>`,
        'utf16le',
      ),
    }),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx whose content types declare another encoding',
    name: 'doc.docx',
    data: ooxml('docx', { types: `<?xml version="1.0" encoding="UTF-7"?><Types><Override PartName="/word/document.xml" ContentType="${OOXML_MAIN.docx.type}"/></Types>` }),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx whose relationships use a character reference',
    name: 'doc.docx',
    data: ooxml('docx', { rels: [['ole&#79;bject', 'media/image1.png']] }),
    reason: 'content-mismatch',
  },
  // Relationships to macros, embedded content or external parts, whatever the part is called.
  { label: 'a docx with an OLE object relationship', name: 'doc.docx', data: ooxml('docx', { rels: [['oleObject', 'media/image1.png']] }), reason: 'macro' },
  { label: 'a docx with an embedded package relationship', name: 'doc.docx', data: ooxml('docx', { rels: [['package', 'media/image1.png']] }), reason: 'macro' },
  {
    label: 'a docx with a VBA project relationship',
    name: 'doc.docx',
    data: ooxml('docx', { rels: [['http://schemas.microsoft.com/office/2006/relationships/vbaProject', 'media/data.xml']] }),
    reason: 'macro',
  },
  {
    label: 'an xlsx with an ActiveX control relationship in a sheet',
    name: 'folha.xlsx',
    data: ooxml('xlsx', { extra: [{ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels([['activeXControlBinary', '../media/image1.png']]) }] }),
    reason: 'macro',
  },
  {
    label: 'a docx with an external template',
    name: 'doc.docx',
    data: ooxml('docx', { extra: [{ name: 'word/_rels/settings.xml.rels', data: rels([['attachedTemplate', 'https://example.test/t.dotm', true]]) }] }),
    reason: 'macro',
  },
  { label: 'a docx with an external image', name: 'doc.docx', data: ooxml('docx', { rels: [['image', 'https://example.test/a.png', true]] }), reason: 'macro' },
  {
    label: 'a docx with an external target after a `>` in an attribute',
    name: 'doc.docx',
    data: ooxml('docx', {
      extra: [
        {
          name: 'word/_rels/document.xml.rels',
          data: '<Relationships><Relationship Id="a>b" Target="https://example.test/a.png" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>',
        },
      ],
    }),
    reason: 'macro',
  },
  {
    label: 'a docx with a prefixed relationship element',
    name: 'doc.docx',
    data: ooxml('docx', {
      extra: [
        {
          name: 'word/_rels/document.xml.rels',
          data: '<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="media/a.png"/></r:Relationships>',
        },
      ],
    }),
    reason: 'macro',
  },
  {
    label: 'a docx with a relationship element under a non-ASCII prefix',
    name: 'doc.docx',
    data: ooxml('docx', {
      extra: [
        {
          name: 'word/_rels/document.xml.rels',
          data: '<é:Relationships xmlns:é="http://schemas.openxmlformats.org/package/2006/relationships"><é:Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/x.png"/></é:Relationships>',
        },
      ],
    }),
    reason: 'macro',
  },
  {
    label: 'a docx with an external target under a non-ASCII prefix',
    name: 'doc.docx',
    data: ooxml('docx', {
      extra: [
        {
          name: 'word/_rels/settings.xml.rels',
          data: '<é:Relationships xmlns:é="http://schemas.openxmlformats.org/package/2006/relationships"><é:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///x/Modelo.png" TargetMode="External"/></é:Relationships>',
        },
      ],
    }),
    reason: 'macro',
  },
  {
    label: 'a docx with a chart, whose workbook is embedded',
    name: 'doc.docx',
    data: ooxml('docx', {
      extra: [
        { name: 'word/charts/chart1.xml', data: xml },
        { name: 'word/charts/_rels/chart1.xml.rels', data: rels([['package', '../embeddings/Microsoft_Excel_Worksheet.xlsx']]) },
        { name: 'word/embeddings/Microsoft_Excel_Worksheet.xlsx', data: 'xlsx' },
      ],
    }),
    reason: 'macro',
  },
  {
    label: 'a docx with a DTD in a relationships part',
    name: 'doc.docx',
    data: ooxml('docx', { extra: [{ name: 'word/_rels/document.xml.rels', data: `<!DOCTYPE Relationships>${rels([['image', 'media/a.png']])}` }] }),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx whose end record counts one entry less than its directory has',
    name: 'doc.docx',
    data: (() => {
      const data = ooxml('docx', { extra: [{ name: 'word/media/a.png', data: 'png' }] });
      data.writeUInt16LE(data.readUInt16LE(data.length - 14) - 1, data.length - 14);
      data.writeUInt16LE(data.readUInt16LE(data.length - 12) - 1, data.length - 12);
      return data;
    })(),
    reason: 'content-mismatch',
  },
  {
    label: 'a docx with ZIP64 records',
    name: 'doc.docx',
    data: (() => {
      const data = ooxml('docx');
      const end = data.subarray(data.length - 22);
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(end.readUInt16LE(10)), 24);
      record.writeBigUInt64LE(BigInt(end.readUInt16LE(10)), 32);
      record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40);
      record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(data.length - 22), 8);
      locator.writeUInt32LE(1, 16);
      return Buffer.concat([data.subarray(0, data.length - 22), record, locator, end]);
    })(),
    reason: 'content-mismatch',
  },
  {
    label: 'a pptx with an OLE object relationship in an uppercase .RELS part',
    name: 'slides.pptx',
    data: ooxml('pptx', { extra: [{ name: 'ppt/slides/_rels/slide1.xml.RELS', data: rels([['oleObject', '../media/image1.png']]) }] }),
    reason: 'macro',
  },
  // The OpenDocument manifest.
  {
    label: 'an odt with an OLE object in its manifest',
    name: 'texto.odt',
    data: odf('text', { manifest: manifest([['Object 1', 'application/vnd.sun.star.oleobject']]), extra: [{ name: 'Object 1', data: 'ole' }] }),
    reason: 'macro',
  },
  { label: 'an odt listing Basic in its manifest', name: 'texto.odt', data: odf('text', { manifest: manifest([['Basic/', 'application/binary']]) }), reason: 'macro' },
  {
    label: 'an odt listing a script library by type',
    name: 'texto.odt',
    data: odf('text', { manifest: manifest([['lib/x.xml', 'application/vnd.sun.star.basic-library']]) }),
    reason: 'macro',
  },
  {
    label: 'an odt whose manifest uses a character reference',
    name: 'texto.odt',
    data: odf('text', { manifest: manifest([['Object 1', 'application/vnd.sun.star.ole&#111;bject']]) }),
    reason: 'content-mismatch',
  },
  {
    label: 'an odt listing an OLE object under a non-ASCII prefix',
    name: 'texto.odt',
    data: odf('text', {
      manifest: manifest([['Object 1', 'application/vnd.sun.star.oleobject']]).replace(/manifest:(?=manifest|file-entry|full-path|media-type|version)/g, 'é:').replace('xmlns:manifest=', 'xmlns:é='),
      extra: [{ name: 'Object 1', data: 'ole' }],
    }),
    reason: 'macro',
  },
  {
    label: 'an odt whose manifest DTD declares attributes',
    name: 'texto.odt',
    data: odf('text', {
      manifest: manifest([['content.xml', 'text/xml']]).replace('<manifest:manifest ', '<!DOCTYPE manifest:manifest [<!ATTLIST manifest:file-entry manifest:media-type CDATA "x">]>\n<manifest:manifest '),
    }),
    reason: 'content-mismatch',
  },
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
