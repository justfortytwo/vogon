import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlApprovalStore, InMemoryApprovalStore, type ApprovalStore } from '../src/index.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'gate-store-')), 'approvals.jsonl');
}

const stores: Array<[string, () => ApprovalStore]> = [
  ['InMemoryApprovalStore', () => new InMemoryApprovalStore()],
  ['JsonlApprovalStore', () => new JsonlApprovalStore(tmpFile())],
];

describe.each(stores)('%s — shared contract', (_name, make) => {
  const pending = { tool: 'X', target: 't1', payload: {}, tier: 'external', tool_use_id: 'tu_1' };

  it('list returns every staged approval with its current status', async () => {
    const store = make();
    await store.addPending(pending);
    await store.addPending({ ...pending, tool: 'Y', target: 't2', tool_use_id: 'tu_2' });
    await store.setDecisionByToolUseId('tu_2', 'approved', 'tester');

    const byId = Object.fromEntries((await store.list()).map((r) => [r.tool_use_id, r.status]));
    expect(Object.keys(byId).sort()).toEqual(['tu_1', 'tu_2']);
    expect(byId['tu_1']).toBe('pending');
    expect(byId['tu_2']).toBe('approved');
  });

  it('markExecuted consumes an approved record exactly once (one-shot)', async () => {
    const store = make();
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'approved');

    expect(await store.markExecutedByToolUseId('tu_1')).toBe(true);
    expect(await store.markExecutedByToolUseId('tu_1')).toBe(false); // already executed
    expect((await store.getByToolUseId('tu_1'))!.status).toBe('executed');
  });

  it('markExecuted refuses a record that was never approved', async () => {
    const store = make();
    await store.addPending(pending);
    expect(await store.markExecutedByToolUseId('tu_1')).toBe(false); // still pending
  });

  it('setDecision on an unknown tool_use_id returns false', async () => {
    const store = make();
    expect(await store.setDecisionByToolUseId('nope', 'approved')).toBe(false);
  });

  it('refuses to resurrect a consumed (executed) one-shot — approve-after-execute is a no-op', async () => {
    const store = make();
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'approved');
    await store.markExecutedByToolUseId('tu_1'); // consumed -> executed

    expect(await store.setDecisionByToolUseId('tu_1', 'approved')).toBe(false);
    expect((await store.getByToolUseId('tu_1'))!.status).toBe('executed');
  });

  it('refuses to flip a denied record back to approved — deny stays denied', async () => {
    const store = make();
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'denied');

    expect(await store.setDecisionByToolUseId('tu_1', 'approved')).toBe(false);
    expect((await store.getByToolUseId('tu_1'))!.status).toBe('denied');
  });
});

describe('JsonlApprovalStore — durability', () => {
  it('replays state across separate store instances on the same file (stage on turn N, read on N+1)', async () => {
    const file = tmpFile();
    const a = new JsonlApprovalStore(file);
    await a.addPending({ tool: 'X', target: 't', payload: {}, tier: 'external', tool_use_id: 'tu_1' });
    await a.setDecisionByToolUseId('tu_1', 'approved');

    const b = new JsonlApprovalStore(file); // fresh process simulation
    const row = await b.getByToolUseId('tu_1');
    expect(row?.status).toBe('approved');
  });

  it('ignores malformed and comment lines instead of crashing', async () => {
    const file = tmpFile();
    const store = new JsonlApprovalStore(file);
    await store.addPending({ tool: 'X', target: 't', payload: {}, tier: 'external', tool_use_id: 'tu_ok' });
    // Corrupt the file with junk a human might fat-finger.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, '# a comment\nnot json at all\n{"partial":\n');

    const rows = await store.list();
    expect(rows.map((r) => r.tool_use_id)).toEqual(['tu_ok']);
  });
});
