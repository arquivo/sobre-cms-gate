// What may be uploaded: the extension must be on the list, and the content must match it. The `Content-Type` written
// to the bucket comes from this table, never from the client. Office files are opened as zips: they must have the
// parts of their type and no macros (VBA, Excel 4.0 macro sheets, ActiveX, OLE objects, Basic or scripts in
// OpenDocument), whatever the extension says: not in their part names, content types, relationships or manifest.
// Their entry names must read the same in every zip reader, and the XML read must be plain (UTF-8, no character or
// entity references beyond the predefined five). Anything else (SVG, HTML, XML, scripts, executables, archives,
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
/** All the parts read from one file, together. */
const MAX_READ = 16 * MAX_PART;

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
/** OOXML relationship types (the end of the URI) that bring in macros, controls, add-ins or embedded documents. */
const MACRO_RELATIONSHIPS =
  /\/(vbaProject|vbaProjectSignature\w*|wordVbaData|oleObject|activeXControl|activeXControlBinary|control|package|attachedTemplate|subDocument|aFChunk|xlMacrosheet|xlIntlMacrosheet|dialogsheet|keyMapCustomizations|attachedToolbars|extensibility|userCustomization|webextension|webextensiontaskpanes)$/i;
/** OpenDocument manifest media types for scripts, besides MACRO_TYPES. */
const ODF_MACRO_TYPES = /basic|script|python|java/i;

interface Zip {
  names: string[];
  parts: Map<string, Buffer>;
}

/** A name with its percent-encoded letters, digits, marks and slashes decoded, as office readers may compare it. */
const decodeName = (name: string) =>
  name.replace(/%[0-9a-f]{2}/gi, (m) => {
    const c = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[\w.~/\\-]/.test(c) ? c : m;
  });

/** Whether an entry's name reads the same in every reader: the central name decodes to its raw bytes (UTF-8 if
 * flagged, else ASCII), there is no Unicode path field (0x7075), no encoded name characters, and the local header has
 * the same name. */
function plainName(data: Buffer, entry: yauzl.Entry): boolean {
  const raw = entry.fileNameRaw;
  const utf8 = (entry.generalPurposeBitFlag & 0x800) !== 0;
  let name: string;
  try {
    name = utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw.toString('latin1');
  } catch {
    return false;
  }
  if (name !== entry.fileName || /[\u0000-\u001f\u007f]/.test(name) || (!utf8 && /[^\x20-\x7e]/.test(name))) return false;
  if (entry.extraFields.some((f) => f.id === 0x7075) || decodeName(name) !== name) return false;
  const at = entry.relativeOffsetOfLocalHeader;
  if (at + 30 > data.length || data.readUInt32LE(at) !== 0x04034b50) return false;
  const local = data.subarray(at + 30, at + 30 + data.readUInt16LE(at + 26));
  return local.equals(raw) && (data.readUInt16LE(at + 6) & 0x800) === (entry.generalPurposeBitFlag & 0x800);
}

/** The end of central directory record, if there is one, it ends the file, and it gives the directory alone: no
 * ZIP64 (never needed under the size limit), one disk, and the directory right before it. Zip readers that find
 * the directory in other ways then all find the same one. */
function endRecord(data: Buffer): { entries: number; size: number } | null {
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--) {
    if (data.readUInt32LE(at) !== 0x06054b50 || at + 22 + data.readUInt16LE(at + 20) !== data.length) continue;
    const [disk, startDisk, onDisk, entries] = [4, 6, 8, 10].map((o) => data.readUInt16LE(at + o)) as [number, number, number, number];
    const size = data.readUInt32LE(at + 12);
    const offset = data.readUInt32LE(at + 16);
    const zip64 = at >= 20 && data.readUInt32LE(at - 20) === 0x07064b50;
    if (zip64 || disk !== 0 || startDisk !== 0 || onDisk !== entries || entries === 0xffff || offset + size !== at) return null;
    return { entries, size };
  }
  return null;
}

/** The entry names of a zip, and the content of the `wanted` entries (up to MAX_PART each, MAX_READ in all); null if
 * it can't be read, or if its names are ambiguous (see plainName, and no two names that differ only in case). */
async function readZip(data: Buffer, wanted: (name: string) => boolean): Promise<Zip | null> {
  if (!startsWith(data, 0x50, 0x4b, 0x03, 0x04)) return null;
  const end = endRecord(data);
  if (!end) return null;
  try {
    const zip = await yauzl.fromBufferPromise(data, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
    const names: string[] = [];
    const seen = new Set<string>();
    const parts = new Map<string, Buffer>();
    let read = 0;
    let directory = 0;
    try {
      for await (const entry of zip.eachEntry()) {
        if (names.length >= MAX_ENTRIES || entry.isEncrypted() || !plainName(data, entry)) return null;
        directory += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
        const folded = entry.fileName.toLowerCase();
        if (seen.has(folded)) return null;
        seen.add(folded);
        names.push(entry.fileName);
        if (wanted(entry.fileName)) {
          read += entry.uncompressedSize;
          if (entry.uncompressedSize > MAX_PART || read > MAX_READ) return null;
          const chunks: Buffer[] = [];
          for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
          parts.set(entry.fileName, Buffer.concat(chunks));
        }
      }
    } finally {
      zip.close();
    }
    return names.length === end.entries && directory === end.size ? { names, parts } : null;
  } catch {
    return null;
  }
}

/** An XML part as text; null if it could mean more than it shows: not UTF-8, another encoding declared, a NUL, a
 * DTD with declarations of its own (or any DTD, unless `doctype`), or a reference other than the five predefined
 * entities (`&#…;` or another name). */
function xmlText(part: Buffer | undefined, doctype = true): string | null {
  if (!part) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(part);
  } catch {
    return null;
  }
  if (/\u0000|<!ENTITY|&(?!(?:lt|gt|amp|quot|apos);)/.test(text)) return null;
  if (doctype ? /<!DOCTYPE(?:[^>"'[]|"[^"]*"|'[^']*')*\[/.test(text) : text.includes('<!DOCTYPE')) return null;
  const encoding = text.match(/^<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']*)["']/)?.[1];
  return encoding === undefined || /^utf-8$/i.test(encoding) ? text : null;
}

/** The attributes of each `name` element (with any namespace prefix, non-ASCII ones too), as [name, value] pairs. */
const elements = (xml: string, name: string): [string, string][][] =>
  [...xml.matchAll(new RegExp(`<(?:[^\\s<>/:="'!?]+:)?${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'g'))].map(([, attrs = '']) =>
    [...attrs.matchAll(/(?:^|\s)([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, k = '', a, b]) => [k, (a ?? b ?? '').trim()]),
  );
/** Every attribute value in a part, whatever element it is on: a second look that doesn't depend on reading the
 * elements right. */
const allValues = (xml: string) => [...xml.matchAll(/"([^"]*)"|'([^']*)'/g)].map(([, a, b]) => (a ?? b ?? '').trim());
/** The values of the attributes with this local name, whatever their prefix: all of them, if it is repeated. */
const values = (attrs: [string, string][], local: string) => attrs.filter(([k]) => k === local || k.endsWith(`:${local}`)).map(([, v]) => v);

/** Office Open XML: the main part of the type, and no macro parts, types or relationships. */
async function checkOoxml(data: Buffer, main: string): Promise<Refusal | null> {
  const zip = await readZip(data, (name) => name === '[Content_Types].xml' || /\.rels$/i.test(name));
  // Office Open XML allows no DTD in its parts (ISO/IEC 29500-2).
  const types = xmlText(zip?.parts.get('[Content_Types].xml'), false);
  if (!zip || types === null) return 'content-mismatch';
  if (zip.names.some(isMacroName) || MACRO_TYPES.test(types)) return 'macro';
  for (const [name, part] of zip.parts) {
    if (name === '[Content_Types].xml') continue;
    const rels = xmlText(part, false);
    if (rels === null) return 'content-mismatch';
    // Any macro relationship type in the part, and as many external targets as the relationships read show.
    const all = allValues(rels);
    if (all.some((v) => MACRO_RELATIONSHIPS.test(v))) return 'macro';
    const parsed = elements(rels, 'Relationship');
    const externals = parsed.filter((rel) => values(rel, 'TargetMode').some((m) => m.toLowerCase() === 'external')).length;
    if (all.filter((v) => v.toLowerCase() === 'external').length !== externals) return 'macro';
    // A link to a web page is fine; any other external target (a template, an image, a linked file) is not.
    for (const rel of parsed) {
      const types = values(rel, 'Type');
      if (types.some((t) => MACRO_RELATIONSHIPS.test(t))) return 'macro';
      const external = values(rel, 'TargetMode').some((m) => m.toLowerCase() === 'external');
      if (external && (types.length === 0 || !types.every((t) => /\/hyperlink$/i.test(t)))) return 'macro';
    }
  }
  // The main part: an Override with the type's main content type, naming a part that is in the zip.
  const found = elements(types, 'Override').some(
    (o) => values(o, 'ContentType').some((t) => t.toLowerCase() === main) && values(o, 'PartName').some((p) => zip.names.includes(p.replace(/^\//, ''))),
  );
  return found ? null : 'content-mismatch';
}

/** OpenDocument: a stored `mimetype` first entry with the type, and no Basic, scripts or OLE objects. */
async function checkOdf(data: Buffer, contentType: string): Promise<Refusal | null> {
  // The format's own signature: the first local header is `mimetype`, stored, followed by the type.
  const nameLength = data.length >= 30 ? data.readUInt16LE(26) : 0;
  const extraLength = data.length >= 30 ? data.readUInt16LE(28) : 0;
  const stored = data.length >= 30 && data.readUInt16LE(8) === 0;
  if (!stored || nameLength !== 8 || !ascii(data, 30, 'mimetype') || !ascii(data, 30 + 8 + extraLength, contentType)) {
    return 'content-mismatch';
  }
  const zip = await readZip(data, (name) => name === 'mimetype' || name === 'META-INF/manifest.xml');
  if (!zip || zip.names[0] !== 'mimetype' || zip.parts.get('mimetype')?.toString('latin1') !== contentType) return 'content-mismatch';
  const manifest = xmlText(zip.parts.get('META-INF/manifest.xml'));
  if (manifest === null) return 'content-mismatch';
  // The manifest says what each entry is: an OLE object or a script library is refused whatever its name.
  const entries = elements(manifest, 'file-entry');
  const paths = entries.flatMap((e) => values(e, 'full-path'));
  const types = entries.flatMap((e) => values(e, 'media-type'));
  const macro = paths.some(isMacroName) || types.some((t) => MACRO_TYPES.test(t) || ODF_MACRO_TYPES.test(t))
    || allValues(manifest).some((v) => MACRO_TYPES.test(v));
  return macro || zip.names.some(isMacroName) ? 'macro' : null;
}
