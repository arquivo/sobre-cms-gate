# sobre-cms-gate

cms-gate is the only backend of the sobre.arquivo.pt CMS. The site is a static Astro site
([arquivo/static-sobre](https://github.com/arquivo/static-sobre)) edited with Decap CMS 3.17.1, and cms-gate does two
things for it:

- **Sign-in.** It runs the GitHub App web flow for Decap's GitHub backend, and gives the token only to members of the
  team `arquivo/sobre-editors`.
- **Uploads.** It receives files from the media library, checks them, and writes them to the Ceph RGW bucket
  `sobre-media` under `media/`, where the site serves them at `/media/...`.

It listens on 127.0.0.1, behind Caddy, on the CMS host (`<cms-host>`), which is reachable only from the VPN and the
office network. The design is `docs/decisions/cms-gate.md` in static-sobre (decisions D7, D13, D15 and D16 of its
`docs/plan.md`); this README lists where the code differs from it.

```text
editor (VPN / office) ──https──▶ Caddy, <cms-host>   (remote_ip allowlist)
                                   ├─ /admin/, its assets  → the staging release
                                   └─ /cms-api/*           → cms-gate on 127.0.0.1:8787
cms-gate ──https──▶ github.com, api.github.com        (sign-in, token and team checks)
cms-gate ──https──▶ RGW, bucket sobre-media, media/    (uploads, list)
Decap (browser) ──https──▶ api.github.com              (commits, with the editor's own token)
```

Nothing calls cms-gate from outside the allowlist: the App's webhooks are off, and GitHub's redirect after sign-in goes
through the editor's browser. cms-gate keeps no session and no database.

## Endpoints

| Method | Path | What |
| --- | --- | --- |
| GET, HEAD | `/cms-api/health` | `{"status":"ok"}`. It reaches neither GitHub nor the bucket and holds no configuration. Not rate limited, and not logged when it answers 200. |
| GET | `/cms-api/auth` | Decap opens it in a popup (`?provider=github&site_id=…`). Sets the state cookie and redirects to GitHub. |
| GET | `/cms-api/callback` | GitHub's redirect. Checks the state, exchanges the code, checks the team, and posts the result to the CMS window. |
| GET | `/cms-api/media` | Lists the uploads, for the media library. |
| POST | `/cms-api/media` | Uploads one file. |

Any other path answers 404, and a known path with another method answers 405 with `Allow`. Every answer is
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, with a CSP: `default-src 'none'` for JSON, and
for the two sign-in pages only their own inline script and style, by hash.

### Sign-in

1. `/cms-api/auth` sets a random state in the cookie `__Host-cms-gate-state` (`Secure`, `HttpOnly`,
   `SameSite=Lax`, 10 minutes) and redirects to `https://github.com/login/oauth/authorize` with the App's client id,
   the callback URL, the state and `allow_signup=false`.
2. `/cms-api/callback` clears the cookie, compares it with `state` (in constant time), and exchanges the code for a
   user token with the client secret. The refresh token is dropped.
3. It reads the user (`GET /user`) and, with an installation token made from the App's private key, checks
   `GET /orgs/<org>/teams/<team>/memberships/<login>`: the state must be `active`.
4. A member gets a page that runs Decap's handshake: it posts `authorizing:github` to `window.opener`, waits for the
   opener's answer from the CMS origin, and posts `authorization:github:success:{"token":…,"provider":"github"}`,
   always with the CMS origin as the target. Anyone else gets a page in Portuguese that posts
   `authorization:github:error:{"message":…}`, with no token, and a non-member's token is revoked. Any failure,
   GitHub's or an unexpected one, ends on that page too.

### Media API

Both media requests need `Authorization: Bearer <the editor's GitHub token>`, the one Decap holds. cms-gate checks
the token and the team on each request; a member's answer is cached for `TEAM_CACHE_SECONDS` by the token's SHA-256,
and a refusal is not cached. A POST must carry `Origin: <CMS_ORIGIN>`; a GET with an `Origin` must have that one; a
`Sec-Fetch-Site` other than `same-origin` is refused.

**Upload.** `POST /cms-api/media`, `multipart/form-data` with exactly one field, `file`, holding the file. The answer
is `201`:

```json
{
  "path": "/media/2026/05/relatorio-anual-2025.pdf",
  "name": "relatorio-anual-2025.pdf",
  "size": 182044,
  "contentType": "application/pdf",
  "sha256": "…"
}
```

`path` is the public path Decap writes into the content. The key is `media/YYYY/MM/<slug>.<ext>` (UTC date), the slug
made from the file name (lowercase ASCII letters, digits and hyphens: `Relatório Anual (2025).PDF` becomes
`relatorio-anual-2025.pdf`). If the key exists, `-2`, `-3`, … are tried, up to 100. A file is never overwritten,
and nothing is ever deleted.

| Kind | Extensions | `Content-Type` written | Content check |
| --- | --- | --- | --- |
| Images | jpg, jpeg, png, gif, webp | `image/jpeg`, `image/png`, `image/gif`, `image/webp` | magic bytes |
| Documents | pdf | `application/pdf` | magic bytes |
| Office | docx, xlsx, pptx | the OOXML types | a zip with `[Content_Types].xml` declaring the right main part; no macros |
| OpenDocument | odt, ods, odp | the ODF types | a zip whose first entry is the stored `mimetype` with the right type; no macros |
| Text | csv, txt | `text/csv; charset=utf-8`, `text/plain; charset=utf-8` | valid UTF-8, no NUL, not starting with `<` |

Refused: anything else (SVG, HTML, XML, scripts, executables, archives…), names without an extension (only the last
one counts: `foto.jpg.html` is HTML, and `x.html.pdf` is checked as a PDF and stored as `x-html.pdf`), and office files with macros or embedded content in any name: `vbaProject.bin`,
macro-enabled content types (xlsm, docm, pptm, also renamed), Excel 4 macro sheets, ActiveX controls, OLE objects,
embedded office files, and ODF `Basic/` or `Scripts/`. The client's `Content-Type` is ignored.

**List.** `GET /cms-api/media?limit=100&cursor=…` (`limit` 1 to 1000, default 100):

```json
{
  "files": [
    { "path": "/media/2026/05/relatorio-anual-2025.pdf", "name": "relatorio-anual-2025.pdf", "size": 182044, "lastModified": "2026-05-15T10:00:00.000Z" }
  ],
  "cursor": null
}
```

When `cursor` is not null, pass it back to get the next page. Only keys under `S3_PREFIX` are listed.

**Errors** are JSON, `{"error": "<code>", "message": "<text in Portuguese for the editor>"}`:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `bad-request`, `bad-form` | bad query; a form that is not one `file` field |
| 401 | `invalid-token` | missing, invalid or expired token (`WWW-Authenticate: Bearer`) |
| 403 | `not-member`, `bad-origin` | not in the team (the token is revoked); wrong `Origin` or `Sec-Fetch-Site` |
| 404, 405 | `not-found`, `method-not-allowed` | |
| 409 | `no-free-name` | 100 files with that name this month |
| 413 | `too-large` | over `MAX_UPLOAD_BYTES` |
| 415 | `type-not-allowed`, `unsupported-media-type` | extension not on the list; body not multipart |
| 422 | `content-mismatch`, `macro`, `not-text`, `empty` | the content check failed |
| 429 | `rate-limited` | with `Retry-After` |
| 502 | `github-unavailable`, `storage-unavailable` | GitHub or the RGW failed, or GitHub's answer was not the JSON expected |
| 503 | `busy` | four uploads already running (`Retry-After: 5`) |

### Logs

One JSON line per event on stdout, for `docker logs` or journald: `listening`, `request` (method, known path or `-`,
status, ms), `sign-in` (result, login, whether a token was revoked), `upload` (`created` with login, key, size and
SHA-256; or `refused` with the reason, login, extension and size), `rate-limited`, `refused` and `error`. Logs never
hold tokens, codes, cookies, query strings, the original file names, file contents, or secrets (a created file's key
holds its slug). The tests check this.

## Configuration

Environment variables only. Secrets are read only from files named by `*_FILE` variables (Docker secrets); setting a
secret directly (`GITHUB_CLIENT_SECRET=…`) is refused. cms-gate checks everything before it listens and exits with
the list of problems if anything is missing or inconsistent. `.env.example` has every variable with placeholders.

| Variable | Default | |
| --- | --- | --- |
| `GITHUB_APP_ID` | required | The App's id (digits). |
| `GITHUB_CLIENT_ID` | required | The App's client id. |
| `GITHUB_INSTALLATION_ID` | required | The App's installation on the org (digits; in the installation's settings URL). |
| `GITHUB_CLIENT_SECRET_FILE` | required | File with the App's client secret. |
| `GITHUB_PRIVATE_KEY_FILE` | required | File with the App's private key (PEM, RSA). |
| `GITHUB_ORG` | required | `arquivo` |
| `GITHUB_TEAM` | required | The team's slug: `sobre-editors` |
| `CMS_ORIGIN` | required | The CMS's origin, `https://<cms-host>`: no path, no trailing slash. The only `postMessage` target and the only `Origin` accepted; the callback is `<CMS_ORIGIN>/cms-api/callback`. |
| `S3_ENDPOINT` | required | The RGW's base URL, `https://<rgw-host>` (path-style requests). |
| `S3_REGION` | `us-east-1` | The signing region the RGW expects. |
| `S3_BUCKET` | required | `sobre-media` |
| `S3_PREFIX` | required | `media/` (must end with `/`) |
| `S3_ACCESS_KEY_ID_FILE` | required | File with the `sobre-cms-gate` access key id. |
| `S3_SECRET_ACCESS_KEY_FILE` | required | File with its secret key. |
| `S3_CA_FILE` | none | PEM bundle for an RGW certificate signed by a private CA (it replaces the system CAs). |
| `LISTEN_HOST` | `127.0.0.1` | The image sets `0.0.0.0`, for the container's port published on 127.0.0.1. Any non-loopback address logs a warning. |
| `LISTEN_PORT` | `8787` | |
| `TRUST_PROXY` | `true` | Take the client address, for the rate limits, from the last `X-Forwarded-For` entry (Caddy's). |
| `MAX_UPLOAD_BYTES` | `52428800` (50 MiB) | Keep Caddy's `max_size` a little above it. |
| `RATE_SIGNINS_PER_MINUTE` | `10` | Per client address. |
| `RATE_REQUESTS_PER_MINUTE` | `120` | Per client address, all routes but health. |
| `RATE_UPLOADS_PER_HOUR` | `100` | Per GitHub login. |
| `RATE_UPLOAD_BYTES_PER_HOUR` | `1073741824` (1 GiB) | Per GitHub login; not below `MAX_UPLOAD_BYTES`. |
| `TEAM_CACHE_SECONDS` | `300` | How long a member's token is trusted before the team is checked again (0 to check every time). |

`GITHUB_URL` and `GITHUB_API_URL` (default `https://github.com` and `https://api.github.com`) exist for the tests'
stub; leave them unset.

## Running it

### With Compose (the deployment)

The image is `arquivo/sobre-cms-gate` on Docker Hub. On the CMS host:

```sh
cp .env.example .env              # fill in the placeholders
mkdir -m 700 secrets              # the four files named in docker-compose.yml, readable by uid 1000
docker compose up -d
docker compose logs -f
```

`docker-compose.yml` publishes the port on `127.0.0.1:8787` only and runs the container read-only, with no
capabilities, `no-new-privileges`, a 1 GiB memory limit and log rotation. The image runs as `node` (uid 1000), has no
npm, and has a `HEALTHCHECK` on `/cms-api/health`.

To update: `docker compose pull && docker compose up -d`. Pin a `sha-…` tag instead of `latest` if you want to choose
when to update.

### Behind Caddy

In the CMS vhost, inside its `remote_ip` allowlist (static-sobre's step 4.7a/4.7b):

```caddyfile
handle /cms-api/* {
	request_body {
		max_size 51MiB
	}
	reverse_proxy 127.0.0.1:8787
}
```

`max_size` must be a little above `MAX_UPLOAD_BYTES` (the multipart wrapping adds a few hundred bytes); cms-gate
refuses anything over `MAX_UPLOAD_BYTES` plus 64 KiB itself. Caddy sets `X-Forwarded-For` to the client address (it
ignores the client's own header unless the client is in `trusted_proxies`), and cms-gate takes the last entry. The
production and staging vhosts answer 404 for `/cms-api/`. Caddy should not add its own CSP or caching headers to
`/cms-api/*`: cms-gate sets them.

### Decap (static-sobre's `src/lib/cms.ts`)

Not changed here; this is what static-sobre needs (steps 5.2 and 5.3):

```ts
backend: {
  name: 'github',
  repo: 'arquivo/static-sobre',
  branch: 'main',
  base_url: 'https://<cms-host>',   // exactly CMS_ORIGIN
  auth_endpoint: 'cms-api/auth',
  // commit_messages as today
},
```

Decap opens `<base_url>/<auth_endpoint>` in a popup and accepts the message only from `base_url`'s origin, so
`base_url` must be the CMS origin itself. Leave `auth_scope` unset: an App's user token has the App's permissions, not
scopes. Decap 3.17.1's GitHub backend can't refresh tokens, so editors sign in again after 8 hours.

For uploads, the media library (`src/scripts/admin.ts`) calls the media API above from the CMS page, with
`fetch('/cms-api/media', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: formData })` (the
browser adds `Origin`), and lists with `GET /cms-api/media`. The token is the one Decap keeps for the GitHub backend.
`public_folder` becomes `/media`, and the returned `path` is what goes into the content.

## The GitHub App

To do by an org owner (static-sobre's step 5.2b); cms-gate never changes the App or the team.

- [ ] Create the App under the `arquivo` organisation (Settings → Developer settings → GitHub Apps), e.g.
      `arquivo-sobre-cms`, with:
  - Homepage URL: `https://<cms-host>/admin/`
  - Callback URL: `https://<cms-host>/cms-api/callback`
  - **Expire user authorization tokens**: on (8 hours)
  - Request user authorization during installation: off; Device flow: off
  - Webhook: **off** (no URL, no secret)
  - Repository permissions: **Contents: read and write**, Metadata: read. Pull requests: read and write only if
    Decap's editorial workflow is turned on. Nothing else (no Workflows, Actions, Administration, Secrets).
  - Organisation permissions: **Members: read**
  - Where can it be installed: only on this account
- [ ] Install it on the org, for **`arquivo/static-sobre` only**. The installation id is the number at the end of the
      installation's settings URL.
- [ ] Generate a client secret and a private key. Keep both in the team vault and on the CMS host
      (`secrets/github-client-secret`, `secrets/github-app.private-key.pem`), nowhere else.
- [ ] Create the team `arquivo/sobre-editors`, give it **Write** on `static-sobre`, add the editors, and require 2FA in
      the org.
- [ ] Put the App id, client id and installation id in `.env`.

An editor's token can do only what both the App and the editor may do: here, read and write `static-sobre`'s
contents. The S3 key (`sobre-cms-gate`) is the one in static-sobre's `docs/runbooks/ceph-buckets.md`: PutObject,
GetObject and AbortMultipartUpload on `sobre-media/media/*`, ListBucket with prefix `media/`, no delete.

## Threat model

| Threat | What stops it |
| --- | --- |
| Someone outside the VPN or office reaches the CMS | Caddy's `remote_ip` allowlist (and the firewall); cms-gate listens on 127.0.0.1 only. |
| A GitHub user who is not an editor signs in | The team check at sign-in, with the App's own installation token; the token is revoked and never sent to the browser. |
| An ex-editor keeps using an old token | The team check on each upload and list (cached 5 minutes at most); the token is revoked once the check fails; tokens expire after 8 hours. |
| Login CSRF, or a forged callback | The state cookie (`__Host-`, `HttpOnly`, 10 minutes), compared in constant time and cleared on every callback. |
| The token is posted to another window | `postMessage` targets only `CMS_ORIGIN`, after a handshake from the opener at that origin; the popup's CSP allows only its own script. |
| Another site drives the media API from an editor's browser | The API needs a bearer token (no cookies); `Origin` must be the CMS origin on POST; `Sec-Fetch-Site` must be same-origin. |
| A file that runs as a page, or a script, on the site's origin | An extension list without SVG, HTML or XML; the content must match the extension; text must not start with `<`; cms-gate sets the `Content-Type` itself; the media vhost sends `nosniff` and a sandbox CSP. |
| An office file with macros | Refused by content (not by name): VBA, macro content types, macro sheets, ActiveX, OLE and embedded office files, ODF scripts. |
| Overwriting or deleting a published file | Keys chosen by the server; `If-None-Match: *` on each write; no delete call exists, and the S3 key can't delete; the bucket is versioned. |
| Path tricks in names | The name is reduced to a slug; the key is always `<prefix>YYYY/MM/<slug>.<ext>`. |
| Floods and large bodies | Rate limits per address and per login; body limit in Caddy and in cms-gate; four uploads at once; request timeouts. |
| Secrets in logs or the image | Secrets from files only, never logged; logs hold no tokens or contents (tested); `.dockerignore` keeps `.env`, `secrets/` and keys out of the build. |
| A compromised dependency | Two production dependencies (aws4, yauzl), pinned, with a lockfile, installed with `--ignore-scripts`; actions pinned by commit. |

Accepted risks, from the spec: an upload is public by URL as soon as it is written, before its page is published
(embargoed documents are not uploaded through the CMS); uploads from staging go to the production bucket; an editor's
own GitHub account can also change code (D15).

## Differences from the spec

- **Its own media API.** Decap's S3 media library is not usable here (it is Turbo-only), so cms-gate exposes the JSON
  API above, for static-sobre's admin page to use as its media library (step 5.3).
- **Editors sign in again after 8 hours.** Decap's GitHub backend has no refresh, so the refresh token is dropped
  rather than kept anywhere.
- **Revocation on upload too.** A token that fails the team check on an upload or list is revoked, not only at
  sign-in.
- **Errors are posted to Decap too**, as `authorization:github:error:…`, so the CMS shows the refusal.
- **Stricter office checks.** OLE objects, embedded office files and ActiveX are refused as well as macros. csv and
  txt starting with `<` are refused, so a text file can't be read as HTML.
- **Overwrite check.** A HEAD that answers 403 is taken as "absent": S3 answers 403 instead of 404 for a missing key
  when the caller's ListBucket doesn't apply, and the key's ListBucket is limited to the prefix `media/`. The real guard
  is `If-None-Match: *` on the PUT, answered 412 or 409 when the key exists. **Check on the RGW** that it honours
  `If-None-Match: *` on PutObject, and how it answers a HEAD on a missing key with this policy.
- **Client address.** The rightmost `X-Forwarded-For` entry is used, because inside the container the peer is the
  Docker bridge, not Caddy's loopback address.
- **No ClamAV scan** (optional in the spec).
- **Memory.** An upload is held in memory while it is checked, about three times its size, with four at most at once:
  hence the 1 GiB limit in Compose.
- **Rate limits are in memory, per process.** A restart resets them; run one instance.

## Development

Node is not needed on the host: `scripts/dev.sh` runs any command in the pinned Node image (the same as the
Dockerfile's), with the repo mounted and the npm cache in `.npm/`.

```sh
scripts/dev.sh npm ci
scripts/dev.sh npm run typecheck
NETWORK=none scripts/dev.sh npm test     # no network: GitHub and S3 are local stubs
scripts/dev.sh npm run build             # dist/
scripts/dev.sh npm audit
docker build -t sobre-cms-gate:local . && scripts/smoke.sh sobre-cms-gate:local
```

The sources are TypeScript run directly by Node's type stripping in development and tests, and compiled to `dist/`
for the image. There is no ESLint: `tsc` runs in strict mode with `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
`erasableSyntaxOnly`, which covers what a linter would catch here without a dozen more dev dependencies.

The tests (`node --test`) start the real server against a stub GitHub (authorize, token, user, team membership,
installation tokens, revoke) and a stub S3 that checks the signatures, all on 127.0.0.1. They cover the state check,
the handshake and the posted origin (the popup's script runs in `node:vm`), a non-member and the revoke, every allowed
type, every refused type (including renamed SVGs and an xlsx with a macro), the size limits, an existing key, the
rate limits, the listing, the configuration checks, the health check holding no secret, and the logs holding no
token or content. `scripts/smoke.sh` runs the built image read-only with dummy secrets.

`npm audit` reports 0 vulnerabilities, for all and for production dependencies.

## CI and the image

- **Test** (`.github/workflows/test.yml`): install, typecheck, tests with no network, build, `npm audit`, and a check
  that the lockfile is unchanged. All in the pinned Node image.
- **Build and Push Docker Images** (`.github/workflows/docker.yml`), as in arquivo/memorial: on pushes to `main`, on
  tags, and on pull requests to `main`. It runs Test first, builds the image, runs the smoke test, and then, except on
  pull requests, pushes `arquivo/sobre-cms-gate` to Docker Hub with the repo secrets `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN`.

| Event | Tags |
| --- | --- |
| push to `main` | `latest`, `main`, `sha-<short>` |
| tag `v1.2.3` | `1.2.3`, `1.2`, `1`, `sha-<short>` |
| pull request | built and smoke-tested, not pushed |

Actions are pinned by commit, and the jobs have read-only permissions.
