import type { ProviderInbound } from './contracts.ts';
import { Controller } from './controller.ts';
import { approvedResponder } from './identity.ts';

/** Exact, incident-bound commands. Language models never authorize progress. */
export function handleResponderProgress(event: ProviderInbound, controller: Controller): boolean {
  const responder = approvedResponder(event.sender, controller.responders);
  const incident = controller.active();
  if (!responder || !incident || event.removed || controller.seenInbound(event.messageId)
    || !event.messageId.trim() || event.messageId.length > 500
    || !controller.matchesConversation(event, responder.id)) return false;
  const targeted = event.targetMessageId !== undefined;
  if (targeted && (!event.targetMessageId
    || !controller.messageMatchesConversation(event.targetMessageId, event)
    || controller.responderIncidentForMessage(event.targetMessageId, responder.id)?.id !== incident.id)) return false;
  if (event.kind === 'reaction') {
    // A thumbs-up on any message about the current incident accepts it (target already checked above).
    if (event.reaction !== '👍' || !event.targetMessageId) return false;
    controller.accept(incident.id, responder.id, event.messageId, event); return true;
  }
  const original = (event.text ?? '').trim();
  if (!original || original.length > 2000) return false;
  const codes = original.match(/\bLF-[A-Z0-9-]+\b/gi) ?? [];
  if (codes.some(id => id.toUpperCase() !== incident.id)) return false;
  const hasCode = codes.length === 1;
  // Plain texts (no thread reply, no incident code) refer to the one active incident.
  const text = (hasCode ? original.replace(new RegExp(`\\s*${incident.id}\\b`, 'i'), '') : original)
    .trim().replace(/[’]/g, "'").toLowerCase().replace(/[\s.!]+$/, '');
  // "On it", a thumbs-up sent as text, or Android's text form of a thumbs-up reaction all accept.
  if (['on it', "i'm on it", 'ok on it', 'okay on it', 'i can help'].includes(text) || /^👍/u.test(text)
    || /^(?:liked|reacted 👍 to) ["“]/u.test(text)) {
    controller.accept(incident.id, responder.id, event.messageId, event); return true;
  }
  if (['depart', 'leaving', "i'm leaving", 'on my way'].includes(text)) {
    controller.progress(incident.id, responder.id, 'depart', event); return true;
  }
  if (['arrived', "i'm here", 'i am here'].includes(text)) {
    controller.progress(incident.id, responder.id, 'arrive', event); return true;
  }
  if (['decline', "i can't help", 'i cannot help'].includes(text)) {
    controller.decline(incident.id, responder.id, event); return true;
  }
  const outcome = text.match(/^resolved\s*:\s*(.+)$/s);
  const codedOutcome = hasCode ? original.match(/^resolved\s+LF-[A-Z0-9-]+\s+(.+)$/is) : null;
  if (outcome || codedOutcome) {
    // Preserve the exact original outcome rather than a lowercased paraphrase.
    const exact = codedOutcome?.[1] ?? original.slice(original.indexOf(':') + 1).trim().replace(new RegExp(`\\s*${incident.id}\\b`, 'i'), '').trim();
    controller.resolve(incident.id, responder.id, exact, event); return true;
  }
  return false;
}
