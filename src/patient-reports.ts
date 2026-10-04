import type { WellbeingMessage } from './wellbeing.ts';
import { patientChoices } from './patient-followup.ts';
export interface PatientReport {
  id: string; symptom: string; startedAt: number; updatedAt: number;
  duration: string | null; impact: string | null; trend: string;
  source: 'patient-reported'; evidence: { messageId: string; at: number; source: string; text: string }[];
  followups: { question: string; author: string; askedAt: number; answer: string | null; answeredAt: number | null }[];
}
/** Only explicit reports and displayed choices become fields. No diagnosis or severity inference. */
export function patientReports(messages: WellbeingMessage[]): PatientReport[] {
  const reports: PatientReport[] = [];
  let current: PatientReport | undefined, previous: WellbeingMessage | undefined;
  let pending: { report: PatientReport; followup: PatientReport['followups'][number] } | undefined;
  for (const m of messages) {
    if (m.source === 'care-team' && m.reportId) {
      const report = reports.find(r => r.id === m.reportId);
      if (report && m.delivery === 'provider_accepted') {
        const followup = { question: m.text, author: m.author || 'Care team', askedAt: m.at, answer: null, answeredAt: null };
        report.followups.push(followup); pending = { report, followup };
      }
    }
    if (m.speaker === 'wearer') {
      const symptom = !/\b(?:not|said|if|no longer)\b/i.test(m.text)
        ? m.text.match(/\b(?:my (back|ankle|knee|hip|head) (?:hurts|aches)|(back|ankle|knee|hip) pain)\b/i) : null;
      const feeling = ['Good', 'A little lonely', 'Not feeling well'].includes(m.text) && previous && patientChoices(previous.text)?.title === 'How are you feeling today?';
      if (symptom || feeling) {
        current = { id: m.id, symptom: symptom ? `${(symptom[1] || symptom[2]).toLowerCase()} pain` : m.text,
          startedAt: m.at, updatedAt: m.at, duration: null, impact: null, trend: 'No comparable earlier report', source: 'patient-reported', evidence: [], followups: [] };
        reports.push(current);
      }
      const title = previous?.delivery === 'provider_accepted' ? patientChoices(previous.text)?.title : null;
      let captured = Boolean(symptom || feeling);
      if (current && m.at - current.updatedAt <= 86400000) {
        if (title === 'How long has this been bothering you?' && ['Less than 3 days', '3–7 days', 'More than a week'].includes(m.text)) { current.duration = m.text; captured = true; }
        if (title === 'How much is it affecting your day?' && ['Manageable', 'Limiting what I can do', 'I need help now'].includes(m.text)) { current.impact = m.text; captured = true; }
      }
      if (pending) {
        pending.followup.answer = m.text; pending.followup.answeredAt = m.at;
        pending.report.updatedAt = m.at;
        pending.report.evidence.push({ messageId: m.id, at: m.at, source: m.source, text: m.text }); pending = undefined;
      }
      if (current && captured) {
        current.updatedAt = m.at;
        if (!current.evidence.some(e => e.messageId === m.id)) current.evidence.push({ messageId: m.id, at: m.at, source: m.source, text: m.text });
      }
    }
    previous = m;
  }
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i], earlier = reports.slice(0, i).findLast(p => p.symptom === r.symptom && p.impact);
    const rank = ['Manageable', 'Limiting what I can do', 'I need help now'];
    if (earlier?.impact && r.impact) {
      const change = rank.indexOf(r.impact) - rank.indexOf(earlier.impact);
      r.trend = change > 0 ? 'More impact reported' : change < 0 ? 'Less impact reported' : 'Same impact reported';
    }
  }
  return reports;
}
