/**
 * Minimal glob matcher with no external deps.
 * Supports:
 *   - `*`     matches anything except `/`
 *   - `**`    matches anything including `/`
 *   - `?`     matches a single character except `/`
 *   - bare names without `/` or `*` match against any basename in the path
 *
 * Patterns are matched against POSIX-style relative paths.
 * A pattern matches if it matches the full path OR any path segment.
 */

export class GlobMatcher {
  private regexes: RegExp[] = [];
  private basenames = new Set<string>();

  constructor(patterns: string[]) {
    for (const raw of patterns) {
      const p = raw.trim();
      if (!p) continue;

      // Bare name (no slash, no wildcard) → fast basename match
      if (!p.includes('/') && !p.includes('*') && !p.includes('?')) {
        this.basenames.add(p);
        continue;
      }
      this.regexes.push(globToRegex(p));
    }
  }

  /**
   * Returns true if relPath (or any of its segments) matches an ignore pattern.
   * relPath should be POSIX-style relative (e.g. "src/foo/bar.ts").
   */
  ignores(relPath: string): boolean {
    // basename check against every segment (so "node_modules" matches "src/node_modules/foo")
    if (this.basenames.size > 0) {
      const parts = relPath.split('/');
      for (const seg of parts) {
        if (this.basenames.has(seg)) return true;
      }
    }
    for (const r of this.regexes) {
      if (r.test(relPath)) return true;
    }
    return false;
  }
}

function globToRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** => match anything including /
        re += '.*';
        i += 2;
        // consume optional trailing slash to avoid // in pattern
        if (glob[i] === '/') i++;
        // emit optional / so "**/foo" still matches "foo"
        re += '(?:|/)';
        continue;
      }
      // single * => match anything except /
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    // escape regex specials
    if (/[.+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp('^' + re + '$');
}
