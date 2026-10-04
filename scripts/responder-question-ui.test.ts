import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the actual renderer against generated DOM/state, without initializing
// app.js's browser connection or contacting any provider.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = [
  ['  function appendText(', '\n  function renderMeasuredEvidence('],
  ['  function renderQuestions(', '\n  function updateRehearsalControls('],
  ['  function timelineDetail(', '\n  function renderActions('],
].map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end))).join('\n');
const labels = source.slice(source.indexOf('  const actionLabels ='), source.indexOf('\n  let snapshot ='));

class FixtureNode {
  tagName: string;
  className = '';
  children: FixtureNode[] = [];
  private value = '';
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  set textContent(value: unknown) { this.value = String(value ?? ''); this.children = []; }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('Question content must remain literal text.'); }
  appendChild(child: FixtureNode) {
    if (child.tagName === 'FRAGMENT') this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }
  replaceChildren(...children: FixtureNode[]) { this.value = ''; this.children = []; children.forEach(child => this.appendChild(child)); }
}

const incident = { id: 'LF-GENERATED-QUESTION', phase: 'HELP_REQUESTED', version: 4,
  contacted: ['fixture-responder', 'other-responder'], declined: [] as string[] };
const question = 'What did the wearer say? <img src=x onerror="alert(1)"> & "exact quote"';
const received = (inboundId = 'fixture-inbound', actor = 'fixture-responder', changes = {}) => ({
  id: `received-${inboundId}`, incidentId: incident.id, type: 'QUESTION_RECEIVED', actor, at: 100,
  detail: JSON.stringify({ question, inboundId, incidentVersion: incident.version, source: 'photon-imessage', providerTimestamp: 90 }), ...changes,
});
const queued = (inboundId = 'fixture-inbound', actor = 'fixture-responder', generation: unknown = 'ai') => ({
  id: `queued-${inboundId}`, incidentId: incident.id, type: 'ANSWER_QUEUED', actor, at: 200,
  detail: JSON.stringify({ question, inboundId, actionId: 'fixture-answer', source: 'photon-imessage', generation }),
});
const answer = { id: 'fixture-answer', incidentId: incident.id, type: 'answer', recipientId: 'fixture-responder', createdAt: 200,
  status: 'provider_accepted', text: 'Wearer: "My ankle hurts." [report:fixture-report]', providerResult: 'Provider accepted the request; receipt is not established.' };

function fixture(state = { incident, timeline: [] as ReturnType<typeof received>[], actions: [] as typeof answer[] }) {
  const elements = new Map<string, FixtureNode>();
  const node = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new FixtureNode());
    return elements.get(selector)!;
  };
  const document = { createElement: (tag: string) => new FixtureNode(tag), createDocumentFragment: () => new FixtureNode('fragment') };
  const api = runInNewContext(`${labels}\n${functions}\n({ renderQuestions, timelineDetail });`, {
    snapshot: state, document, $: node, text: (selector: string, value: unknown) => { node(selector).textContent = value; },
    nameFor: (id: string) => id === 'fixture-responder' ? 'Generated responder' : id,
    time: (at: number) => `fixture time ${at}`,
    terminal: (i: typeof incident) => ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(i?.phase),
  }) as { renderQuestions(): void; timelineDetail(event: { type: string; detail: string }): string };
  api.renderQuestions();
  return { ...api, node, rows: node('#responder-questions').children };
}

test('received question appears once, literal and pending, before an answer exists', () => {
  const result = fixture({ incident, timeline: [received(), received()], actions: [] });
  assert.equal(result.node('#question-count').textContent, '1');
  assert.equal(result.rows.length, 1);
  assert.ok(result.rows[0].textContent.includes(question));
  assert.match(result.rows[0].textContent, /Answer pending/);
  assert.match(result.rows[0].textContent, /No answer has been queued yet/);
  assert.doesNotMatch(result.rows[0].textContent, /AI GENERATED|Provider accepted/);
  assert.equal(result.rows[0].children.filter(child => child.className === 'question-text')[0].children.length, 0);
});

test('matching queued answer replaces the pending row and preserves provenance and actual delivery status', () => {
  for (const [generation, expected] of [['ai', 'AI GENERATED'], ['degraded', 'DEGRADED TEMPLATE'], ['policy_refusal', 'POLICY REFUSAL']]) {
    const result = fixture({ incident, timeline: [received(), queued('fixture-inbound', 'fixture-responder', generation)], actions: [answer] });
    assert.equal(result.rows.length, 1);
    assert.equal(result.node('#question-count').textContent, '1');
    assert.ok(result.rows[0].textContent.includes(question));
    assert.ok(result.rows[0].textContent.includes(answer.text));
    assert.match(result.rows[0].textContent, /Provider accepted/);
    assert.ok(result.rows[0].textContent.includes(expected));
    assert.doesNotMatch(result.rows[0].textContent, /Answer pending|Delivered|Received for answer preparation/);
  }
});

test('pairing uses responder and inbound identity rather than identical question text or ambiguous ID concatenation', () => {
  for (const event of [queued('different-inbound'), queued('fixture-inbound', 'other-responder')]) {
    const result = fixture({ incident, timeline: [received(), event], actions: [answer] });
    assert.equal(result.rows.length, 2);
    assert.match(result.rows.map(row => row.textContent).join('\n'), /Answer pending/);
  }
  const result = fixture({ incident, timeline: [received('c', 'a:b'), queued('b:c', 'a')], actions: [answer] });
  assert.equal(result.rows.length, 2);
});

test('context changes stop implying active answer preparation and other incidents are excluded', () => {
  for (const changed of [{ ...incident, version: 5 }, { ...incident, phase: 'RESOLVED' }, { ...incident, declined: ['fixture-responder'] }]) {
    const result = fixture({ incident: changed, timeline: [received(), received('other', 'fixture-responder', { incidentId: 'LF-OTHER' })], actions: [] });
    assert.equal(result.rows.length, 1);
    assert.match(result.rows[0].textContent, /Context changed/);
    assert.doesNotMatch(result.rows[0].textContent, /Answer pending|Received for answer preparation/);
  }
});

test('legacy answers retain unavailable provenance and hostile or unsupported generation never implies AI', () => {
  const legacy = { ...queued(), detail: 'Responder answer queued; delivery is not yet established.' };
  for (const event of [legacy, queued('fixture-inbound', 'fixture-responder', '__proto__'), queued('fixture-inbound', 'fixture-responder', 'constructor'),
    queued('fixture-inbound', 'fixture-responder', '<svg onload=alert(1)>')]) {
    const result = fixture({ incident, timeline: [event], actions: [answer] });
    assert.equal(result.rows.length, 1);
    assert.match(result.rows[0].textContent, /PROVENANCE UNAVAILABLE/);
    if (event === legacy) assert.match(result.rows[0].textContent, /Question unavailable/);
    assert.ok(result.rows[0].textContent.includes(answer.text));
  }
});

test('timeline explains receipt separately from queued provenance and preserves unsupported legacy text', () => {
  const result = fixture();
  const receipt = result.timelineDetail(received());
  assert.ok(receipt.startsWith(`Question received: ${question}\n`));
  assert.match(receipt, /Queued for answer preparation/);
  assert.match(receipt, /does not establish an answer or delivery/);
  assert.match(result.timelineDetail(queued()), /Answer queued · ai generated/);
  assert.match(result.timelineDetail(queued('fixture-inbound', 'fixture-responder', 'constructor')), /provenance unavailable/);
  for (const detail of ['Legacy question <tag> & "quote"', '{broken', JSON.stringify({ question, source: 'unsupported' })])
    assert.equal(result.timelineDetail({ type: 'QUESTION_RECEIVED', detail }), detail);
});
