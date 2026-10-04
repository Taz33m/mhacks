import test from 'node:test';import assert from 'node:assert/strict';
import {choiceText,patientChoices,patientFollowup,resolvePatientChoice} from './patient-followup.ts';
import type {WellbeingMessage} from './wellbeing.ts';
const message=(text:string):WellbeingMessage=>({id:'q',speaker:'lifeline',text,source:'agent',at:1,delivery:'provider_accepted'});
test('pain reports lead to duration then function, retaining reported context without diagnosis',()=>{
 const first=patientFollowup('My back hurts',[])!;assert.equal(patientChoices(first)?.title,'How long has this been bothering you?');
 const next=patientFollowup('2',[message(first)])!;assert.equal(patientChoices(next)?.title,'How much is it affecting your day?');
 assert.equal(resolvePatientChoice('three',next),'I need help now');
 assert.doesNotMatch(first+next,/posture|fracture|medicine|treatment/);
});
test('loneliness choices have meaningful follow-ups and offer writing without pretending to send',()=>{
 const first=patientFollowup('I feel lonely',[])!;assert.equal(patientChoices(first)?.options.length,3);
 assert.equal(patientFollowup('Talk for a bit',[message(first)]),'I’m here. What’s been on your mind?');
 assert.match(patientFollowup('2',[message(first)])!,/Who would you like to write to/);
 assert.equal(patientChoices('random data'),null);
});
