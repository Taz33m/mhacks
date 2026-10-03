import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller.ts';
import type { ProviderInbound } from './contracts.ts';
import { handleResponderQuestion } from './responder-questions.ts';

const responders = [
  { id: 'maya', name: 'Maya', phone: '+12025550101' },
  { id: 'jordan', name: 'Jordan', phone: '+12025550102' },
  { id: 'lee', name: 'Lee', phone: '+12025550103' },
];
function setup(path = ':memory:') {
  let t = 1000;
  const c = new Controller(path, responders, () => t, { checkinMs: 20, acceptMs: 60_000, progressMs: 120_000 });
  const i = c.active() ?? c.trigger({ kind: 'manual', summary: 'Synthetic question test' });
  while (true) {
    const a = c.claimAction('responders'); if (!a) break;
    c.finishAction(a.id, 'provider_accepted', 'Offline fixture', `sent-${a.id}`);
  }
  return { c, i, advance: (ms: number) => { t += ms; } };
}
function question(messageId: string, extra: Partial<ProviderInbound> = {}): ProviderInbound {
  return { messageId, kind: 'text', sender: responders[0].phone, text: 'What medications are recorded?', ...extra };
}
const generate = async () => 'Synthetic record med-1: example medication. Missing details are unknown.';

test('distinct questions in one phase persist separate answers and concurrent duplicates commit once', async () => {
  const { c, i } = setup();
  try {
    const results = await Promise.all([
      handleResponderQuestion(question('q1'), c, generate),
      handleResponderQuestion(question('q1'), c, generate),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await handleResponderQuestion(question('q2'), c, generate), true);
    assert.equal(await handleResponderQuestion(question('q1'), c, () => { throw new Error('Duplicate generated again'); }), false);
    assert.equal(c.actions(i.id).filter(a => a.type === 'answer').length, 2);
    assert.equal(c.events(i.id).filter(e => e.type === 'ANSWER_QUEUED').length, 2);
    const exchanges = c.events(i.id).filter(e => e.type === 'ANSWER_QUEUED').map(e => JSON.parse(e.detail));
    for (const exchange of exchanges) {
      assert.equal(exchange.question, 'What medications are recorded?');
      assert.equal(exchange.source, 'photon-imessage');
      assert.equal(c.actions(i.id).find(a => a.id === exchange.actionId)?.type, 'answer');
    }
    assert.deepEqual(exchanges.map(e => e.inboundId).sort(), ['q1', 'q2']);
    assert.equal(c.active()?.phase, 'HELP_REQUESTED');
    assert.equal(c.active()?.ownerId, null);
  } finally { c.close(); }
});

test('question audit keeps individual answer provenance and marks oversized substitutes degraded', async () => {
  const { c, i } = setup();
  try {
    const original = 'What should I know before I arrive?';
    assert.equal(await handleResponderQuestion(question('model-q', { text: original }), c,
      async () => ({ text: 'Known synthetic allergy [allergy-1]. Location unknown.', generation: 'ai' })), true);
    assert.equal(await handleResponderQuestion(question('long-q'), c,
      async () => ({ text: 'x'.repeat(6001), generation: 'ai' })), true);
    const details = c.events(i.id).filter(e => e.type === 'ANSWER_QUEUED').map(e => JSON.parse(e.detail));
    assert.equal(details[0].question, original);
    assert.equal(details[0].generation, 'ai');
    assert.equal(details[1].generation, 'degraded');
    assert.match(c.actions(i.id).find(a => a.id === details[1].actionId)!.text, /exceeds the message limit/);
  } finally { c.close(); }
});

test('only eligible contacted identities and current message targets can ask questions', async () => {
  const { c, i } = setup();
  try {
    const alert = c.actions(i.id).find(a => a.type === 'alert' && a.recipientId === 'maya')!;
    const rejected: Partial<ProviderInbound>[] = [
      { sender: '+12025550999' }, { sender: responders[2].phone },
      { targetMessageId: 'unknown' }, { targetMessageId: '' },
      { targetMessageId: c.actions(i.id).find(a => a.recipientId === 'jordan')!.providerMessageId! },
      { removed: true }, { kind: 'reaction', reaction: 'like' },
      { text: 'Question LF-OLD12345' }, { text: `Question LF-OLD12345 and ${i.id}` },
      { text: 'ON IT LF-OLD12345' }, { text: 'DEPART' },
    ];
    for (const [n, extra] of rejected.entries())
      assert.equal(await handleResponderQuestion(question(`reject-${n}`, extra), c, () => { throw new Error('Unauthorized generation'); }), false);
    assert.equal(await handleResponderQuestion(question('valid', { targetMessageId: alert.providerMessageId! }), c, generate), true);
    const answer = c.claimAction('responders')!;
    c.finishAction(answer.id, 'provider_accepted', 'Offline fixture', 'answer-target');
    assert.equal(c.incidentForMessage('answer-target', 'maya'), null, 'An answer must not become a tapback acceptance target');
    assert.equal(await handleResponderQuestion(question('followup', { targetMessageId: 'answer-target' }), c, generate), true);
    c.decline(i.id, 'maya');
    assert.equal(await handleResponderQuestion(question('declined'), c, () => { throw new Error('Declined generation'); }), false);
  } finally { c.close(); }
});

test('delimiter-containing identities and message IDs cannot collapse separate answers', async () => {
  const c = new Controller(':memory:', [
    { ...responders[0], id: 'maya:turn' }, { ...responders[1], id: 'maya' },
  ]);
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Synthetic collision test' });
    assert.equal(await handleResponderQuestion(question('answer-1'), c, generate), true);
    assert.equal(await handleResponderQuestion(question('turn:answer-1', { sender: responders[1].phone }), c, generate), true);
    assert.equal(c.actions(i.id).filter(a => a.type === 'answer').length, 2);
  } finally { c.close(); }
});

test('old incident targets and codes cannot be rescued by the new active incident', async () => {
  const { c, i } = setup();
  try {
    const oldTarget = c.actions(i.id).find(a => a.type === 'alert')!.providerMessageId!;
    c.reset(); const next = c.trigger({ kind: 'manual', summary: 'Next synthetic incident' });
    assert.equal(await handleResponderQuestion(question('stale-target', { targetMessageId: oldTarget, text: `Records for ${next.id}?` }), c, generate), false);
    assert.equal(await handleResponderQuestion(question('stale-code', { text: `Records for ${i.id}?` }), c, generate), false);
    assert.equal(c.actions(next.id).some(a => a.type === 'answer'), false);
  } finally { c.close(); }
});

test('decline, closure, shutdown, or phase changes during generation prevent queueing', async () => {
  for (const change of ['decline', 'close', 'phase', 'shutdown'] as const) {
    const { c, i } = setup();
    try {
      let ready!: (text: string) => void;
      let canQueue = true;
      const result = handleResponderQuestion(question(change), c,
        () => new Promise(resolve => { ready = resolve; }), () => canQueue);
      if (change === 'decline') c.decline(i.id, 'maya');
      if (change === 'close') c.reset();
      if (change === 'phase') c.accept(i.id, 'jordan');
      if (change === 'shutdown') canQueue = false;
      ready('Snapshot answer');
      assert.equal(await result, false, change);
      assert.equal(c.seenInbound(change), false);
      assert.equal(c.actions(i.id).some(a => a.type === 'answer'), false);
    } finally { c.close(); }
  }
});

test('confirmed answer failures retry through the outbox while unknown submissions do not', async () => {
  const { c, i, advance } = setup();
  try {
    await handleResponderQuestion(question('failed'), c, generate);
    const failed = c.claimAction('responders')!; assert.equal(failed.type, 'answer');
    c.finishAction(failed.id, 'failed', 'Offline pre-submission failure');
    await handleResponderQuestion(question('unknown'), c, generate);
    const unknown = c.claimAction('responders')!;
    c.finishAction(unknown.id, 'unknown', 'Offline uncertain submission');
    advance(10_001);
    const retry = c.claimAction('responders')!;
    assert.equal(retry.id, failed.id); assert.equal(retry.attempts, 2);
    c.finishAction(retry.id, 'provider_accepted', 'Offline accepted', 'reply-1');
    assert.equal(c.claimAction('responders'), null);
    assert.equal(c.actions(i.id).find(a => a.id === unknown.id)?.status, 'unknown');
  } finally { c.close(); }
});

test('prepared answers lose submission permission after decline, progress, or resolution', async () => {
  for (const change of ['decline', 'progress', 'resolve'] as const) {
    const { c, i } = setup();
    try {
      c.accept(i.id, 'maya');
      if (change === 'resolve') c.progress(i.id, 'maya', 'arrive');
      await handleResponderQuestion(question(change), c, generate);
      const answer = c.actions(i.id).find(a => a.type === 'answer')!;
      assert.equal(c.actionPermitted(answer), true);
      if (change === 'decline') c.decline(i.id, 'maya');
      if (change === 'progress') c.progress(i.id, 'maya', 'depart');
      if (change === 'resolve') c.resolve(i.id, 'maya', 'Synthetic outcome reported on scene.');
      assert.equal(c.actionPermitted(answer), false, change);
      while (c.claimAction('responders')) { /* Obsolete queued answers must cancel instead of submitting. */ }
      assert.equal(c.actions(i.id).find(a => a.id === answer.id)?.status, 'cancelled');
    } finally { c.close(); }
  }
});

test('answer, inbound dedupe, and audit roll back together if persistence fails', async () => {
  const { c, i } = setup();
  try {
    c.db.exec("CREATE TRIGGER reject_answer_event BEFORE INSERT ON events WHEN json_extract(NEW.body,'$.type')='ANSWER_QUEUED' BEGIN SELECT RAISE(ABORT,'Offline failure'); END;");
    await assert.rejects(handleResponderQuestion(question('rollback'), c, generate), /Offline failure/);
    assert.equal(c.seenInbound('rollback'), false);
    assert.equal(c.actions(i.id).some(a => a.type === 'answer'), false);
    c.db.exec('DROP TRIGGER reject_answer_event');
    assert.equal(await handleResponderQuestion(question('rollback'), c, generate), true);
  } finally { c.close(); }
});

test('queued answers and inbound dedupe survive restart without repeating generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-answer-')); const path = join(dir, 'state.sqlite');
  let c: Controller | null = null;
  try {
    ({ c } = setup(path));
    const id = c.active()!.id;
    await handleResponderQuestion(question('persisted'), c, generate);
    const answerId = c.actions(id).find(a => a.type === 'answer')!.id;
    c.close(); c = new Controller(path, responders, () => 1000);
    assert.equal(await handleResponderQuestion(question('persisted'), c, () => { throw new Error('Repeated generation'); }), false);
    assert.equal(c.claimAction('responders')?.id, answerId);
    c.close(); c = new Controller(path, responders, () => 1000);
    assert.equal(c.actions(id).find(a => a.id === answerId)?.status, 'unknown');
    assert.equal(c.claimAction('responders'), null);
  } finally { c?.close(); rmSync(dir, { recursive: true, force: true }); }
});
