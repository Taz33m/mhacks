import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Chat, Message, MessageListFilter, MessageListPage } from '@photon-ai/advanced-imessage/grpc';
import { readUnknownActions, runPhotonReadiness, writePrivateReadinessReport } from './photon-readiness.ts';

// Synthetic offline addresses/messages. Every HTTP and native read is injected.
const wearer = '+12025550111', responder = '+41225550222', line = '+12025559999';
const now = Date.parse('2026-10-04T01:20:00Z'), createdAt = now - 20_000, registeredAt = now - 60_000;
const env = { SPECTRUM_PROJECT_ID: 'offline-project-private', SPECTRUM_PROJECT_SECRET: 'offline-secret-private',
  LIFELINE_WEARER_PHONE: wearer, LIFELINE_RESPONDERS_JSON: JSON.stringify([{ id: 'approved-helper-private', name: 'Private fixture name', phone: responder }]) };
const action = { id: 'local-action-private', type: 'alert' as const, recipientId: 'approved-helper-private', status: 'unknown' as const,
  createdAt, text: 'SYNTHETIC original unknown body must never appear in report.', providerMessageId: null as string | null };
const chatId = (phone: string) => `any;-;${phone}`;
const user = (phone: string) => ({ id: `user-${phone}`, projectId: env.SPECTRUM_PROJECT_ID, type: 'shared', phoneNumber: phone,
  assignedPhoneNumber: line, createdAt: new Date(registeredAt).toISOString(), firstName: 'Hidden', lastName: 'Hidden', email: 'hidden@example.test', meta: { private: 'Hidden' } });
function message(phone: string, options: Partial<Message> = {}): Message {
  return { guid: `native-${phone}-${options.isFromMe ? 'out' : 'in'}`, chatGuids: [chatId(phone)],
    content: { text: options.isFromMe ? action.text : 'Private inbound words.', attachments: [], formatting: [], mentions: [] },
    isFromMe: false, isSent: true, isDelivered: true, sendErrorCode: 0,
    dateCreated: new Date(createdAt + 1000), dateDelivered: new Date(createdAt + 2000), destinationCallerId: `p:${line}`,
    sender: { address: phone, service: phone === wearer ? 'iMessage' : 'RCS' }, appliedReactions: [], placedStickers: [],
    ...options } as Message;
}
type UsersPage = { users: ReturnType<typeof user>[]; total: number };
function fixture(options: {
  users?: (phone: string, offset: number) => UsersPage;
  pages?: (phone: string, filter: MessageListFilter) => MessageListPage;
  native?: (guid: string, original: Message | undefined) => Message;
  chat?: (phone: string) => Chat;
  getError?: unknown;
  httpFailure?: boolean;
} = {}) {
  let closes = 0, creations = 0;
  const gets: string[] = [], requests: { path: string; method: string; phone?: string; offset?: number }[] = [], historyReads: string[] = [];
  const source = [message(wearer), message(responder), message(responder, { isFromMe: true })];
  const fetcher = (async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://spectrum.photon.codes');
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    if (parsed.pathname.endsWith('/imessage/tokens')) {
      assert.equal(init?.method, 'POST'); requests.push({ path: 'token', method: 'POST' });
      return new Response(JSON.stringify({ succeed: true, data: { type: 'shared', token: 'offline-token-private' } }), { headers: { 'Content-Type': 'application/json' } });
    }
    assert.ok(parsed.pathname.endsWith('/users/')); assert.equal(init?.method, 'GET');
    assert.equal(parsed.searchParams.get('type'), 'shared'); assert.equal(parsed.searchParams.get('limit'), '100');
    const phone = parsed.searchParams.get('search')!, offset = Number(parsed.searchParams.get('offset'));
    assert.ok([wearer, responder].includes(phone)); requests.push({ path: 'users', method: 'GET', phone, offset });
    if (options.httpFailure) return new Response(`Private ${env.SPECTRUM_PROJECT_SECRET} ${phone}`, { status: 403 });
    return new Response(JSON.stringify({ succeed: true, data: options.users?.(phone, offset) ?? { users: [user(phone)], total: 1 } }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const clientFactory = async (token: string) => {
    assert.equal(token, 'offline-token-private'); creations++;
    return {
      chats: { get: async (guid: string) => {
        const phone = guid.slice('any;-;'.length);
        return options.chat?.(phone) ?? { guid, isGroup: false, isArchived: false, isFiltered: false,
          service: phone === wearer ? 'iMessage' : 'RCS', participants: [], displayName: 'Not copied' } as Chat;
      } },
      messages: {
        listInChat: async (guid: string, filter: MessageListFilter) => {
          assert.equal(filter.pageSize, 100); assert.equal(filter.before?.getTime(), now);
          historyReads.push(guid); const phone = guid.slice('any;-;'.length);
          return options.pages?.(phone, filter) ?? { messages: source.filter(m => m.chatGuids.includes(guid)) };
        },
        get: async (guid: string) => {
          gets.push(guid); if (options.getError) throw options.getError;
          const original = source.find(m => m.guid === guid);
          return options.native?.(guid, original) ?? original!;
        },
      },
      close: async () => { closes++; },
    };
  };
  return { source, requests, gets, historyReads, closes: () => closes, creations: () => creations,
    run: (additional: Partial<Parameters<typeof runPhotonReadiness>[0]> = {}) =>
      runPhotonReadiness({ env, unknownActions: [action], fetch: fetcher, clientFactory, now: () => now, httpGapMs: 0, ...additional }),
  };
}
function assertPrivate(report: unknown) {
  const serialized = JSON.stringify(report);
  for (const hidden of [wearer, responder, action.id, action.text, env.SPECTRUM_PROJECT_ID, env.SPECTRUM_PROJECT_SECRET,
    'offline-token-private', 'Private inbound words.', 'hidden@example.test', 'approved-helper-private']) assert.ok(!serialized.includes(hidden), hidden);
}

test('approved conversation/native caller and exact unknown delivery are proved read-only without quota claims or private bodies', async () => {
  const f = fixture(), original = JSON.stringify(action), report = await f.run();
  assert.equal(report.status, 'read_evidence_available'); assert.equal(report.externalMessages, false);
  assert.equal(report.outboundReadiness, 'not_probed'); assert.equal(report.warmupQuota, 'not_exposed_by_read_api');
  assert.equal(report.unknownActionsUnchanged, true); assert.equal(JSON.stringify(action), original);
  assert.equal(f.closes(), 1); assert.equal(f.creations(), 1);
  const [w, r] = report.results;
  assert.equal(w.assignedLine, line); assert.equal(r.assignedLine, line);
  assert.equal(w.service, 'iMessage'); assert.equal(r.service, 'RCS');
  for (const role of report.results) {
    assert.equal(role.observedInboundTexts, 1); assert.equal(role.inboundCountIsQuotaCounter, false);
    assert.equal(role.nativeLine.verified, true); assert.equal(role.historyComplete, true);
  }
  assert.equal(r.unknownActions[0].status, 'unknown_preserved'); assert.equal(r.unknownActions[0].evidence, 'matching_native_candidate');
  assert.equal(r.unknownActions[0].correlation, 'exact_content_window'); assert.equal(r.unknownActions[0].nativeState, 'delivered');
  assert.equal(r.unknownActions[0].native[0].deliveredAt, new Date(createdAt + 2000).toISOString());
  assertPrivate(report);
});

test('Users pagination follows published limit/offset/total and never suffix-matches another registered number', async () => {
  const unrelated = Array.from({ length: 100 }, (_, index) => ({ ...user(`+1202556${String(index).padStart(4, '0')}`), id: `unrelated-${index}` }));
  const f = fixture({ users: (phone, offset) => phone === wearer
    ? { users: offset === 0 ? unrelated : [user(wearer)], total: 101 } : { users: [user(phone)], total: 1 } });
  const report = await f.run();
  assert.equal(report.results[0].registration, 'verified'); assert.equal(report.results[0].assignedLine, line);
  assert.deepEqual(f.requests.filter(r => r.phone === wearer).map(r => r.offset), [0, 100]); assertPrivate(report);
  const alias = fixture({ users: phone => ({ users: [{ ...user(phone), phoneNumber: `+99${phone.slice(1)}` }], total: 1 }) });
  const absent = await alias.run();
  assert.ok(absent.results.every(role => role.registration === 'not_found' && role.assignedLine === null));
  assert.equal(alias.historyReads.length, 0); assert.equal(alias.gets.length, 0);
});

test('incomplete, repeated, changing-total and duplicate-contact Users evidence cannot authorize a line', async () => {
  const scenarios = [
    { maxPages: 1, users: (phone: string) => ({ users: [user(phone)], total: 2 }), expected: 'incomplete' },
    { maxPages: 3, users: (phone: string) => ({ users: [user(phone)], total: 2 }), expected: 'incomplete' },
    { maxPages: 3, users: (phone: string, offset: number) => ({ users: offset ? [{ ...user(phone), id: 'second' }] : [user(phone)], total: offset ? 3 : 2 }), expected: 'incomplete' },
    { maxPages: 3, users: (phone: string) => ({ users: [user(phone), { ...user(phone), id: 'second' }], total: 2 }), expected: 'ambiguous' },
  ];
  for (const scenario of scenarios) {
    const f = fixture({ users: scenario.users }), report = await f.run({ maxPages: scenario.maxPages });
    assert.equal(report.status, 'attention_required');
    assert.ok(report.results.every(role => role.registration === scenario.expected && role.assignedLine === null));
    assert.equal(f.historyReads.length, 0); assert.equal(f.gets.length, 0); assertPrivate(report);
  }
});

test('history pagination reaches later native messages and suppresses unrelated sender counts', async () => {
  const f = fixture({ pages: (phone, filter) => phone === responder && !filter.pageToken
    ? { messages: [message(responder)], nextPageToken: 'second-page-private' }
    : { messages: phone === responder ? [message(responder, { isFromMe: true })] : [message(wearer),
      message(wearer, { guid: 'unrelated-inbound', sender: { address: 'unrelated@example.test', service: 'iMessage' } })] } });
  const report = await f.run();
  assert.equal(report.results[1].historyPages, 2); assert.equal(report.results[1].historyComplete, true);
  assert.equal(report.results[1].unknownActions[0].evidence, 'matching_native_candidate');
  assert.equal(report.results[0].observedInboundTexts, 1); assertPrivate(report);
});

test('bounded or cyclic history cannot prove unique unknown outcomes, and multiple exact matches stay ambiguous without extra get calls', async () => {
  for (const cyclic of [false, true]) {
    const f = fixture({ pages: phone => ({ messages: [message(phone, { isFromMe: true })], nextPageToken: 'repeated-private-page' }) });
    const report = await f.run({ maxPages: cyclic ? 5 : 1 });
    assert.equal(report.results[1].historyComplete, false); assert.equal(report.results[1].unknownActions[0].evidence, 'ambiguous');
    assert.ok(report.results[1].historyPages <= (cyclic ? 2 : 1)); assertPrivate(report);
  }
  const many = fixture({ pages: phone => ({ messages: [message(phone, { isFromMe: true }), message(phone, { guid: 'second-match', isFromMe: true })] }) });
  const report = await many.run();
  assert.equal(report.results[1].unknownActions[0].candidateCount, 2);
  assert.equal(report.results[1].unknownActions[0].evidence, 'ambiguous'); assert.equal(many.gets.length, 0);
});

test('delivery proof requires exact native ID, approved chat, outbound direction, text, time and assigned caller', async () => {
  const changes: Partial<Message>[] = [
    { guid: 'wrong-id' }, { chatGuids: [chatId(wearer)] }, { isFromMe: false },
    { content: { text: 'Other private text.', attachments: [], formatting: [], mentions: [] } },
    { dateCreated: new Date(createdAt - 2000) }, { dateCreated: new Date(now + 1000) },
    { destinationCallerId: `p:${wearer}` }, { destinationCallerId: 'e:private@example.test' },
  ];
  for (const change of changes) {
    const f = fixture({ native: (_id, original) => ({ ...original!, ...change }) }), report = await f.run({
      unknownActions: [{ ...action, providerMessageId: message(responder, { isFromMe: true }).guid }],
    });
    const evidence = report.results[1].unknownActions[0];
    assert.equal(evidence.evidence, 'unverified'); assert.equal(evidence.verifiedMatchCount, 0); assertPrivate(report);
  }
});

test('sent alone, native errors and conflicting delivery flags never become delivered evidence', async () => {
  for (const [change, expected] of [
    [{ isDelivered: false, dateDelivered: undefined }, 'sent_not_delivered'],
    [{ isSent: false, isDelivered: false }, 'unverified'],
    [{ isSent: false, isDelivered: true }, 'conflicting_native_state'],
    [{ isDelivered: false, sendErrorCode: 4 }, 'native_failed'],
    [{ isDelivered: true, sendErrorCode: 4 }, 'conflicting_native_state'],
  ] as const) {
    const f = fixture({ native: (_id, original) => ({ ...original!, ...change }) }), report = await f.run({
      unknownActions: [{ ...action, providerMessageId: message(responder, { isFromMe: true }).guid }],
    });
    assert.equal(report.results[1].unknownActions[0].evidence, expected);
    assert.equal(report.results[1].unknownActions[0].status, 'unknown_preserved'); assertPrivate(report);
  }
});

test('native caller conflict and wrong chat remain visible, while missing history never marks unknown actions failed', async () => {
  const conflict = fixture({ pages: phone => ({ messages: [message(phone, { destinationCallerId: `p:${wearer}` })] }) });
  const conflicted = await conflict.run();
  assert.equal(conflicted.status, 'attention_required'); assert.ok(conflicted.results.every(r => !r.nativeLine.verified && r.nativeLine.conflictingMessages === 1));
  assert.equal(conflicted.results[1].unknownActions[0].evidence, 'not_found_in_window'); assertPrivate(conflicted);
  const mismatch = fixture({ chat: phone => ({ guid: `wrong-${phone}`, isGroup: false, service: 'SMS' } as Chat) });
  const wrong = await mismatch.run();
  assert.equal(wrong.status, 'attention_required'); assert.ok(wrong.results.every(r => !r.exactChatMatched));
  assert.equal(mismatch.historyReads.length, 0); assertPrivate(wrong);
});

test('read errors redact arbitrary SDK/HTTP context and still close the client', async () => {
  const f = fixture({ getError: Object.assign(new Error(`${env.SPECTRUM_PROJECT_SECRET} ${responder} private body`), { grpcCode: 8,
    context: { token: 'offline-token-private' } }) }), report = await f.run();
  assert.equal(report.results[1].unknownActions[0].evidence, 'unverified'); assert.equal(f.closes(), 1);
  assert.deepEqual(report.results[1].errors, [{ operation: 'message', grpcCode: 8 }]); assertPrivate(report);
  const denied = fixture({ httpFailure: true }), unavailable = await denied.run();
  assert.ok(unavailable.results.every(role => role.registration === 'unavailable'));
  assert.ok(unavailable.results.every(role => role.errors[0].httpStatus === 403)); assert.equal(denied.closes(), 1); assertPrivate(unavailable);
});

test('an original native provider ID can identify one verified message even when history pagination is incomplete', async () => {
  const f = fixture({ pages: phone => ({ messages: [message(phone)], nextPageToken: 'more-private' }) });
  const report = await f.run({ maxPages: 1, unknownActions: [{ ...action, providerMessageId: message(responder, { isFromMe: true }).guid }] });
  assert.equal(report.results[1].historyComplete, false); assert.equal(report.results[1].unknownActions[0].evidence, 'delivered');
  assert.equal(report.results[1].unknownActions[0].correlation, 'provider_message_id');
  assert.equal(report.results[1].unknownActions[0].status, 'unknown_preserved'); assertPrivate(report);
});

test('a unique later same-text delivery is only a candidate without an original provider ID', async () => {
  const f = fixture({ native: (_id, original) => ({ ...original!, dateCreated: new Date(now - 1000), dateDelivered: new Date(now - 500) }) });
  const report = await f.run(), evidence = report.results[1].unknownActions[0];
  assert.equal(evidence.correlation, 'exact_content_window'); assert.equal(evidence.candidateCount, 1);
  assert.equal(evidence.nativeState, 'delivered'); assert.equal(evidence.evidence, 'matching_native_candidate');
  assert.equal(evidence.status, 'unknown_preserved'); assertPrivate(report);
});

test('existing SQLite is opened read-only and optional reports have mode0600 even when replacing an older file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-offline-photon-'));
  try {
    const path = join(directory, 'isolated.sqlite'), db = new DatabaseSync(path);
    db.exec('CREATE TABLE actions(status TEXT, body TEXT)');
    db.prepare('INSERT INTO actions VALUES(?,?)').run('unknown', JSON.stringify(action));
    db.prepare('INSERT INTO actions VALUES(?,?)').run('queued', JSON.stringify({ ...action, status: 'queued' })); db.close();
    const before = await readFile(path), loaded = readUnknownActions(path);
    assert.equal(loaded.length, 1); assert.deepEqual(loaded[0], action);
    const report = await fixture().run({ unknownActions: loaded });
    assert.deepEqual(await readFile(path), before, 'No Controller startup recovery or action reconciliation writes are allowed.');
    const output = join(directory, 'report.json');
    await writePrivateReadinessReport(output, report); await chmod(output, 0o644); await writePrivateReadinessReport(output, report);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assertPrivate(JSON.parse(await readFile(output, 'utf8')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
