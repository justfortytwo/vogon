// Bash allowlist: the one place known-safe shell commands are permitted past the
// gate. Human-editable JSONL (one entry per line); malformed or expired lines are
// silently ignored so a typo can never crash the gate (it would fail closed and
// block everything). Globs are anchored (^...$) against the WHOLE command, so an
// exact entry like "npm test" will NOT match "npm test && curl evil" — that is the
// point: chaining-safety by default. The gate's deny-wins rule still applies — a
// command flagged by any policy elevation pattern can never be satisfied here.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface BashAllowlistEntry {
  command_glob: string;
  cwd_glob?: string;
  expires_at?: string;
  approved_by?: string;
  created_at?: string;
  source_tool_use_id?: string;
  note?: string;
}

export const DEFAULT_BASH_ALLOW_TTL_HOURS = 24;

function escapeRegexChar(c: string): string {
  return /[|\\{}()[\]^$+?.]/.test(c) ? `\\${c}` : c;
}

export function escapeGlobLiteral(s: string): string {
  return s.replace(/[\\*?]/g, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') {
      const next = glob[++i];
      out += next === undefined ? '\\\\' : escapeRegexChar(next);
    } else if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else {
      out += escapeRegexChar(c);
    }
  }
  return new RegExp(`${out}$`);
}

function isExpired(e: BashAllowlistEntry, now: Date): boolean {
  if (!e.expires_at) return false;
  const t = Date.parse(e.expires_at);
  return Number.isFinite(t) ? t <= now.getTime() : true;
}

export function readBashAllowlist(filePath: string, now = new Date()): BashAllowlistEntry[] {
  if (!existsSync(filePath)) return [];
  const entries: BashAllowlistEntry[] = [];
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      const parsed = JSON.parse(trimmed) as BashAllowlistEntry;
      if (typeof parsed.command_glob !== 'string' || parsed.command_glob.length === 0) continue;
      if (parsed.cwd_glob !== undefined && typeof parsed.cwd_glob !== 'string') continue;
      if (isExpired(parsed, now)) continue;
      entries.push(parsed);
    } catch {
      // Human-editable JSONL: ignore malformed lines instead of breaking the gate.
    }
  }
  return entries;
}

/**
 * Default allowlist location, relative to a project/repo root. Override via the
 * `bashAllowlistPath` field on GateContext to point anywhere you like.
 */
export function bashAllowlistPath(projectRoot: string): string {
  return resolve(projectRoot, 'rules', 'bash-allowlist.jsonl');
}

export function findBashAllowlistMatch(
  filePath: string,
  command: string,
  cwd: string,
  now = new Date(),
): BashAllowlistEntry | undefined {
  const absCwd = resolve(cwd);
  return readBashAllowlist(filePath, now).find((entry) => {
    const cwdGlob = entry.cwd_glob ?? '*';
    return globToRegExp(entry.command_glob).test(command) && globToRegExp(cwdGlob).test(absCwd);
  });
}

export function appendExactBashAllowlistEntry(args: {
  filePath: string;
  command: string;
  cwd: string;
  approvedBy: string;
  ttlHours?: number;
  sourceToolUseId?: string;
  now?: Date;
}): BashAllowlistEntry {
  const now = args.now ?? new Date();
  const ttlHours = args.ttlHours ?? DEFAULT_BASH_ALLOW_TTL_HOURS;
  const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  const entry: BashAllowlistEntry = {
    command_glob: escapeGlobLiteral(args.command),
    cwd_glob: escapeGlobLiteral(resolve(args.cwd)),
    expires_at: expires.toISOString(),
    approved_by: args.approvedBy,
    created_at: now.toISOString(),
  };
  if (args.sourceToolUseId) entry.source_tool_use_id = args.sourceToolUseId;
  mkdirSync(dirname(args.filePath), { recursive: true });
  appendFileSync(args.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}
