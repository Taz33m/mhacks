import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedResponder, phoneIdentity } from './identity.ts';

test('Apple-ID email handles cannot alias an approved phone number', () => {
  const responders = [{ id: 'maya', name: 'Maya', phone: '+15551234567' }];
  assert.equal(approvedResponder('15551234567@example.com', responders), null);
  assert.equal(approvedResponder('tel:15551234567@example.com', responders), null);
  assert.equal(approvedResponder('+15551234567', responders)?.id, 'maya');
  assert.equal(approvedResponder('15551234567', responders)?.id, 'maya');
  assert.equal(approvedResponder('+15551234568', responders), null);
  assert.equal(phoneIdentity(''), null);
});
