# @justfortytwo/gate

A standalone, agent-agnostic **PreToolUse safety gate** for Claude Code.

It is the piece that decides, *before any tool runs*, whether a call is safe to
auto-run, must be **deferred for a one-shot human approval**, or should be
**denied outright** — and it does so **fail-closed**: anything it doesn't
recognise, and anything that errors, is blocked rather than waved through.

It is built from three independent parts you can use together or à la carte:

1. **A capability policy engine** — every tool is tagged with an *autonomy tier*
   (`read`, `internal`, `draft`, `external`, `irreversible`) in a small TOML
   manifest. Auto tiers pass; outward/destructive tiers defer for approval.
2. **A fail-closed bash allowlist** — `Bash` defers by default; only commands you
   explicitly allowlist (anchored, chaining-safe globs in a JSONL file) fast-path.
   **Deny always wins**: a dangerous command (`git push`, `rm -rf`, `curl --data`,
   `sudo`, …) can never be laundered past the gate by a broad allowlist glob.
3. **A PreToolUse hook** — reads the Claude Code hook event on stdin and emits the
   permission decision on stdout.

No database, no network, no agent-specific code. It runs as a Claude Code plugin,
a hook wired by hand, or a plain library.

## Why

LLM agents are happy to run whatever a tool, a web page, or a chat message tells
them to. A blocklist ("never run `rm -rf`") fails open: anything you didn't think
of slips through. This gate inverts that — the dangerous and the *unknown* both
stop and wait for you, while genuinely safe, known operations stay fast.

## Install

```sh
npm install @justfortytwo/gate
```

`@justfortytwo/gate` is a leaf package — it has **no `@justfortytwo/*` peer
dependencies**.

## Use as a Claude Code plugin (recommended)

This repo ships a plugin manifest (`.claude-plugin/plugin.json`) and a hook
(`hooks/hooks.json`) that wires a `PreToolUse` matcher `"*"` to the compiled
`dist/gate-hook.js` via `${CLAUDE_PLUGIN_ROOT}`. Plugin hooks **compose** with your
project and user hooks, so the gate adds to — never replaces — your existing setup.

Then, in the project the agent operates in, provide:

- `.claude/policy/capabilities.toml` — your capability manifest
  (copy `examples/capabilities.toml`).
- `rules/bash-allowlist.jsonl` — your bash allowlist
  (copy `examples/bash-allowlist.jsonl`).

Paths are configurable via environment variables (all resolved relative to the
project root the agent runs in):

| Env var | Default | Purpose |
| --- | --- | --- |
| `GATE_MANIFEST` | `.claude/policy/capabilities.toml` | capability manifest TOML |
| `GATE_BASH_ALLOWLIST` | `rules/bash-allowlist.jsonl` | bash allowlist JSONL |
| `GATE_APPROVALS` | `.gate/approvals.jsonl` | durable one-shot approval store |

## Use as a hook without the plugin

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node node_modules/@justfortytwo/gate/dist/gate-hook.js" }
        ]
      }
    ]
  }
}
```

The hook emits a standard Claude Code `permissionDecision` (`allow` | `deny` and a
`defer`-style hold) with a human-readable reason. The gate is the safety
authority; with `deny > defer > ask > allow`, a `defer`/`deny` from the gate still
overrides a permissive `permissions.allow` list.

### How an approval flows

1. The agent calls an `external`/`irreversible` tool. The gate **defers** and
   stages a pending one-shot keyed by the call's `tool_use_id`.
2. You clear it out of band with the bundled CLI — **`fortytwo-gate approve <tool_use_id>`**
   (or `fortytwo-gate deny <tool_use_id>`). A host integration can instead call
   `setDecisionByToolUseId(...)` on its own store.
3. The agent re-fires the same call. The gate **consumes the one-shot exactly
   once** and allows it; any later re-fire is denied.

## Clearing approvals — the `fortytwo-gate` CLI

When the gate defers a call it stages a one-shot in the approvals store
(`GATE_APPROVALS`, default `.gate/approvals.jsonl`). The bundled `fortytwo-gate` command
lets you clear it standalone — no host required:

```sh
fortytwo-gate list                   # what's waiting: status, tier, tool_use_id, target
fortytwo-gate approve <tool_use_id>  # allow it once (the agent's next re-fire consumes it)
fortytwo-gate deny <tool_use_id>     # block it
```

Run it from the **same project root** the agent runs in: the default
`.gate/approvals.jsonl` is resolved relative to the current directory, so a
different cwd points at a different (or empty) store. `fortytwo-gate list` prints the
resolved store path so a mismatch is obvious; set `GATE_APPROVALS` to an absolute
path to remove the ambiguity. With the package installed, invoke it as `fortytwo-gate`
(or `npx @justfortytwo/gate`).

`approve`/`deny` only act on a **pending** call — an already-consumed (executed) or
denied one-shot is immutable, so an approval can never be resurrected into a second
run.

## Use as a library

```ts
import {
  loadManifest,
  decide,
  JsonlApprovalStore,
} from '@justfortytwo/gate';

const manifest = loadManifest('.claude/policy/capabilities.toml');
const store = new JsonlApprovalStore('.gate/approvals.jsonl');

const decision = await decide(manifest, {
  toolName: 'Bash',
  toolInput: { command: 'git push origin main' },
  toolUseId: 'toolu_123',
  cwd: process.cwd(),
}, { store });

// decision.permission -> 'allow' | 'defer' | 'deny'
```

Bring your own durable approval store / audit log by implementing the
`ApprovalStore` / `AuditLogger` interfaces and passing them to `decide(...)`. The
package ships an `InMemoryApprovalStore` (the library default) and a file-backed
`JsonlApprovalStore` (used by the hook); a richer host integration can supply a
transactional store instead.

There is also a content-trust policy engine (`decidePolicy`, `classifyAuthority`,
`canUseAsInstruction`, …) for the *"may this source instruct the agent?"* question —
useful if you ingest untrusted content (web pages, messages, tool output) and want
a principled trusted/untrusted boundary.

## The `policySchema` contract: `POLICY_SCHEMA_VERSION`

```ts
import { POLICY_SCHEMA_VERSION } from '@justfortytwo/gate'; // 1
```

`POLICY_SCHEMA_VERSION` is the version of the **`policySchema` contract**: the
shape and meaning of the `Tier` model (the capability manifest) and of the
`Authority` / `MemoryClass` / `SourceKind` types and `decidePolicy()` outcomes (the
content-trust engine).

Other `@justfortytwo/*` packages depend on this contract via a **caret range** on
this package. Any change to the *meaning* of these types or decisions is a breaking
change: it bumps `POLICY_SCHEMA_VERSION` **and** the package major version (a major
bump signals a contract break to every consumer).

## Manifest format

A small TOML file (see `examples/capabilities.toml`):

- `default_tier` — tier for any tool not listed (recommended: `external`).
- `[tiers]` — exact tool name → tier, plus trailing-`*` **prefix globs**
  (e.g. `"mcp__messaging__*" = "external"`).
- `[bash]` — JS-regex command patterns that **elevate** Bash above its base tier
  (and double as the denylist). Highest match wins; patterns only ever raise.
- `[guard].files` — project-relative paths whose edit is `irreversible`; point this
  at the manifest, settings, and allowlist so the gate can't be silently weakened.

## Bash allowlist format

JSONL, one entry per line (see `examples/bash-allowlist.jsonl`). Fields:
`command_glob` (required, anchored, matched against the whole command),
`cwd_glob` (optional, default `*`), `expires_at` (optional ISO 8601),
`approved_by`, `note`. Prefer **exact** commands; a trailing `*` re-enables
chaining and should be used sparingly.

## License

MIT — Copyright (c) 2026 Enrico Deleo.

---

Created and maintained by [**Enrico Deleo**](https://enricodeleo.com).
