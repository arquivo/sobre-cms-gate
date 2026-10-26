// The pages of the sign-in popup. Each runs one fixed script, allowed by its hash in a strict CSP: it does Decap's
// handshake with `window.opener` and posts the result (the token, or an error without one) to the CMS origin only.
//   popup → opener: "authorizing:github"           (target: the CMS origin)
//   opener → popup: "authorizing:github"           (accepted only from the opener, at the CMS origin)
//   popup → opener: "authorization:github:success:{"token":…,"provider":"github"}"  or  "…:error:{"message":…}"
import { createHash } from 'node:crypto';

const SCRIPT = `(function () {
  var el = document.getElementById('cms-gate');
  var origin = el.getAttribute('data-origin');
  var message = el.getAttribute('data-message');
  el.removeAttribute('data-message');
  var opener = window.opener;
  if (!opener || !origin || !message) return;
  window.addEventListener('message', function (e) {
    if (e.source !== opener || e.origin !== origin || e.data !== 'authorizing:github') return;
    opener.postMessage(message, origin);
  });
  opener.postMessage('authorizing:github', origin);
})();`;

const STYLE = 'body{font:1rem/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}';

const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/** The CSP of the popup pages: nothing but the inline script and style, by hash. */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${hash(SCRIPT)}`,
  `style-src ${hash(STYLE)}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(title: string, text: string, cmsOrigin: string, message: string | null): string {
  const data = message === null ? '' : ` data-message="${escapeHtml(message)}"`;
  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · sobre.arquivo.pt</title>
<style>${STYLE}</style>
</head>
<body>
<main id="cms-gate" data-origin="${escapeHtml(cmsOrigin)}"${data}>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(text)}</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** A member signed in: the token goes to the CMS. */
export const successPage = (cmsOrigin: string, token: string, login: string) =>
  page(
    'Sessão iniciada',
    `Sessão iniciada como ${login}. Esta janela fecha-se sozinha; se não fechar, feche-a e volte ao editor.`,
    cmsOrigin,
    `authorization:github:success:${JSON.stringify({ token, provider: 'github' })}`,
  );

/** No token: the CMS is told why, and the page says it too. */
export const errorPage = (cmsOrigin: string, title: string, text: string) =>
  page(title, text, cmsOrigin, `authorization:github:error:${JSON.stringify({ message: text })}`);

export const MESSAGES = {
  notMember: [
    'Sem acesso',
    'Esta conta GitHub não tem acesso ao editor do sobre.arquivo.pt. Peça acesso a quem gere a equipa de editores.',
  ],
  badState: [
    'Pedido inválido',
    'O pedido de início de sessão expirou ou não é válido. Feche esta janela e tente de novo a partir do editor.',
  ],
  denied: ['Início de sessão cancelado', 'O GitHub não autorizou o início de sessão. Feche esta janela e tente de novo.'],
  github: ['Erro no início de sessão', 'Não foi possível confirmar a conta no GitHub. Tente de novo dentro de momentos.'],
  internal: ['Erro no início de sessão', 'Ocorreu um erro inesperado. Feche esta janela e tente de novo dentro de momentos.'],
  rateLimited: ['Demasiadas tentativas', 'Houve demasiadas tentativas de início de sessão. Aguarde um minuto e tente de novo.'],
  badRequest: ['Pedido inválido', 'Este endereço só é usado pelo editor do sobre.arquivo.pt.'],
} as const satisfies Record<string, readonly [string, string]>;

/** The popup script, for the tests that run it. */
export const POPUP_SCRIPT = SCRIPT;
