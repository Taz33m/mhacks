/** Offline, illustrative sensor-space model. No backend imports or packet schema.
 * Three.js/browser viewer and offline exporter share the exact same kinematics.
 * A forward-kinematic skeleton is posed from keyframed joint angles (fall, shaking)
 * or planted-foot leg IK (gait). Values are pose derivatives, not measured traces
 * or a contact-force model.
 */
export const TWIN_SCHEMA = 'lifeline.offline-kinematics.v1';
export const SCENARIOS = Object.freeze({ fall: { title: 'Fall + stillness', duration: 8 },
  shaking: { title: 'Rhythmic shaking', duration: 8 }, gait: { title: 'Gait over time', duration: 8 } });
const G = 9.80665;
const clamp01 = n => Math.max(0, Math.min(1, n));
const smooth = n => { const t = clamp01(n); return t * t * t * (10 + t * (-15 + t * 6)); };
// Gravity-like acceleration into contact, then a short (~70 ms) crush instead of an infinite stop.
const impact = n => { const t = clamp01(n); return t < .8 ? .8 * (t / .8) ** 2 : 1 - .2 * ((1 - t) / .2) ** 2; };
const mix = (a, b, k) => a + (b - a) * k;

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, s) => a.map(v => v * s);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vecNorm = v => Math.hypot(...v);
const unit = v => scale(v, 1 / (vecNorm(v) || 1));

// Quaternions are [x, y, z, w]. Joint angles use Y·X·Z order (yaw, flexion, roll).
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const qAxis = (axis, angle) => { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; };
const qMul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qEuler = ([x, y, z]) => qMul(qMul(qAxis(Y, y), qAxis(X, x)), qAxis(Z, z));
const qConj = q => [-q[0], -q[1], -q[2], q[3]];
const qRotate = (q, v) => { const u = [q[0], q[1], q[2]], uv = cross(u, v), uuv = cross(u, uv); return add(v, add(scale(uv, 2 * q[3]), scale(uuv, 2))); };
const qNormalize = q => { const n = Math.hypot(...q); return q.map(v => v / n); };
const qSlerp = (a, b, k) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map(v => -v); d = -d; }
  if (d > .9995) return qNormalize(a.map((v, i) => v + (b[i] - v) * k));
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((v, i) => v * Math.sin((1 - k) * th) / s + b[i] * Math.sin(k * th) / s);
};
const qBasis = (x, y, z) => { // rotation whose columns are the given orthonormal axes
  const tr = x[0] + y[1] + z[2];
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; return qNormalize([(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]); }
  if (x[0] > y[1] && x[0] > z[2]) { const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2; return qNormalize([s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]); }
  if (y[1] > z[2]) { const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2; return qNormalize([(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]); }
  const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2; return qNormalize([(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]);
};

/** Skeleton: +y up, +z forward, +x the mannequin's left. Offsets are in the parent bone frame. */
export const LEG = Object.freeze({ thigh: .43, shin: .44, ankleHeight: .065 });
export const BONES = Object.freeze([
  ['pelvis', null, [0, 0, 0]], ['spine', 'pelvis', [0, .09, 0]], ['chest', 'spine', [0, .19, 0]],
  ['neck', 'chest', [0, .23, 0]], ['head', 'neck', [0, .08, .012]],
  ...[['left', 1], ['right', -1]].flatMap(([side, s]) => [
    [`${side}Shoulder`, 'chest', [s * .165, .185, -.012]], [`${side}Elbow`, `${side}Shoulder`, [0, -.28, 0]], [`${side}Hand`, `${side}Elbow`, [0, -.245, 0]],
    [`${side}Hip`, 'pelvis', [s * .088, -.045, 0]], [`${side}Knee`, `${side}Hip`, [0, -LEG.thigh, 0]], [`${side}Foot`, `${side}Knee`, [0, -LEG.shin, 0]]]),
].map(Object.freeze));
const SENSORS = { chest: { bone: 'chest', offset: [0, .135, .108], rangeG: 2, placement: 'Chest / sternum · WILi' },
  waist: { bone: 'pelvis', offset: [-.162, -.005, .03], rangeG: null, placement: 'Waist / pelvis · AirPod' } };

function solve(root, angles, world = {}) {
  const bones = {};
  for (const [name, parent, offset] of BONES) {
    if (!parent) { bones[name] = { position: root.position, rotation: root.rotation }; continue; }
    const base = bones[parent], position = add(base.position, qRotate(base.rotation, offset));
    bones[name] = { position, rotation: world[name] ?? qMul(base.rotation, qEuler(angles[name] ?? [0, 0, 0])) };
  }
  return bones;
}
// Body volumes used to rest the mannequin on the floor: spheres [bone, centre, radius], ellipsoids [bone, centre, semi-axes].
const CONTACT_SPHERES = [...['left', 'right'].flatMap(side => [[`${side}Foot`, [0, -.053, -.045], .012], [`${side}Foot`, [0, -.05, .12], .015],
  [`${side}Knee`, [0, -.02, .035], .05], [`${side}Knee`, [0, -.22, 0], .045], [`${side}Hip`, [0, -.215, 0], .065],
  [`${side}Hand`, [0, -.07, 0], .028], [`${side}Elbow`, [0, 0, 0], .04], [`${side}Shoulder`, [0, 0, 0], .05]])];
const CONTACT_VOLUMES = [['pelvis', [0, -.01, 0], [.165, .12, .115]], ['spine', [0, .08, .005], [.15, .12, .105]],
  ['chest', [0, .11, .005], [.172, .16, .115]], ['head', [0, .11, .02], [.088, .115, .1]]];
function lowestPoint(bones) {
  let low = Infinity;
  for (const [bone, centre, radius] of CONTACT_SPHERES) low = Math.min(low, add(bones[bone].position, qRotate(bones[bone].rotation, centre))[1] - radius);
  for (const [bone, centre, semi] of CONTACT_VOLUMES) {
    const { position, rotation } = bones[bone], c = add(position, qRotate(rotation, centre));
    const extent = Math.hypot(...[X, Y, Z].map((axis, i) => qRotate(rotation, axis)[1] * semi[i]));
    low = Math.min(low, c[1] - extent);
  }
  return low;
}
const grounded = (root, angles, lift = 0) => {
  const probe = solve({ position: [root.position[0], 0, root.position[2]], rotation: root.rotation }, angles);
  return solve({ position: [root.position[0], lift - lowestPoint(probe), root.position[2]], rotation: root.rotation }, angles);
};

const mirror = ([x, y, z]) => [x, -y, -z];
function pose(spec) { // symmetric helpers keep keyframes readable
  const out = {};
  for (const [name, value] of Object.entries(spec)) {
    if (name.startsWith('both')) { const bone = name.slice(4); out[`left${bone}`] = value; out[`right${bone}`] = mirror(value); }
    else out[name] = value;
  }
  return out;
}
const blend = (a, b, k) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])]
  .map(name => [name, (a[name] ?? [0, 0, 0]).map((v, i) => mix(v, (b[name] ?? [0, 0, 0])[i], k))]));
function track(keys, t) { // keys: [time, value, easing into this key]
  if (t <= keys[0][0]) return { from: keys[0], to: keys[0], k: 0 };
  for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) {
    const from = keys[i - 1], to = keys[i];
    return { from, to, k: (to[2] ?? smooth)((t - from[0]) / (to[0] - from[0])) };
  }
  const last = keys.at(-1); return { from: last, to: last, k: 0 };
}

// Elderly standing posture: rounded upper back, head extended to keep gaze level, soft knees.
const STAND = pose({ spine: [.06, 0, 0], chest: [.11, 0, 0], neck: [-.05, 0, 0], head: [-.12, 0, 0],
  bothShoulder: [-.05, 0, .07], bothElbow: [-.28, 0, 0], bothHand: [.05, 0, 0],
  bothHip: [-.07, 0, .025], bothKnee: [.12, 0, 0], bothFoot: [-.05, 0, 0] });
const facing = yaw => qAxis(Y, yaw);
const FALL_KEYS = [
  [0, { xz: [-.62, .32], q: facing(Math.PI / 2), angles: STAND }],
  [1.55, { xz: [-.62, .32], q: facing(Math.PI / 2), angles: STAND }],
  // Toe catches: trunk pitches forward, the left leg reaches out and both arms fling forward.
  [1.98, { xz: [-.46, .33], q: qMul(facing(Math.PI / 2), qAxis(X, .34)), angles: pose({ spine: [.14, 0, .02], chest: [.12, 0, 0], neck: [-.3, 0, 0], head: [-.22, .05, 0],
    leftShoulder: [-1.05, 0, .42], rightShoulder: [-.85, 0, -.5], bothElbow: [-.55, 0, 0], bothHand: [-.3, 0, 0],
    leftHip: [-.82, 0, .06], leftKnee: [.7, 0, 0], leftFoot: [.15, 0, 0], rightHip: [.16, 0, -.04], rightKnee: [.42, 0, 0], rightFoot: [.45, 0, 0] }) }],
  // Knees buckle onto the carpet; hands reach for the floor as the trunk tips and starts rolling left.
  [2.34, { xz: [-.2, .36], q: qMul(qMul(facing(Math.PI / 2), qAxis(X, .98)), qAxis(Y, -.22)), angles: pose({ spine: [.2, 0, .06], chest: [.1, 0, .05], neck: [-.45, 0, 0], head: [-.3, -.2, 0],
    leftShoulder: [-1.55, 0, .25], rightShoulder: [-1.35, 0, -.35], bothElbow: [-.2, 0, 0], bothHand: [-.5, 0, 0],
    leftHip: [-1.05, 0, .1], leftKnee: [1.5, 0, 0], leftFoot: [.6, 0, 0], rightHip: [-.55, 0, -.06], rightKnee: [1.25, 0, 0], rightFoot: [.55, 0, 0] }), ease: smooth }],
  // Trunk drops to the floor under gravity (accelerating), ending three-quarter prone on the left side.
  [2.66, { xz: [.12, .4], q: qMul(qMul(facing(Math.PI / 2), qAxis(X, 1.52)), qAxis(Y, -.62)), angles: pose({ spine: [.05, 0, .05], chest: [-.02, 0, .04], neck: [-.25, 0, .25], head: [-.2, -.55, .1],
    leftShoulder: [-2.55, 0, .25], leftElbow: [-.35, 0, 0], leftHand: [.2, 0, 0], rightShoulder: [-1.1, 0, -.55], rightElbow: [-.95, 0, 0], rightHand: [.3, 0, 0],
    leftHip: [-.12, 0, .06], leftKnee: [.35, 0, 0], leftFoot: [.75, 0, 0], rightHip: [-.85, 0, -.12], rightKnee: [1.25, 0, 0], rightFoot: [.7, 0, 0] }), ease: impact }],
];
function fallPose(t) {
  const { from, to, k } = track(FALL_KEYS.map(([time, key]) => [time, key, key.ease]), t);
  const a = from[1], b = to[1];
  const xz = [mix(a.xz[0], b.xz[0], k), mix(a.xz[1], b.xz[1], k)];
  let angles = blend(a.angles, b.angles, k);
  // Idle: a slow look around before the trip. Trunk and sensors stay exactly still.
  const idle = smooth(t / .4) * (1 - smooth((t - 1.1) / .4));
  angles = { ...angles, neck: add(angles.neck, [0, .16 * Math.sin(t * 2.6) * idle, 0]), head: add(angles.head, [.04 * Math.sin(t * 3.1) * idle, .1 * Math.sin(t * 2.6) * idle, 0]) };
  // Contact rebound: the trunk bounces once and settles; motion is exactly zero after 2.88 s.
  const r = (t - 2.66) / .22, bounce = r > 0 && r < 1 ? .028 * Math.sin(Math.PI * r) * (1 - r * .4) : 0;
  return grounded({ position: [xz[0], 0, xz[1]], rotation: qNormalize(qSlerp(a.q, b.q, k)) }, angles, bounce);
}

// Seated, then a tonic phase and rhythmic clonic jerks that slow before a slumped stillness.
export const CHAIR = Object.freeze({ position: [-1.05, 0, .62], yaw: .9, seat: .47 });
const SIT = pose({ spine: [.05, 0, 0], chest: [.07, 0, 0], neck: [-.04, 0, 0], head: [-.06, 0, 0],
  bothShoulder: [-.42, 0, .1], bothElbow: [-1.05, 0, 0], bothHand: [.15, 0, 0],
  bothHip: [-1.42, 0, .06], bothKnee: [1.36, 0, 0], bothFoot: [.18, 0, 0] });
const TONIC = pose({ spine: [-.08, 0, 0], chest: [-.1, 0, 0], neck: [.05, 0, 0], head: [-.3, 0, 0],
  bothShoulder: [-.85, 0, .32], bothElbow: [-1.45, 0, 0], bothHand: [.6, 0, 0], bothHip: [-1.3, 0, .1], bothKnee: [1.05, 0, 0], bothFoot: [.45, 0, 0] });
const SLUMP = pose({ spine: [.14, 0, -.06], chest: [.12, 0, -.08], neck: [.3, .1, -.2], head: [.15, .1, -.15],
  bothShoulder: [-.2, 0, .12], bothElbow: [-.55, 0, 0], bothHand: [.3, 0, 0], bothHip: [-1.4, 0, .1], bothKnee: [1.32, 0, 0], bothFoot: [.2, 0, 0] });
function shakingPose(t) {
  const tonic = smooth((t - 1) / .35) * (1 - smooth((t - 1.5) / .3)), envelope = smooth((t - 1.4) / .3) * (1 - smooth((t - 5.6) / .7));
  const after = smooth((t - 6) / .6);
  const span = t - 1.4, f0 = 3.1, f1 = 1.9, phase = Math.max(0, f0 * span + (f1 - f0) * span * span / (2 * 4.4));
  const p = phase % 1, beat = Math.floor(phase), side = beat % 2 ? -1 : 1;
  const jerk = (p < .22 ? smooth(p / .22) : 1 - smooth((p - .22) / .78)) * envelope; // sharp contraction, slower release
  let angles = blend(blend(SIT, TONIC, tonic), SLUMP, after);
  const j = (name, d) => { angles[name] = add(angles[name], d.map(v => v * jerk)); };
  j('spine', [.12, 0, .05 * side]); j('chest', [.1, 0, .04 * side]); j('neck', [.22, 0, 0]); j('head', [.18, .08 * side, 0]);
  for (const [s, sign] of [['left', 1], ['right', -1]]) {
    j(`${s}Shoulder`, [-.32, 0, .16 * sign]); j(`${s}Elbow`, [-.55, 0, 0]); j(`${s}Hand`, [.4, 0, 0]);
    j(`${s}Hip`, [-.1, 0, 0]); j(`${s}Knee`, [-.22, 0, 0]); j(`${s}Foot`, [-.2, 0, 0]);
  }
  const pelvis = qMul(qAxis(Y, CHAIR.yaw), qEuler([-.1 - .06 * tonic + .04 * after, 0, .085 * side * jerk + .04 * after]));
  const back = qRotate(qAxis(Y, CHAIR.yaw), [0, 0, -.06 - .012 * jerk]);
  return solve({ position: add(CHAIR.position, add(back, [0, CHAIR.seat + .092 + .012 * jerk, 0])), rotation: pelvis }, angles);
}

// Gait: a slow, slightly stooped walk around the carpet with planted feet and two-bone leg IK.
export const PATH = Object.freeze({ centre: [.05, 0, .28], radius: .74, loop: 8, steps: 14, stance: .6 });
const pathPoint = phi => [PATH.centre[0] + PATH.radius * Math.sin(phi), 0, PATH.centre[2] + PATH.radius * Math.cos(phi)];
const pathYaw = phi => phi + Math.PI / 2; // counter-clockwise tangent seen from above
const lateral = yaw => [Math.cos(yaw), 0, -Math.sin(yaw)]; // the mannequin's left
function legIK(hip, ankle, pole) {
  const { thigh: a, shin: b } = LEG; let d = sub(ankle, hip), dist = vecNorm(d);
  if (dist > a + b - 1e-4) { ankle = add(hip, scale(unit(d), a + b - 1e-4)); d = sub(ankle, hip); dist = a + b - 1e-4; }
  const dir = scale(d, 1 / dist), along = (a * a - b * b + dist * dist) / (2 * dist), bend = Math.sqrt(Math.max(0, a * a - along * along));
  const perp = unit(sub(pole, scale(dir, dot(pole, dir)))), knee = add(hip, add(scale(dir, along), scale(perp, bend)));
  const segment = (top, bottom) => { const y = unit(sub(top, bottom)), z = unit(sub(pole, scale(y, dot(pole, y)))); return qBasis(cross(y, z), y, z); };
  return { knee, ankle, thigh: segment(hip, knee), shin: segment(knee, ankle) };
}
function gaitPose(t, day) {
  const cycle = 2 * PATH.loop / PATH.steps, jitter = (.006 + (day - 1) * .0016) * PATH.loop / (2 * Math.PI);
  const clock = time => time + jitter * (Math.sin(2 * Math.PI * time * 3 / PATH.loop) + .6 * Math.sin(2 * Math.PI * time * 5 / PATH.loop + 1.3));
  const tau = clock(t), phiAt = time => 2 * Math.PI * time / PATH.loop;
  const phase = offset => (((tau - offset) / cycle) % 1 + 1) % 1;
  const uL = phase(0), uR = phase(cycle / 2);
  const phi = phiAt(tau), yaw = pathYaw(phi), forward = qRotate(qAxis(Y, yaw), Z);
  const bob = .013 * Math.cos(4 * Math.PI * (uL - .3)), sway = .018 * Math.cos(2 * Math.PI * (uL - .3));
  const centre = add(pathPoint(phi), add(scale(lateral(yaw), sway), [0, .895 + bob, 0]));
  const turn = .07 * Math.sin(2 * Math.PI * uL);
  const pelvis = qMul(qAxis(Y, yaw + turn), qEuler([.05, 0, .035 * Math.sin(2 * Math.PI * (uL - .05))]));
  const world = {};
  const hipOf = name => add(centre, qRotate(pelvis, BONES.find(bone => bone[0] === name)[2]));
  const footAt = (strike, s) => { // ankle target and sole orientation for one foot
    const phiPlant = phiAt(strike + PATH.stance * cycle / 2), plantYaw = pathYaw(phiPlant);
    return { at: add(pathPoint(phiPlant), add(scale(lateral(plantYaw), s * .095), [0, LEG.ankleHeight, 0])), yaw: plantYaw };
  };
  const pivot = (plant, pitch, toe) => { // roll the shoe about its heel or toe
    const q = qMul(qAxis(Y, plant.yaw), qAxis(X, pitch)), contact = toe ? [0, -LEG.ankleHeight, .13] : [0, -LEG.ankleHeight, -.045];
    const base = add(plant.at, qRotate(qAxis(Y, plant.yaw), contact));
    return { ankle: sub(base, qRotate(q, contact)), q };
  };
  for (const [side, u, s] of [['left', uL, 1], ['right', uR, -1]]) {
    const strike = tau - u * cycle;
    let ankle, foot;
    if (u < PATH.stance) {
      const plant = footAt(strike, s);
      if (u < .08) ({ ankle, q: foot } = pivot(plant, -.22 * (1 - smooth(u / .08)), false));
      else if (u > .42) ({ ankle, q: foot } = pivot(plant, .5 * smooth((u - .42) / (PATH.stance - .42)), true));
      else { ankle = plant.at; foot = qAxis(Y, plant.yaw); }
    } else {
      // Swing starts from the toe-off pose and lands in the heel-strike pose of the next footprint.
      const k = (u - PATH.stance) / (1 - PATH.stance), from = pivot(footAt(strike, s), .5, true), to = pivot(footAt(strike + cycle, s), -.22, false);
      const plantFrom = footAt(strike, s), plantTo = footAt(strike + cycle, s), travel = .5 - .5 * Math.cos(Math.PI * k);
      ankle = add(add(scale(from.ankle, 1 - travel), scale(to.ankle, travel)), [0, .12 * Math.sin(Math.PI * k), 0]);
      foot = qMul(qAxis(Y, mix(plantFrom.yaw, plantTo.yaw, travel)), qAxis(X, mix(.5, -.22, smooth(k))));
    }
    const hip = hipOf(`${side}Hip`), pole = add(forward, scale(lateral(yaw), s * .12));
    const leg = legIK(hip, ankle, pole);
    world[`${side}Hip`] = leg.thigh; world[`${side}Knee`] = leg.shin; world[`${side}Foot`] = foot;
  }
  const swingL = Math.cos(2 * Math.PI * uR), swingR = Math.cos(2 * Math.PI * uL);
  const angles = { ...STAND, spine: [.08, -turn * .5, 0], chest: [.12, -turn * .9, 0], neck: [-.06, turn * .4, 0], head: [-.12, turn * .3, 0],
    leftShoulder: [-.05 - .2 * swingL, 0, .08], rightShoulder: [-.05 - .2 * swingR, 0, -.08],
    leftElbow: [-.32 - .14 * Math.max(0, swingL), 0, 0], rightElbow: [-.32 - .14 * Math.max(0, swingR), 0, 0] };
  return solve({ position: centre, rotation: pelvis }, angles, world);
}

export function poseAt(scenario, t, day = 1) {
  if (!Object.hasOwn(SCENARIOS, scenario) || !Number.isFinite(t) || !Number.isFinite(day) || day < 1 || day > 28) throw new Error('Invalid offline scenario.');
  const bones = scenario === 'fall' ? fallPose(t) : scenario === 'shaking' ? shakingPose(t) : gaitPose(t, day);
  const joints = Object.fromEntries(Object.entries(bones).map(([name, bone]) => [name, bone.position]));
  joints.hips = bones.pelvis.position;
  const sensors = Object.fromEntries(Object.entries(SENSORS).map(([id, s]) => [id, {
    position: add(bones[s.bone].position, qRotate(bones[s.bone].rotation, s.offset)), rotation: bones[s.bone].rotation, rangeG: s.rangeG, placement: s.placement }]));
  return { joints, bones, sensors };
}
export function sampleAt(scenario, t, day = 1, dt = 1 / 60) {
  if (!Number.isFinite(dt) || dt < .001 || dt > .1) throw new Error('Invalid differentiation interval.');
  const before = poseAt(scenario, t - dt, day), current = poseAt(scenario, t, day), after = poseAt(scenario, t + dt, day);
  const sensors = {};
  for (const id of ['chest', 'waist']) {
    const sensor = current.sensors[id], inverse = qConj(sensor.rotation);
    const worldAcceleration = sensor.position.map((value, axis) => (after.sensors[id].position[axis] - 2 * value + before.sensors[id].position[axis]) / (dt * dt));
    const linearG = qRotate(inverse, worldAcceleration).map(value => value / G);
    // Specific force: R^-1 (a_world - gravity_world), divided by g.
    const accelerationG = qRotate(inverse, add(worldAcceleration, [0, G, 0])).map(value => value / G);
    // Body-frame angular velocity from the relative rotation across the central difference.
    let delta = qMul(qConj(before.sensors[id].rotation), after.sensors[id].rotation);
    if (delta[3] < 0) delta = delta.map(v => -v);
    const half = Math.hypot(delta[0], delta[1], delta[2]), angle = 2 * Math.atan2(half, delta[3]);
    const rotationRate = half < 1e-12 ? [0, 0, 0] : [delta[0], delta[1], delta[2]].map(v => v / half * angle / (2 * dt));
    const clipped = sensor.rangeG !== null && accelerationG.some(v => Math.abs(v) >= sensor.rangeG);
    sensors[id] = { placement: sensor.placement, positionM: sensor.position, accelerationG,
      linearG, rotationRate, totalG: vecNorm(accelerationG), angularSpeed: vecNorm(rotationRate),
      rangeG: sensor.rangeG, clipped, deviceAccelerationG: sensor.rangeG === null ? accelerationG : accelerationG.map(v => Math.max(-sensor.rangeG, Math.min(sensor.rangeG, v))) };
  }
  return { schema: TWIN_SCHEMA, provenance: 'synthetic-kinematic', scenario, timeSeconds: t, day, sensors };
}
export function traceFor(scenario, day = 1, hz = 60) {
  if (!Number.isInteger(hz) || hz < 10 || hz > 120) throw new Error('Offline sample rate must be 10–120 Hz.');
  if (!Object.hasOwn(SCENARIOS, scenario)) throw new Error('Invalid offline scenario.');
  return Array.from({ length: SCENARIOS[scenario].duration * hz + 1 }, (_, i) => sampleAt(scenario, i / hz, day, 1 / hz));
}
export function gaitDays() {
  return Array.from({ length: 28 }, (_, index) => {
    const day = index + 1;
    const intervals = Array.from({ length: 40 }, (_, i) => .556 * (1 + (.015 + index * .003) * Math.sin(i * 2.399)));
    const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
    const sd = Math.sqrt(intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length);
    return { day, provenance: 'synthetic-illustrative', stepIntervalsSeconds: intervals, meanStepIntervalSeconds: mean,
      variabilityPercent: sd / mean * 100, stepCount: intervals.length, clinicalInterpretation: null };
  });
}
export function timingGate(scenario, t) {
  if (scenario === 'fall') return t < 1.55 ? 'Baseline' : t < 2.66 ? 'Loss of balance → descent'
    : t < 2.95 ? 'Contact / rebound assumption' : t < 5.4 ? 'Stillness window accumulating' : 'Illustrative stillness window complete';
  if (scenario === 'shaking') return t < 1 ? 'Baseline' : t < 5 ? 'Alternating movement → duration gate'
    : t < 6.5 ? 'Illustrative duration gate complete' : 'Movement settles';
  return 'Step timing → daily interval variability';
}
