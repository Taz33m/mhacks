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
  if (help.has(command)) return 'help_requested';
  if (confirmation.has(command)) return 'confirmation_required';
  return 'unresolved';
}
