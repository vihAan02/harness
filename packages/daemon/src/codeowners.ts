// Who must review a change (AGENTS.md's review rules, encoded in .github/CODEOWNERS): the owners of each changed path,
// from the last matching line, as GitHub reads it. Used to say in a task's PR who needs to review it, and by the
// integration reservation's review gate (D-115). The file is read at the base commit, never from the PR's head, so a
// PR can't rewrite who reviews it.
import { git } from './git.ts';

type Rule = { pattern: RegExp; owners: string[] };

/** A CODEOWNERS pattern (gitignore-like) as a regular expression over a repo-relative path. */
export function patternToRegExp(p: string): RegExp {
  const anchored = p.startsWith('/');
  const dir = p.endsWith('/');
  const body = p.replace(/^\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '*' && body[i + 1] === '*') { re += '.*'; i++; if (body[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored || body.includes('/') ? '^' : '^(?:.*/)?';
  // A directory pattern (or a plain name) also covers everything under it.
  return new RegExp(`${prefix}${re}${dir ? '/.*' : '(?:/.*)?'}$`);
}

export function parseCodeowners(text: string): Rule[] {
  return text.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean).flatMap((l) => {
    const [pattern, ...owners] = l.split(/\s+/);
    return pattern ? [{ pattern: patternToRegExp(pattern), owners: owners.filter((o) => o.startsWith('@')).map((o) => o.slice(1)) }] : [];
  });
}

/** The owners (GitHub logins) of each path: the last matching rule wins, as on GitHub. */
export function ownersOf(rules: Rule[], paths: string[]): Map<string, string[]> {
  return new Map(paths.map((p) => [p, rules.filter((r) => r.pattern.test(p)).at(-1)?.owners ?? []]));
}

/** CODEOWNERS at a commit (.github/, then the root, then docs/), parsed; empty if there's none. */
export async function codeownersAt(repo: string, commit: string): Promise<Rule[]> {
  for (const f of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const text = await git(repo, 'show', `${commit}:${f}`).catch(() => null);
    if (text !== null) return parseCodeowners(text);
  }
  return [];
}

/** The reviewers a change needs: every owner of a changed path, except its author. */
export function requiredReviewers(rules: Rule[], paths: string[], author: string | null): string[] {
  const all = new Set([...ownersOf(rules, paths).values()].flat());
  if (author) all.delete(author);
  return [...all].sort();
}
