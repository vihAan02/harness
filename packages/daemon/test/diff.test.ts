import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeLiveDiff, parseUnifiedDiff, unquoteGitPath } from "../src/diff.ts";
import { git } from "../src/git.ts";
import { cleanupTmp, commitAll, makeTeamRepos } from "./fixtures.ts";

afterAll(cleanupTmp);

describe("parseUnifiedDiff", () => {
  it("splits a hunk into exact change runs and ignores context", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,7 +1,8 @@",
      " line1",
      "-line2",
      "+line2 changed",
      " line3",
      " line4",
      " line5",
      "+inserted after 5",
      " line6",
      " line7",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(patch);
    expect(f).toMatchObject({ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 });
    expect(f!.hunks).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
      { oldStart: 5, oldLines: 0, newStart: 6, newLines: 1 }, // insertion after old line 5
    ]);
  });

  it("does not mistake deleted lines starting with '-- ' for headers", () => {
    const patch = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,1 @@",
      "--- a SQL comment",
      " select 1;",
      "diff --git a/b.md b/b.md",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1 +1 @@",
      "-old",
      "+++ bold",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ["q.sql", 0, 1],
      ["b.md", 1, 1],
    ]);
  });

  it("handles added, deleted, renamed and binary files", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
      "diff --git a/old name.ts b/new name.ts",
      "similarity index 100%",
      "rename from old name.ts",
      "rename to new name.ts",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch, { includePatch: true });
    expect(files.map(({ patch: _p, ...f }) => f)).toEqual([
      { path: "new.ts", status: "added", additions: 2, deletions: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }] },
      { path: "gone.ts", status: "deleted", additions: 0, deletions: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 }] },
      { path: "new name.ts", oldPath: "old name.ts", status: "renamed", additions: 0, deletions: 0, hunks: [] },
      { path: "logo.png", status: "modified", additions: 0, deletions: 0, hunks: [] },
    ]);
    expect(files[0]!.patch).toContain("+++ b/new.ts");
  });

  it("unquotes C-style git paths", () => {
    expect(unquoteGitPath('"tab\\there.ts"')).toBe("tab\there.ts");
    expect(unquoteGitPath('"caf\\303\\251.ts"')).toBe("café.ts");
    expect(unquoteGitPath("plain.ts")).toBe("plain.ts");
  });
});

describe("computeLiveDiff", () => {
  it("covers committed, staged, unstaged, untracked, deleted and renamed changes against the merge-base", async () => {
    const { sam } = await makeTeamRepos();
    await git(sam, ["checkout", "-q", "-b", "mp/sam/work"]);

    // Committed on the branch.
    await writeFile(join(sam, "src/routes.ts"), "export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\n");
    await commitAll(sam, "b=20");
    // Unstaged edit, a deletion, a rename, and an untracked file.
    await writeFile(join(sam, "README.md"), "# app\n\nMore docs.\n");
    await rm(join(sam, "src/billing/stripe.ts"));
    await git(sam, ["mv", "src/auth/middleware.ts", "src/auth/mw.ts"]);
    await writeFile(join(sam, "src/new.ts"), "one\ntwo\nthree\n");

    const { mergeBase, files } = await computeLiveDiff(sam, "origin/main");
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

    expect(byPath["src/routes.ts"]).toMatchObject({ status: "modified", additions: 1, deletions: 1, hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] });
    expect(byPath["README.md"]).toMatchObject({ status: "modified", additions: 2, deletions: 0 });
    expect(byPath["src/billing/stripe.ts"]).toMatchObject({ status: "deleted", deletions: 1 });
    expect(byPath["src/auth/mw.ts"]).toMatchObject({ status: "renamed", oldPath: "src/auth/middleware.ts" });
    expect(byPath["src/new.ts"]).toMatchObject({ status: "added", additions: 3, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }] });
    expect(byPath["src/new.ts"]!.patch).toContain("+two");
    expect(Object.keys(byPath)).not.toContain("package.json");
  });

  it("omits code when patches are disabled but keeps line ranges", async () => {
    const { sam } = await makeTeamRepos();
    await writeFile(join(sam, "src/routes.ts"), "changed\n");
    await rename(join(sam, "README.md"), join(sam, "README.txt"));
    const { files } = await computeLiveDiff(sam, "origin/main", { includePatch: false });
    expect(files.every((f) => f.patch === undefined)).toBe(true);
    expect(files.find((f) => f.path === "src/routes.ts")?.hunks.length).toBeGreaterThan(0);
  });
});
