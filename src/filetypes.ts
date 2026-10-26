// What may be uploaded: the extension must be on the list, and the content must match it. The `Content-Type` written
// to the bucket comes from this table, never from the client. Office files are opened as zips: they must have the
// parts of their type and no macros (VBA, Excel 4.0 macro sheets, ActiveX, OLE objects, Basic or scripts in
// OpenDocument), whatever the extension says. Anything else (SVG, HTML, XML, scripts, executables, archives,
// macro-enabled office files) is refused. Extending the list is a decision recorded in static-sobre's D7.
import yauzl from 'yauzl';

export type Refusal = 'type-not-allowed' | 'content-mismatch' | 'macro' | 'not-text' | 'empty';
export type Check = { ok: true; contentType: string } | { ok: false; reason: Refusal };

const OOXML = 'application/vnd.openxmlformats-officedocument';
const ODF = 'application/vnd.oasis.opendocument';

type Kind =
  | { kind: 'magic'; test: (b: Buffer) => boolean }
  | { kind: 'ooxml'; main: string }
  | { kind: 'odf' }
  | { kind: 'text' };

const startsWith = (b: Buffer, ...bytes: number[]) => b.length >= bytes.length && bytes.every((x, i) => b[i] === x);
const ascii = (b: Buffer, offset: number, s: string) => b.toString('latin1', offset, offset + s.length) === s;

const JPEG: Kind = { kind: 'magic', test: (b) => startsWith(b, 0xff, 0xd8, 0xff) };

export const TYPES: Record<string, { contentType: string } & Kind> = {
  jpg: { contentType: 'image/jpeg', ...JPEG },
  jpeg: { contentType: 'image/jpeg', ...JPEG },
  png: { contentType: 'image/png', kind: 'magic', test: (b) => startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  gif: { contentType: 'image/gif', kind: 'magic', test: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a') },
  webp: { contentType: 'image/webp', kind: 'magic', test: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  pdf: { contentType: 'application/pdf', kind: 'magic', test: (b) => ascii(b, 0, '%PDF-') },
  docx: { contentType: `${OOXML}.wordprocessingml.document`, kind: 'ooxml', main: `${OOXML}.wordprocessingml.document.main+xml` },
  xlsx: { contentType: `${OOXML}.spreadsheetml.sheet`, kind: 'ooxml', main: `${OOXML}.spreadsheetml.sheet.main+xml` },
  pptx: { contentType: `${OOXML}.presentationml.presentation`, kind: 'ooxml', main: `${OOXML}.presentationml.presentation.main+xml` },
  odt: { contentType: `${ODF}.text`, kind: 'odf' },
  ods: { contentType: `${ODF}.spreadsheet`, kind: 'odf' },
  odp: { contentType: `${ODF}.presentation`, kind: 'odf' },
  csv: { contentType: 'text/csv; charset=utf-8', kind: 'text' },
  txt: { contentType: 'text/plain; charset=utf-8', kind: 'text' },
};

/** Checks a file's content against its (lowercase) extension. */
export async function checkFile(ext: string, data: Buffer): Promise<Check> {
  const type = Object.hasOwn(TYPES, ext) ? TYPES[ext] : undefined;
  if (!type) return { ok: false, reason: 'type-not-allowed' };
  if (data.length === 0) return { ok: false, reason: 'empty' };
  const refusal = await (async (): Promise<Refusal | null> => {
    switch (type.kind) {
      case 'magic':
        return type.test(data) ? null : 'content-mismatch';
      case 'text':
        return checkText(data);
      case 'ooxml':
        return checkOoxml(data, type.main);
      case 'odf':
        return checkOdf(data, type.contentType);
    }
  })();
  return refusal ? { ok: false, reason: refusal } : { ok: true, contentType: type.contentType };
}

/** UTF-8 text without control characters (tab, line breaks and form feed allowed), and not markup in disguise. */
function checkText(data: Buffer): Refusal | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return 'not-text';
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return 'not-text';
  // An SVG or HTML file renamed .txt or .csv: served as text it would be harmless, but it is not what the list allows.
  if (/^\s*</.test(text)) return 'content-mismatch';
  return null;
}

// --- Zips (OOXML and OpenDocument) ---

const MAX_ENTRIES = 20_000;
const MAX_PART = 1024 * 1024;

/** Entry names that mean macros or embedded programs, in either format. */
const MACRO_NAMES = [
  /(^|\/)vba[^/]*$/i, // vbaProject.bin, vbaData.xml, vbaProjectSignature.bin
  /(^|\/)activex\//i,
  /(^|\/)macrosheets\//i,
  /(^|\/)(basic|scripts)\//i, // OpenDocument: Basic/, Scripts/python/…
  /(^|\/)(attachedtoolbars|keymapcustomizations)\.(bin|xml)$/i,
  /\.(docm|dotm|xlsm|xltm|xlam|xlsb|pptm|potm|ppam|ppsm|sldm|doc|dot|xls|xlt|xla|ppt|pot|pps)$/i, // embedded files that may hold macros
  /\.(exe|dll|com|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|hta|msi|jar|lnk)$/i,
];
/** Binary parts are OLE objects or VBA, except printer settings. */
const isMacroName = (name: string) =>
  MACRO_NAMES.some((re) => re.test(name)) || (/\.bin$/i.test(name) && !/(^|\/)printerSettings\/printerSettings\d*\.bin$/i.test(name));
/** Content types that mean macros or OLE objects. */
const MACRO_TYPES = /macroenabled|vbaproject|vbadata|macrosheet|activex|oleobject|ms-office\.vba|keymapcustomizations|attachedtoolbars/i;

interface Zip {
  names: string[];
  parts: Map<string, Buffer>;
}

/** The entry names of a zip, and the content of the `wanted` entries (up to MAX_PART each); null if it can't be read. */
async function readZip(data: Buffer, wanted: string[]): Promise<Zip | null> {
  if (!startsWith(data, 0x50, 0x4b, 0x03, 0x04)) return null;
  try {
    const zip = await yauzl.fromBufferPromise(data, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
    const names: string[] = [];
    const parts = new Map<string, Buffer>();
    try {
      for await (const entry of zip.eachEntry()) {
        if (names.length >= MAX_ENTRIES || entry.isEncrypted()) return null;
        names.push(entry.fileName);
        if (wanted.includes(entry.fileName)) {
          if (entry.uncompressedSize > MAX_PART) return null;
          const chunks: Buffer[] = [];
          for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
          parts.set(entry.fileName, Buffer.concat(chunks));
        }
      }
    } finally {
      zip.close();
    }
    return { names, parts };
  } catch {
    return null;
  }
}

/** Office Open XML: the main part of the type, and no macro parts or types. */
async function checkOoxml(data: Buffer, main: string): Promise<Refusal | null> {
  const zip = await readZip(data, ['[Content_Types].xml']);
  const types = zip?.parts.get('[Content_Types].xml')?.toString('utf8');
  if (!zip || !types) return 'content-mismatch';
  if (zip.names.some(isMacroName) || MACRO_TYPES.test(types)) return 'macro';
  // The main part: an Override with the type's main content type, naming a part that is in the zip.
  const overrides = [...types.matchAll(/<Override\b([^>]*)>/g)].map(([, attrs = '']) => ({
    part: attrs.match(/PartName\s*=\s*["']([^"']*)["']/)?.[1] ?? '',
    type: attrs.match(/ContentType\s*=\s*["']([^"']*)["']/)?.[1] ?? '',
  }));
  const found = overrides.some((o) => o.type.toLowerCase() === main && zip.names.includes(o.part.replace(/^\//, '')));
  return found ? null : 'content-mismatch';
}

/** OpenDocument: a stored `mimetype` first entry with the type, and no Basic or scripts. */
async function checkOdf(data: Buffer, contentType: string): Promise<Refusal | null> {
  // The format's own signature: the first local header is `mimetype`, stored, followed by the type.
  const nameLength = data.length >= 30 ? data.readUInt16LE(26) : 0;
  const extraLength = data.length >= 30 ? data.readUInt16LE(28) : 0;
  const stored = data.length >= 30 && data.readUInt16LE(8) === 0;
  if (!stored || nameLength !== 8 || !ascii(data, 30, 'mimetype') || !ascii(data, 30 + 8 + extraLength, contentType)) {
    return 'content-mismatch';
  }
  const zip = await readZip(data, ['mimetype', 'META-INF/manifest.xml']);
  if (!zip || zip.names[0] !== 'mimetype' || zip.parts.get('mimetype')?.toString('latin1') !== contentType) return 'content-mismatch';
  if (!zip.parts.has('META-INF/manifest.xml')) return 'content-mismatch';
  return zip.names.some(isMacroName) ? 'macro' : null;
}
