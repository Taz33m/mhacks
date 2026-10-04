import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RouteEtaPoint { latitude: number; longitude: number }
export interface RouteEtaEstimate { seconds: number; distanceMeters: number; method: 'apple-maps-walking'; updatedAt: number }
export type RouteEta = RouteEtaEstimate;
export type RouteEtaSpawn = (file: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: true },
  callback: (error: Error | null, stdout: string, stderr: string) => void) => unknown;

const validPoint = (point: RouteEtaPoint): boolean => !!point && typeof point === 'object'
  && typeof point.latitude === 'number' && Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
  && typeof point.longitude === 'number' && Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;

/** Does not acquire locations or grant policy authority. The caller supplies
 * fresh authorized points, chooses when to route, and manages rate/caching.
 * Missing helper, MapKit errors and malformed results remain unavailable.
 */
export function createRouteEta(options: { helperPath?: string; spawn?: RouteEtaSpawn } = {}): {
  estimate(origin: RouteEtaPoint, target: RouteEtaPoint): Promise<RouteEtaEstimate | null>;
} {
  const helper = options.helperPath ?? fileURLToPath(new URL('../native/macos/build/route-eta', import.meta.url));
  const run: RouteEtaSpawn = options.spawn ?? execFile;
  return {
    async estimate(origin, target) {
      if (!validPoint(origin) || !validPoint(target) || !isAbsolute(helper) || helper.includes('\0')) return null;
      const args = [origin.latitude, origin.longitude, target.latitude, target.longitude].map(String);
      try {
        const stdout = await new Promise<string | null>(resolve => {
          run(helper, args, { timeout: 8000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
            resolve(error || typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096 ? null : stdout);
          });
        });
        if (stdout === null) return null;
        const result: unknown = JSON.parse(stdout);
        if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
        const p = result as Record<string, unknown>;
        if (Object.keys(p).length !== 3 || !['seconds', 'distanceMeters', 'transport'].every(key => Object.hasOwn(p, key))
          || p.transport !== 'walking' || typeof p.seconds !== 'number' || !Number.isFinite(p.seconds) || p.seconds < 0 || p.seconds > 86400
          || typeof p.distanceMeters !== 'number' || !Number.isFinite(p.distanceMeters) || p.distanceMeters < 0 || p.distanceMeters > 500000) return null;
        return { seconds: p.seconds, distanceMeters: p.distanceMeters, method: 'apple-maps-walking', updatedAt: Date.now() };
      } catch { return null; }
    },
  };
}
