import assert from 'node:assert/strict';
import { patientFixture } from './patient-fixture.ts';

// Preloaded only by care-reply-server.test.ts. These are generated API/model
// responses, not a live Finch lookup or evidence of actual model inference.
const FINCH = 'https://api.finchnode.com/demo/v1/users/patient-demo-001/records?categories=demographics,medications,conditions,allergies,vitals';
const MODEL = 'http://127.0.0.1:11999/v1/chat/completions';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
let retrieval = 0;
globalThis.fetch = (async (input, options) => {
  if (String(input) === FINCH) {
    const fixture = structuredClone(patientFixture); retrieval++;
    fixture.data.medications[0].dosage = `Synthetic recorded regimen, fixture retrieval ${retrieval}`;
    fixture.data.allergies[0].reaction = `Historical fictional rash, fixture retrieval ${retrieval}`;
    return json(fixture);
  }
  if (String(input) !== MODEL) throw new Error('External network disabled in care-record integration test.');
  const request = JSON.parse(String(options?.body));
  if (request.response_format?.json_schema?.name === 'wellbeing_reply') {
    // Clinical replies and their saved source values must never enter the
    // ordinary companion model's conversation projection.
    assert.doesNotMatch(request.messages[1].content, /Fictional Patient|Fictional regimen|Fictional substance|Synthetic recorded regimen/);
    return json({ choices: [{ message: { content: JSON.stringify({ text: 'Thank you for sharing. What did you enjoy about your day?' }) } }] });
  }
  const selection = JSON.parse(request.messages[1].content) as {
    records: { id: string; category: string; data: Record<string, unknown> }[];
    currentVitalsRequested?: boolean; requiredPrimaryRecordIds?: string[];
  };
  assert.ok(Array.isArray(selection.records));
  const facts = selection.records.filter(record => !selection.requiredPrimaryRecordIds
    || selection.requiredPrimaryRecordIds.includes(record.id)).map(record => ({ recordId: record.id,
    fields: (record.category === 'allergies' ? ['substance', 'reaction']
      : record.category === 'medications' ? ['name', 'dosage', 'frequency'] : ['name'])
      .filter(field => Object.hasOwn(record.data, field)),
  }));
  const plan = { facts, incidentFields: selection.requiredPrimaryRecordIds ? ['evidence', 'createdAt'] : [],
    unavailable: selection.requiredPrimaryRecordIds ? ['location', 'currentVitals'] : selection.currentVitalsRequested ? ['currentVitals'] : [] };
  return json({ choices: [{ message: { content: JSON.stringify(plan) } }] });
}) as typeof fetch;
