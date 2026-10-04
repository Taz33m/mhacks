import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, FINCH_DEMO_URL } from '../src/providers/index.ts';
import { patientFixture } from '../src/test-helpers/patient-fixture.ts';
import { createIncidentSmokeProviders, GENERATED_OUTCOME, GENERATED_WEARER_STATEMENT, GENERATED_WEARER_UPDATE, runIncidentFlowSmoke } from './incident-flow-smoke.ts';

interface ModelInput {
  question: string; requiredPrimaryRecordIds?: string[];
  localReports?: { id: string; speaker: string; text: string }[];
  records: { id: string; category: string; data: Record<string, unknown> }[];
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function rehearsalProviders(options: { modelUnavailable?: boolean; healthUnavailable?: boolean } = {}) {
  const requests: string[] = [], modelInputs: ModelInput[] = [];
  let messagingStarts = 0;
  const providers = createProviders({ env: {
    LIFELINE_LLM_API_KEY: 'offline', LIFELINE_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LIFELINE_LLM_MODEL: 'offline',
    SPECTRUM_PROJECT_ID: 'must-not-use', SPECTRUM_PROJECT_SECRET: 'must-not-use', ELEVENLABS_API_KEY: 'must-not-use',
  }, photonFactory: async () => { messagingStarts++; throw new Error('Messaging is forbidden in this rehearsal.'); },
  fetch: (async (url, init) => {
    requests.push(String(url));
    if (String(url) === FINCH_DEMO_URL) return options.healthUnavailable ? new Response('Unavailable', { status: 503 }) : json(patientFixture);
    assert.equal(String(url), 'http://127.0.0.1:11434/v1/chat/completions', 'Only synthetic Finch and local model requests are permitted.');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, 'json_schema');
    const input = JSON.parse(body.messages[1].content) as ModelInput;
    modelInputs.push(input);
    if (input.requiredPrimaryRecordIds || /wearer say/i.test(input.question))
      assert.ok(input.localReports?.some(report => report.speaker === 'wearer' && report.text === GENERATED_WEARER_STATEMENT));
    else assert.equal(input.localReports?.length ?? 0, 0, 'Clinical-only questions must not disclose unrelated human reports.');
    assert.ok(input.records.every(record => !Object.values(record.data).some(value => String(value).includes(GENERATED_WEARER_STATEMENT))),
      'Incident quote must never be inserted into the clinical records sent to the model.');
    if (options.modelUnavailable) return new Response('Unavailable', { status: 503 });
    const plan = input.requiredPrimaryRecordIds ? {
      facts: input.requiredPrimaryRecordIds.map(recordId => ({ recordId, fields: [recordId === 'allergy-1' ? 'substance' : 'name'] })),
      incidentFields: ['evidence', 'createdAt'], unavailable: ['location', 'currentVitals'],
    } : /wearer say/i.test(input.question) ? {
      facts: [], incidentFields: ['wearerReports'], unavailable: [],
    } : /medications and allergies/i.test(input.question) ? {
      facts: input.records.filter(record => ['medications', 'allergies'].includes(record.category))
        .map(record => ({ recordId: record.id, fields: record.category === 'allergies' ? ['substance', 'reaction'] : ['name', 'dosage'] })),
      incidentFields: [], unavailable: ['currentVitals'],
    } : {
      facts: [{ recordId: 'allergy-1', fields: ['substance', 'reaction'] }], incidentFields: [], unavailable: [],
    };
    return json({ choices: [{ message: { content: JSON.stringify(plan) } }] });
  }) as typeof fetch });
  return { providers, requests, modelInputs, messagingStarts: () => messagingStarts };
}

test('complete isolated rehearsal exercises policy, conversation correlation, grounded AI and durable resolution without sending', async () => {
  const fixture = rehearsalProviders();
  const report = await runIncidentFlowSmoke({ providers: fixture.providers });
  assert.equal(report.status, 'passed'); assert.equal(report.aiRequirementMet, true);
  assert.deepEqual(report.phases, ['DETECTED', 'CONFIRMING', 'HELP_REQUESTED', 'ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED']);
  assert.equal(report.incident.outcome, GENERATED_OUTCOME);
  assert.equal(report.incident.resolutionActor, 'isolated-responder');
  assert.equal(report.handoff.generation, 'ai');
  assert.deepEqual(report.questions.map(question => question.answer.generation), ['ai', 'ai', 'ai', 'policy_refusal']);
  assert.ok(report.handoff.text.includes(`“${GENERATED_WEARER_STATEMENT}”`));
  assert.ok(report.questions[0].answer.text.includes(`[conversation:${report.wearer.conversationId}]`));
  assert.match(report.questions[1].answer.text, /Fictional substance.*\[allergy-1\]/);
  assert.match(report.questions[2].answer.text, /Fictional regimen.*\[med-1\]/);
  assert.match(report.questions[2].answer.text, /Fictional substance.*\[allergy-1\]/);
  assert.match(report.questions[2].answer.text, /Current vital signs not provided/);
  assert.equal(report.health.immutable, true); assert.equal(report.checks.persistedAcrossReopen, true);
  assert.equal(report.wearerUpdate.text, GENERATED_WEARER_UPDATE);
  assert.equal(report.wearerUpdate.handoffRefreshed, true);
  assert.equal(report.rehearsal.externalMessages, false); assert.equal(report.rehearsal.physicalAcquisition, false);
  assert.equal(report.rehearsal.wearerInput, 'generated-text-replay');
  assert.ok(report.recordedOutbox.length > 5);
  assert.ok(report.recordedOutbox.every(record => record.acceptance === 'synthetic-local-only' && record.messageId.startsWith('synthetic-recorded-')));
  assert.equal(fixture.messagingStarts(), 0);
  assert.equal(fixture.requests.filter(url => url === FINCH_DEMO_URL).length, 1);
  assert.equal(fixture.modelInputs.length, 5, 'Four original generations plus refreshed handoff; clinical advice refusal must not call the model.');
  assert.ok(fixture.modelInputs.at(-1)?.localReports?.some(report => report.text === GENERATED_WEARER_UPDATE));
});

test('unavailable model retains the exact quote and cited clinical fallback but reports AI requirement unmet', async () => {
  const fixture = rehearsalProviders({ modelUnavailable: true });
  const report = await runIncidentFlowSmoke({ providers: fixture.providers });
  assert.equal(report.status, 'degraded'); assert.equal(report.aiRequirementMet, false);
  assert.equal(report.handoff.generation, 'degraded');
  assert.deepEqual(report.questions.map(question => question.answer.generation), ['degraded', 'degraded', 'degraded', 'policy_refusal']);
  assert.ok(report.handoff.text.includes(`“${GENERATED_WEARER_STATEMENT}”`));
  assert.ok(report.questions[0].answer.text.includes(`[conversation:${report.wearer.conversationId}]`));
  assert.equal(report.incident.phase, 'RESOLVED'); assert.equal(report.health.immutable, true);
  assert.equal(fixture.messagingStarts(), 0);
});

test('unavailable Finch cannot become a successful EHR rehearsal or invented clinical snapshot', async () => {
  const fixture = rehearsalProviders({ healthUnavailable: true });
  await assert.rejects(runIncidentFlowSmoke({ providers: fixture.providers }), /available synthetic Finch snapshot is required/);
  assert.equal(fixture.modelInputs.length, 0); assert.equal(fixture.messagingStarts(), 0);
});

test('rehearsal rejects unrelated disclosure in a wearer-only answer even when its correct quote is present', async () => {
  for (const unrelatedReport of ['clinical', 'responder'] as const) {
    const fixture = rehearsalProviders();
    const providers = { ...fixture.providers, answerQuestionDetailed: async (...args: Parameters<typeof fixture.providers.answerQuestionDetailed>) => {
      const answer = await fixture.providers.answerQuestionDetailed(...args);
      if (args[2] !== 'What did the wearer say?') return answer;
      const extra = unrelatedReport === 'clinical' ? 'Unrelated recorded medicine [med-1]'
        : `Unrelated responder statement [conversation:${args[3]?.find(message => message.speaker === 'responder')?.id}]`;
      return { ...answer, text: `${answer.text}\n${extra}` };
    } };
    await assert.rejects(runIncidentFlowSmoke({ providers }),
      unrelatedReport === 'clinical' ? /unrelated clinical record citations/ : /unrelated responder report citations/);
    assert.equal(fixture.messagingStarts(), 0);
  }
});

test('live smoke strips messaging and voice credentials and refuses hosted inference before requests', () => {
  const provider = createIncidentSmokeProviders({ SPECTRUM_PROJECT_ID: 'private', SPECTRUM_PROJECT_SECRET: 'private', ELEVENLABS_API_KEY: 'private',
    LIFELINE_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LIFELINE_LLM_API_KEY: 'local', LIFELINE_LLM_MODEL: 'local' });
  assert.equal(provider.providerStatus().photon.configured, false);
  assert.equal(provider.providerStatus().elevenlabs.configured, false);
  assert.equal(provider.providerStatus().llm.configured, true);
  for (const base of ['https://hosted-model.example/v1', 'http://127.0.0.1.evil.example/v1', 'http://private@localhost:11434/v1', 'http://localhost:11434/v1?secret=private'])
    assert.throws(() => createIncidentSmokeProviders({ LIFELINE_LLM_BASE_URL: base }), /loopback local AI/);
});
