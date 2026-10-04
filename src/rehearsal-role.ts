import { phoneIdentity } from './identity.ts';
import type { ProviderInbound } from './contracts.ts';
export class RehearsalRole {
  private selected: { incidentId: string; responderId: string; expiresAt: number } | null = null;
  private readonly now: () => number;
  constructor(now=Date.now) {this.now=now;}
  view(incidentId?: string) {
    if (this.selected && (this.now() >= this.selected.expiresAt || this.selected.incidentId !== incidentId)) this.selected=null;
    return this.selected;
  }
  set(incidentId: string, responderId: string) { this.selected={incidentId,responderId,expiresAt:this.now()+30*60_000}; }
  clear() {this.selected=null;}
  map(event: ProviderInbound, incidentId: string | undefined, wearer: string | null, responderPhone: string | null): ProviderInbound | null {
    const role=this.view(incidentId);
    if (!role || !wearer || !responderPhone || phoneIdentity(event.sender)!==phoneIdentity(wearer)) return null;
    let text=event.text;
    if(event.kind==='text' && !event.targetMessageId && /^(on it|i can help|depart|on my way|arrived|decline)$/i.test(text?.trim()??'')) text=`${text!.trim()} ${role.incidentId}`;
    if(event.kind==='text' && !event.targetMessageId && /^resolved\s*:/i.test(text?.trim()??'')) text=`RESOLVED ${role.incidentId} ${text!.replace(/^resolved\s*:/i,'').trim()}`;
    return {...event,sender:responderPhone,...(text!==undefined?{text}:{})};
  }
}
