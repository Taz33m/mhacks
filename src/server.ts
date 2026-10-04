import { clinicalMessage } from './clinical-message.ts';
import { RehearsalRole } from './rehearsal-role.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { Controller, PolicyError } from './controller.ts';
import { SimulatedDispatch } from './simulated-dispatch.ts';
import { parsePolicy } from './policy.ts';
import { Motion, validSample } from './motion.ts';
import { FreeWili } from './freewili.ts';
import { WiliAssessment } from './wili-assessment.ts';
import { EarlyCheckinAssessment, detectionProfile } from './early-checkin-assessment.ts';
import { EventWindowCapture } from './event-window.ts';
import { Teaching } from './teaching.ts';
import { ShakingAssessment } from './shaking-assessment.ts';
import { WiliDeviceProtocol } from '../native/freewili/protocol.ts';
import type { WiliHello } from '../native/freewili/protocol.ts';
import { readStockVoiceManifest } from '../native/freewili/prepare-stock-audio.ts';
import { approvedResponder, phoneIdentity } from './identity.ts';
import { handleWearerInbound } from './wearer.ts';
import { enqueueResponderQuestion, createResponderQuestionWorker } from './responder-questions.ts';
import { handleResponderProgress } from './responder.ts';
import { handleResponderRelay } from './responder-relay.ts';
import { Trials } from './trials.ts';
import { Wellbeing } from './wellbeing.ts';
import { createCareReply } from './care-reply.ts';
import { buildEhrWorkspace } from './ehr.ts';
import { classifyCheckinReply, reportsCurrentSeizure } from './checkin.ts';
import { Location } from './location.ts';
import { createLocationGateway } from './location-gateway.ts';
import { createRouteEta } from './route-eta.ts';
import type { RouteEta } from './route-eta.ts';
import { createFindMy } from './providers/find-my.ts';
import { FindMyRequests } from './find-my-onboarding.ts';
import type { FindMySubject } from './find-my-onboarding.ts';
import type { CheckinAudioStatus, CheckinReply, ClockPong, Command, DispatchMode, HealthContext, Incident, ProviderInbound, Responder, Snapshot, Source, TrialRecord, TrialSource } from './contracts.ts';
import { providerStatus, loadHealth, buildHandoffDetailed, answerQuestionDetailed, answerPatientQuestionDetailed, sendMessage, startPhotonListener, prepareCheckinAudio } from './providers/index.ts';

const port = Number(process.env.LIFELINE_PORT ?? 8877);
const host = process.env.LIFELINE_HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.LIFELINE_DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true }); mkdirSync(resolve(dataDir, 'recordings'), { recursive: true });
const tokenFile = resolve(dataDir, 'pairing-token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 });
const token = readFileSync(tokenFile, 'utf8').trim();
const sameToken = (candidate: string) => {
  const a = Buffer.from(candidate), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
const authorized = (req: IncomingMessage) => sameToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
const loopback = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
const responderConfig: unknown = process.env.LIFELINE_RESPONDERS_JSON ? JSON.parse(process.env.LIFELINE_RESPONDERS_JSON)
  : [{ id: 'maya', name: 'Maya', phone: null }, { id: 'jordan', name: 'Jordan', phone: null }];
if (!Array.isArray(responderConfig) || responderConfig.some(r => !r || typeof r.id !== 'string' || typeof r.name !== 'string'
  || !(r.phone === null || (typeof r.phone === 'string' && /^\+[1-9]\d{7,14}$/.test(r.phone))))) throw new Error('Invalid approved responder configuration. Use E.164 phone numbers or null for development simulation.');
const dispatchChoice = process.env.LIFELINE_DISPATCH_MODE?.trim() || 'live';
if (dispatchChoice !== 'live' && dispatchChoice !== 'simulated') throw new Error('LIFELINE_DISPATCH_MODE must be live or simulated.');
const dispatchMode: DispatchMode = dispatchChoice;
// Keep the approved live contact list in private configuration. Demo dispatch
// has its own identity and can never send to those real responder addresses.
const responders: Responder[] = dispatchMode === 'simulated'
  ? [{ id: 'demo-maya', name: 'Maya', phone: null, simulated: true }] : responderConfig as Responder[];
if (new Set(responders.filter(r => r.phone).map(r => r.phone)).size !== responders.filter(r => r.phone).length) throw new Error('Approved phone numbers must be unique.');
const wearerPhone = process.env.LIFELINE_WEARER_PHONE?.trim() || null;
if (wearerPhone && !/^\+[1-9]\d{7,14}$/.test(wearerPhone)) throw new Error('LIFELINE_WEARER_PHONE must be an approved E.164 phone number.');
if (wearerPhone && responders.some(r => r.phone && phoneIdentity(r.phone) === phoneIdentity(wearerPhone)))
  throw new Error('The wearer and responder phone numbers must be different.');
const policyProfile = parsePolicy(process.env);
const selectedDetectionProfile = detectionProfile(process.env.LIFELINE_DETECTION_PROFILE);
const policy = { demoMode: policyProfile.demoMode, checkinMs: policyProfile.checkinMs, configuredCheckinMs: policyProfile.configuredCheckinMs,
  ...(selectedDetectionProfile === 'early-checkin' ? { detectionProfile: selectedDetectionProfile } : {}) };
const rehearsalRole = new RehearsalRole();
const controller = new Controller(resolve(dataDir, 'lifeline.sqlite'), responders, Date.now, policyProfile,
  { wearerName: process.env.LIFELINE_WEARER_NAME, dispatchMode });
const simulatedStepMs = process.env.LIFELINE_SIMULATED_STEP_MS === undefined ? undefined
  : Number(process.env.LIFELINE_SIMULATED_STEP_MS);
if (simulatedStepMs !== undefined && (!Number.isSafeInteger(simulatedStepMs) || simulatedStepMs < 100 || simulatedStepMs > 30_000))
  throw new Error('LIFELINE_SIMULATED_STEP_MS must be an integer from 100 to 30000.');
const simulatedDispatch = new SimulatedDispatch(controller, simulatedStepMs === undefined ? {}
  : { acceptMs: simulatedStepMs, departMs: simulatedStepMs, arriveMs: simulatedStepMs, resolveMs: simulatedStepMs });
const wellbeing = new Wellbeing(resolve(dataDir, 'lifeline.sqlite'), {
  phone: wearerPhone, wearerName: controller.wearerName,
  timezone: process.env.LIFELINE_WELLBEING_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  hour: Number(process.env.LIFELINE_WELLBEING_HOUR ?? 14), enabled: process.env.LIFELINE_WELLBEING_ENABLED !== '0',
});
const locations = new Location(resolve(dataDir, 'lifeline.sqlite'), { wearerName: controller.wearerName });
const locationPublicUrl = process.env.LIFELINE_LOCATION_PUBLIC_URL?.trim().replace(/\/$/, '') || null;
if (locationPublicUrl) {
  const u = new URL(locationPublicUrl);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw new Error('LIFELINE_LOCATION_PUBLIC_URL must be a secure public origin.');
}
const locationGatewayPort = Number(process.env.LIFELINE_LOCATION_GATEWAY_PORT ?? 8879);
if (!Number.isSafeInteger(locationGatewayPort) || locationGatewayPort < 0 || locationGatewayPort > 65535)
  throw new Error('Invalid location sharing gateway port.');
const locationGateway = locationPublicUrl ? createLocationGateway(() => (server.address() as { port: number }).port) : null;
const routeEta = createRouteEta();
const findMy = createFindMy();
const findMyEnabled = process.env.LIFELINE_FIND_MY_ENABLED !== '0';
const findMyRequests = new FindMyRequests(resolve(dataDir, 'lifeline.sqlite'));
let stopFindMy: (() => Promise<void>) | null = null;
let routeBusy = false, nextRouteAt = 0, nextApproachAt = 0;
let routedEta: { key: string; eta: RouteEta } | null = null;
let wellbeingReplyBusy = false, nextWellbeingTick = 0;
let wellbeingVoice: NonNullable<Snapshot['wellbeing']>['voice'] = null;
let wellbeingVoiceSession: string | null = null;
const motion = new Motion();
const wili = new FreeWili();
const wiliAssessment = new WiliAssessment();
const earlyCheckinAssessment = new EarlyCheckinAssessment();
let wearableIdleIncidentId: string | null = null;
let eventCapture: { incidentId: string; capture: EventWindowCapture } | null = null;
const teaching = new Teaching(resolve(dataDir, 'teaching'));
const shakingAssessment = new ShakingAssessment();
const legacyPhone = process.env.LIFELINE_LEGACY_PHONE === '1';
const trials = new Trials(resolve(dataDir, 'trials'));
const trialPinged = new Set<TrialSource>();
let trialWiliHello: WiliHello | null = null;
function recordWiliTrial(type: TrialRecord['type'], payload?: unknown, atMs?: number) {
  if (!legacyPhone) trials.record(type, payload, 'body-wili', atMs);
}
const producers = new Map<string, WebSocket>();
const recorders = new Map<string, WriteStream>();
let healthPromise = loadHealth();
const wellbeingReply = createCareReply({ loadHealth: () => healthPromise, answerPatientQuestionDetailed });
const incidentHealth = new Map<string, Promise<HealthContext>>();
let audio: Uint8Array | null = null;
let audioPreparing = false;
// Demo pacing belongs to our outbox, not a claimed provider quota.
const messageGapMs = Number(process.env.LIFELINE_MESSAGE_GAP_MS ?? 5000);
if (!Number.isFinite(messageGapMs) || messageGapMs < 0 || messageGapMs > 60_000) throw new Error('Invalid LIFELINE_MESSAGE_GAP_MS.');
// Different people have independent submission lanes. A slow wearer check-in
// must not hold an approved responder alert behind its network request.
type MessageLane = 'wearer' | 'responders';
const messageLanes: Record<MessageLane, { busy: boolean; nextAt: number }> = {
  wearer: { busy: false, nextAt: 0 }, responders: { busy: false, nextAt: 0 },
};
let stopPhoton: (() => Promise<void>) | null = null;
let handoffKey: string | null = null;
let stopping = false;
const responderQuestionWorker = createResponderQuestionWorker(controller, generateResponderAnswer,
  { canQueue: () => !stopping });
let contextPreviewBusy = false;
let checkinAudio: CheckinAudioStatus | null = null;
let boardVoice = { configured: false, detail: 'No complete verified WILi voice cache found.' };
let voiceCacheReading = false;
async function refreshVoiceCache(): Promise<void> {
  if (stopping || voiceCacheReading) return;
  voiceCacheReading = true;
  try {
    const manifest = await readStockVoiceManifest(resolve(process.env.LIFELINE_WILI_AUDIO_DIR ?? 'output/freewili-audio'));
    boardVoice = manifest
      ? { configured: true, detail: `${manifest.source}: seven wearable prompts prepared${manifest.provider === 'local' ? ' (local fallback)' : ''}.` }
      : { configured: false, detail: 'No complete verified WILi voice cache found.' };
  } finally { voiceCacheReading = false; }
}
await refreshVoiceCache();
const voiceCacheTimer = setInterval(() => void refreshVoiceCache(), 5000);
voiceCacheTimer.unref();

function locationKey(view = locations.view(controller.active())): string | null {
  const i = controller.active();
  return i?.ownerId && view.eta && view.wearer?.fresh && view.responder?.fresh
    ? JSON.stringify([i.id, i.ownerId, view.wearer.latitude, view.wearer.longitude, view.responder.latitude, view.responder.longitude]) : null;
}
function locationView(): NonNullable<Snapshot['location']> {
  const view = locations.view(controller.active()), key = locationKey(view);
  const eta = routedEta && routedEta.key === key && Date.now() - routedEta.eta.updatedAt <= 60_000 ? routedEta.eta : view.eta;
  const native = findMy.status();
  return { ...view, configured: Boolean(wearerPhone && ((findMyEnabled && native.configured) || locationPublicUrl)), eta,
    detail: eta?.method === 'apple-maps-walking' ? 'Apple Maps walking estimate; indoor access and location accuracy can affect arrival.' : view.detail,
    invite: findMyEnabled && native.configured ? findMyRequests.view() ?? undefined : locations.inviteStatus() ?? undefined,
    native: { ...native, configured: findMyEnabled && native.configured, request: findMyRequests.view() } };
}
function findMySubjects(): FindMySubject[] {
  const list: FindMySubject[] = wearerPhone ? [{ role: 'wearer', address: wearerPhone, name: controller.wearerName }] : [];
  const active = controller.active();
  if (active) for (const r of responders) {
    if (!r.phone || !active.contacted.includes(r.id) || active.declined.includes(r.id) || (active.ownerId && active.ownerId !== r.id)) continue;
    list.push({ role: 'responder', address: r.phone, name: r.name, responderId: r.id, incidentId: active.id });
  }
  return list;
}
function acceptedWearerChat(): string | null {
  const daily = wellbeing.acceptedConversation(); if (daily) return daily.chatId;
  const active = controller.active();
  return active ? controller.actions(active.id).findLast(a => a.recipientId === null && a.status === 'provider_accepted' && a.providerChatId)?.providerChatId ?? null : null;
}
function wearerFindMyKey(chatId: string): string {
  return `wearer:${createHash('sha256').update(`${wearerPhone}:${chatId}`).digest('hex')}`;
}
function ensureFindMyOnboarding(): void {
  if (!findMyEnabled || !findMy.status().configured || !wearerPhone) return;
  const view = locations.view(controller.active()), chatId = acceptedWearerChat();
  if (chatId && view.wearer?.source !== 'photon-find-my') findMyRequests.queue(wearerFindMyKey(chatId),
    { role: 'wearer', address: wearerPhone, name: controller.wearerName }, chatId);
  const active = controller.active(); if (!active?.ownerId || view.responder?.source === 'photon-find-my') return;
  const responder = responders.find(r => r.id === active.ownerId);
  const accepted = controller.actions(active.id).findLast(a => a.recipientId === active.ownerId && a.status === 'provider_accepted' && a.providerChatId);
  if (responder?.phone && accepted?.providerChatId) findMyRequests.queue(`responder:${active.id}:${responder.id}`,
    { role: 'responder', address: responder.phone, name: responder.name, incidentId: active.id, responderId: responder.id }, accepted.providerChatId);
}
function shareLink(key: string, role: 'wearer' | 'responder', incidentId?: string, responderId?: string): string | null {
  if (!locationPublicUrl) return null;
  const grant = locations.issue({ key, role, name: role === 'wearer' ? controller.wearerName
    : responders.find(r => r.id === responderId)?.name ?? 'Responder', incidentId, responderId });
  return `${locationPublicUrl}/share-location#grant=${encodeURIComponent(grant)}`;
}
function locationBrief(): string {
  const view = locationView(), p = view.wearer;
  if (!p) return 'Patient location has not been shared. Location is unknown.';
  const label = p.fresh ? 'Shared phone location' : 'Last shared phone location (stale; current location unknown)';
  const map = `https://maps.apple.com/?ll=${p.latitude},${p.longitude}`;
  const accuracy = p.accuracy === null ? 'Accuracy unknown' : `Accuracy ±${Math.ceil(p.accuracy)} m`;
  const lines = [`${label} (${p.source === 'photon-find-my' ? 'Photon Find My' : 'browser geolocation'}): ${map}`, `${accuracy}; captured ${new Date(p.timestamp).toISOString()}.`];
  if (view.eta && view.responder) lines.push(`${view.responder.name}: ${Math.max(1, Math.ceil(view.eta.seconds / 60))} min estimated walk (${view.eta.method === 'apple-maps-walking' ? 'Apple Maps' : 'straight-line approximation'}). This does not confirm arrival.`);
  return lines.join('\n');
}
async function refreshRoute(): Promise<void> {
  if (stopping || routeBusy || Date.now() < nextRouteAt) return;
  const view = locations.view(controller.active()), key = locationKey(view);
  if (!key || !view.wearer || !view.responder) { routedEta = null; return; }
  nextRouteAt = Date.now() + 20_000; routeBusy = true;
  try {
    const eta = await routeEta.estimate(view.responder, view.wearer);
    if (!stopping && eta && locationKey() === key) { routedEta = { key, eta }; broadcast(); }
  } finally { routeBusy = false; }
}

function snapshot(): Snapshot {
  const incident = controller.latest();
  const providers = { ...providerStatus(), wiliVoice: boardVoice };
  const wearerMessaging = { configured: Boolean(wearerPhone && providers.photon?.configured),
    detail: !wearerPhone ? 'Set LIFELINE_WEARER_PHONE to the approved patient phone for the iMessage check-in.'
      : !providers.photon?.configured ? 'Patient phone configured; Photon credentials are required for iMessage check-in.'
        : 'Patient phone and Photon credentials configured.' };
  return { rehearsalRole: rehearsalRole.view(controller.active()?.id), serverTime: Date.now(), wearer: { name: controller.wearerName }, incident, responders: responders.map(r => ({ ...r, phone: r.phone ? 'configured' : null })),
    dispatch: { mode: dispatchMode, detail: dispatchMode === 'simulated'
      ? 'Local dispatch: Maya’s acceptance, travel, arrival and outcome run automatically.'
      : 'Approved human responders accept and report their own progress over Photon.' },
    timeline: incident ? controller.events(incident.id) : [], actions: incident ? controller.actions(incident.id).map(action => {
      const { providerChatId, providerLineId, replyChatId, replyLineId, ...visible } = action;
      return visible;
    }) : [],
    conversation: incident ? controller.conversation(incident.id) : [],
    checkinAudio: checkinAudio && checkinAudio.incidentId === incident?.id && checkinAudio.checkinId === incident?.checkinId ? checkinAudio : null,
    sensors: motion.views().filter(s => legacyPhone || s.source !== 'chest-phone'),
    wili: wili.view(), providers, wearerMessaging, trial: trials.view(), policy, eventUnderstanding: true,
    wellbeing: { ...wellbeing.view(), voice: wellbeingVoice }, location: locationView() };
}
async function prepareWellbeingReply(): Promise<void> {
  if (stopping || wellbeingReplyBusy || controller.active()) return;
  const pending = wellbeing.replyNeeded(); if (!pending) return;
  wellbeingReplyBusy = true;
  try {
    const reply = await wellbeingReply.generate(pending, wellbeing.view().messages);
    if (!stopping && !controller.active()) {
      if (reply.recordContext) wellbeing.queueRecordReply(pending.id, reply.text, reply.generation, reply.recordContext, reply.patientRecord);
      else if (reply.generation !== 'policy_refusal') wellbeing.queueReply(pending.id, reply.text, reply.generation);
    }
  } catch {
    if (!stopping && !controller.active()) wellbeing.queueReply(pending.id,
      'Thank you for telling me. Would you like to tell me a little more about your day?', 'degraded');
  } finally { wellbeingReplyBusy = false; if (!stopping) broadcast(); }
}
function wellbeingHelp(transcript: string, source: 'freewili-local-speech' | 'photon-imessage', event?: ProviderInbound): boolean {
  if (classifyCheckinReply(transcript) !== 'help_requested' || controller.active()) return false;
  const seizure = reportsCurrentSeizure(transcript);
  const i = controller.triggerReportedHelp({ kind: 'manual', ...(seizure ? { eventType: 'reported-seizure' as const } : {}),
    summary: seizure ? 'Patient reports a current seizure; help requested. Reported, not sensor-confirmed.'
      : 'Patient requested help during a daily check-in conversation.' }, transcript, source, event);
  const pending = wellbeing.replyNeeded(); if (pending) wellbeing.markIncidentRouted(pending.id);
  prepareIncident(controller.active() ?? i); return true;
}
function healthForIncident(i: Incident): Promise<HealthContext> {
  const stored = controller.healthContext(i.id); if (stored) return Promise.resolve(stored);
  let pending = incidentHealth.get(i.id);
  if (!pending) {
    const patientAtDetection = healthPromise;
    pending = patientAtDetection.then(h => controller.bindHealthContext(i.id, h));
    incidentHealth.set(i.id, pending);
  }
  return pending;
}
const live = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const ingest = new WebSocketServer({ noServer: true, maxPayload: 8192 });
function broadcast(): void {
  if (stopping || !live.clients.size) return;
  const data = JSON.stringify(snapshot());
  for (const ws of live.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 100_000) ws.send(data);
}
function prepareIncident(i: Incident): void {
  const observations = controller.conversation(i.id);
  const contextKey = (incident: Incident) => JSON.stringify([incident.id, incident.evidence.window?.completedAtMs ?? null,
    controller.conversation(incident.id).filter(m => m.speaker === 'wearer').map(m => m.id)]);
  const key = contextKey(i);
  const stillCurrent = () => !stopping && handoffKey === key && controller.active()?.id === i.id
    && contextKey(controller.active()!) === key;
  if (handoffKey !== key) {
    handoffKey = key;
    void healthForIncident(i).then(h => buildHandoffDetailed(i, h, observations)).then(handoff => {
      // A record-only composition started before speech must not overwrite the
      // newer handoff that includes the wearer's exact reported symptoms.
      if (stillCurrent()) {
        controller.setHandoff(i.id, handoff.text, handoff); broadcast();
      }
    }).catch(() => { if (stillCurrent())
      controller.setHandoff(i.id, 'Health record unavailable. Response continues.', { generation: 'degraded' }); });
  }
  prepareAudio();
}
function prepareAudio(): void {
  if (legacyPhone && !audio && !audioPreparing) {
    audioPreparing = true;
    void prepareCheckinAudio().then(bytes => { audio = bytes; }).catch(() => {}).finally(() => { audioPreparing = false; });
  }
}
async function providerWorker(channel: MessageLane): Promise<void> {
  const lane = messageLanes[channel];
  if (channel === 'wearer' && rehearsalRole.view(controller.active()?.id)) return;
  if (lane.busy || stopping || Date.now() < lane.nextAt || !providerStatus().photon?.configured
    || (channel === 'responders' && dispatchMode === 'simulated')) return;
  lane.busy = true;
  try {
    let a = controller.claimAction(channel, true);
    if (!a) {
      if (channel === 'responders') return;
      const native = findMyEnabled ? findMyRequests.claim() : null;
      if (native) {
        const eligible = () => !stopping && findMySubjects().some(s => s.role === native.subject.role && s.address === native.subject.address
          && s.incidentId === native.subject.incidentId && s.responderId === native.subject.responderId);
        if (!eligible()) { findMyRequests.finish(native.id, { status: 'failed', detail: 'Sharing request authorization ended before submission.' }); return; }
        lane.nextAt = Date.now() + messageGapMs;
        const result = await findMy.request(native.subject.address, native.chatId, native.id, eligible);
        if (!stopping) findMyRequests.finish(native.id, result);
        return;
      }
      if (controller.active()) return;
      const invite = locations.claimInvite();
      if (invite && wearerPhone) {
        lane.nextAt = Date.now() + messageGapMs;
        const result = await sendMessage(wearerPhone, invite.text, () => !stopping && !controller.active());
        if (!stopping) locations.finishInvite(invite.id, result);
        return;
      }
      const daily = wellbeing.claimAction(); if (!daily || !wearerPhone) return;
      lane.nextAt = Date.now() + messageGapMs;
      const result = await sendMessage(wearerPhone, daily.type === 'followup' ? `${daily.author || 'Care team'} asks: ${daily.text}` : clinicalMessage(daily.text, controller.wearerName),
        () => !stopping && wellbeing.actionPermitted(daily, Boolean(controller.active())), daily.replyChatId
          ? { replyToMessageId: daily.replyToMessageId, chatId: daily.replyChatId, lineId: daily.replyLineId } : undefined);
      if (!stopping) wellbeing.finishAction(daily.id, result.status, result.detail, result.messageId, result);
      return;
    }
    const wearerAction = ['wearer_checkin', 'wearer_ack', 'wearer_status', 'wearer_location'].includes(a.type);
    const recipientId = a.recipientId;
    const role = rehearsalRole.view(controller.active()?.id);
    const roleRoute = !wearerAction && role?.responderId === recipientId;
    const phone = wearerAction || roleRoute ? wearerPhone : responders.find(r => r.id === recipientId)?.phone;
    if (!phone) { controller.finishAction(a.id, 'failed', wearerAction
      ? 'No approved patient phone configured; iMessage was not sent.' : 'No approved phone configured; message not sent.'); return; }
    let prepared = a.text;
    if (locationPublicUrl && !prepared.includes('/share-location#grant=')) {
      if (a.type === 'wearer_checkin') prepared += `\n\nShare where you are (optional):\n${shareLink(`action:${a.id}`, 'wearer', a.incidentId)}`;
      if (a.type === 'alert' || (a.type === 'status' && controller.active()?.ownerId === a.recipientId))
        prepared += `\n\nSee the shared location and share your approach:\n${shareLink(`action:${a.id}`, 'responder', a.incidentId, a.recipientId ?? undefined)}`;
    }
    if (['alert', 'handoff'].includes(a.type) && locationView().wearer && !prepared.includes('\n\nShared location:\n'))
      prepared = prepared.replace('Location not provided.', 'Current location appears in the separate shared-location section.') + `\n\nShared location:\n${locationBrief()}`;
    if (prepared.length <= 6000 && prepared !== a.text) a = controller.decorateAction(a.id, prepared);
    lane.nextAt = Date.now() + messageGapMs;
    const result = await sendMessage(phone, a.type === 'answer' ? clinicalMessage(a.text, controller.wearerName) : a.text, () => !stopping && controller.actionPermitted(a)
      && Boolean(rehearsalRole.view(controller.active()?.id)?.responderId === recipientId) === Boolean(roleRoute)
      && (a.type !== 'wearer_location' || Boolean(locationView().eta)), a.replyToMessageId
      ? { replyToMessageId: a.replyToMessageId, chatId: a.replyChatId, lineId: a.replyLineId } : undefined);
    if (!stopping) controller.finishAction(a.id, result.status, result.detail, result.messageId, result);
  } catch { /* attempt remains attempting; startup recovery preserves an unknown outcome */ }
  finally { lane.busy = false; if (!stopping) broadcast(); }
}
async function inbound(e: ProviderInbound): Promise<void> {
  if (stopping || controller.seenInbound(e.messageId)) return;
  try {
    // Cloud input without persisted exact-channel provenance cannot operate the incident.
    if (!e.chatId || !e.lineId) return;
    const role = rehearsalRole.view(controller.active()?.id);
    const roleResponder = role ? responders.find(r => r.id === role.responderId) : null;
    const mapped = rehearsalRole.map(e, controller.active()?.id, wearerPhone, roleResponder?.phone ?? null);
    if (mapped) e = mapped;
    else if (roleResponder?.phone && phoneIdentity(e.sender) === phoneIdentity(roleResponder.phone)) return;
    if (!mapped && wearerPhone && phoneIdentity(e.sender) === phoneIdentity(wearerPhone)) {
      if (controller.active()) {
        if (controller.matchesConversation(e, null)) handleWearerInbound(e, wearerPhone, controller);
      } else if (wellbeing.matchesConversation(e) && wellbeing.recordText(e)) {
        if (!wellbeingHelp(wellbeing.replyNeeded()?.text ?? e.text!, 'photon-imessage', e)) void prepareWellbeingReply();
      }
      return;
    }
    const r = approvedResponder(e.sender, responders);
    const i = controller.active(); if (!r || !i || e.removed || !controller.matchesConversation(e, r.id)) return;
    if (handleResponderProgress(e, controller)) return;
    if (handleResponderRelay(e, controller)) return;
    if (e.kind !== 'text') return;
    if (e.targetMessageId !== undefined
      && (!e.targetMessageId || !controller.responderIncidentForMessage(e.targetMessageId, r.id))) return;
    if ((e.text ?? '').trim()) enqueueResponderQuestion(e, controller);
  } catch (error) {
    if (!(error instanceof PolicyError)) console.error('Provider processing failed; incident remains unresolved.');
  } finally {
    if (!stopping) { const active = controller.active(); if (active) prepareIncident(active); broadcast(); }
  }
}

async function generateResponderAnswer(incident: Incident, question: string) {
  if (/\blocation\b|\bwhere\b|\beta\b|how (?:far|long)|when.*arriv/i.test(question)) {
    const brief = locationBrief();
    if (!/medicat|allerg|condition|health|record|vital|dose|blood/i.test(question)) return brief;
    const answer = await answerQuestionDetailed(incident, await healthForIncident(incident), question, controller.conversation(incident.id));
    return { ...answer, text: answer.text.replace('Location not provided.', 'See the current shared-location context below.') + `\n\n${brief}` };
  }
  return answerQuestionDetailed(incident, await healthForIncident(incident), question, controller.conversation(incident.id));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
}
async function requestBody(req: IncomingMessage): Promise<unknown> {
  req.setEncoding('utf8');
  let text = '', bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk); if (bytes > 8000) throw new PolicyError('Request is too large.');
    text += chunk;
  }
  return JSON.parse(text);
}
async function commandBody(req: IncomingMessage): Promise<Command> {
  const parsed = await requestBody(req);
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as Command).type !== 'string') throw new PolicyError('Invalid command.');
  return parsed as Command;
}
function execute(c: Command): { calibratedSources: Source[] } | undefined {
  switch (c.type) {
    case 'trigger': {
      if (!['synthetic', 'manual'].includes(c.kind) || (c.summary !== undefined && (typeof c.summary !== 'string' || c.summary.length > 1000))) throw new PolicyError('Invalid trigger.');
      prepareIncident(controller.trigger({ kind: c.kind, summary: c.summary ?? (c.kind === 'synthetic' ? 'Check-in started manually.' : 'Help requested.') })); break;
    }
    case 'cancel': controller.cancel(c.incidentId, c.checkinId); break;
    case 'accept': controller.accept(c.incidentId, c.responderId); break;
    case 'depart': case 'arrive': controller.progress(c.incidentId, c.responderId, c.type); break;
    case 'decline': controller.decline(c.incidentId, c.responderId); break;
    case 'resolve': controller.resolve(c.incidentId, c.responderId, c.outcome); break;
    case 'calibrate': {
      const guarded = c.expectedSessionId !== undefined || c.expectedSensorLocation !== undefined;
      if (guarded) {
        if (typeof c.expectedSessionId !== 'string' || !/^[\w-]{1,80}$/.test(c.expectedSessionId)
          || !['Left', 'Right'].includes(c.expectedSensorLocation ?? ''))
          throw new PolicyError('Calibration requires the current AirPod session and reporting side.');
        const waist = motion.views().find(s => s.source === 'waist-airpod');
        if (!waist?.connected || !waist.fresh || waist.sessionId !== c.expectedSessionId
          || waist.sensorLocation !== c.expectedSensorLocation)
          throw new PolicyError('The waist AirPod changed or disconnected. Check its placement and restart calibration.');
      }
      const sources = guarded ? motion.calibrate(['waist-airpod']) : motion.calibrate();
      if (!sources.length) throw new PolicyError('Calibration requires one second of continuous still samples; stop moving and try again.');
      trials.record('calibration', { sources }); return { calibratedSources: sources };
    }
    case 'reset': {
      if (c.readyImmediately !== undefined && typeof c.readyImmediately !== 'boolean') throw new PolicyError('Invalid reset readiness option.');
      rehearsalRole.clear(); controller.reset();
      eventCapture = null;
      teaching.cancel();
      const fast = c.readyImmediately === true;
      motion.reset({ preserveCalibration: true, cooldown: !fast });
      wili.clearObservations();
      wiliAssessment.reset({ cooldown: !fast }); earlyCheckinAssessment.reset({ cooldown: !fast }); shakingAssessment.reset({ cooldown: !fast });
      if (fast) { wearableIdleIncidentId = controller.latest()?.id ?? null; checkinAudio = null; }
      trials.record('motion.reset', { clocks: false, cooldown: !fast, preserveCalibration: true }); handoffKey = null; break;
    }
    default: throw new PolicyError('Unsupported command.');
  }
}
const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/vnd.microsoft.icon', '.zip': 'application/zip' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok',
      motionSources: [...motion.views().filter(v => v.fresh && (legacyPhone || v.source !== 'chest-phone')).map(v => v.source),
        ...(wili.view().fresh ? ['body-wili'] : [])] });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());
    if (['/api/ehr', '/api/ehr/brief'].includes(url.pathname) && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Patient workspace access requires the operator token.' });
      const incidentId = url.searchParams.get('incidentId');
      if (url.searchParams.getAll('incidentId').length > 1 || (incidentId !== null && !/^LF-[A-Z0-9-]+$/.test(incidentId)))
        throw new PolicyError('Provide one valid incident ID or use the current record.');
      const selectedIncident = incidentId ? controller.incident(incidentId) : controller.latest();
      if (incidentId && !selectedIncident) return json(res, 404, { error: 'Unknown incident. The current record has not been substituted.' });
      // Capture the chosen clinical read once. An absent saved snapshot stays absent.
      const health = incidentId ? controller.healthContext(incidentId) : await healthPromise;
      const incidents = controller.db.prepare('SELECT id FROM incidents ORDER BY rowid DESC LIMIT 12').all()
        .map(row => controller.incident(String(row.id))).filter((i): i is Incident => Boolean(i));
      const workspace = buildEhrWorkspace({ patientRecord: health?.patientRecord ?? null, incidentId,
        wearerName: controller.wearerName, wellbeing: { ...wellbeing.view(), ...(wellbeingVoice ? { voice: wellbeingVoice } : {}) },
        incidents, selectedIncident, responders,
        timeline: selectedIncident ? controller.events(selectedIncident.id) : [],
        conversation: selectedIncident ? controller.conversation(selectedIncident.id) : [] });
      if (url.pathname === '/api/ehr') return json(res, 200, { ...workspace, careTeam: responders.map(r => ({ id: r.id, name: r.name })) });
      const journal = wellbeing.careJournal();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="lifeline-care-record.json"' });
      return res.end(JSON.stringify({ schemaVersion: 1, kind: 'LIFELINE source-separated care record',
        exportedAt: new Date(workspace.generatedAt).toISOString(), context: workspace.context,
        hospitalRecords: { source: workspace.sources.hospital, snapshot: workspace.patientRecord,
          incidentSnapshot: selectedIncident ? controller.healthContext(selectedIncident.id)?.patientRecord ?? null : null,
          answerSnapshots: journal.hospitalRecords.snapshots },
        lifelineObservations: { source: workspace.sources.observations, wearer: workspace.care.subject,
          wellbeing: journal.lifelineObservations, incident: workspace.care.selectedIncident },
      }, null, 2));
    }
    if (url.pathname === '/api/location/invite' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Pairing token required.' });
      if (findMyEnabled && findMy.status().configured && wearerPhone) {
        await requestBody(req);
        const chatId = acceptedWearerChat();
        if (!chatId) return json(res, 409, { error: 'The approved patient must have an accepted Photon conversation first.' });
        const queued = findMyRequests.queue(wearerFindMyKey(chatId),
          { role: 'wearer', address: wearerPhone, name: controller.wearerName }, chatId);
        broadcast(); return json(res, 200, { ok: true, queued, location: locationView() });
      }
      if (!locationPublicUrl || !wearerPhone) return json(res, 503, { error: 'Photon Find My or secure browser sharing configuration required.' });
      if (controller.active()) return json(res, 409, { error: 'The incident check-in already includes location sharing.' });
      await requestBody(req);
      const key = `invitation:${randomBytes(16).toString('hex')}`;
      const link = shareLink(key, 'wearer');
      const queued = locations.queueInvite(`LIFELINE: You can share where you are so a responder can find you. Open this private link, then tap Share my location. You can stop at any time.\n${link}`);
      broadcast(); return json(res, 200, { ok: true, queued, location: locationView() });
    }
    if (url.pathname === '/api/location/share' && ['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const active = controller.active(), grant = locations.authorize(bearer, active);
      if (!grant || (grant.role === 'responder' && (!active?.contacted.includes(grant.responderId!) || active.declined.includes(grant.responderId!))))
        return json(res, 401, { error: 'Your sharing link has expired or is no longer active. Ask for a new link.' });
      if (req.method === 'DELETE') { locations.stop(bearer, active); routedEta = null; broadcast(); return json(res, 200, { ok: true }); }
      if (req.method === 'POST') {
        if (!locations.update(bearer, await requestBody(req) as Parameters<Location['update']>[1], active))
          return json(res, 400, { error: 'A recent, accurate location update is required.' });
        void refreshRoute(); broadcast(); return json(res, 200, { ok: true, location: locationView() });
      }
      return json(res, 200, { role: grant.role, name: grant.name, incidentId: grant.incidentId ?? null, location: locationView() });
    }
    if (url.pathname === '/api/setup' && req.method === 'GET') {
      const origin = req.headers.origin;
      const requestHost = new URL(`http://${req.headers.host ?? ''}`).hostname;
      if (!loopback(req) || !['localhost', '127.0.0.1', '[::1]'].includes(requestHost)
        || (origin && new URL(origin).host !== req.headers.host)) return json(res, 403, { error: 'Pairing setup is available only from this Mac.' });
      const addresses = Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a!.address);
      const bindAddress = (server.address() as { address: string }).address;
      return json(res, 200, { token, port: req.socket.localPort ?? port, addresses,
        lanEnabled: !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(bindAddress) });
    }
    if (url.pathname === '/api/commands' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator/pairing token required.' });
      const result = execute(await commandBody(req)); broadcast(); return json(res, 200, { ok: true, ...result });
    }
    if (url.pathname === '/api/rehearsal/role') {
      if (!authorized(req)) return json(res,401,{error:'Operator token required.'});
      if (req.method === 'GET') return json(res,200,{role:rehearsalRole.view(controller.active()?.id)});
      if (req.method !== 'POST') return json(res,405,{error:'Method not allowed.'});
      const body = await requestBody(req) as {role?:unknown;responderId?:unknown;incidentId?:unknown};
      if(body?.role==='patient') {rehearsalRole.clear();broadcast();return json(res,200,{role:null});}
      const incident=controller.active();
      if(body?.role!=='responder'||!incident||body.incidentId!==incident.id||incident.phase==='CONFIRMING'
        ||dispatchMode!=='live'||!wearerPhone) throw new PolicyError('Escalate the current live incident before switching to the care-team role.');
      const responder=responders.find(r=>r.id===body.responderId&&r.phone);
      if(!responder) throw new PolicyError('Select an approved responder.');
      if(incident.ownerId&&incident.ownerId!==responder.id) throw new PolicyError('Another responder owns this incident.');
      controller.queueRehearsalAlert(incident.id,responder.id);
      rehearsalRole.set(incident.id,responder.id);broadcast();
      return json(res,200,{role:rehearsalRole.view(incident.id)});
    }
    if (url.pathname === '/api/teaching') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator token required.' });
      if (req.method === 'GET') return json(res, 200, teaching.view());
      if (req.method === 'POST') {
        const body = await requestBody(req) as { action?: unknown; id?: unknown; label?: unknown };
        if (body?.action === 'start') {
          if (controller.active()) throw new PolicyError('Reset or finish the current incident before recording practice movements.');
          teaching.start(wili, motion);
        } else if (body?.action === 'label') teaching.label(body.id, body.label);
        else if (body?.action === 'cancel') {
          teaching.cancel(); motion.reset({ preserveCalibration: true, cooldown: false }); wili.clearObservations();
          wiliAssessment.reset({ cooldown: false }); earlyCheckinAssessment.reset({ cooldown: false }); shakingAssessment.reset({ cooldown: false });
        }
        else throw new PolicyError('Invalid teaching action.');
        return json(res, 200, teaching.view());
      }
      return json(res, 405, { error: 'Use GET or POST.' });
    }
    if (url.pathname === '/api/patient-record' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Patient record access requires the operator token.' });
      const id = url.searchParams.get('incidentId');
      const health = id ? controller.healthContext(id) : await healthPromise;
      if (!health?.patientRecord) return json(res, id ? 404 : 503, { error: 'Patient record snapshot unavailable.' });
      return json(res, 200, health.patientRecord);
    }
    if (url.pathname === '/api/patient-record/refresh' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Patient record access requires the operator token.' });
      healthPromise = loadHealth();
      const h = await healthPromise;
      return h.patientRecord ? json(res, 200, h.patientRecord) : json(res, 503, { error: 'Patient record unavailable.' });
    }
    if (url.pathname === '/api/wellbeing/checkin' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator token required.' });
      if (controller.active()) return json(res, 409, { error: 'The current incident takes priority. Try after it is resolved.' });
      if (!wellbeing.view().enabled) return json(res, 503, { error: 'Configure the approved patient and enable daily wellbeing.' });
      await requestBody(req);
      const queued = wellbeing.queueDailyCheckin(); broadcast();
      return json(res, 200, { ok: true, queued, wellbeing: wellbeing.view() });
    }
    if (url.pathname === '/api/wellbeing/followup' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Care team access requires the operator token.' });
      if (controller.active()) return json(res, 409, { error: 'Use the active incident conversation while an incident is open.' });
      const body = await requestBody(req) as { reportId?: string; responderId?: string; question?: string; requestId?: string };
      const responder = responders.find(r => r.id === body?.responderId);
      if (!responder || typeof body?.reportId !== 'string' || typeof body.question !== 'string' || typeof body.requestId !== 'string')
        return json(res, 400, { error: 'Select a patient report, approved care team member, and question.' });
      const queued = wellbeing.queueFollowup(body.reportId, responder.name, body.question, body.requestId);
      if (!queued) return json(res, 400, { error: 'Invalid or already submitted follow-up.' });
      broadcast(); return json(res, 202, { queued: true });
    }
    if (url.pathname === '/api/wellbeing/brief' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Care journal access requires the operator token.' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="lifeline-care-journal.json"' });
      return res.end(JSON.stringify(wellbeing.careJournal(), null, 2));
    }
    if (url.pathname === '/api/patient-record/question' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Patient record access requires the operator token.' });
      const body = await requestBody(req) as { question?: unknown; revision?: unknown; incidentId?: unknown };
      if (!body || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000
        || typeof body.revision !== 'string' || (body.incidentId !== undefined && typeof body.incidentId !== 'string'))
        throw new PolicyError('Provide a question, the displayed record revision, and optional incident ID.');
      const health = body.incidentId ? controller.healthContext(String(body.incidentId)) : await healthPromise;
      if (!health?.patientRecord) return json(res, 503, { error: 'Patient record unavailable.' });
      if (health.patientRecord.revision !== body.revision) return json(res, 409, { error: 'The patient context changed. Refresh and ask again.' });
      if (contextPreviewBusy) return json(res, 409, { error: 'Another answer is being prepared.' });
      contextPreviewBusy = true;
      try {
        const answer = await answerPatientQuestionDetailed(health, body.question.trim());
        if (stopping || res.destroyed) return;
        if (!body.incidentId && (await healthPromise).patientRecord?.revision !== body.revision)
          return json(res, 409, { error: 'The patient context changed while preparing the answer.' });
        return json(res, 200, { answer: answer.text, generation: answer.generation, revision: health.patientRecord.revision });
      } finally { contextPreviewBusy = false; }
    }
    const careBrief = url.pathname.match(/^\/api\/incidents\/(LF-[A-Z0-9-]+)\/brief$/);
    if (careBrief && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Care brief access requires the operator token.' });
      const i = controller.incident(careBrief[1]);
      if (!i) return json(res, 404, { error: 'Unknown incident.' });
      const h = controller.healthContext(i.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${i.id}-care-brief.json"` });
      return res.end(JSON.stringify({ schemaVersion: 1, kind: 'LIFELINE care brief', exportedAt: new Date().toISOString(),
        hospitalRecords: { source: 'FinchNode (read-only)', snapshot: h?.patientRecord ?? null },
        lifelineObservations: { source: 'LIFELINE local incident log; not hospital EHR entries',
          incident: i, timeline: controller.events(i.id), conversation: controller.conversation(i.id),
          limitations: 'Motion evidence is a possible incident, not a diagnosis. Responder progress and outcome are reports. Older sensor-or-operator events have unspecified origin.' },
        summary: { text: i.handoff, clinicalRevision: i.healthRevision ?? null, generation: i.handoffGeneration ?? 'unavailable' },
      }, null, 2));
    }
    if (url.pathname === '/api/context/question' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator token required for local AI rehearsal.' });
      const body = await requestBody(req) as { incidentId?: unknown; question?: unknown };
      if (!body || typeof body !== 'object' || typeof body.incidentId !== 'string'
        || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000)
        throw new PolicyError('Provide the displayed incident ID and a question of 1–2000 characters.');
      const incident = controller.latest();
      if (!incident) throw new PolicyError('Start a labelled development incident before rehearsing a question.');
      if (incident.id !== body.incidentId) return json(res, 409, { error: 'The incident changed. Refresh the context and ask again.' });
      if (contextPreviewBusy) return json(res, 409, { error: 'An answer is already being prepared. Wait for it to finish.' });
      contextPreviewBusy = true;
      try {
        const observations = controller.conversation(incident.id);
        const observationKey = JSON.stringify(observations.map(({ id, text }) => [id, text]));
        const answer = await answerQuestionDetailed(incident, await healthForIncident(incident), body.question.trim(), observations);
        if (stopping || res.destroyed) return;
        const current = controller.latest();
        if (!current || current.id !== incident.id || current.version !== incident.version
          || JSON.stringify(controller.conversation(incident.id).map(({ id, text }) => [id, text])) !== observationKey)
          return json(res, 409, { error: 'The incident changed while preparing the answer. Ask again using the current context.' });
        // Local rehearsal only: no outbox entry, responder impersonation, or phase change.
        broadcast();
        return json(res, 200, { incidentId: incident.id, version: incident.version,
          answer: answer.text, generation: answer.generation });
      } finally { contextPreviewBusy = false; }
    }
    if (url.pathname === '/api/trials/start' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator token required.' });
      const body = await requestBody(req) as { label?: unknown; scenario?: unknown };
      if (!body || typeof body !== 'object') throw new PolicyError('Invalid trial request.');
      if (controller.active()) throw new PolicyError('Finish the active incident before starting a trial.');
      const sensors = motion.views(), bodyView = wili.view();
      const initialSources: TrialSource[] = sensors.filter(s => s.connected).map(s => s.source);
      if (!legacyPhone && bodyView.connected) initialSources.push('body-wili');
      const initialSessions = Object.fromEntries(sensors.filter(s => s.connected && s.sessionId)
        .map(s => [s.source, s.sessionId!]));
      if (!legacyPhone && bodyView.connected && trialWiliHello) initialSessions['body-wili'] = trialWiliHello.sessionId;
      const view = trials.start(body.label, body.scenario, initialSources, {
        captureMode: legacyPhone ? 'legacy-core-motion' : 'wili-waist', initialSessions,
        preservedCalibration: legacyPhone ? [] : sensors.filter(s => s.calibrated && s.sessionId && s.sensorLocation)
          .map(s => ({ source: s.source, sessionId: s.sessionId!, sensorLocation: s.sensorLocation! })),
      });
      motion.reset({ clocks: true, cooldown: false, preserveCalibration: !legacyPhone }); trialPinged.clear();
      if (!legacyPhone) {
        // New paired trials use only subsequent measurements; calibration stays session-bound.
        wili.resetForTrial(); wiliAssessment.reset({ cooldown: false }); earlyCheckinAssessment.reset({ cooldown: false });
        if (bodyView.connected && trialWiliHello) trials.record('device.hello', trialWiliHello, 'body-wili');
      }
      broadcast(); return json(res, 200, view);
    }
    if (url.pathname === '/api/trials/marker' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator token required.' });
      const body = await requestBody(req) as { label?: unknown };
      const view = trials.marker(body?.label); broadcast(); return json(res, 200, view);
    }
    if (url.pathname === '/api/trials/stop' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator token required.' });
      const view = trials.stop(); broadcast(); return json(res, 200, view);
    }
    const trialDownload = url.pathname.match(/^\/api\/trials\/([0-9a-f-]+)\/download$/i);
    if (trialDownload && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Operator token required.' });
      const file = trials.download(trialDownload[1]);
      res.on('close', () => file.destroy());
      file.on('error', () => { if (!res.headersSent) json(res, 500, { error: 'Recording could not be read.' }); else res.destroy(); });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="trial-${trialDownload[1]}.jsonl"`, 'Cache-Control': 'no-store' });
      file.pipe(res); return;
    }
    if (url.pathname === '/api/checkin' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Pairing token required.' });
      const active = controller.active(); if (active) prepareIncident(active);
      const i = active ?? controller.latest();
      return json(res, 200, { incident: i, audioUrl: audio ? '/api/audio/checkin' : null,
        serverTime: Date.now(), responders: responders.map(r => ({ id: r.id, name: r.name })), policy });
    }
    if (url.pathname === '/api/checkin/reply' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'Pairing token required.' });
      if (!legacyPhone) return json(res, 410, { error: 'Phone speech acquisition is disabled. Use the communication controls.' });
      const body = await requestBody(req);
      if (!body || typeof body !== 'object') throw new PolicyError('Invalid check-in reply.');
      const decision = controller.recordCheckinReply(body as CheckinReply);
      const active = controller.active(); if (active) prepareIncident(active);
      broadcast(); return json(res, 200, { decision });
    }
    if (url.pathname === '/api/audio/checkin' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Pairing token required.' });
      if (!audio) return json(res, 404, { error: 'ElevenLabs clip is unavailable; native fallback is development-only.' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' }); return res.end(Buffer.from(audio));
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API endpoint.' });
    const avatarAsset: Record<string, { file: string; mime: string }> = {
      '/media/demo/avatar.ply': { file: 'output/demo-avatar/person-posed.ply', mime: 'application/octet-stream' },
      '/vendor/avatar-engine.js': { file: 'output/demo-avatar/engine.js', mime: 'text/javascript' },
    };
    const avatarFile = avatarAsset[url.pathname];
    if (req.method === 'GET' && avatarFile) {
      if (!existsSync(avatarFile.file)) return json(res, 404, { error: 'Avatar asset is unavailable.' });
      res.writeHead(200, { 'Content-Type': avatarFile.mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(readFileSync(avatarFile.file));
    }
    const allowed = new Set(['/index.html', '/landing.html', '/styles.css', '/app.js', '/teach.js', '/dashboard-view.js', '/care-summary.js', '/landing.js', '/storyboard.html', '/storyboard.js',
      '/ehr.html', '/ehr.js', '/ehr.css',
      '/twin/lab.html', '/twin/lab.js', '/twin/lab.css', '/twin/kinematics.js',
      '/vendor/location-engine.js', '/media/location/apartment-111.glb', '/media/location/provenance.json',
      '/brand.html', '/brand.css', '/brand.js', '/favicon.svg', '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/apple-touch-icon.png',
      '/media/brand/lifeline-mark.svg', '/media/brand/lifeline-mark-white.svg', '/media/brand/lifeline-logo-original.png', '/media/brand/identity-board.png', '/media/brand/color-tokens.json', '/media/brand/lifeline-brand-kit.zip',
      '/media/ehr-workspace.png', '/media/lifeline-logo.png',
      '/media/avatars/doctor-chen.jpg', '/media/avatars/care-team.jpg',
      '/share-location.html', '/share-location.js', '/share-location.css',
      '/fonts/cormorant-regular.ttf', '/fonts/cormorant-italic.ttf', '/fonts/dm-sans-regular.ttf', '/fonts/aspekta-variable.woff2']);
    const pageRoutes: Record<string, string> = { '/': '/landing.html', '/dashboard': '/index.html',
      '/motion-lab': '/twin/lab.html', '/motion-lab/': '/twin/lab.html',
      '/brand': '/brand.html', '/brand/': '/brand.html',
      '/ehr': '/ehr.html', '/ehr/': '/ehr.html',
      '/dashboard/': '/index.html', '/care': '/index.html', '/calibration': '/index.html', '/storyboard': '/storyboard.html', '/share-location': '/share-location.html' };
    const path = pageRoutes[url.pathname] ?? url.pathname;
    const storyAsset = /^\/media\/story\/(?:manifest\.json|opening\.webp|held\.webp|(?:desktop|mobile)\/frame_\d{4}\.webp)$/.test(path);
    if (req.method !== 'GET' || (!allowed.has(path) && !storyAsset)) return json(res, 404, { error: 'Not found.' });
    const file = resolve('public', path.slice(1));
    if (!existsSync(file)) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': path.endsWith('.glb') ? 'model/gltf-binary' : mime[extname(path)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(readFileSync(file));
  } catch (error) { json(res, error instanceof PolicyError || error instanceof SyntaxError ? 400 : 500,
    { error: error instanceof PolicyError || error instanceof SyntaxError ? error.message : 'Request failed; incident state is preserved.' }); }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/live') { live.handleUpgrade(req, socket, head, ws => { live.emit('connection', ws); ws.send(JSON.stringify(snapshot())); }); return; }
  const source = url.searchParams.get('source') as Source;
  const sourceName = url.searchParams.get('source');
  const allowedSource = sourceName === 'body-wili' || sourceName === 'waist-airpod' || (legacyPhone && sourceName === 'chest-phone');
  if (url.pathname !== '/motion' || !allowedSource || !sameToken(url.searchParams.get('token') ?? '') || producers.has(sourceName!)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  if (sourceName === 'body-wili') {
    ingest.handleUpgrade(req, socket, head, ws => {
      producers.set('body-wili', ws); wili.connected(); recordWiliTrial('source.connected');
      const protocol = new WiliDeviceProtocol();
      let recorder: WriteStream | null = null;
      let acquisitionEnded = false;
      const recordDisconnect = () => {
        if (acquisitionEnded) return; acquisitionEnded = true;
        recordWiliTrial('source.disconnected'); trialPinged.delete('body-wili');
      };
      let contextSignature = '';
      let wellbeingSignature = '';
      const sendContext = () => {
        if (!protocol.hello || ws.readyState !== WebSocket.OPEN) return;
        const latest = controller.latest();
        const i = latest?.id === wearableIdleIncidentId ? null : latest;
        const signature = `${i?.id ?? ''}:${i?.version ?? ''}`;
        if (signature === contextSignature) return;
        contextSignature = signature;
        const ownerName = responders.find(r => r.id === i?.ownerId)?.name ?? null;
        const screens: Record<string, string> = {
          CONFIRMING: 'CHECKING ON YOU\nGREEN: I AM OKAY\nRED: I NEED HELP',
          HELP_REQUESTED: 'GETTING HELP\nTRY TO STAY STILL',
          ACKNOWLEDGED: `${(ownerName ?? 'HELP').toUpperCase()} ANSWERED\nI AM HERE WITH YOU`,
          RESPONDER_EN_ROUTE: `${(ownerName ?? 'HELP').toUpperCase()} IS ON THE WAY`,
          ON_SCENE: `${(ownerName ?? 'HELP').toUpperCase()} IS HERE`,
          RESOLVED: 'TAKE CARE',
          CANCELLED_FALSE_ALARM: 'CHECK-IN CLOSED',
        };
        const voices: Record<string, string> = { CONFIRMING: ['sustained-shaking', 'possible-balance-loss'].includes(i?.evidence.eventType ?? '') ? 'MOVEMENT' : 'CHECKIN', HELP_REQUESTED: 'HELP', ACKNOWLEDGED: 'ACCEPTED',
          RESPONDER_EN_ROUTE: 'ENROUTE', ON_SCENE: 'ARRIVED', RESOLVED: 'RESOLVED' };
        ws.send(JSON.stringify({ type: 'incident.context', sessionId: protocol.hello.sessionId,
          incidentId: i?.id ?? null, checkinId: i?.checkinId ?? null, phase: i?.phase ?? null,
          checkinDeadline: i?.checkinDeadline ?? null, serverTime: Date.now(), ownerName,
          dispatchMode: i?.dispatchMode ?? dispatchMode,
          statusText: `LIFELINE\n${i ? screens[i.phase] ?? i.phase : 'READY\nGREEN: OKAY\nRED: HELP'}`.slice(0,300),
          voiceAsset: i ? voices[i.phase] ?? null : null }));
      };
      const sendConversation = () => {
        if (!protocol.hello?.capabilities.speaker || ws.readyState !== WebSocket.OPEN) return;
        const message = controller.claimResponderSpeech(protocol.hello.sessionId);
        if (!message) return;
        ws.send(JSON.stringify({ type: 'conversation.speak', sessionId: protocol.hello.sessionId,
          eventId: message.id, incidentId: message.incidentId,
          speakerName: message.speakerName,
          text: message.text }));
      };
      const sendWellbeingContext = () => {
        if (!protocol.hello || ws.readyState !== WebSocket.OPEN) return;
        const view = wellbeing.view(), enabled = view.enabled && protocol.hello.capabilities.microphone
          && protocol.hello.capabilities.buttons && !controller.active();
        const received = wellbeingVoice?.stage === 'complete' && Date.now() - wellbeingVoice.at < 6000;
        const statusText = enabled ? received
          ? 'LIFELINE | VOICE MESSAGE RECEIVED | HOLD BLUE TO TALK | RED: HELP'
          : 'LIFELINE | HOLD BLUE TO TALK | Release to send | RED: HELP' : '';
        const signature = JSON.stringify([enabled, wellbeing.conversationId, statusText]);
        if (signature === wellbeingSignature) return; wellbeingSignature = signature;
        ws.send(JSON.stringify({ type: 'wellbeing.context', sessionId: protocol.hello.sessionId,
          conversationId: wellbeing.conversationId, enabled, statusText }));
      };
      const ping = () => {
        if (ws.readyState === WebSocket.OPEN && protocol.hello) {
          const p = wili.ping(); recordWiliTrial('clock.ping', p, p.serverSentMs); ws.send(JSON.stringify(p));
        }
      };
      const timer = setInterval(() => { ping(); sendContext(); }, 2000);
      const contextTimer = setInterval(() => { sendContext(); sendWellbeingContext(); sendConversation(); }, 100);
      ws.on('error', () => ws.close());
      ws.on('message', bytes => {
        try {
          const packet = protocol.accept(JSON.parse(bytes.toString()));
          if (packet.type === 'device.hello') {
            trialWiliHello = packet; recordWiliTrial('device.hello', packet);
            ping(); sendContext(); sendWellbeingContext(); sendConversation(); return;
          }
          const at = performance.now();
          if (packet.type === 'clock.pong') {
            // A paired capture starts without history or clocks; synchronize only after its first sample.
            if (trials.recording && !legacyPhone && !trialPinged.has('body-wili')) return;
            if (wili.pong(packet, at)) recordWiliTrial('clock.pong', packet, at); return;
          }
          if (packet.type === 'accel.sample') {
            const firstSample = wili.view().sessionId !== packet.sessionId;
            if (!wili.sample(packet, at)) return;
            recordWiliTrial('accel.sample', packet, at);
            const firstTrialSample = trials.recording && !trialPinged.has('body-wili');
            if (firstTrialSample) trialPinged.add('body-wili');
            if (firstSample || firstTrialSample || wili.view().alignmentUncertaintyMs === null) ping();
            if (!recorder) {
              recorder = createWriteStream(resolve(dataDir, 'recordings', `body-wili-${packet.sessionId}.jsonl`), { flags: 'a', mode: 0o600 });
              recorder.on('error', () => console.error('WILi recording unavailable.'));
            }
            recorder.write(JSON.stringify({ ...packet, receivedAt: Date.now(), hostMonotonicMs: at }) + '\n');
            return;
          }
          if (packet.type === 'button.press') {
            if (packet.action === 'reset') {
              execute({ type: 'reset', readyImmediately: true });
              sendContext(); sendWellbeingContext(); broadcast(); return;
            }
            const i = controller.boardButton(packet.action, packet.incidentId, packet.checkinId, `${packet.sessionId}:${packet.eventId}`);
            if (i && controller.active()?.id === i.id) prepareIncident(i);
            sendContext(); broadcast(); return;
          }
          if (packet.type === 'checkin.audio') {
            const current = controller.latest();
            if (current?.id !== packet.incidentId || current.checkinId !== packet.checkinId
              || (current.phase !== 'CONFIRMING' && packet.stage !== 'complete')
              || Date.now() >= current.checkinDeadline) return;
            checkinAudio = { incidentId: packet.incidentId, checkinId: packet.checkinId,
              sessionId: packet.sessionId, stage: packet.stage, at: Date.now() };
            broadcast(); return;
          }
          if (packet.type === 'checkin.reply') {
            const decision = controller.recordCheckinReply({ incidentId: packet.incidentId, checkinId: packet.checkinId,
              transcript: packet.transcript, source: 'freewili-local-speech' });
            const active = controller.active(); if (active) prepareIncident(active);
            if (decision === 'confirmation_required') ws.send(JSON.stringify({ type: 'audio.command', sessionId: packet.sessionId,
              commandId: `speech-${packet.eventId}`, incidentId: packet.incidentId, checkinId: packet.checkinId,
              action: 'play', asset: 'safe-confirmation' }));
            sendContext(); broadcast(); return;
          }
          if (packet.type === 'wellbeing.audio') {
            if (controller.active() || !wellbeing.view().enabled || packet.conversationId !== wellbeing.conversationId) return;
            wellbeingVoiceSession = packet.sessionId;
            wellbeingVoice = { stage: packet.stage, at: Date.now() }; broadcast(); return;
          }
          if (packet.type === 'wellbeing.reply') {
            if (controller.active() || !wellbeing.view().enabled) return;
            if (wellbeing.recordVoice(packet)) {
              wellbeingVoiceSession = packet.sessionId;
              wellbeingVoice = { stage: 'complete', at: Date.now() };
              if (!wellbeingHelp(wellbeing.replyNeeded()?.text ?? packet.transcript, 'freewili-local-speech')) void prepareWellbeingReply();
            }
            sendContext(); sendWellbeingContext(); broadcast(); return;
          }
          if (packet.type === 'audio.ack') throw new Error('No audio command has been issued for this session.');
          if (packet.type === 'voice.playback') {
            controller.recordResponderPlayback(packet.eventId, packet.incidentId, packet.sessionId, packet.status);
            broadcast(); return;
          }
          if (packet.type === 'device.status') { recordDisconnect(); wili.disconnected(); ws.close(1008, 'Acquisition unavailable; reconnect with fresh device session.'); }
        } catch (error) {
          if (!(error instanceof PolicyError)) { recordDisconnect(); wili.disconnected(); ws.close(1008, 'Invalid acquisition packet.'); }
        }
      });
      ws.on('close', () => {
        clearInterval(timer); clearInterval(contextTimer); recorder?.end();
        if (protocol.hello) controller.failResponderSpeechSession(protocol.hello.sessionId);
        if (checkinAudio?.sessionId === protocol.hello?.sessionId) checkinAudio = null;
        if (wellbeingVoiceSession === protocol.hello?.sessionId) { wellbeingVoice = null; wellbeingVoiceSession = null; }
        if (producers.get('body-wili') === ws) {
          producers.delete('body-wili'); wili.disconnected(); trialWiliHello = null;
          recordDisconnect(); broadcast();
        }
      });
    });
    return;
  }
  ingest.handleUpgrade(req, socket, head, ws => {
    producers.set(source, ws); motion.connected(source); trials.record('source.connected', undefined, source); let session: string | null = null;
    const ping = () => {
      if (ws.readyState === WebSocket.OPEN) { const p = motion.ping(source); trials.record('clock.ping', p, source, p.serverSentMs); ws.send(JSON.stringify(p)); }
    };
    const timer = setInterval(ping, 2000); ping();
    ws.on('error', () => ws.close());
    ws.on('message', bytes => {
      try {
        const p: unknown = JSON.parse(bytes.toString());
        const receivedMs = performance.now();
        if (p && typeof p === 'object' && (p as ClockPong).type === 'clock.pong') {
          if (trials.recording && !legacyPhone && !trialPinged.has(source)) return;
          if (motion.pong(source, p as ClockPong, receivedMs)) trials.record('clock.pong', p, source, receivedMs); return;
        }
        if (!validSample(p, source) || (session && p.sessionId !== session)) return;
        if (!motion.sample(source, p, receivedMs)) return; session = p.sessionId;
        trials.record('motion.sample', p, source, receivedMs);
        if (trials.recording && !trialPinged.has(source)) { trialPinged.add(source); ping(); }
        const key = `${source}-${session}`;
        if (!recorders.has(key)) {
          const recorder = createWriteStream(resolve(dataDir, 'recordings', `${key}.jsonl`), { flags: 'a', mode: 0o600 });
          recorder.on('error', () => console.error('Motion recording failed; check storage.')); recorders.set(key, recorder);
        }
        recorders.get(key)!.write(JSON.stringify({ ...p, receivedAt: Date.now(), hostMonotonicMs: performance.now() }) + '\n');
      } catch { /* invalid packets never become evidence */ }
    });
    ws.on('close', () => {
      clearInterval(timer);
      if (session) { const key = `${source}-${session}`; recorders.get(key)?.end(); recorders.delete(key); }
      if (producers.get(source) === ws) { producers.delete(source); motion.disconnected(source); trials.record('source.disconnected', undefined, source); trialPinged.delete(source); broadcast(); }
    });
  });
});
live.on('connection', ws => ws.on('error', () => ws.close()));
const heartbeat = setInterval(() => {
  controller.tick(); simulatedDispatch.tick(); const assessedAt = performance.now();
  const collectingPractice = teaching.practiceMode;
  teaching.tick(wili, motion, assessedAt);
  const evaluated = !controller.active() && !collectingPractice;
  const evidence = !evaluated ? null
    : legacyPhone ? motion.candidate() : wiliAssessment.candidate(wili, motion, assessedAt)
      ?? (selectedDetectionProfile === 'early-checkin' ? earlyCheckinAssessment.candidate(wili, motion, assessedAt) : null)
      ?? shakingAssessment.candidate(wili, motion, assessedAt);
  trials.record('assessment', { candidate: evidence, evaluated,
    detector: legacyPhone ? 'legacy-core-motion' : evidence?.onset?.detector ?? evidence?.shaking?.detector
      ?? (selectedDetectionProfile === 'early-checkin' ? 'wili-waist-early-checkin-v1' : 'wili-waist-provisional-v1') }, undefined, assessedAt);
  if (evidence) {
    const incident = controller.trigger(evidence);
    eventCapture = { incidentId: incident.id, capture: new EventWindowCapture(evidence, assessedAt) };
    prepareIncident(incident);
  }
  if (eventCapture) {
    if (controller.active()?.id !== eventCapture.incidentId) eventCapture = null;
    else {
      const window = eventCapture.capture.collect(wili, motion, assessedAt);
      if (window) { controller.recordEventWindow(eventCapture.incidentId, window); eventCapture = null; }
    }
  }
  const active = controller.active(); if (active) prepareIncident(active);
  if (Date.now() >= nextWellbeingTick) {
    nextWellbeingTick = Date.now() + 10_000;
    wellbeing.tick(Boolean(active)); void prepareWellbeingReply();
    ensureFindMyOnboarding();
  }
  void refreshRoute();
  if (Date.now() >= nextApproachAt) {
    nextApproachAt = Date.now() + 15_000;
    const position = locationView();
    if (active?.phase === 'RESPONDER_EN_ROUTE' && position.eta && position.responder) {
      controller.queueApproachUpdate(active.id, active.version,
        `${active.id}: ${position.responder.name} is on the way. Estimated walk: ${Math.max(1, Math.ceil(position.eta.seconds / 60))} min (${position.eta.method === 'apple-maps-walking' ? 'Apple Maps' : 'straight-line approximation'}), updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. This is an estimate; arrival is not confirmed.`);
    }
  }
  broadcast(); void providerWorker('wearer'); void providerWorker('responders');
  void responderQuestionWorker.tick().catch(() => {
    if (!stopping) console.error('Responder answer preparation interrupted; persisted question remains available.');
  });
}, 100);

server.listen(port, host, () => {
  const actualPort = (server.address() as { port: number }).port;
  if (locationGateway) locationGateway.listen(locationGatewayPort, '127.0.0.1', () => console.log(`Location sharing gateway ready on 127.0.0.1:${(locationGateway.address() as { port: number }).port}; only scoped mobile routes are public.`));
  console.log(`LIFELINE running at http://${host}:${actualPort}. Native pairing token is available in the local dashboard; not logged.`);
  prepareAudio();
  const i = controller.active(); if (i) prepareIncident(i);
  void startPhotonListener(inbound).then(async stop => {
    if (stopping) await stop(); else stopPhoton = stop;
  }).catch(() => { if (!stopping) console.error('Photon listener unavailable; provider status and incident state remain visible.'); });
  if (findMyEnabled) void findMy.start(findMySubjects, (subject, point) => {
    if (stopping) return;
    if (!point) locations.clearNative(subject);
    else locations.recordNative(subject, point, controller.active());
    void refreshRoute(); broadcast();
  }).then(async stop => { if (stopping) await stop(); else stopFindMy = stop; })
    .catch(() => { if (!stopping) console.error('Photon Find My unavailable; no location is assumed.'); });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; void shutdown(); });
locationGateway?.on('error', () => console.error('Location gateway unavailable; private incident response continues.'));
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true; clearInterval(heartbeat); clearInterval(voiceCacheTimer);
  responderQuestionWorker.stop();
  for (const ws of [...live.clients, ...ingest.clients, ...producers.values()]) ws.terminate();
  for (const recorder of recorders.values()) recorder.end();
  if (trials.recording) trials.stop('Backend stopped; capture ended.');
  await stopPhoton?.().catch(() => {});
  await stopFindMy?.().catch(() => {});
  // A send in progress is left recoverable as unknown if interrupted.
  locationGateway?.close(); server.close(); controller.close(); wellbeing.close(); locations.close(); findMyRequests.close();
}
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
