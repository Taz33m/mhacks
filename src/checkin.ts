import type { CheckinDecision } from './contracts.ts';

// Distress can escalate without exact wording; positive replies still require
// the explicit cancel control. Recognition never establishes clinical safety.
const help = new Set([
  'help', 'help me', 'please help', 'please help me', 'i need help',
  'yes i need help', 'i need help please', 'im not safe', 'i am not safe',
  'im hurt', 'i am hurt', 'i cant get up', 'i cannot get up',
  // WILi asks "Morgan, do you need help?", so a plain yes is a request for help.
  'yes', 'yeah', 'yep', 'yes please', 'yes help', 'yes help me', 'yeah i need help',
]);
const confirmation = new Set([
  'im okay', 'i am okay', 'im ok', 'i am ok', 'im safe', 'i am safe',
  'i dont need help', 'i do not need help', 'false alarm', 'cancel this check in',
  'no', 'nope', 'no thanks', 'no im okay', 'no im ok', 'no im fine', 'im fine', 'i am fine',
]);

/** A current first-person report requests help; it does not establish a diagnosis. */
export function reportsCurrentSeizure(transcript: string): boolean {
  const command = transcript.toLowerCase().replace(/['’]/g, '').replace(/[.,!;:\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[?"“”‘]/.test(transcript) || /(?:^|\s)'[^']*'/.test(transcript)) return false;
  if (/\b(?:said|says|say|saying|told|heard|quote|quoted|if|unless|whether|not|dont|never|no longer|but|however|yesterday|previously|earlier|ago|last|might|may|could|would|will|think|feel like|pretend|example)\b/.test(command)) return false;
  return /^(?:help |please help |yes )?(?:im|i am) (?:having a seizure|seizing)(?: right now| now| please| help me| i need help)*$/.test(command);
}

export function classifyCheckinReply(transcript: string): CheckinDecision {
  // 'I said, "please help"' is the patient repeating themselves, not reported speech.
  transcript = transcript.replace(/^\s*i\s+(?:said|say|am saying|['’]m saying)\s*[,:]?\s*["“]?\s*(.*?)\s*["”]?\s*$/is, '$1');
  const command = transcript.toLowerCase().replace(/['’]/g, '')
    .replace(/[.,!?;:\-]/g, ' ').replace(/\s+/g, ' ').trim();
  // A direct polite request is still a request even when STT adds a question mark.
  if (!/["“”‘]/.test(transcript) && /^(?:please )?(?:can|could|would) you (?:please )?help(?: me)?(?: please| now| right now)?$/.test(command)) return 'help_requested';
  // Quoted/reported speech and questions cannot become a first-person distress report.
  if (/[?"“”‘]/.test(transcript) || /(?:^|\s)'[^']*'/.test(transcript)) return 'unresolved';
  if (help.has(command)) return 'help_requested';
  if (confirmation.has(command)) return 'confirmation_required';
  if (reportsCurrentSeizure(transcript)) return 'help_requested';
  const reportedOrConditional = /\b(?:said|says|say|saying|told|heard|quote|quoted|if|unless|whether)\b/.test(command)
    || /^(?:who|what|when|where|why|how|can|could|would|should|do|does|did)\b/.test(command);
  const conflicting = /\b(?:dont|do not|never|never mind|no longer|not|but|however)\b/.test(command);
  const unableToRise = /\bi (?:cant|cannot) (?:stand up|get up)\b/.test(command)
    || /\bi (?:cant|cannot) stand(?:$|\s+(?:now|anymore|on my feet)\b)/.test(command);
  const directHelp = /\b(?:i (?:really |urgently )?(?:need|want) (?:some |your )?help|(?:please )?help me|please help|(?:someone|somebody) help|can you help me)\b/.test(command);
  const helpQuestion = /^(?:please )?(?:can|could|would) you (?:please )?help(?: me)?(?: please| now| right now)?$/.test(command);
  if (helpQuestion && !conflicting) return 'help_requested';
  if ((unableToRise || directHelp) && !reportedOrConditional && !conflicting) return 'help_requested';
  return 'unresolved';
}
