import test from 'node:test';
import assert from 'node:assert/strict';
import { patientReports } from './patient-reports.ts';
import { choiceText } from './patient-followup.ts';
import { Wellbeing, type WellbeingMessage } from './wellbeing.ts';
const m = (id: string, speaker: 'wearer' | 'lifeline', text: string, extra = {}): WellbeingMessage => ({ id, speaker, text,
  source: speaker === 'wearer' ? 'photon-imessage' : 'agent', at: Number(id) * 1000, delivery: speaker === 'wearer' ? 'recorded' : 'provider_accepted', ...extra });
const duration = choiceText('How long has this been bothering you?', ['Less than 3 days','3–7 days','More than a week']);
const impact = choiceText('How much is it affecting your day?', ['Manageable','Limiting what I can do','I need help now']);
test('explicit choices, provenance, follow-up and patient-reported trend', () => {
  const messages = [m('1','wearer','My back hurts'),m('2','lifeline',duration),m('3','wearer','Less than 3 days'),
    m('4','lifeline',impact),m('5','wearer','Manageable'),m('6','wearer','My back hurts'),m('7','lifeline',impact),
    m('8','wearer','Limiting what I can do'),m('9','lifeline','Can you describe the pain?', { source: 'care-team', author: 'Maya', reportId: '6' }),
    m('10','wearer','It hurts when I bend', { source: 'freewili-local-speech' })];
  const [first, second] = patientReports(messages);
  assert.equal(first.duration,'Less than 3 days'); assert.equal(first.impact,'Manageable');
  assert.equal(second.trend,'More impact reported'); assert.equal(second.followups[0].answer,'It hurts when I bend');
  assert.equal(second.evidence.at(-1)?.source,'freewili-local-speech');
});
test('unprompted, stale, negated reports do not invent fields', () => {
  assert.deepEqual(patientReports([m('1','wearer','My back does not hurt')]),[]);
  const [report] = patientReports([m('1','wearer','My ankle hurts'),m('2','wearer','More than a week'),m('3','wearer','Limiting what I can do')]);
  assert.equal(report.duration,null); assert.equal(report.impact,null);
});
test('care follow-up is persisted, deduped and not falsely marked delivered', () => {
  const wb = new Wellbeing(':memory:', { phone: '+15555550123', wearerName:'Morgan' }, () => 1000);
  assert.ok(wb.recordVoice({ eventId:'voice-1', conversationId:wb.conversationId, sessionId:'session-1', transcript:'My back hurts' }));
  const id = wb.view().reports[0].id;
  assert.ok(wb.queueFollowup(id,'Maya','When does it hurt?','request-1'));
  assert.equal(wb.queueFollowup(id,'Maya','When does it hurt?','request-1'),false);
  assert.equal(wb.queueFollowup('missing','Maya','When does it hurt?','request-2'),false);
  assert.equal(wb.view().reports[0].followups.length,0);
  const action = wb.claimAction()!; assert.equal(action.author,'Maya');
  wb.finishAction(action.id,'provider_accepted','accepted','provider-1');
  assert.equal(wb.view().reports[0].followups[0].answer,null);
  wb.recordVoice({ eventId:'voice-2', conversationId:wb.conversationId, sessionId:'session-1', transcript:'When I bend' });
  assert.equal(wb.view().reports[0].followups[0].answer,'When I bend'); wb.close();
});
