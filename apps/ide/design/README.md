# Harness UI directions (prototype)

Two candidate looks for the Harness IDE, built on mock room data, so we can pick one before restyling the workbench.

- **A · Graphite**: editor-first, the Cursor-for-VS-Code approach. Floating panels, a centered ⌘K bar, horizontal view tabs, and a right-hand agent panel with a composer. Multiplayer shows up in the title bar (presence), the tree (claims, locks, who's editing), tabs, and the editor (live agent cursor, other agents' pending hunks inline, claim/lock banners).
- **B · Prism**: agent-first mission control in the style of vgpu.sh. Pure black, a spectral color per agent, serif display type and mono labels. The room is the home screen: a WebGPU map of who is working where, the "What is everyone doing?" board, and an inspector. The editor and review are modes of the room.

- **C · Room**: Graphite, plus the Room window as the first editor tab. It answers "what is everyone doing" in three reads: what needs a human right now, how the agents are talking to each other (a live flow of every message between agents, people and the claim policy, with threads you can expand into the real transcript), and each agent's own plan with progress and the places one plan waits on another. Clicking any agent opens the agent panel on it.

Stack: React, Tailwind v4, shadcn/ui (radix-nova), anime.js v4 for motion, and [vgpu](https://vgpu.sh) (WebGPU) for the agent orbs and the room field, with CSS fallbacks when WebGPU is unavailable.

```bash
npm install
npm run dev        # http://localhost:5178, press 1 / 2 / 3 to switch styles
```

Layout: `src/graphite` (A and C, C adds `RoomWindow.tsx`), `src/prism` (B), `src/shared` (code view, new-agent dialog), `src/gpu` (vgpu runtime and WGSL), `src/data/room.ts` (mock room shaped like `packages/protocol`).
