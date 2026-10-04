import test from 'node:test';
import assert from 'node:assert/strict';
import {clinicalMessage} from './clinical-message.ts';
const input='Known source facts:\nmedications: Lisinopril 10 mg tablet; status: active; dosage: Take one synthetic tablet daily.; frequency: Daily; startDate: 2026-07-18; endDate: not returned; unknown [rec_abc123]\nmedications: Metformin 500 mg tablet; status: completed; dosage: Previous regimen: one tablet daily; frequency: Daily; startDate: 2026-01-18; endDate: 2026-07-17 [rec_def456]\nmedications: Metformin 500 mg tablet; status: active; dosage: one tablet twice daily with meals; frequency: Twice daily [rec_ghi789]\nCurrent vital signs are unavailable.\nAnything not listed is unknown.';
test('clinical messages distinguish active from past records and retain exact regimen values',()=>{
 const output=clinicalMessage(input);
 assert.ok(output.indexOf('• Lisinopril')<output.indexOf('• Previous:'));
 assert.ok(output.includes('one tablet twice daily with meals'));
 assert.ok(output.includes('Previous regimen: one tablet daily'));
 assert.ok(output.includes('2026-01-18 → 2026-07-17'));
 assert.ok(output.includes('Current vital signs are unavailable.'));
 assert.ok(!output.includes('rec_'));assert.ok(!output.includes('endDate: not returned'));
 assert.ok(!/\[\d+\]/.test(output));
});
test('nonclinical and patient-directed replies remain verbatim',()=>{
 assert.equal(clinicalMessage('Morgan, I’m on my way.'),'Morgan, I’m on my way.');
});
test('missing and unfamiliar status are not labelled current',()=>{
 const result=clinicalMessage('medications: Example; dosage: recorded value [rec_xyz]');
 assert.ok(!result.includes('Current medications'));assert.match(result,/Status unclear/);
});

test('patient-record daily replies use the named subject and hide raw record scaffolding',()=>{
 const output=clinicalMessage('From your health record:\n'+input,'Morgan Rivera');
 assert.match(output,/^• Lisinopril/);
 assert.doesNotMatch(output,/From your health record|Known source facts|rec_|endDate:|startDate:|\bsynthetic tablet\b/);
 assert.doesNotMatch(output,/Morgan’s medication records|Current medications|Previous medication records|Full citations/);
 assert.match(output,/• Previous:/);
 assert.match(output,/2026-07-17/);
});

test('allergy and unavailable-vitals answers contain facts without raw scaffolding',()=>{
 const output=clinicalMessage('From your health record:\nKnown source facts:\nallergies: Penicillin; status: active; reaction: Synthetic example: rash; severity: mild; recordedDate: 2021-03-15 [rec_example]\nUnavailable information:\nCurrent vital signs not provided.\nAnything not listed is unknown.','Morgan');
 assert.equal(output,'Allergy: Penicillin — rash.\nCurrent vital signs not provided.\nSource: Finch synthetic record.');
});
