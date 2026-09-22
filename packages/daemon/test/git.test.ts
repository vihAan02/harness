import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, normalizeRemote, repoInfo } from "../src/git.ts";
import { formatInvite, parseInvite } from "../src/invite.ts";
import { cleanupTmp, makeTeamRepos, tmp } from "./fixtures.ts";

afterAll(cleanupTmp);

describe("normalizeRemote", () => {
  it.each([
    ["git@github.com:vihAan02/harness.git", "github.com/vihAan02/harness"],
    ["https://github.com/vihAan02/harness.git", "github.com/vihAan02/harness"],
    ["https://GitHub.com/vihAan02/harness/", "github.com/vihAan02/harness"],
    ["ssh://git@github.com/vihAan02/harness.git", "github.com/vihAan02/harness"],
    ["/srv/git/app.git", "local:/srv/git/app"],
    ["file:///srv/git/app.git", "local:/srv/git/app"],
  ])("%s → %s", (url, key) => {
    expect(normalizeRemote(url)).toBe(key);
  });
});

describe("invites", () => {
  it("round-trips, keeping the secret in the fragment", () => {
    const invite = { relayUrl: "https://relay.example.com", roomId: "0123456789abcdef01234567", secret: "s3cr3t-s3cr3t-s3cr3t" };
    const link = formatInvite(invite);
    expect(link).toBe("https://relay.example.com/join/0123456789abcdef01234567#s3cr3t-s3cr3t-s3cr3t");
    expect(parseInvite(link)).toEqual(invite);
  });

  it("keeps a base path on the relay URL", () => {
    const parsed = parseInvite("http://127.0.0.1:8787/mp/join/0123456789abcdef01234567#xxxxxxxxxxxxxxxxxxxx");
    expect(parsed.relayUrl).toBe("http://127.0.0.1:8787/mp");
  });

  it.each(["not a url", "https://relay.example.com/join/short#secretsecretsecret", "https://relay.example.com/join/0123456789abcdef01234567"])(
    "rejects %s",
    (link) => {
      expect(() => parseInvite(link)).toThrow();
    },
  );
});

describe("repoInfo", () => {
  it("reports the main checkout and the same repo key from inside a linked worktree", async () => {
    const { sam, origin } = await makeTeamRepos();
    const wt = join(await tmp("wt"), "feature");
    await git(sam, ["worktree", "add", "-q", "-b", "feature", wt, "origin/main"]);
    const fromMain = await repoInfo(sam);
    const fromWorktree = await repoInfo(join(wt, "src"));
    expect(fromWorktree.root).toBe(fromMain.root);
    expect(fromWorktree.repoKey).toBe(fromMain.repoKey);
    expect(fromMain.repoKey).toBe(normalizeRemote(origin));
    expect(fromMain.defaultBase).toBe("main");
  });

  it("rejects paths outside a repo", async () => {
    await expect(repoInfo(await tmp("norepo"))).rejects.toThrow(/not inside a git repository/);
  });
});
