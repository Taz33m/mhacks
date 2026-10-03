import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { Controller, PolicyError } from './controller.ts';
import { parsePolicy } from './policy.ts';
import { Motion, validSample } from './motion.ts';
import { FreeWili } from './freewili.ts';
import { WiliAssessment } from './wili-assessment.ts';
import { WiliDeviceProtocol } from '../native/freewili/protocol.ts';
import { readStockVoiceManifest } from '../native/freewili/prepare-stock-audio.ts';
import { approvedResponder, phoneIdentity } from './identity.ts';
import { handleWearerInbound } from './wearer.ts';
import { handleResponderQuestion } from './responder-questions.ts';
import { handleResponderProgress } from './responder.ts';
import { Trials } from './trials.ts';
import type { CheckinReply, ClockPong, Command, HealthContext, Incident, ProviderInbound, Responder, Snapshot, Source } from './contracts.ts';
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
const responders = responderConfig as Responder[];
if (new Set(responders.filter(r => r.phone).map(r => r.phone)).size !== responders.filter(r => r.phone).length) throw new Error('Approved phone numbers must be unique.');
const wearerPhone = process.env.LIFELINE_WEARER_PHONE?.trim() || null;
if (wearerPhone && !/^\+[1-9]\d{7,14}$/.test(wearerPhone)) throw new Error('LIFELINE_WEARER_PHONE must be an approved E.164 phone number.');
if (wearerPhone && responders.some(r => r.phone && phoneIdentity(r.phone) === phoneIdentity(wearerPhone)))
  throw new Error('The wearer and responder phone numbers must be different.');
const policyProfile = parsePolicy(process.env);
const policy = { demoMode: policyProfile.demoMode, checkinMs: policyProfile.checkinMs, configuredCheckinMs: policyProfile.configuredCheckinMs };
const controller = new Controller(resolve(dataDir, 'lifeline.sqlite'), responders, Date.now, policyProfile);
const motion = new Motion();
const wili = new FreeWili();
const wiliAssessment = new WiliAssessment();
const legacyPhone = process.env.LIFELINE_LEGACY_PHONE === '1';
const trials = new Trials(resolve(dataDir, 'trials'));
const trialPinged = new Set<Source>();
const producers = new Map<string, WebSocket>();
const recorders = new Map<string, WriteStream>();
let healthPromise = loadHealth();
const incidentHealth = new Map<string, Promise<HealthContext>>();
let audio: Uint8Array | null = null;
let audioPreparing = false;
const busyChannels = new Set<'wearer' | 'responders'>();
let stopPhoton: (() => Promise<void>) | null = null;
let handoffIncident: string | null = null;
let stopping = false;
let contextPreviewBusy = false;
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

function snapshot(): Snapshot {
  const incident = controller.latest();
  const providers = { ...providerStatus(), wiliVoice: boardVoice };
  const wearerMessaging = { configured: Boolean(wearerPhone && providers.photon?.configured),
    detail: !wearerPhone ? 'Set LIFELINE_WEARER_PHONE to the approved wearer phone for the companion iMessage check-in.'
      : !providers.photon?.configured ? 'Wearer phone configured; Photon credentials are required for iMessage check-in.'
        : 'Wearer phone and Photon credentials configured; verify actual iMessage receipt and replies on the demo phone.' };
  return { serverTime: Date.now(), incident, responders: responders.map(r => ({ ...r, phone: r.phone ? 'configured' : null })),
    timeline: incident ? controller.events(incident.id) : [], actions: incident ? controller.actions(incident.id).map(action => {
      const { providerChatId, providerLineId, replyChatId, replyLineId, ...visible } = action;
      return visible;
    }) : [],
    sensors: motion.views().filter(s => legacyPhone || s.source !== 'chest-phone'),
    wili: wili.view(), providers, wearerMessaging, trial: trials.view(), policy };
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
  if (handoffIncident !== i.id) {
    handoffIncident = i.id;
    void healthForIncident(i).then(h => buildHandoffDetailed(i, h)).then(handoff => {
      if (!stopping && controller.active()?.id === i.id) { controller.setHandoff(i.id, handoff.text, handoff); broadcast(); }
    }).catch(() => { if (!stopping && controller.active()?.id === i.id)
      controller.setHandoff(i.id, 'Synthetic health record unavailable. Response continues.', { generation: 'degraded' }); });
  }
  prepareAudio();
}
function prepareAudio(): void {
  if (legacyPhone && !audio && !audioPreparing) {
    audioPreparing = true;
    void prepareCheckinAudio().then(bytes => { audio = bytes; }).catch(() => {}).finally(() => { audioPreparing = false; });
  }
}
async function providerWorker(channel: 'wearer' | 'responders'): Promise<void> {
  if (busyChannels.has(channel) || stopping || !providerStatus().photon?.configured) return;
  busyChannels.add(channel);
  try {
    const a = controller.claimAction(channel); if (!a) return;
    const wearerAction = ['wearer_checkin', 'wearer_ack', 'wearer_status'].includes(a.type);
    const phone = wearerAction ? wearerPhone : responders.find(r => r.id === a.recipientId)?.phone;
    if (!phone) { controller.finishAction(a.id, 'failed', wearerAction
      ? 'No approved wearer phone configured; wearer iMessage was not sent.' : 'No approved phone configured; development simulation only.'); return; }
    const result = await sendMessage(phone, a.text, () => !stopping && controller.actionPermitted(a), a.replyToMessageId
      ? { replyToMessageId: a.replyToMessageId, chatId: a.replyChatId, lineId: a.replyLineId } : undefined);
    if (!stopping) controller.finishAction(a.id, result.status, result.detail, result.messageId, result);
  } catch { /* attempt remains attempting; startup recovery preserves an unknown outcome */ }
  finally { busyChannels.delete(channel); if (!stopping) broadcast(); }
}
async function inbound(e: ProviderInbound): Promise<void> {
  if (stopping || controller.seenInbound(e.messageId)) return;
  try {
    // Cloud input without persisted exact-channel provenance cannot operate the incident.
    if (!e.chatId || !e.lineId) return;
    if (wearerPhone && phoneIdentity(e.sender) === phoneIdentity(wearerPhone)) {
      if (controller.matchesConversation(e, null)) handleWearerInbound(e, wearerPhone, controller);
      return;
    }
    const r = approvedResponder(e.sender, responders);
    const i = controller.active(); if (!r || !i || e.removed || !controller.matchesConversation(e, r.id)) return;
    if (handleResponderProgress(e, controller)) return;
    if (e.kind !== 'text') return;
    if (e.targetMessageId !== undefined
      && (!e.targetMessageId || !controller.responderIncidentForMessage(e.targetMessageId, r.id))) return;
    const text = (e.text ?? '').trim();
    if (text) await handleResponderQuestion(e, controller,
      async (incident, question) => answerQuestionDetailed(incident, await healthForIncident(incident), question), () => !stopping);
  } catch (error) {
    if (!(error instanceof PolicyError)) console.error('Provider processing failed; incident remains unresolved.');
  } finally { if (!stopping) broadcast(); }
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
function execute(c: Command): void {
  switch (c.type) {
    case 'trigger': {
      if (!['synthetic', 'manual'].includes(c.kind) || (c.summary !== undefined && (typeof c.summary !== 'string' || c.summary.length > 1000))) throw new PolicyError('Invalid trigger.');
      prepareIncident(controller.trigger({ kind: c.kind, summary: c.summary ?? (c.kind === 'synthetic' ? 'Development simulation — not a real sensor event.' : 'Explicit manual help request.') })); break;
    }
    case 'cancel': controller.cancel(c.incidentId, c.checkinId); break;
    case 'accept': controller.accept(c.incidentId, c.responderId); break;
    case 'depart': case 'arrive': controller.progress(c.incidentId, c.responderId, c.type); break;
    case 'decline': controller.decline(c.incidentId, c.responderId); break;
    case 'resolve': controller.resolve(c.incidentId, c.responderId, c.outcome); break;
    case 'calibrate': {
      const sources = motion.calibrate();
      if (!sources.length) throw new PolicyError('Calibration requires one second of continuous still samples; stop moving and try again.');
      trials.record('calibration', { sources }); break;
    }
    case 'reset': controller.reset(); motion.reset(); wiliAssessment.reset(); trials.record('motion.reset', { clocks: false, cooldown: true }); handoffIncident = null; break;
    default: throw new PolicyError('Unsupported command.');
  }
}
const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok',
      motionSources: [...motion.views().filter(v => v.fresh && (legacyPhone || v.source !== 'chest-phone')).map(v => v.source),
        ...(wili.view().fresh ? ['body-wili'] : [])] });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());
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
      execute(await commandBody(req)); broadcast(); return json(res, 200, { ok: true });
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
        hospitalRecords: { source: 'FinchNode read-only synthetic demo', snapshot: h?.patientRecord ?? null },
        lifelineObservations: { source: 'LIFELINE local incident log; not hospital EHR entries',
          incident: i, timeline: controller.events(i.id),
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
        const answer = await answerQuestionDetailed(incident, await healthForIncident(incident), body.question.trim());
        if (stopping || res.destroyed) return;
        const current = controller.latest();
        if (!current || current.id !== incident.id || current.version !== incident.version)
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
      const view = trials.start(body.label, body.scenario, motion.views().filter(s => s.connected).map(s => s.source));
      motion.reset({ clocks: true, cooldown: false }); trialPinged.clear();
      broadcast(); return json(res, 200, view);
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
      broadcast(); return json(res, 200, { decision });
    }
    if (url.pathname === '/api/audio/checkin' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'Pairing token required.' });
      if (!audio) return json(res, 404, { error: 'ElevenLabs clip is unavailable; native fallback is development-only.' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' }); return res.end(Buffer.from(audio));
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API endpoint.' });
    const allowed = new Set(['/index.html', '/styles.css', '/app.js']);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (req.method !== 'GET' || !allowed.has(path)) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': mime[extname(path)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(readFileSync(resolve('public', path.slice(1))));
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
      producers.set('body-wili', ws); wili.connected();
      const protocol = new WiliDeviceProtocol();
      let recorder: WriteStream | null = null;
      let contextSignature = '';
      const sendContext = () => {
        if (!protocol.hello || ws.readyState !== WebSocket.OPEN) return;
        const i = controller.latest();
        const signature = `${i?.id ?? ''}:${i?.version ?? ''}`;
        if (signature === contextSignature) return;
        contextSignature = signature;
        const ownerName = responders.find(r => r.id === i?.ownerId)?.name ?? null;
        const screens: Record<string, string> = {
          CONFIRMING: 'CHECKING ON YOU\nGREEN: I AM OKAY\nRED: I NEED HELP',
          HELP_REQUESTED: 'HELP REQUESTED\nWAITING FOR RESPONDER',
          ACKNOWLEDGED: `${ownerName ?? 'RESPONDER'} ACCEPTED\nDEPARTURE NOT REPORTED`,
          RESPONDER_EN_ROUTE: `${ownerName ?? 'RESPONDER'} EN ROUTE`,
          ON_SCENE: `${ownerName ?? 'RESPONDER'} ON SCENE`,
          RESOLVED: 'RESOLVED\nOUTCOME RECORDED',
          CANCELLED_FALSE_ALARM: i?.resolutionActor === 'development-operator'
            ? 'REHEARSAL ENDED\nDEVELOPMENT RESET'
            : 'CHECK-IN CLOSED\nEXPLICIT CONTROL CONFIRMED',
        };
        const voices: Record<string, string> = { CONFIRMING: 'CHECKIN', HELP_REQUESTED: 'HELP', ACKNOWLEDGED: 'ACCEPTED',
          RESPONDER_EN_ROUTE: 'ENROUTE', ON_SCENE: 'ARRIVED', RESOLVED: 'RESOLVED' };
        ws.send(JSON.stringify({ type: 'incident.context', sessionId: protocol.hello.sessionId,
          incidentId: i?.id ?? null, checkinId: i?.checkinId ?? null, phase: i?.phase ?? null,
          checkinDeadline: i?.checkinDeadline ?? null, serverTime: Date.now(), ownerName,
          statusText: `LIFELINE\n${i ? screens[i.phase] ?? i.phase : 'READY\nGREEN: OKAY\nRED: HELP'}`.slice(0,300),
          voiceAsset: i ? voices[i.phase] ?? null : null }));
      };
      const ping = () => {
        if (ws.readyState === WebSocket.OPEN && protocol.hello) ws.send(JSON.stringify(wili.ping()));
      };
      const timer = setInterval(() => { ping(); sendContext(); }, 2000);
      const contextTimer = setInterval(sendContext, 100);
      ws.on('error', () => ws.close());
      ws.on('message', bytes => {
        try {
          const packet = protocol.accept(JSON.parse(bytes.toString()));
          if (packet.type === 'device.hello') { ping(); sendContext(); return; }
          const at = performance.now();
          if (packet.type === 'clock.pong') { wili.pong(packet, at); return; }
          if (packet.type === 'accel.sample') {
            const firstSample = wili.view().sessionId !== packet.sessionId;
            if (!wili.sample(packet, at)) return;
            if (firstSample || wili.view().alignmentUncertaintyMs === null) ping();
            if (!recorder) {
              recorder = createWriteStream(resolve(dataDir, 'recordings', `body-wili-${packet.sessionId}.jsonl`), { flags: 'a', mode: 0o600 });
              recorder.on('error', () => console.error('WILi recording unavailable.'));
            }
            recorder.write(JSON.stringify({ ...packet, receivedAt: Date.now(), hostMonotonicMs: at }) + '\n');
            return;
          }
          if (packet.type === 'button.press') {
            const i = controller.boardButton(packet.action, packet.incidentId, packet.checkinId, `${packet.sessionId}:${packet.eventId}`);
            if (i && controller.active()?.id === i.id) prepareIncident(i);
            sendContext(); broadcast(); return;
          }
          if (packet.type === 'checkin.reply') {
            const decision = controller.recordCheckinReply({ incidentId: packet.incidentId, checkinId: packet.checkinId,
              transcript: packet.transcript, source: 'freewili-local-speech' });
            if (decision === 'confirmation_required') ws.send(JSON.stringify({ type: 'audio.command', sessionId: packet.sessionId,
              commandId: `speech-${packet.eventId}`, incidentId: packet.incidentId, checkinId: packet.checkinId,
              action: 'play', asset: 'safe-confirmation' }));
            sendContext(); broadcast(); return;
          }
          if (packet.type === 'audio.ack') throw new Error('No audio command has been issued for this session.');
          if (packet.type === 'device.status') { wili.disconnected(); ws.close(1008, 'Acquisition unavailable; reconnect with fresh device session.'); }
        } catch (error) {
          if (!(error instanceof PolicyError)) { wili.disconnected(); ws.close(1008, 'Invalid acquisition packet.'); }
        }
      });
      ws.on('close', () => {
        clearInterval(timer); clearInterval(contextTimer); recorder?.end();
        if (producers.get('body-wili') === ws) { producers.delete('body-wili'); wili.disconnected(); broadcast(); }
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
  controller.tick(); const assessedAt = performance.now(); const evidence = controller.active() ? null
    : legacyPhone ? motion.candidate() : wiliAssessment.candidate(wili, motion);
  trials.record('assessment', { candidate: evidence }, undefined, assessedAt);
  if (evidence) prepareIncident(controller.trigger(evidence));
  broadcast(); void providerWorker('wearer'); void providerWorker('responders');
}, 100);

server.listen(port, host, () => {
  const actualPort = (server.address() as { port: number }).port;
  console.log(`LIFELINE running at http://${host}:${actualPort}. Native pairing token is available in the local dashboard; not logged.`);
  prepareAudio();
  const i = controller.active(); if (i) prepareIncident(i);
  void startPhotonListener(inbound).then(async stop => {
    if (stopping) await stop(); else stopPhoton = stop;
  }).catch(() => { if (!stopping) console.error('Photon listener unavailable; provider status and incident state remain visible.'); });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; void shutdown(); });
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true; clearInterval(heartbeat); clearInterval(voiceCacheTimer);
  for (const ws of [...live.clients, ...ingest.clients, ...producers.values()]) ws.terminate();
  for (const recorder of recorders.values()) recorder.end();
  if (trials.recording) trials.stop('Backend stopped; capture ended.');
  await stopPhoton?.().catch(() => {});
  // A send in progress is left recoverable as unknown if interrupted.
  server.close(); controller.close();
}
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
