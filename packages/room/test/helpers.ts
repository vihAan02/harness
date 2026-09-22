import { ClientOp, type ClientOpInput } from "@mp/protocol";
import { RoomEngine, type ApplyResult, type EngineOptions } from "../src/index.ts";

/** `Omit` that distributes over the op union instead of collapsing it to shared keys. */
type OpInput = ClientOpInput extends infer T ? (T extends unknown ? Omit<T, "reqId"> : never) : never;

export function makeEngine(opts: Partial<EngineOptions> = {}) {
  let n = 0;
  const engine = new RoomEngine("room-1", { newId: () => `id${++n}`, ...opts });
  let now = 1_000_000;
  let req = 0;

  const run = (memberId: string, input: OpInput): ApplyResult => {
    const op = ClientOp.parse({ reqId: `r${++req}`, ...input });
    return engine.apply({ memberId, now }, op);
  };

  const ok = (memberId: string, input: OpInput) => {
    const res = run(memberId, input);
    if (!res.ok) throw new Error(`${input.op} failed: ${res.error?.code} ${res.error?.message}`);
    return res;
  };

  return {
    engine,
    run,
    ok,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Two members (Sam, Ria) with one agent each: a Claude agent and a Codex agent. */
export function twoAgents(opts: Partial<EngineOptions> = {}) {
  const h = makeEngine(opts);
  h.engine.connect({ id: "sam", name: "Sam" }, h.now);
  h.engine.connect({ id: "ria", name: "Ria" }, h.now);
  h.ok("sam", {
    op: "agent.upsert",
    agent: { id: "claude-1", deviceId: "sam-mbp", vendor: "claude", name: "auth-refactor", status: "thinking" },
  });
  h.ok("ria", {
    op: "agent.upsert",
    agent: { id: "codex-1", deviceId: "ria-mbp", vendor: "codex", name: "billing", status: "thinking" },
  });
  return h;
}
