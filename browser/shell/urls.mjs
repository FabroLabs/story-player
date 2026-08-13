/**
 * Where the page is, versus where the story is.
 *
 * `?story=build/<stem>/story.json` is written relative to the repository root,
 * but the page that reads it lives one level down in `player/`. Resolving that
 * is a property of how the player is served, not of any bundle version, so it
 * belongs to the shell: the dispatcher needs the URL before it knows which
 * performer will get it. Asset paths are the other half and stay with the
 * performer — bucket keys and the trusted host-supplied base are a version's
 * business (`v0/app/urls.mjs`).
 */
/**
 * `?story=` names a bundle on this origin, and nothing else.
 *
 * The query string is attacker-supplied — it travels in a link — and the whole
 * bundle is interpreted once it is fetched: its validated keys become
 * `video.src`, `new Audio()` sources and CSS backgrounds. Without this check
 * `?story=https://evil.example/story.json` made THIS origin perform a stranger's
 * document. That is not script injection (nothing in `player/` writes
 * `innerHTML` or calls `eval`), which is exactly why it would not have been
 * noticed: the page looks like it is working.
 *
 * Refused, each by name so the reader is told which rule they broke:
 *   - anything carrying a scheme      `https://evil.example/story.json`
 *   - protocol-relative               `//evil.example/story.json`, `\\evil.example/x`
 *   - a relative path that climbs     `../../../etc/passwd`
 * and, as a backstop rather than the argument, a resolved URL that has left the
 * page's origin — which is what catches the shapes no lexical rule sees, such
 * as `/\evil.example/x`, where the parser reads the backslash as a second slash.
 *
 * The climb is detected by RESOLVING, never by looking for ".." in the text.
 * A text search reads only the spelling it was taught: `%2e%2e` and `.%2e` are
 * dot segments to the URL parser and ordinary characters to `String.split`, so
 * a lexical rule refuses `../../x` while accepting `%2e%2e/%2e%2e/x`, which
 * goes to the same place. Resolving against a sentinel directory asks the
 * parser itself — if the answer has left the sentinel, the path climbed,
 * however it was spelled.
 *
 * The sentinel is needed because the obvious comparison does not work: when the
 * player is served FROM the repository root, "the repository root" and "the
 * origin root" are the same directory, so `../../../x` clamps to the root and
 * compares equal to a path that never climbed at all.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SENTINEL = 'never-a-real-directory/';

export function resolveStoryUrl(storyPath, pageUrl) {
  if (!storyPath) return null;

  const refuse = (why) => {
    throw new Error(`refusing ?story=${storyPath} — ${why}`);
  };

  if (SCHEME.test(storyPath)) refuse('a story must be a path on this site, not a full URL');
  // both separators: `new URL` reads a backslash as a slash for http(s), so
  // `\\evil.example/x` names a host exactly as `//evil.example/x` does
  if (/^[/\\]{2}/.test(storyPath)) {
    refuse('a story must be a path on this site, not another host');
  }

  const repositoryRoot = new URL('../', pageUrl);
  const cleaned = storyPath.replace(/^\.\//, '');
  // a path from the site root is already unambiguous and cannot climb anywhere
  // it could not simply have named; only a relative one is asked the question
  if (!cleaned.startsWith('/')) {
    const sentinel = new URL(SENTINEL, repositoryRoot);
    if (!new URL(cleaned, sentinel).pathname.startsWith(sentinel.pathname)) {
      refuse('a story path may not climb above the site');
    }
  }

  const resolved = new URL(cleaned, repositoryRoot);
  if (resolved.origin !== repositoryRoot.origin) refuse('it resolves off this site');
  return resolved.href;
}
