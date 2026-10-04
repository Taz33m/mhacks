import test from 'node:test';
import assert from 'node:assert/strict';
import { stockContextToDeliver } from './stock-bridge.ts';
import type { WiliIncidentContext } from './protocol.ts';

test('reconnection starts at silent idle for a closed incident; a fresh closing transition still speaks', () => {
  for (const phase of ['RESOLVED', 'CANCELLED_FALSE_ALARM'] as const) {
    const context = { type: 'incident.context', phase, voiceAsset: 'RESOLVED' } as WiliIncidentContext;
    assert.equal(stockContextToDeliver(context, true, Date.now(), true)?.voiceAsset, null);
    assert.equal(stockContextToDeliver(context, true, Date.now(), true)?.phase, null);
    assert.equal(stockContextToDeliver(context, true, Date.now(), true)?.incidentId, null);
    assert.equal(stockContextToDeliver(context, true)?.voiceAsset, 'RESOLVED');
    assert.equal(context.voiceAsset, 'RESOLVED', 'restoring cannot mutate live transition context');
  }
});

test('setup and expired check-ins cannot play; a current check-in still can', () => {
  const context = { type: 'incident.context', phase: 'CONFIRMING', incidentId: 'fixture', checkinId: 'checkin',
    checkinDeadline: 100, voiceAsset: 'CHECKIN' } as WiliIncidentContext;
  assert.equal(stockContextToDeliver(context, false, 50, true), null);
  assert.equal(stockContextToDeliver(context, true, 100, true), null);
  assert.equal(stockContextToDeliver(context, true, 50, true)?.voiceAsset, 'CHECKIN');
});
