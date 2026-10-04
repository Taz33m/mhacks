import type { PatientRecordSnapshot } from './patient-record.ts';
import type { BodyWiliView } from './freewili.ts';
import type { WiliAssessmentFeatures } from './wili-assessment.ts';
import type { ShakingFeatures } from './shaking-assessment.ts';
import type { WellbeingView } from './wellbeing.ts';
import type { LocationView } from './location.ts';
import type { RouteEta } from './route-eta.ts';

export type Source = 'chest-phone' | 'waist-airpod';
export type Vec3 = [number, number, number];
export type Phase = 'DETECTED' | 'CONFIRMING' | 'HELP_REQUESTED' | 'ACKNOWLEDGED' | 'RESPONDER_EN_ROUTE' | 'ON_SCENE' | 'RESOLVED' | 'CANCELLED_FALSE_ALARM';
export type DispatchMode = 'live' | 'simulated';
export interface MotionSample {
  type: 'motion.sample'; source: Source; sensorLocation: 'phone' | 'Left' | 'Right';
  sessionId: string; sequence: number; sensorTime: number;
  quaternion: [number, number, number, number]; rotationRate: Vec3;
  gravity: Vec3; userAcceleration: Vec3;
}
export interface ClockPing { type: 'clock.ping'; id: string; serverSentMs: number }
export interface ClockPong {
  type: 'clock.pong'; id: string; sessionId: string;
  deviceReceivedMs: number; deviceSentMs: number;
}
export interface Evidence {
  kind: 'manual' | 'synthetic' | 'single-source' | 'cross-body';
  summary: string; sourceSessions?: Partial<Record<Source | 'body-wili', string>>;
  assessment?: WiliAssessmentFeatures;
  eventType?: 'sustained-shaking' | 'reported-seizure';
  shaking?: ShakingFeatures;
}
export interface Incident {
  id: string; phase: Phase; version: number; createdAt: number; updatedAt: number;
  /** Stored when the incident starts; absent historical values mean live. */
  dispatchMode?: DispatchMode;
  evidence: Evidence; checkinId: string; checkinDeadline: number;
  progressDeadline: number | null; ownerId: string | null;
  handoff: string; outcome: string | null; resolutionActor: string | null;
  healthRevision?: string;
  handoffGeneration?: 'ai' | 'degraded';
}
export interface Responder { id: string; name: string; phone: string | null; simulated?: boolean }
export type ActionType = 'checkin' | 'wearer_checkin' | 'wearer_ack' | 'wearer_status' | 'wearer_location' | 'wearer_relay' | 'alert' | 'status' | 'handoff' | 'answer';
export interface Action {
  id: string; incidentId: string; type: ActionType; recipientId: string | null;
  text: string; status: 'queued' | 'attempting' | 'provider_accepted' | 'simulated' | 'failed' | 'unknown' | 'cancelled';
  attempts: number; providerMessageId: string | null; providerResult: string | null;
  nextAttemptAt: number; createdAt: number;
  providerChatId?: string; providerLineId?: string;
  replyToMessageId?: string; replyChatId?: string; replyLineId?: string;
}
export interface TimelineEvent { id: string; incidentId: string; type: string; actor: string; at: number; detail: string }
export interface ConversationMessage {
  id: string; incidentId: string; speaker: 'wearer' | 'responder'; speakerName: string;
  text: string; source: CheckinReply['source'] | 'photon-imessage' | 'simulated-dispatch'; at: number;
  delivery: 'recorded' | 'queued' | 'playing' | 'spoken' | 'failed'; detail?: string;
}
export type CheckinDecision = 'help_requested' | 'confirmation_required' | 'unresolved';
export interface CheckinReply {
  incidentId: string; checkinId: string; transcript: string; source: 'ios-on-device-speech' | 'freewili-local-speech';
}
export interface CheckinAudioStatus {
  incidentId: string; checkinId: string; sessionId: string; at: number;
  stage: 'prompting' | 'listening' | 'transcribing' | 'complete' | 'unavailable';
}
export interface SensorView {
  source: Source; connected: boolean; fresh: boolean; calibrated: boolean;
  sensorLocation: string | null; sessionId: string | null; ageMs: number | null;
  sampleHz: number; alignmentUncertaintyMs: number | null;
  totalG: number | null; tiltDegrees: number | null;
  quaternion?: [number, number, number, number] | null;
  trace: { at: number; totalG: number; tiltDegrees: number | null; angularSpeed: number }[];
}
export interface Snapshot {
  serverTime: number; incident: Incident | null; responders: Responder[];
  wearer?: { name: string };
  policy: { demoMode: boolean; checkinMs: number; configuredCheckinMs: number };
  dispatch?: { mode: DispatchMode; detail: string };
  timeline: TimelineEvent[]; actions: Action[]; sensors: SensorView[];
  conversation?: ConversationMessage[];
  checkinAudio?: CheckinAudioStatus | null;
  providers: Record<string, { configured: boolean; detail: string }>;
  wearerMessaging: { configured: boolean; detail: string };
  trial: TrialView | null;
  wili?: BodyWiliView;
  wellbeing?: Omit<WellbeingView, 'voice'> & { voice: { stage: 'recording' | 'transcribing' | 'complete' | 'unavailable'; at: number } | null };
  location?: Omit<LocationView, 'eta'> & { eta: LocationView['eta'] | RouteEta;
    native?: { configured: boolean; detail: string; request?: { status: string; detail: string } | null } };
}
export type TrialScenario = 'standing' | 'phone-drop' | 'sit' | 'bend' | 'staged-fall' | 'other';
export type TrialSource = Source | 'body-wili';
export type TrialCaptureMode = 'legacy-core-motion' | 'wili-waist';
export interface TrialView {
  id: string; label: string; scenario: TrialScenario; status: 'recording' | 'stopping' | 'stopped' | 'error';
  startedAt: number; endedAt: number | null; sampleCounts: Record<TrialSource, number>; reason: string | null;
  captureMode: TrialCaptureMode; markerCount: number;
}
export interface TrialRecord {
  type: 'trial.start' | 'trial.marker' | 'source.connected' | 'source.disconnected' | 'device.hello' | 'clock.ping' | 'clock.pong' | 'accel.sample' | 'motion.sample' | 'calibration' | 'motion.reset' | 'assessment' | 'trial.stop';
  atMs: number; at: number; source?: TrialSource; payload?: unknown;
}
export type Command =
  | { type: 'trigger'; kind: 'synthetic' | 'manual'; summary?: string }
  | { type: 'cancel'; incidentId: string; checkinId: string }
  | { type: 'accept' | 'depart' | 'arrive' | 'decline'; incidentId: string; responderId: string }
  | { type: 'resolve'; incidentId: string; responderId: string; outcome: string }
  | { type: 'calibrate'; expectedSessionId?: string; expectedSensorLocation?: 'Left' | 'Right' }
  | { type: 'reset' };
export interface ProviderInbound {
  messageId: string; sender: string; targetMessageId?: string;
  kind: 'reaction' | 'text'; text?: string; reaction?: string; removed?: boolean;
  chatId?: string; lineId?: string; providerTimestamp?: number;
  /** Native sender transport, when supplied by Photon; never inferred from platform. */
  service?: 'iMessage' | 'SMS' | 'RCS' | 'unknown';
}
export interface ProviderResult {
  status: 'provider_accepted' | 'failed' | 'unknown' | 'cancelled'; messageId?: string; detail: string;
  chatId?: string; lineId?: string;
}
export interface HealthContext { summary: string; recordIds: string[]; retrievedAt: number; available: boolean; patientRecord?: PatientRecordSnapshot }
