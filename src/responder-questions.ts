import type { Incident, ProviderInbound } from './contracts.ts';
import { Controller, PolicyError } from './controller.ts';
import { approvedResponder } from './identity.ts';

export async function handleResponderQuestion(
  event: ProviderInbound, controller: Controller,
  generate: (incident: Incident, question: string) => Promise<string>,
  canQueue: () => boolean = () => true,
): Promise<boolean> {
  if (event.removed || event.kind !== 'text' || typeof event.text !== 'string'
    || !event.text.trim() || event.text.length > 2000 || controller.seenInbound(event.messageId)) return false;
  const responder = approvedResponder(event.sender, controller.responders);
  const incident = controller.active();
  if (!responder || !incident || !incident.contacted.includes(responder.id) || incident.declined.includes(responder.id)) return false;
  const question = event.text.trim();
  // A stale command is never reinterpreted as a question about a newer incident.
  if (/^(ON IT|DEPART|ARRIVED|DECLINE|RESOLVED)(?:\s|$)/i.test(question)) return false;
  const codes = question.match(/\bLF-[A-Z0-9-]+\b/gi) ?? [];
  if (codes.some(code => code.toUpperCase() !== incident.id)) return false;
  if (event.targetMessageId !== undefined
    && (!event.targetMessageId || controller.responderIncidentForMessage(event.targetMessageId, responder.id)?.id !== incident.id)) return false;

  const answer = await generate(incident, question);
  if (!canQueue()) return false;
  const text = `${incident.id}: ${answer}`;
  const boundedText = text.length <= 6000 ? text
    : `${incident.id}: The returned record summary exceeds the message limit. Please ask about a specific medication, condition, or allergy.`;
  try {
    // Authorization, version, dedupe, audit, and the outbox commit together.
    return controller.queueAnswer(incident.id, incident.version, responder.id, event.messageId, boundedText);
  } catch (error) {
    if (error instanceof PolicyError) return false;
    throw error;
  }
}
