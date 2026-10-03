// Seconds; opt-in hackathon profile only. Normal policy remains configurable.
export const DEMO_CHECKIN_TIMEOUT = 5;

export function parsePolicy(env: Record<string, string | undefined>) {
  function duration(name: string, fallback: number): number {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 1000 || value > 86_400_000) throw new Error(`Invalid duration: ${name}`);
    return value;
  }
  const demoMode = env.LIFELINE_DEMO_MODE === '1';
  const configuredCheckinMs = duration('LIFELINE_CHECKIN_MS', 20_000);
  return {
    demoMode, configuredCheckinMs,
    checkinMs: demoMode ? DEMO_CHECKIN_TIMEOUT * 1000 : configuredCheckinMs,
    acceptMs: duration('LIFELINE_ACCEPT_MS', 60_000),
    progressMs: duration('LIFELINE_PROGRESS_MS', 120_000),
  };
}
