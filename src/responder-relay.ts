import type { ProviderInbound } from './contracts.ts';
import { Controller, terminal } from './controller.ts';
import { approvedResponder } from './identity.ts';

function wearerCommunicationCheck(text: string): boolean {
  return /^(?:(?:can|could) you hear me(?: clearly| now)?|are you there|did you hear me)$/i.test(text);
}

function informationRequest(text: string): boolean {
  if (/^(?:who|what|when|where|why|how|which|whose)\b/i.test(text)) return true;
  if (/^(?:can|could|would|will|should|is|are|was|were|do|does|did|has|have|had)\s+(?:i|we|you|he|she|they|it|this|that|there|the|his|her|their|our|patient|wearer)\b/i.test(text)) return true;
  if (/^(?:please\s+)?(?:tell|show|list|summari[sz]e|check|explain|describe|confirm|give|share)\b/i.test(text)) return true;
  if (/^any\b.*\b(?:meds|medications?|allergies|conditions|vitals|medical history)\b/i.test(text)) return true;
  if (/^(?:medications?|allergy|allergies|condition|conditions|vitals)\s+(?:list|summary|details)\b/i.test(text)) return true;
  return /^(?:(?:any|all|recorded|current|known)\s+)?(?:meds|medications|allergies|conditions|vitals|vital signs|medical history|health records?|handoff|status|location|eta)\s*[:.]?$/i.test(text);
}

function asksForInformation(text: string): boolean {
  const clauses = (text.match(/[^.!?]+[.!?]?/g) ?? []).map(clause => ({
    question: clause.endsWith('?'), text: clause.replace(/[.!?]$/, '').trim(),
  }));
  // A direct communication check is for the wearer to hear and answer. Other
  // questions or record requests in the same message still belong to Q&A.
  if (text.includes('?') && (!clauses.some(clause => clause.question)
    || clauses.some(clause => clause.question && !wearerCommunicationCheck(clause.text)))) return true;
  return clauses.some(clause => !wearerCommunicationCheck(clause.text) && informationRequest(clause.text));
}

/** Relay an authorized person's exact statement; text alone never establishes progress. */
export function handleResponderRelay(event: ProviderInbound, controller: Controller): boolean {
  if (event.removed || event.kind !== 'text' || typeof event.text !== 'string'
    || !event.text.trim() || event.text.length > 500 || typeof event.messageId !== 'string'
    || !event.messageId.trim() || event.messageId.length > 500 || typeof event.sender !== 'string'
    || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(event.text) || controller.seenInbound(event.messageId)) return false;
  const responder = approvedResponder(event.sender, controller.responders);
  const incident = controller.active();
  if (!responder || !incident || terminal(incident.phase)
    || !controller.matchesConversation(event, responder.id)) return false;

  const text = event.text.trim();
  if (/^(?:ON IT|DEPART|ARRIVED|DECLINE|RESOLVED)\b/i.test(text)
    || /^LF-/i.test(text) || asksForInformation(text)) return false;
  const codes = text.match(/\bLF-[A-Z0-9-]+\b/gi) ?? [];
  if (codes.some(code => code.toUpperCase() !== incident.id)) return false;

  const accepted = controller.actions(incident.id).filter(action => action.recipientId === responder.id
    && action.status === 'provider_accepted' && Boolean(action.providerMessageId)
    && action.providerChatId === event.chatId && action.providerLineId === event.lineId
    && ['alert', 'status', 'handoff', 'answer', 'wearer_relay'].includes(action.type));
  if (event.targetMessageId !== undefined) {
    // An explicit stale or mismatched reply target cannot fall back to this conversation.
    if (!event.targetMessageId || !accepted.some(action => action.providerMessageId === event.targetMessageId)) return false;
  } else if (!accepted.some(action => action.type === 'alert')) return false;

  // The controller repeats authorization and persists the transcript/dedupe atomically.
  return controller.recordResponderRelay(event, responder.id);
}
