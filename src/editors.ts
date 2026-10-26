// Who may use the CMS: the token must be a user token of this App, and its GitHub user an active member of the
// editors' team. A token of another App or OAuth app is refused as invalid, whoever it belongs to. A positive answer is
// cached for a few minutes by the token's hash; a refusal is not cached, so a newly added editor gets in at once.
// The token of a non-member is revoked. A token that isn't shaped like a GitHub App user token is refused before
// GitHub is asked, so made-up tokens don't spend the App's rate limit.
import { tokenHash, type GitHub } from './github.ts';

export type Verdict = { ok: true; login: string } | { ok: false; reason: 'invalid-token' | 'not-member'; login?: string };

const MAX_ENTRIES = 1000;
/** A GitHub App user access token. */
const USER_TOKEN = /^ghu_[A-Za-z0-9_]{20,255}$/;

export class Editors {
  readonly #github: GitHub;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, { login: string; expires: number }>();

  constructor(github: GitHub, ttlSeconds: number) {
    this.#github = github;
    this.#ttlMs = ttlSeconds * 1000;
  }

  /** The verdict for a token; `revoked` says whether a non-member's token was revoked. */
  async check(token: string): Promise<Verdict & { revoked?: boolean }> {
    if (!USER_TOKEN.test(token)) return { ok: false, reason: 'invalid-token' };
    const hash = tokenHash(token);
    const cached = this.#cache.get(hash);
    if (cached && cached.expires > Date.now()) return { ok: true, login: cached.login };
    this.#cache.delete(hash);

    const user = await this.#github.tokenUser(token);
    if (!user) return { ok: false, reason: 'invalid-token' };
    if (!(await this.#github.isTeamMember(user.login))) {
      return { ok: false, reason: 'not-member', login: user.login, revoked: await this.#github.revoke(token) };
    }
    if (this.#ttlMs > 0) {
      if (this.#cache.size >= MAX_ENTRIES) this.#cache.delete(this.#cache.keys().next().value as string);
      this.#cache.set(hash, { login: user.login, expires: Date.now() + this.#ttlMs });
    }
    return { ok: true, login: user.login };
  }
}
