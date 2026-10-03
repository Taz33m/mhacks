export type Source = 'chest-phone' | 'waist-airpod';
export type Vec3 = [number, number, number];
export type Phase = 'DETECTED' | 'CONFIRMING' | 'HELP_REQUESTED' | 'ACKNOWLEDGED' | 'RESPONDER_EN_ROUTE' | 'ON_SCENE' | 'RESOLVED' | 'CANCELLED_FALSE_ALARM';
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
  summary: string; sourceSessions?: Partial<Record<Source, string>>;
}
export interface Incident {
  id: string; phase: Phase; version: number; createdAt: number; updatedAt: number;
  evidence: Evidence; checkinId: string; checkinDeadline: number;
  progressDeadline: number | null; ownerId: string | null;
  handoff: string; outcome: string | null; resolutionActor: string | null;
}
export interface Responder { id: string; name: string; phone: string | null }
export type ActionType = 'checkin' | 'alert' | 'status' | 'handoff';
export interface Action {
  id: string; incidentId: string; type: ActionType; recipientId: string | null;
  text: string; status: 'queued' | 'attempting' | 'provider_accepted' | 'failed' | 'unknown' | 'cancelled';
  attempts: number; providerMessageId: string | null; providerResult: string | null;
  nextAttemptAt: number; createdAt: number;
}
export interface TimelineEvent { id: string; incidentId: string; type: string; actor: string; at: number; detail: string }
export type CheckinDecision = 'help_requested' | 'confirmation_required' | 'unresolved';
export interface CheckinReply {
  incidentId: string; checkinId: string; transcript: string; source: 'ios-on-device-speech';
}
export interface SensorView {
  source: Source; connected: boolean; fresh: boolean; calibrated: boolean;
  sensorLocation: string | null; sessionId: string | null; ageMs: number | null;
  sampleHz: number; alignmentUncertaintyMs: number | null;
  totalG: number | null; tiltDegrees: number | null;
  trace: { at: number; totalG: number; tiltDegrees: number | null; angularSpeed: number }[];
}
export interface Snapshot {
  serverTime: number; incident: Incident | null; responders: Responder[];
  timeline: TimelineEvent[]; actions: Action[]; sensors: SensorView[];
  providers: Record<string, { configured: boolean; detail: string }>;
  trial: TrialView | null;
}
export type TrialScenario = 'standing' | 'phone-drop' | 'sit' | 'bend' | 'staged-fall' | 'other';
export interface TrialView {
  id: string; label: string; scenario: TrialScenario; status: 'recording' | 'stopping' | 'stopped' | 'error';
  startedAt: number; endedAt: number | null; sampleCounts: Record<Source, number>; reason: string | null;
}
export interface TrialRecord {
  type: 'trial.start' | 'source.connected' | 'source.disconnected' | 'clock.ping' | 'clock.pong' | 'motion.sample' | 'calibration' | 'motion.reset' | 'assessment' | 'trial.stop';
  atMs: number; at: number; source?: Source; payload?: unknown;
}
export type Command =
  | { type: 'trigger'; kind: 'synthetic' | 'manual'; summary?: string }
  | { type: 'cancel'; incidentId: string; checkinId: string }
  | { type: 'accept' | 'depart' | 'arrive' | 'decline'; incidentId: string; responderId: string }
  | { type: 'resolve'; incidentId: string; responderId: string; outcome: string }
  | { type: 'calibrate' | 'reset' };
export interface ProviderInbound {
  messageId: string; sender: string; targetMessageId?: string;
  kind: 'reaction' | 'text'; text?: string; reaction?: string; removed?: boolean;
}
export interface ProviderResult { status: 'provider_accepted' | 'failed' | 'unknown'; messageId?: string; detail: string }
export interface HealthContext { summary: string; recordIds: string[]; retrievedAt: number; available: boolean }
