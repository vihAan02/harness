import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Regenerated rather than hand-merged, so locking them would only block people. */
export const DEFAULT_LOCK_EXEMPT = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "go.sum",
  "composer.lock",
];

export const RepoConfig = z.object({
  baseBranch: z.string().min(1).optional(),
  /** Agents must publish a plan (mp_plan) before their first edit. */
  requirePlan: z.boolean().default(true),
  lockExempt: z.array(z.string()).default(DEFAULT_LOCK_EXEMPT),
  /** When false, live diffs carry stats and line ranges but no code. */
  shareLiveDiffs: z.boolean().default(true),
  shareStreams: z.boolean().default(true),
  criticalFiles: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export const CONFIG_FILE = ".multiplayer.json";

/** Reads `.multiplayer.json` from a checkout. Missing file means defaults; a broken file is an error. */
export async function loadRepoConfig(dir: string): Promise<RepoConfig> {
  let raw: string;
  try {
    raw = await readFile(join(dir, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return RepoConfig.parse({});
    throw err;
  }
  const parsed = RepoConfig.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${CONFIG_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
