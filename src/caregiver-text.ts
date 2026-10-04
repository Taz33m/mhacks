// Short, plain-text versions of care-team messages for any phone (SMS/RCS/iMessage).
// Applied only when sending to a caregiver; the dashboard keeps the full record.
// Plain ASCII only: SMS fallback garbles curly quotes, bullets and emoji on many Android phones.
const plain = (text: string) => text
  .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, '-').replace(/≥/g, '>=').replace(/…/g, '...')
  .replace(/[·•]/g, '-').replace(/→/g, 'to').replace(/\s*\[(?:rec_[^\]]*|conversation:[^\]]*|\d+)\]/g, '')
  .replace(/\s+for LF-[A-Z0-9]+\b|\bLF-[A-Z0-9]+:?\s*/g, '').replace(/[^\S\n]+/g, ' ')
  .replace(/[^\x00-\x7F]/g, '').replace(/ {2,}/g, ' ').trim();
const cap = (text: string, max = 320) => text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
const BOILERPLATE = /^(Known source facts:|Anything not listed is unknown|Quoted statements are not|Fields not returned are unknown|Recorded doses are not treatment|No supporting health record selected|Clinical snapshot revision|Sources?:|\[\d+\])/i;

export function caregiverText(type: string, text: string, patientName: string, recipientName = ''): string {
  const first = patientName.trim().split(/\s+/)[0] || 'The patient';
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (type === 'alert' || type === 'handoff') {
    const time = /Detected (\d{1,2}:\d{2}\s?[AP]M)/i.exec(text)?.[1]
      ?? new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    // Classify from the trigger summary only; health notes can mention unrelated conditions.
    const trigger = lines.find(line => /^(?:Possible (?:fall|loss of balance)|Sustained unusual movement|Patient reports a current seizure)/i.test(line)) ?? '';
    const event = /seizure/i.test(trigger) ? `${first} may be having a seizure`
      : /fall|balance/i.test(trigger) ? `${first} may have fallen` : `${first} needs help`;
    const quote = lines.map(line => /^[^:“]{1,80}: “([^”]{1,220})”/.exec(line)?.[1]).find(Boolean);
    const flagsAt = lines.indexOf('Fall-relevant:'), healthAt = lines.indexOf('Health context:');
    const flags = flagsAt < 0 ? [] : lines.slice(flagsAt + 1, healthAt > flagsAt ? healthAt : undefined).slice(0, 2)
      .map(line => line.replace(/^[•*-]\s*/, '').replace(/;\s*status:[^\[]*/i, ''));
    // Blood thinner + fall = head-injury risk: always say it plainly, first.
    const thinner = lines.filter(line => !/\b(?:completed|stopped|previous|discontinued)\b/i.test(line))
      .map(line => /\b(warfarin|apixaban|rivaroxaban|dabigatran|edoxaban|enoxaparin|heparin|clopidogrel)\b/i.exec(line)?.[1]).find(Boolean);
    const notes = [...(thinner ? [`${first} is on a blood thinner (${thinner.toLowerCase()}): check for head injury.`] : []),
      ...flags.filter(flag => !/blood thinner/i.test(flag)).map(flag => `Note: ${flag}`)].slice(0, 2);
    const allergies = lines.filter(line => /^allergies:/i.test(line))
      .map(line => line.replace(/^allergies:\s*/i, '').split(';')[0].trim()).filter(Boolean).slice(0, 2);
    const reply = type === 'alert' ? `\nText back 👍 or ON IT if you can go. Ask me anything about ${first}'s health.` : '';
    return cap(plain([
      type === 'handoff' ? `Update on ${first} (${time}):` : `LIFELINE: ${event} (${time}).`,
      ...(quote ? [`${first} said: "${quote}"`] : []),
      ...notes,
      ...(allergies.length ? [`Allergy: ${allergies.join(', ')}`] : []),
    ].join('\n')), 480 - reply.length) + reply;
  }
  if (type === 'status') {
    if (/LIFELINE FYI/.test(text)) return cap(plain(text));
    const accepted = /^(.+?) accepted /.exec(lines[0] ?? '')?.[1];
    if (accepted) return accepted === recipientName
      ? `You're responding. Text LEAVING when you head out and ARRIVED when you get there. Start a message with "${first}," to talk to ${first}.`
      : `${accepted} is responding to ${first}.`;
    if (/reported departure/.test(text)) return `${first} knows you're on the way. Text ARRIVED when you get there.`;
    if (/reported arrival/.test(text)) return 'When you are done, text RESOLVED: and what happened.';
    if (/closed by the on-scene owner/.test(text)) return 'Incident closed. Thank you.';
  }
  if (type === 'answer') return cap(plain(lines.filter(line => !BOILERPLATE.test(line)).join('\n')), 480);
  return cap(plain(text));
}
