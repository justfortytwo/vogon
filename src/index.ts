// @justfortytwo/gate — a standalone, agent-agnostic PreToolUse safety gate.
//
// Public API:
//   - the capability manifest + classifier + defer/allow/deny engine  (./gate)
//   - the fail-closed bash allowlist                                   (./bash-allowlist)
//   - the durable one-shot approval store contract + stock impls       (./approval-store)
//   - the content-trust policy engine                                  (./policy)
//
// CONTRACT: POLICY_SCHEMA_VERSION is the version of the `policySchema` contract —
// the shape and meaning of the Authority / MemoryClass / SourceKind types and the
// decidePolicy() outcomes in ./policy, together with the Tier model in ./gate.
// Downstream @justfortytwo/* packages pin a caret range on this package; any change
// to that contract's meaning is a breaking change and must bump this number (and
// the package major version).
export const POLICY_SCHEMA_VERSION = 1;

// --- capability gate (autonomy tiers + defer/allow/deny state machine) ---
export {
  decide,
  classify,
  loadManifest,
  parseManifest,
  parseToml,
  InMemoryApprovalStore,
  NullAuditLogger,
} from './gate.js';
export type {
  Tier,
  Manifest,
  GateContext,
  Decision,
  DecideOptions,
} from './gate.js';

// --- approval-clearing CLI (standalone approve/deny/list) ---
export { runCli } from './cli.js';
export type { CliOptions } from './cli.js';

// --- durable one-shot approval store (the host-integration seam) ---
export {
  JsonlApprovalStore,
} from './approval-store.js';
export type {
  ApprovalStore,
  AuditLogger,
  AuditEntry,
  ApprovalStatus,
  PendingApproval,
  AddPendingInput,
} from './approval-store.js';

// --- bash allowlist ---
export {
  readBashAllowlist,
  findBashAllowlistMatch,
  bashAllowlistPath,
  appendExactBashAllowlistEntry,
  escapeGlobLiteral,
  globToRegExp,
  DEFAULT_BASH_ALLOW_TTL_HOURS,
} from './bash-allowlist.js';
export type { BashAllowlistEntry } from './bash-allowlist.js';

// --- content-trust policy engine (the policySchema contract surface) ---
export {
  decidePolicy,
  classifyAuthority,
  canUseAsInstruction,
  createSourceEnvelope,
  defaultMemoryClassForSource,
  recallPriorityForMemoryClass,
  rankRecall,
  renderContextPack,
} from './policy.js';
export type {
  SourceKind,
  Authority,
  MemoryClass,
  RequestedOperation,
  PolicyInput,
  PolicyDecision,
  SourceEnvelope,
  SourceEnvelopeInput,
  ContextPackItem,
  RecallItem,
  RankedRecallItem,
} from './policy.js';
