// Content-trust policy engine: the "who said this, and may it instruct the agent?"
// half of the gate's contract. It classifies an inbound source into an authority
// level and a memory class, decides whether content may be used as an instruction
// vs. merely analyzed, and ranks recalled items by trust. It is deliberately free
// of any storage/DB concern — it is pure data in, pure decision out.
//
// The shape of these types + the classification rules are the `policySchema`
// contract that downstream `@justfortytwo/*` packages depend on; the version of
// that contract is exported as POLICY_SCHEMA_VERSION from ./index.ts. Any change
// to the meaning of an Authority/MemoryClass, or to a decidePolicy() outcome, is a
// contract break and must bump the major version (and the schema version).
//
// NOTE: a handful of SourceKind values below describe inbound transport channels
// (chat messages, email, direct-owner statements). They are kept as generic,
// host-agnostic labels here. A host integration may want to map its own channels
// onto these.
//   TODO(extract): host channel -> SourceKind mapping belongs to the host
//   integration package, not to the standalone gate. The gate only needs the
//   trusted/untrusted distinction.

import { createHash } from 'node:crypto';

export type SourceKind =
  | 'repo_policy'
  | 'repo_document'
  | 'approved_rule'
  | 'installed_skill'
  | 'owner_direct'
  | 'approval_record'
  | 'assistant_message'
  | 'guide_doc'
  | 'chat_message'
  | 'chat_photo'
  | 'chat_document'
  | 'quoted_text'
  | 'document'
  | 'web_page'
  | 'email'
  | 'tool_output'
  | 'mcp_output'
  | 'plugin_output'
  | 'memory_recall';

export type Authority =
  | 'trusted_policy'
  | 'trusted_user'
  | 'trusted_approval'
  | 'trusted_procedure'
  | 'evidence'
  | 'untrusted_content';

export type MemoryClass =
  | 'journal_fact'
  | 'working_note'
  | 'pending_decision'
  | 'preference'
  | 'canonical_rule'
  | 'inferred_trait'
  | 'secret'
  | 'untrusted_claim';

export type RequestedOperation =
  | 'summarize'
  | 'extract_fact'
  | 'store_journal'
  | 'store_working_note'
  | 'store_preference'
  | 'promote_to_canonical_rule'
  | 'store_inferred_trait'
  | 'store_secret'
  | 'execute_tool'
  | 'approve_action'
  | 'use_as_instruction';

export interface PolicyInput {
  source: SourceKind | string;
  requested_operation: RequestedOperation;
  content?: string;
  memory_class?: MemoryClass;
  provenance?: string;
  direct_user_statement?: boolean;
}

export interface PolicyDecision {
  authority: Authority;
  memory_class: MemoryClass;
  allowed: boolean;
  must_propose: boolean;
  approval_required: boolean;
  provenance_required: boolean;
  recall_priority: number;
  can_use_as_instruction: boolean;
  reason: string;
}

export interface SourceEnvelopeInput {
  source_kind: SourceKind | string;
  content: string;
  source_id?: string;
  authority?: Authority | string;
  memory_class?: MemoryClass;
  actor?: string;
  channel?: string;
  parent_source_id?: string | null;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceEnvelope {
  source_id: string;
  source_kind: string;
  authority: Authority;
  memory_class: MemoryClass;
  actor?: string;
  channel?: string;
  content_hash: string;
  parent_source_id?: string | null;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface ContextPackItem {
  id: string | number;
  source_kind?: string;
  source?: SourceKind | string;
  authority: Authority;
  memory_class: MemoryClass;
  recall_priority: number;
  can_use_as_instruction: boolean;
  content: string;
}

const TRUSTED_SOURCES: Partial<Record<SourceKind, Authority>> = {
  repo_policy: 'trusted_policy',
  approved_rule: 'trusted_policy',
  installed_skill: 'trusted_procedure',
  owner_direct: 'trusted_user',
  approval_record: 'trusted_approval',
  repo_document: 'evidence',
  assistant_message: 'evidence',
  guide_doc: 'evidence',
  memory_recall: 'evidence',
};

const UNTRUSTED_SOURCES = new Set<string>([
  'chat_message', 'chat_photo', 'chat_document', 'quoted_text', 'document', 'web_page', 'email', 'tool_output', 'mcp_output', 'plugin_output',
]);

const SOURCE_DEFAULT_CLASS: Record<SourceKind, MemoryClass> = {
  repo_policy: 'canonical_rule',
  repo_document: 'working_note',
  approved_rule: 'canonical_rule',
  installed_skill: 'working_note',
  owner_direct: 'journal_fact',
  approval_record: 'pending_decision',
  assistant_message: 'journal_fact',
  guide_doc: 'journal_fact',
  chat_message: 'journal_fact',
  chat_photo: 'untrusted_claim',
  chat_document: 'untrusted_claim',
  quoted_text: 'untrusted_claim',
  document: 'untrusted_claim',
  web_page: 'untrusted_claim',
  email: 'untrusted_claim',
  tool_output: 'untrusted_claim',
  mcp_output: 'untrusted_claim',
  plugin_output: 'untrusted_claim',
  memory_recall: 'journal_fact',
};

const CLASS_PRIORITY: Record<MemoryClass, number> = {
  canonical_rule: 100,
  preference: 80,
  pending_decision: 75,
  journal_fact: 60,
  working_note: 45,
  inferred_trait: 25,
  untrusted_claim: 15,
  secret: 0,
};

const AUTHORITIES = new Set<string>([
  'trusted_policy', 'trusted_user', 'trusted_approval', 'trusted_procedure', 'evidence', 'untrusted_content',
]);

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function isAuthority(value: unknown): value is Authority {
  return typeof value === 'string' && AUTHORITIES.has(value);
}

function isKnownSourceKind(value: string): value is SourceKind {
  return Object.prototype.hasOwnProperty.call(SOURCE_DEFAULT_CLASS, value);
}

function stableSourceId(input: SourceEnvelopeInput, contentHash: string): string {
  return `src_${sha256([
    input.source_kind,
    input.actor ?? '',
    input.channel ?? '',
    input.parent_source_id ?? '',
    contentHash,
  ].join('\0')).slice(0, 24)}`;
}

export function classifyAuthority(source: SourceKind | string): Authority {
  if (UNTRUSTED_SOURCES.has(source)) return 'untrusted_content';
  if (isKnownSourceKind(source)) return TRUSTED_SOURCES[source] ?? 'untrusted_content';
  return 'untrusted_content';
}

export function defaultMemoryClassForSource(source: SourceKind | string): MemoryClass {
  return isKnownSourceKind(source) ? SOURCE_DEFAULT_CLASS[source] : 'untrusted_claim';
}

export function recallPriorityForMemoryClass(memoryClass: MemoryClass): number {
  return CLASS_PRIORITY[memoryClass];
}

export function createSourceEnvelope(input: SourceEnvelopeInput): SourceEnvelope {
  const sourceKind = String(input.source_kind);
  const classifiedAuthority = classifyAuthority(sourceKind);
  const authority = isAuthority(input.authority) && input.authority === classifiedAuthority
    ? input.authority
    : classifiedAuthority;
  const memoryClass = input.memory_class ?? defaultMemoryClassForSource(sourceKind);
  const contentHash = sha256(input.content);
  return {
    source_id: input.source_id ?? stableSourceId(input, contentHash),
    source_kind: sourceKind,
    authority,
    memory_class: memoryClass,
    actor: input.actor,
    channel: input.channel,
    content_hash: contentHash,
    parent_source_id: input.parent_source_id ?? null,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata: input.metadata,
  };
}

function defaultClassFor(input: PolicyInput, authority: Authority): MemoryClass {
  if (input.memory_class) return input.memory_class;
  switch (input.requested_operation) {
    case 'store_working_note': return 'working_note';
    case 'store_preference': return authority === 'trusted_user' && input.direct_user_statement ? 'preference' : 'inferred_trait';
    case 'promote_to_canonical_rule': return 'canonical_rule';
    case 'store_inferred_trait': return 'inferred_trait';
    case 'store_secret': return 'secret';
    case 'approve_action': return 'pending_decision';
    case 'extract_fact': return authority === 'untrusted_content' ? 'untrusted_claim' : 'journal_fact';
    default: return defaultMemoryClassForSource(input.source);
  }
}

function classPolicy(memoryClass: MemoryClass): Pick<PolicyDecision, 'approval_required' | 'provenance_required' | 'must_propose'> {
  switch (memoryClass) {
    case 'canonical_rule': return { approval_required: true, provenance_required: true, must_propose: true };
    case 'preference': return { approval_required: false, provenance_required: true, must_propose: false };
    case 'inferred_trait': return { approval_required: true, provenance_required: true, must_propose: true };
    case 'secret': return { approval_required: true, provenance_required: true, must_propose: false };
    case 'untrusted_claim': return { approval_required: false, provenance_required: true, must_propose: false };
    case 'pending_decision': return { approval_required: true, provenance_required: true, must_propose: false };
    case 'working_note': return { approval_required: false, provenance_required: true, must_propose: false };
    case 'journal_fact': return { approval_required: false, provenance_required: true, must_propose: false };
  }
}

function isTrustedInstructionAuthority(authority: Authority): boolean {
  return authority === 'trusted_policy' || authority === 'trusted_user' || authority === 'trusted_approval' || authority === 'trusted_procedure';
}

export function canUseAsInstruction(sourceOrAuthority: SourceKind | Authority | string): boolean {
  const authority = isAuthority(sourceOrAuthority)
    ? sourceOrAuthority
    : classifyAuthority(sourceOrAuthority);
  return isTrustedInstructionAuthority(authority);
}

export function decidePolicy(input: PolicyInput): PolicyDecision {
  const authority = classifyAuthority(input.source);
  const memoryClass = defaultClassFor(input, authority);
  const policy = classPolicy(memoryClass);
  const canInstruct = canUseAsInstruction(authority);
  let allowed = true;
  let mustPropose = policy.must_propose;
  let approvalRequired = policy.approval_required;
  let reason = 'allowed under class policy';

  if (input.requested_operation === 'summarize' || input.requested_operation === 'extract_fact') {
    allowed = true;
    approvalRequired = false;
    reason = 'content may be analyzed as content';
  }

  if (input.requested_operation === 'use_as_instruction') {
    allowed = canInstruct;
    approvalRequired = !canInstruct;
    reason = canInstruct ? 'trusted authority may instruct the agent' : 'content/evidence cannot instruct the agent';
  }

  if (input.requested_operation === 'execute_tool' || input.requested_operation === 'approve_action') {
    allowed = authority === 'trusted_approval';
    approvalRequired = !allowed;
    reason = allowed ? 'explicit approval record grants action' : 'action requires explicit approval';
  }

  if (input.requested_operation === 'promote_to_canonical_rule') {
    allowed = authority === 'trusted_policy' || authority === 'trusted_approval';
    approvalRequired = !allowed;
    mustPropose = !allowed;
    reason = allowed ? 'trusted policy/approval may change canonical rules' : 'canonical rule changes must be proposed and approved';
  }

  if (input.requested_operation === 'store_preference') {
    if (authority === 'trusted_user' && input.direct_user_statement) {
      allowed = true;
      mustPropose = false;
      approvalRequired = false;
      reason = 'direct user preference may be stored with provenance';
    } else {
      allowed = false;
      mustPropose = true;
      approvalRequired = true;
      reason = 'inferred or untrusted preference must be proposed';
    }
  }

  if (input.requested_operation === 'store_secret') {
    allowed = false;
    approvalRequired = true;
    reason = 'secrets must not be stored in durable memory';
  }

  return {
    authority,
    memory_class: memoryClass,
    allowed,
    must_propose: mustPropose,
    approval_required: approvalRequired,
    provenance_required: policy.provenance_required,
    recall_priority: recallPriorityForMemoryClass(memoryClass),
    can_use_as_instruction: canInstruct,
    reason,
  };
}

export interface RecallItem {
  id: string;
  memory_class: MemoryClass;
  source: SourceKind | string;
  content: string;
}

export interface RankedRecallItem extends RecallItem {
  authority: Authority;
  recall_priority: number;
  can_use_as_instruction: boolean;
}

export function rankRecall(items: RecallItem[]): RankedRecallItem[] {
  return items
    .map((item) => {
      const authority = classifyAuthority(item.source);
      return {
        ...item,
        authority,
        recall_priority: recallPriorityForMemoryClass(item.memory_class),
        can_use_as_instruction: canUseAsInstruction(authority),
      };
    })
    .sort((a, b) => b.recall_priority - a.recall_priority);
}

function packText(s: string): string {
  return s
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderContextPack(items: ContextPackItem[]): string {
  const lines = ['CP/1 rows: id|src|auth|mc|p|can|txt'];
  for (const item of items) {
    const source = item.source_kind ?? String(item.source ?? 'unknown');
    lines.push([
      packText(String(item.id)),
      packText(source),
      item.authority,
      item.memory_class,
      String(item.recall_priority),
      item.can_use_as_instruction ? '1' : '0',
      packText(item.content),
    ].join('|'));
  }
  return lines.join('\n');
}
