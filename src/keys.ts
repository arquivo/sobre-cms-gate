// Server-chosen keys: `<prefix>YYYY/MM/<slug>.<ext>`, the slug from the file name (lowercase ASCII letters, digits
// and hyphens), with `-2`, `-3`, … when the key is taken.

const MAX_SLUG = 80;

/** The base name and lowercase extension of an uploaded file's name (any client-side path is dropped). */
export function splitName(filename: string): { base: string; ext: string } | null {
  const name = filename.split(/[/\\]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

/** `Relatório Anual (2025)` → `relatorio-anual-2025`; `file` when nothing is left. */
export function slugify(base: string): string {
  const slug = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, '');
  return slug || 'file';
}

/** The n-th candidate key (n = 1 has no suffix), dated in UTC. */
export function candidateKey(prefix: string, date: Date, slug: string, ext: string, n: number): string {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}${yyyy}/${mm}/${slug}${n > 1 ? `-${n}` : ''}.${ext}`;
}
