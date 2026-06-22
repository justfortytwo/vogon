import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManifest,
  classify,
  decide,
  InMemoryApprovalStore,
  type Manifest,
  type ApprovalStore,
} from '../src/index.js';

const MANIFEST_SRC = `
default_tier = "external"
[tiers]
"Read" = "read"
"Write" = "internal"
"Bash" = "external"
"mcp__messaging__*" = "external"
[bash]
"\\brm\\s+-rf?\\b" = "irreversible"
"\\bgit\\s+push\\b" = "external"
[guard]
files = [".claude/policy/capabilities.toml"]
`;

let m: Manifest;
let store: ApprovalStore;
beforeEach(() => {
  m = parseManifest(MANIFEST_SRC);
  store = new InMemoryApprovalStore();
});

describe('classify', () => {
  it('auto tiers pass, prefix globs and bash elevation work', () => {
    expect(classify(m, 'Read', {})).toBe('read');
    expect(classify(m, 'Write', { file_path: 'note.md' })).toBe('internal');
    expect(classify(m, 'mcp__messaging__send', {})).toBe('external');
    expect(classify(m, 'Bash', { command: 'rm -rf /tmp/x' })).toBe('irreversible');
    // Bash fails closed: an unmatched command stays at the external base.
    expect(classify(m, 'Bash', { command: 'ls -la' })).toBe('external');
  });
});

describe('decide — one-shot approval state machine', () => {
  const ext = { toolName: 'mcp__messaging__send', toolInput: { to: 'someone' }, toolUseId: 'tu_1' };

  it('auto-tier tools allow without any pending record', async () => {
    const d = await decide(m, { toolName: 'Read', toolInput: {}, toolUseId: 'tu_r' }, { store });
    expect(d.permission).toBe('allow');
  });

  it('an external call defers and stages an approval, then allows once after approval', async () => {
    const first = await decide(m, ext, { store });
    expect(first.permission).toBe('defer');

    await store.setDecisionByToolUseId('tu_1', 'approved', 'tester');

    const allow = await decide(m, ext, { store });
    expect(allow.permission).toBe('allow');

    const again = await decide(m, ext, { store });
    expect(again.permission).toBe('deny');
  });

  it('fails closed when an external call has no tool_use_id', async () => {
    const d = await decide(m, { toolName: 'mcp__messaging__send', toolInput: {} }, { store });
    expect(d.permission).toBe('deny');
  });

  it('deny-wins: a broad allowlist glob cannot permit git push', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const allowFile = join(dir, 'bash-allowlist.jsonl');
    writeFileSync(allowFile, `${JSON.stringify({ command_glob: 'git *', expires_at: '2999-01-01T00:00:00.000Z' })}\n`);

    const push = await decide(m, {
      toolName: 'Bash', toolInput: { command: 'git push origin main' },
      toolUseId: 'tu_push', cwd: dir, bashAllowlistPath: allowFile,
    }, { store });
    expect(push.permission).toBe('defer');

    const status = await decide(m, {
      toolName: 'Bash', toolInput: { command: 'git status' },
      toolUseId: 'tu_status', cwd: dir, bashAllowlistPath: allowFile,
    }, { store });
    expect(status.permission).toBe('allow');
  });
});
