// End-to-end: drive the REAL built artifacts as subprocesses, the way Claude Code
// runs them — gate-hook.js reads a PreToolUse event on stdin and prints a
// permissionDecision; the gate CLI clears a deferred approval out of band.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const HOOK = join(ROOT, 'dist', 'gate-hook.js');
const CLI = join(ROOT, 'dist', 'cli-bin.js');

const MANIFEST = `
default_tier = "external"
[tiers]
"Read" = "read"
"mcp__messaging__*" = "external"
`;

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-e2e-'));
  mkdirSync(join(dir, '.claude', 'policy'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'policy', 'capabilities.toml'), MANIFEST);
  return dir;
}

function hook(event: Record<string, unknown>, cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(r.stdout).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
}

function cli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env } });
}

const evt = (over: Record<string, unknown>, cwd: string) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, cwd, ...over,
});

beforeAll(() => {
  // Build so the test exercises current source even on a fresh checkout.
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT });
}, 60000);

describe('gate-hook (subprocess)', () => {
  it('auto-tier tool is allowed', () => {
    const dir = newProject();
    expect(hook(evt({ tool_name: 'Read' }, dir), dir).permissionDecision).toBe('allow');
  });

  it('a non-PreToolUse event passes through', () => {
    const dir = newProject();
    expect(hook(evt({ hook_event_name: 'PostToolUse' }, dir), dir).permissionDecision).toBe('allow');
  });

  it('an external tool defers, the CLI approves it, then it is allowed exactly once', () => {
    const dir = newProject();
    const ext = evt({ tool_name: 'mcp__messaging__send', tool_input: { to: 'x' }, tool_use_id: 'tu_x' }, dir);

    expect(hook(ext, dir).permissionDecision).toBe('defer');         // staged
    expect(cli(['approve', 'tu_x'], dir).status).toBe(0);            // approved out of band
    expect(hook(ext, dir).permissionDecision).toBe('allow');         // one-shot consumed
    expect(hook(ext, dir).permissionDecision).toBe('deny');          // already executed
  });

  it('the CLI cannot resurrect a consumed one-shot (no double-execution)', () => {
    const dir = newProject();
    const ext = evt({ tool_name: 'mcp__messaging__send', tool_input: { to: 'x' }, tool_use_id: 'tu_r' }, dir);
    hook(ext, dir);                                            // defer + stage
    cli(['approve', 'tu_r'], dir);                            // approve
    expect(hook(ext, dir).permissionDecision).toBe('allow');  // one-shot consumed
    expect(hook(ext, dir).permissionDecision).toBe('deny');   // executed -> denied
    expect(cli(['approve', 'tu_r'], dir).status).not.toBe(0); // re-approve refused
    expect(hook(ext, dir).permissionDecision).toBe('deny');   // STILL denied — invariant holds
  });

  it('the CLI can list and deny a staged approval', () => {
    const dir = newProject();
    hook(evt({ tool_name: 'mcp__messaging__send', tool_input: { to: 'y' }, tool_use_id: 'tu_y' }, dir), dir);
    expect(cli(['list'], dir).stdout).toMatch(/tu_y/);
    expect(cli(['deny', 'tu_y'], dir).status).toBe(0);
    expect(hook(evt({ tool_name: 'mcp__messaging__send', tool_input: { to: 'y' }, tool_use_id: 'tu_y' }, dir), dir).permissionDecision).toBe('deny');
  });

  it('fails CLOSED: a missing manifest denies rather than leaking', () => {
    const dir = newProject();
    const d = hook(evt({ tool_name: 'mcp__messaging__send', tool_use_id: 'tu_z' }, dir), dir, { GATE_MANIFEST: 'does-not-exist.toml' });
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toMatch(/fail-closed/);
  });
});
