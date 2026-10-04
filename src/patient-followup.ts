import type { WellbeingMessage } from './wellbeing.ts';
export interface PatientChoices { title: string; options: string[] }
export function choiceText(title: string, options: string[]): string {
  return `${title}\n${options.map((o,i)=>`${i+1}. ${o}`).join('\n')}\nTap a choice, reply with its number, or hold blue on WILi to speak.`;
}
export function patientChoices(text: string): PatientChoices | null {
  const lines=text.split('\n');
  if (!lines[0]?.endsWith('?') || lines.at(-1)!=='Tap a choice, reply with its number, or hold blue on WILi to speak.') return null;
  const options=lines.slice(1,-1).map((line,i)=>line.startsWith(`${i+1}. `)?line.slice(3):'');
  return options.length>=2 && options.length<=4 && options.every(o=>o.length>0&&o.length<100) ? {title:lines[0],options}:null;
}
export function patientFollowup(text: string, history: WellbeingMessage[]): string | null {
  const previous=history.findLast(m=>m.speaker==='lifeline'&&patientChoices(m.text));
  const choices=previous?patientChoices(previous.text):null;
  const raw=text.trim().replace(/[.!]+$/,'');
  const selected=choices && /^\d$/.test(raw) ? choices.options[Number(raw)-1] : raw;
  if(choices && choices.options.some(o=>o.toLowerCase()===selected?.toLowerCase())) {
    if(choices.title==='How long has this been bothering you?')
      return choiceText(`How much is it affecting your day?`,['Manageable','Limiting what I can do','I need help now']);
    if(choices.title==='How much is it affecting your day?')
      return selected==='I need help now'?'You asked for help.':`Noted: ${selected?.toLowerCase()}. What would you like the person helping you to know?`;
    if(selected==='Good')return 'Glad to hear it. Anything you’d like to share today?';
    if(selected==='A little lonely')return choiceText('What would feel helpful right now?',['Talk for a bit','Write a message to someone','A quiet check-in']);
    if(selected==='Not feeling well')return 'What’s bothering you? You can reply here or hold blue on WILi to speak.';
    if(selected==='Talk for a bit')return 'I’m here. What’s been on your mind?';
    if(selected==='Write a message to someone')return 'Who would you like to write to, and what would you like to say?';
    if(selected==='A quiet check-in')return 'Okay. You can message me whenever you want to talk.';
  }
  if(/\b(?:my (?:back|ankle|knee|hip|head) (?:hurts|aches)|(?:back|ankle|knee|hip) pain)\b/i.test(text) && !/\b(?:not|yesterday|said|if)\b/i.test(text))
    return choiceText('How long has this been bothering you?',['Less than 3 days','3–7 days','More than a week']);
  if(/\b(?:lonely|isolated|no one to talk to)\b/i.test(text))
    return choiceText('What would feel helpful right now?',['Talk for a bit','Write a message to someone','A quiet check-in']);
  return null;
}

export function resolvePatientChoice(text: string, prompt: string): string {
  const choices=patientChoices(prompt);
  const token=text.trim().toLowerCase().replace(/[.!]+$/,'');
  const index = /^[1-4]$/.test(token) ? Number(token)-1 : ['one','two','three','four'].indexOf(token);
  return choices && index>=0 && choices.options[index] ? choices.options[index] : text;
}
