import type { ProviderInbound } from './contracts.ts';
import type { Controller } from './controller.ts';
import { phoneIdentity } from './identity.ts';

// Recognizing the wearer consumes the route even when the event is unusable;
// the same phone must never fall through to responder commands or free-text Q&A.
export function handleWearerInbound(event: ProviderInbound, phone: string | null, controller: Controller): boolean {
  const expected = typeof phone === 'string' ? phoneIdentity(phone) : null;
  if (!expected || typeof event.sender !== 'string' || phoneIdentity(event.sender) !== expected) return false;
  if ((event.chatId !== undefined || event.lineId !== undefined) && !controller.matchesConversation(event, null)) return true;
  if (event.removed || event.kind !== 'text' || typeof event.text !== 'string'
    || !event.text.trim() || event.text.length > 500) return true;

  const incident = controller.active();
  if (!incident || incident.phase !== 'CONFIRMING') return true;
  const text = event.text.trim();
  const codeAt = text.length - incident.id.length;
  const hasCode = codeAt > 0 && text.slice(codeAt) === incident.id && /\s/.test(text[codeAt - 1]);

  if (event.targetMessageId !== undefined) {
    // An explicit stale/unknown target cannot be rescued by a current code.
    const target = event.targetMessageId ? controller.wearerIncidentForMessage(event.targetMessageId) : null;
    if (!target || target.id !== incident.id) return true;
    if (event.chatId && !controller.messageMatchesConversation(event.targetMessageId!, event)) return true;
  } else if (!hasCode || !controller.actions(incident.id).some(action => action.type === 'wearer_checkin')) {
    return true;
  }

  const transcript = hasCode ? text.slice(0, codeAt).trim() : text;
  if (!transcript) return true;
  // The Controller checks its own clock, deduplicates, and applies the exact
  // check-in policy. No text interpretation here can cancel an incident.
  controller.recordWearerCheckinReply({ incidentId: incident.id, checkinId: incident.checkinId, transcript }, event.messageId, event);
  return true;
}
