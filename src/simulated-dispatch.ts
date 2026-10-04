import type { Controller } from './controller.ts';

export interface SimulatedDispatchOptions {
  now?: () => number; acceptMs?: number; departMs?: number; arriveMs?: number; resolveMs?: number;
}

/** A labelled stand-in for a human responder. It has no transport or location API. */
export class SimulatedDispatch {
  private readonly controller: Controller;
  private readonly now: () => number;
  private readonly delays: { accept: number; depart: number; arrive: number; resolve: number };

  constructor(controller: Controller, options: SimulatedDispatchOptions = {}) {
    this.controller = controller;
    this.now = options.now ?? Date.now;
    this.delays = { accept: options.acceptMs ?? 4000, depart: options.departMs ?? 8000,
      arrive: options.arriveMs ?? 16000, resolve: options.resolveMs ?? 12000 };
    if (Object.values(this.delays).some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > 300_000))
      throw new Error('Simulated responder delays must be whole milliseconds between 0 and 300000.');
  }

  tick(): void {
    const c = this.controller;
    if (c.dispatchMode !== 'simulated') return;
    const latest = c.latest();
    if (!latest || latest.dispatchMode !== 'simulated') return;
    const at = this.now();
    if (!Number.isFinite(at) || at < 0) throw new Error('Invalid simulated responder clock.');
    // Include the final simulated notices, while leaving every wearer/Photon lane untouched.
    for (let count = 0; count < 32; count++) {
      const action = c.claimAction('responders', true, latest.id);
      if (!action) break;
      c.finishSimulatedAction(action.id);
    }
    const i = c.active();
    if (!i || i.id !== latest.id || i.dispatchMode !== 'simulated') return;
    const eligible = c.responders.filter(r => r.simulated === true && r.phone === null
      && i.contacted.includes(r.id) && !i.declined.includes(r.id));
    if (i.phase === 'HELP_REQUESTED' && i.ownerId === null && at - i.updatedAt >= this.delays.accept) {
      const responder = eligible.find(r => c.actions(i.id).some(a => a.type === 'alert'
        && a.recipientId === r.id && a.status === 'simulated'));
      if (responder) c.simulateResponder(i.id, responder.id, 'accept');
      return;
    }
    const owner = eligible.find(r => r.id === i.ownerId);
    if (!owner) return;
    if (i.phase === 'ACKNOWLEDGED' && at - i.updatedAt >= this.delays.depart) {
      c.simulateResponder(i.id, owner.id, 'depart');
    } else if (i.phase === 'RESPONDER_EN_ROUTE' && at - i.updatedAt >= this.delays.arrive) {
      c.simulateResponder(i.id, owner.id, 'arrive');
    } else if (i.phase === 'ON_SCENE' && at - i.updatedAt >= this.delays.resolve) {
      const speechPending = c.conversation(i.id).some(message => message.speaker === 'responder'
        && ['queued', 'playing'].includes(message.delivery));
      if (speechPending && at - i.updatedAt < this.delays.resolve + 30_000) return;
      c.simulateResponder(i.id, owner.id, 'resolve');
    }
  }
}
