import type { Responder } from './contracts.ts';

export function phoneIdentity(value: string): string | null {
  const phone = value.trim();
  return /^\+?[1-9]\d{7,14}$/.test(phone) ? phone.replace(/^\+/, '') : null;
}
export function approvedResponder(sender: string, responders: Responder[]): Responder | null {
  const phone = phoneIdentity(sender);
  return phone ? responders.find(r => r.phone && phoneIdentity(r.phone) === phone) ?? null : null;
}
