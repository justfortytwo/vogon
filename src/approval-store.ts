// The durable one-shot approval store: the seam between the agent-agnostic gate
// and whatever records human approvals out of band. The original host backed this
// with a transactional database and surfaced approvals over a chat bridge; the
// gate only needs the small contract below.
//
//   TODO(extract): a host integration (e.g. @justfortytwo/memory) may provide a
//   richer, transactional ApprovalStore + an AuditLogger that persists to its own
//   store and notifies an approver channel. Pass it to decide() via opts.store /
//   opts.audit. The two implementations here keep the gate fully standalone.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'expired';

export interface PendingApproval {
  id: string;
  tool: string;
  target: string;
  payload: Record<string, unknown>;
  tier: string;
  tool_use_id: string;
  session_id?: string | null;
  status: ApprovalStatus;
  created_at: string;
  updated_at: string;
}

export interface AddPendingInput {
  tool: string;
  target: string;
  payload: Record<string, unknown>;
  tier: string;
  tool_use_id: string;
  session_id?: string | null;
}

export interface ApprovalStore {
  /** Stage a new pending approval; returns its id. */
  addPending(input: AddPendingInput): Promise<string>;
  /** Look up the current record for a tool_use_id (most recent wins). */
  getByToolUseId(toolUseId: string): Promise<PendingApproval | undefined>;
  /**
   * Atomically consume an `approved` record: flip it to `executed` and return
   * true exactly once. A second call (already executed) returns false. This is
   * what makes the approval a one-shot.
   */
  markExecutedByToolUseId(toolUseId: string): Promise<boolean>;
  /** Record an out-of-band decision (approve/deny) against a staged approval. */
  setDecisionByToolUseId(toolUseId: string, status: 'approved' | 'denied', by?: string): Promise<boolean>;
}

export interface AuditEntry {
  actor: string;
  kind: string;
  content: string;
  approval_status?: ApprovalStatus;
  meta?: Record<string, unknown>;
}

export interface AuditLogger {
  log(entry: AuditEntry): Promise<void>;
}

export class NullAuditLogger implements AuditLogger {
  async log(): Promise<void> {
    /* no-op */
  }
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `pa_${Date.now().toString(36)}_${counter.toString(36)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Process-local store. Good enough for a single hook invocation that both stages
 * and (on a later turn) consumes — but only when the hook process is long-lived.
 * Most Claude Code hooks are one-shot processes, so prefer JsonlApprovalStore for
 * the actual hook; this is the safe library default.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly byToolUse = new Map<string, PendingApproval>();

  async addPending(input: AddPendingInput): Promise<string> {
    const id = nextId();
    const ts = nowIso();
    this.byToolUse.set(input.tool_use_id, {
      id,
      tool: input.tool,
      target: input.target,
      payload: input.payload,
      tier: input.tier,
      tool_use_id: input.tool_use_id,
      session_id: input.session_id ?? null,
      status: 'pending',
      created_at: ts,
      updated_at: ts,
    });
    return id;
  }

  async getByToolUseId(toolUseId: string): Promise<PendingApproval | undefined> {
    return this.byToolUse.get(toolUseId);
  }

  async markExecutedByToolUseId(toolUseId: string): Promise<boolean> {
    const row = this.byToolUse.get(toolUseId);
    if (!row || row.status !== 'approved') return false;
    row.status = 'executed';
    row.updated_at = nowIso();
    return true;
  }

  async setDecisionByToolUseId(toolUseId: string, status: 'approved' | 'denied', _by?: string): Promise<boolean> {
    const row = this.byToolUse.get(toolUseId);
    if (!row) return false;
    row.status = status;
    row.updated_at = nowIso();
    return true;
  }
}

/**
 * File-backed store: appends approval events as JSONL and replays them to derive
 * current state. Survives across separate one-shot hook processes, which is what a
 * PreToolUse hook needs (stage on turn N, consume on turn N+1). Approvals are
 * recorded out of band by appending a decision line (or via setDecisionByToolUseId
 * from a companion tool). This is intentionally simple and single-writer; a
 * concurrent multi-writer host should supply a transactional store instead.
 */
export class JsonlApprovalStore implements ApprovalStore {
  constructor(private readonly filePath: string) {}

  private readAll(): PendingApproval[] {
    if (!existsSync(this.filePath)) return [];
    const byId = new Map<string, PendingApproval>();
    for (const line of readFileSync(this.filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try {
        const rec = JSON.parse(trimmed) as PendingApproval;
        if (rec && typeof rec.tool_use_id === 'string') byId.set(rec.tool_use_id, rec);
      } catch {
        // Ignore malformed lines rather than crash the gate.
      }
    }
    return [...byId.values()];
  }

  private writeAll(rows: PendingApproval[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    renameSync(tmp, this.filePath);
  }

  private append(row: PendingApproval): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, 'utf8');
  }

  async addPending(input: AddPendingInput): Promise<string> {
    const id = nextId();
    const ts = nowIso();
    this.append({
      id,
      tool: input.tool,
      target: input.target,
      payload: input.payload,
      tier: input.tier,
      tool_use_id: input.tool_use_id,
      session_id: input.session_id ?? null,
      status: 'pending',
      created_at: ts,
      updated_at: ts,
    });
    return id;
  }

  async getByToolUseId(toolUseId: string): Promise<PendingApproval | undefined> {
    return this.readAll().find((r) => r.tool_use_id === toolUseId);
  }

  async markExecutedByToolUseId(toolUseId: string): Promise<boolean> {
    const rows = this.readAll();
    const row = rows.find((r) => r.tool_use_id === toolUseId);
    if (!row || row.status !== 'approved') return false;
    row.status = 'executed';
    row.updated_at = nowIso();
    this.writeAll(rows);
    return true;
  }

  async setDecisionByToolUseId(toolUseId: string, status: 'approved' | 'denied', _by?: string): Promise<boolean> {
    const rows = this.readAll();
    const row = rows.find((r) => r.tool_use_id === toolUseId);
    if (!row) return false;
    row.status = status;
    row.updated_at = nowIso();
    this.writeAll(rows);
    return true;
  }
}
