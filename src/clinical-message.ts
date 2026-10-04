/** Compact transport presentation. The original sourced answer remains in the incident audit. */
export function clinicalMessage(original: string, _subjectName?: string): string {
  const references = new Map<string, number>();
  const cite = (line: string) => line.replace(/\[(rec_[A-Za-z0-9_-]+)\]/g, (_, id: string) => {
    if (!references.has(id)) references.set(id, references.size + 1);
    return `[${references.get(id)}]`;
  });
  const medications: { text: string; status: string }[] = [];
  const other: string[] = [];
  for (const raw of original.split('\n')) {
    const line = cite(raw);
    const match = line.match(/^medications:\s*(.+?)\s*\[(\d+)\]$/);
    if (!match) { other.push(line); continue; }
    const fields = match[1].split(/;\s*(?=(?:status|dosage|frequency|startDate|endDate):)/);
    const name = fields.shift()!;
    const values = new Map(fields.map(field => { const at=field.indexOf(':');return [field.slice(0,at),field.slice(at+1).trim()] as const; }));
    const status = values.get('status') || 'unknown';
    const dosage = values.get('dosage'), frequency = values.get('frequency');
    const regimen = dosage ? ` — ${dosage.replace(/\bsynthetic /gi, '').replace(/^Take /, '').replace(/\.$/, '')}` : '';
    const schedule = frequency && (!dosage || !/daily|weekly|monthly|hour|twice|once|as needed/i.test(dosage)) ? `\n  Frequency: ${frequency}` : '';
    const historical = /^(completed|stopped|inactive|cancelled|canceled|discontinued|entered-in-error)$/i.test(status);
    const dates = historical ? ['startDate','endDate'].map(k=>values.get(k)).filter(v=>v && !/not returned|unknown/i.test(v)).join(' → ') : '';
    medications.push({status,text:`• ${name}${status.toLowerCase()==='active'?'':` — ${status}`}${dates?` (${dates})`:''}${regimen}${schedule}`});
  }
  if (!medications.length) {
    if (!/Known source facts:|(?:allergies|conditions|vitals):/.test(original)) return original;
    const facts = original.split('\n').flatMap(raw => {
      const line = raw.replace(/\[(?:rec_)[A-Za-z0-9_-]+\]/g, '').trim();
      if (!line || /^(?:From .+ health record:|Known source facts:|Unavailable information:|Anything not listed is unknown\.)$/.test(line)) return [];
      const fact = line.match(/^(allergies|conditions|vitals):\s*(.+)$/);
      if (!fact) return [line];
      const parts = fact[2].split(/;\s*(?=[A-Za-z][A-Za-z0-9]*:)/);
      const label = parts.shift();
      const fields = new Map(parts.map(p => { const at=p.indexOf(':'); return [p.slice(0,at),p.slice(at+1).trim()] as const; }));
      if (fact[1] === 'allergies') {
        const reaction = fields.get('reaction')?.replace(/^Synthetic example:\s*/i,'');
        const status = fields.get('status');
        return [`Allergy: ${label}${reaction ? ` — ${reaction}` : ' — reaction unknown'}${status && status !== 'active' ? ` (${status})` : ''}.`];
      }
      if (fact[1] === 'conditions') return [`Condition record: ${label}${fields.get('status') ? ` (${fields.get('status')})` : ''}.`];
      return [`Historical ${label}: ${fields.get('value') ?? 'unknown'} ${fields.get('unit') ?? ''}${fields.get('date') ? ` (${fields.get('date')})` : ''}.`];
    });
    return [...facts, 'Source: Finch synthetic record.'].join('\n');
  }
  const active=medications.filter(m=>m.status.toLowerCase()==='active');
  const historical=medications.filter(m=>/^(completed|stopped|inactive|cancelled|canceled|discontinued|entered-in-error)$/i.test(m.status));
  const unclear=medications.filter(m=>!active.includes(m)&&!historical.includes(m));
  const rest=other.filter(line=>!['Known source facts:','From the health record:','From your health record:','Anything not listed is unknown.'].includes(line.replace(/^LF-[A-Z0-9-]+:\s*/, '').trim()));
  return [
    ...active.map(m=>m.text),
    ...unclear.map(m=>m.text.replace('• ', '• Status unclear: ')),
    ...historical.map(m=>m.text.replace('• ', '• Previous: ')),
    ...(rest.some(line=>line.trim())?['',...rest]:[]),
    '\nSource: Finch synthetic record.',
  ].join('\n');
}
