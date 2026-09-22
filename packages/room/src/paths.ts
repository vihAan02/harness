import picomatch from "picomatch";
import type { Hunk } from "@mp/protocol";

const matcherCache = new Map<string, (path: string) => boolean>();

function trimSlashes(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * True if `path` (repo-relative) falls under `pattern`.
 * A pattern without glob characters matches the path itself or anything beneath it,
 * so `src/api` and `src/api/` both cover `src/api/users.ts`.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const pat = trimSlashes(pattern);
  const target = trimSlashes(path);
  if (!picomatch.scan(pat).isGlob) {
    return target === pat || target.startsWith(pat + "/");
  }
  let matcher = matcherCache.get(pat);
  if (!matcher) {
    matcher = picomatch(pat, { dot: true });
    matcherCache.set(pat, matcher);
  }
  return matcher(target);
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchesPattern(p, path));
}

/** The literal directory prefix of a pattern: `src/api/**\/*.ts` → `src/api`. */
export function patternBase(pattern: string): string {
  const pat = trimSlashes(pattern);
  const scan = picomatch.scan(pat);
  return scan.isGlob ? trimSlashes(scan.base) : pat;
}

function isPathPrefix(prefix: string, path: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(prefix + "/");
}

/**
 * Conservative overlap test for two claim patterns. Exact glob intersection is undecidable in
 * general, so two patterns overlap when one's literal base contains the other's. This can
 * over-report (e.g. `src/**\/*.css` vs `src/**\/*.ts`), which is acceptable for advisory claims.
 */
export function patternsOverlap(a: string, b: string): boolean {
  const baseA = patternBase(a);
  const baseB = patternBase(b);
  const globA = picomatch.scan(trimSlashes(a)).isGlob;
  const globB = picomatch.scan(trimSlashes(b)).isGlob;
  if (!globA && !globB) return isPathPrefix(baseA, baseB) || isPathPrefix(baseB, baseA);
  if (!globA) return matchesPattern(b, baseA) || isPathPrefix(baseA, baseB);
  if (!globB) return matchesPattern(a, baseB) || isPathPrefix(baseB, baseA);
  return isPathPrefix(baseA, baseB) || isPathPrefix(baseB, baseA);
}

/** Old-side (base) line span of a hunk as a half-open range. Pure insertions occupy one line slot. */
function oldSpan(h: Hunk): [number, number] {
  return [h.oldStart, h.oldStart + Math.max(h.oldLines, 1)];
}

/**
 * True if two sets of hunks (both relative to the same base) touch the same or adjacent base lines,
 * which is exactly when git's three-way merge would report a conflict.
 */
export function hunksOverlap(a: readonly Hunk[], b: readonly Hunk[]): boolean {
  for (const ha of a) {
    const [sa, ea] = oldSpan(ha);
    for (const hb of b) {
      const [sb, eb] = oldSpan(hb);
      if (sa <= eb && sb <= ea) return true;
    }
  }
  return false;
}
