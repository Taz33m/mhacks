import { patientFixture } from './patient-fixture.ts';

// Generated source responses for ehr-server.test.ts only. No network, model
// inference, private patient access or transport receipt is represented here.
const FINCH = 'https://api.finchnode.com/demo/v1/users/patient-demo-001/records?categories=demographics,medications,conditions,allergies,vitals';
let retrieval = 0;
globalThis.fetch = async input => {
  if (String(input) !== FINCH) throw new Error('External network disabled in isolated EHR test.');
  retrieval++;
  if (retrieval === 1 && process.env.LIFELINE_EHR_FIXTURE_FAIL_FIRST === '1')
    return new Response('Generated unavailable source fixture.', { status: 503 });
  const fixture = structuredClone(patientFixture);
  fixture.data.medications[0].dosage = `Synthetic recorded regimen, generated EHR retrieval ${retrieval}`;
  fixture.data.allergies[0].reaction = `Historical fictional rash, generated EHR retrieval ${retrieval}`;
  return new Response(JSON.stringify(fixture), { headers: { 'Content-Type': 'application/json' } });
};
