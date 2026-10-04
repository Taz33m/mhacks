import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindMyRequests } from './find-my-onboarding.ts';

test('native sharing card dedupes and interrupted submission never retries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeline-findmy-')), path = join(dir, 'test.sqlite');
  let requests = new FindMyRequests(path);
  try {
    const subject = { role: 'wearer' as const, address: '+15555550101', name: 'Demo wearer' };
    assert.equal(requests.queue('wearer:today', subject, 'test-chat'), true);
    assert.equal(requests.queue('wearer:today', subject, 'test-chat'), false);
    const action = requests.claim()!;
    assert.equal(action.subject.address, subject.address); assert.equal(requests.claim(), null);
    requests.close(); requests = new FindMyRequests(path);
    assert.equal(requests.view()!.status, 'unknown'); assert.equal(requests.claim(), null);
    assert.equal(requests.queue('wearer:today', subject, 'test-chat'), false);
    const visible = JSON.stringify(requests.view()); assert.ok(!visible.includes('test-chat')); assert.ok(!visible.includes(subject.address));
    assert.equal(requests.queue('bad', { ...subject, role: 'responder' }, 'test-chat'), false);
  } finally { requests.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('native request receipt stays private and responder status cannot replace wearer onboarding', () => {
  const requests = new FindMyRequests(':memory:');
  try {
    const wearer = { role: 'wearer' as const, address: '+15555550101', name: 'Demo wearer' };
    requests.queue('wearer:approved-chat', wearer, 'test-wearer-chat');
    const first = requests.claim()!;
    requests.finish(first.id, { status: 'provider_accepted', detail: 'Sharing card submitted; permission pending.', messageId: 'test-private-native-guid' });
    requests.queue('responder:incident:maya', { role: 'responder', address: '+15555550102', name: 'Maya', incidentId: 'LF-TEST', responderId: 'maya' }, 'test-responder-chat');
    const second = requests.claim()!;
    requests.finish(second.id, { status: 'failed', detail: 'Request failed before acceptance.' });
    assert.equal(requests.view()!.status, 'provider_accepted');
    assert.equal(requests.view('responder')!.status, 'failed');
    assert.equal(requests.queue('wearer:approved-chat', wearer, 'test-wearer-chat'), false);
    assert.equal(requests.claim(), null);
    assert.ok(!JSON.stringify(requests.view()).includes('test-private-native-guid'));
    requests.finish(first.id, { status: 'unknown', detail: 'Late duplicate result.' });
    assert.equal(requests.view()!.status, 'provider_accepted');
  } finally { requests.close(); }
});
