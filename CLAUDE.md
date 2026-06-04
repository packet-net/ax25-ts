# CLAUDE.md

Operating notes for Claude Code (and other agents) working in `m0lte/ax25-ts`.

## What this repo is

`@packet-net/ax25` — a browser-targeted TypeScript library for AX.25 v2.2 connected-mode sessions over Web Serial KISS modems. The downstream-facing companion to:

- [`m0lte/ax25sdl`](https://github.com/m0lte/ax25sdl) — canonical SDL transcriptions + codegen. Published as the `ax25sdl` npm package; we consume it.
- [`m0lte/packet.net`](https://github.com/m0lte/packet.net) — the .NET libraries + packet-radio node host. The C# side of the same protocol stack; the docker interop matrix lives there.

Extracted from `m0lte/packet.net` on 2026-05-17 (history-preserving via `git filter-repo`). Before the split, the library lived at `web/ax25/` in `m0lte/packet.net`.

## Read first

- [`README.md`](README.md) — quick-start, public API surface, and worked browser example.
- [`CHANGELOG.md`](CHANGELOG.md) — version history (carried over from the `web/ax25/` days).

## Hard rules

### Consume `ax25sdl` from npm, never hand-edit generated tables

The AX.25 SDL state-machine tables come from the [`ax25sdl`](https://www.npmjs.com/package/ax25sdl) npm package, built and published by [`m0lte/ax25sdl`](https://github.com/m0lte/ax25sdl). **Do not** vendor, regenerate, or modify those tables from this repo. If a change is needed in the spec data, raise it against `m0lte/ax25sdl`, publish a new version, and bump the `ax25sdl` dep in `package.json`.

### Integration tests live in packet.net's interop matrix

`tests/integration/*` (notably `linbpq-via-netsim.test.ts`) dials the docker compose stack in [`m0lte/packet.net`](https://github.com/m0lte/packet.net) (LinBPQ + Xrouter + rax25 + netsim, 127.0.0.1:8100 KISS-TCP listener). That stack does not exist in this repo, so CI here runs only unit tests + typecheck + build. The integration step lives in `m0lte/packet.net`'s `interop.yml` job, which **clones this repo's `main`** and runs `npm ci && npm run build && npm run test:integration` against that stack — it builds from source and does *not* consume the published `@packet-net/ax25` npm package.

When you change `tests/integration/*`, the corresponding interop verification happens in `m0lte/packet.net` on its next interop run against your merged `main` — no publish required. (The published `@packet-net/ax25` npm artefact is for external/web consumers — the esm.sh pin, packet-term-web — not the interop matrix.)

### Self-hosted runners only

Every workflow job MUST target `runs-on: [self-hosted, Linux, X64]`. **Do not** add jobs using `ubuntu-latest` or any other GitHub-hosted runner label. The same rule applies across `m0lte/packet.net`, `m0lte/ax25sdl`, and the rest of the sibling-repos set — no budget for hosted runner minutes.

## Common commands

```sh
# install
npm ci

# typecheck (library + examples)
npm run typecheck
npm run typecheck:examples

# build
npm run build

# unit tests (excludes tests/integration/**)
npm test

# integration tests — REQUIRES the docker stack from m0lte/packet.net
# to be running locally on 127.0.0.1:8100. Most contributors won't run
# these; the interop job in m0lte/packet.net is the canonical run.
npm run test:integration

# generate typedoc HTML
npm run docs
```

## Things to avoid

- Don't hand-edit anything under `node_modules/ax25sdl/` (the generated SDL tables we consume).
- Don't commit `dist/` (gitignored — `tsc` builds at consume time).
- Don't commit `node_modules/` (gitignored).
- Don't add `runs-on: ubuntu-latest` to any workflow.

## When in doubt

Ask Tom (M0LTE). AX.25 protocol questions usually defer to the SDL figures (which live in `m0lte/ax25sdl`); runtime behaviour questions defer to the C# reference implementation in `m0lte/packet.net`.
