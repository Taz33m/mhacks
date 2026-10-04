import type { CheckinDecision } from './contracts.ts';

// Exact commands keep a transcript or model interpretation from becoming a
// safety determination. Positive replies still require the explicit cancel control.
const help = new Set([
  'help', 'help me', 'please help', 'please help me', 'i need help',
  'yes i need help', 'i need help please', 'im not safe', 'i am not safe',
  'im hurt', 'i am hurt', 'i cant get up', 'i cannot get up',
]);
const confirmation = new Set([
  'im okay', 'i am okay', 'im ok', 'i am ok', 'im safe', 'i am safe',
  'i dont need help', 'i do not need help', 'false alarm', 'cancel this check in',
]);

export function classifyCheckinReply(transcript: string): CheckinDecision {
  const command = transcript.toLowerCase().replace(/['’]/g, '')
    .replace(/[.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim();
  // Quoted/reported speech and questions cannot become a first-person distress report.
  if (/[?"“”‘]/.test(transcript) || /(?:^|\s)'[^']*'/.test(transcript)) return 'unresolved';
  if (help.has(command)) return 'help_requested';
  if (confirmation.has(command)) return 'confirmation_required';
  const reportedOrConditional = /\b(?:said|says|say|saying|told|heard|quote|quoted|if|unless|whether)\b/.test(command)
    || /^(?:who|what|when|where|why|how|can|could|would|should|do|does|did)\b/.test(command);
  const conflicting = /\b(?:dont|do not|never|never mind|no longer|not|but|however)\b/.test(command);
  const unableToRise = /\bi (?:cant|cannot) (?:stand up|get up)\b/.test(command)
    || /\bi (?:cant|cannot) stand(?:$|\s+(?:now|anymore|on my feet)\b)/.test(command);
  if (unableToRise && !reportedOrConditional && !conflicting) return 'help_requested';
  return 'unresolved';
}
