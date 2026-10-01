# CLAUDE.md

@AGENTS.md

## Claude Code–specific notes
- **The shared instructions are imported above.** If the import didn't load, read [AGENTS.md](AGENTS.md) first.
- **This repo designs a system that supervises Claude Code itself:** hooks, Agent SDK sessions, settings.json policy. Claims about Claude Code behavior go in [docs/research/vendor-capabilities.md](docs/research/vendor-capabilities.md) as F-IDs with a source and date. Don't rely on memory, because hook and SDK details change between releases.
- **Settings and hooks in this repo:** if you add Claude Code hooks or settings to the repo while developing, keep them separate from the harness's own runtime policy. `harnessd` never loads repo hooks or settings into agent sessions (D-45; security TH-5, TH-13).
