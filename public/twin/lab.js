import { TWIN_SCHEMA, BONES, CHAIR, poseAt, sampleAt, traceFor, gaitDays, timingGate } from './kinematics.js';
if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embedded');
const $ = id => document.getElementById(id);
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
let scenario = 'fall', t = 0, day = 1, playing = !reduce.matches, lastFrame = null, renderPose = null;
let renderScene = null, sceneVisible = true;
let trace = traceFor(scenario), days = gaitDays();
function chart() {
  const canvas = $('twin-chart'), box = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
  const c = canvas.getContext('2d'); c.scale(dpr, dpr);
  const width = box.width, height = box.height, left = 22, top = 12, bottom = height - 10;
  const peak = Math.max(2, ...trace.flatMap(s => [s.sensors.chest.totalG, s.sensors.waist.totalG]));
  const max = Math.ceil(peak), x = time => left + time / 8 * (width - left - 8), y = g => bottom - g / max * (bottom - top);
  c.font = '9px Aspekta, Arial'; c.fillStyle = '#a1acb8';
  for (let i = 0; i < 3; i++) { const value = max * i / 2; c.fillText(value.toFixed(0), 2, y(value) + 3); c.strokeStyle = '#edf0f4'; c.beginPath(); c.moveTo(left, y(value)); c.lineTo(width, y(value)); c.stroke(); }
  c.setLineDash([3, 3]); c.strokeStyle = '#bcc8d5'; c.beginPath(); c.moveTo(left, y(2)); c.lineTo(width, y(2)); c.stroke(); c.setLineDash([]);
  for (const [sensor, color] of [['chest', '#4598ef'], ['waist', '#d8a76c']]) {
    c.strokeStyle = color; c.lineWidth = 1.6; c.beginPath();
    trace.forEach((s, i) => { const point = [x(s.timeSeconds), y(s.sensors[sensor].totalG)]; i ? c.lineTo(...point) : c.moveTo(...point); }); c.stroke();
  }
  c.strokeStyle = '#18334c'; c.lineWidth = 1; c.beginPath(); c.moveTo(x(t), top); c.lineTo(x(t), bottom); c.stroke();
}
function update() {
  const sample = sampleAt(scenario, t, day);
  $('chest-value').replaceChildren(document.createTextNode(`${sample.sensors.chest.totalG.toFixed(2)} `), Object.assign(document.createElement('small'), { textContent: 'g' }));
  $('waist-value').replaceChildren(document.createTextNode(`${sample.sensors.waist.angularSpeed.toFixed(2)} `), Object.assign(document.createElement('small'), { textContent: 'rad/s' }));
  $('clip-label').textContent = sample.sensors.chest.clipped ? 'Exceeds 2 g · board would clip' : '2 g board range';
  $('timing-gate').textContent = timingGate(scenario, t);
  $('time-label').textContent = `${t.toFixed(2)} s`; $('twin-time').value = String(t);
  $('day-label').textContent = String(day);
  $('gait-summary').textContent = `Illustrative step interval CV: ${days[day - 1].variabilityPercent.toFixed(1)}% · 40 intervals / day`;
  renderPose?.(poseAt(scenario, t, day)); chart();
}
function syncPlayback() { $('play').textContent = playing ? 'Pause' : 'Play'; $('play').setAttribute('aria-label', playing ? 'Pause motion' : 'Play motion'); }
function pause() { playing = false; syncPlayback(); }
syncPlayback();
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  scenario = button.dataset.scenario; t = 0; playing = !reduce.matches; lastFrame = null; syncPlayback(); trace = traceFor(scenario, day);
  document.querySelectorAll('[data-scenario]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  $('gait-controls').hidden = scenario !== 'gait'; cameraGoal = CAMERA_VIEWS[scenario]; update();
}));
$('twin-time').addEventListener('input', event => { pause(); t = Number(event.target.value); update(); });
$('gait-day').addEventListener('input', event => { day = Number(event.target.value); trace = traceFor(scenario, day); update(); });
$('play').addEventListener('click', () => {
  if (playing) { pause(); return; }
  if (t >= 8) t = 0;
  playing = true; lastFrame = null; $('play').textContent = 'Pause'; $('play').setAttribute('aria-label', 'Pause motion');
});
new ResizeObserver(update).observe($('twin-chart'));
update();

const CAMERA_VIEWS = { fall: { target: [-.2, .62, .35], position: [2.45, 2.15, 4.15] },
  shaking: { target: [-1.55, .66, .72], position: [.55, 1.75, 3.6] }, gait: { target: [.05, .6, .3], position: [3.05, 2.65, 4.6] } };
let cameraGoal = null;
async function initScene() {
  const T = await import('/vendor/location-engine.js'), stage = $('twin-stage');
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7)); renderer.setClearColor(0, 0);
  renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
  stage.append(renderer.domElement);
  const scene = new T.Scene(), camera = new T.PerspectiveCamera(36, 1, .05, 100);
  const view = CAMERA_VIEWS[scenario]; camera.position.set(...view.position);
  const controls = new T.OrbitControls(camera, renderer.domElement); controls.target.set(...view.target);
  controls.enableDamping = true; controls.minDistance = 1.4; controls.maxDistance = 9; controls.maxPolarAngle = Math.PI * .47;
  controls.addEventListener('start', () => { cameraGoal = null; });
  scene.add(new T.HemisphereLight(0xe8f1ff, 0x5a6470, 1.6));
  const key = new T.DirectionalLight(0xfff6ec, 2.6); key.position.set(2.2, 5.5, 3.2); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -.0004; key.shadow.normalBias = .025; key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: .5, far: 14 }); scene.add(key);
  const rim = new T.DirectionalLight(0xc9dcff, 1.1); rim.position.set(-3, 3, -2.5); scene.add(rim);
  // A quiet apartment vignette keeps the articulated subject primary.
  const matte = color => new T.MeshStandardMaterial({ color, roughness: .95 });
  const roomMat = matte(0xc3c8cc), softMat = matte(0xd3d6d6), woodMat = matte(0xa9b0b3);
  function box(size, position, mat = roomMat, parent = scene) {
    const mesh = new T.Mesh(new T.BoxGeometry(...size), mat); mesh.position.set(...position); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  box([5, .08, 4.5], [0, -.04, -.15], matte(0xd5d9dc));
  box([5, .75, .10], [0, .34, -2.35]);
  box([.10, .75, 4.5], [-2.5, .34, -.15]);
  box([1.55, .27, .65], [-1.45, .23, -1.6], softMat);
  box([1.55, .55, .15], [-1.45, .56, -1.87], softMat);
  for (const x of [-2.18, -.72]) box([.12, .4, .7], [x, .41, -1.6], softMat);
  box([.65, .055, .65], [2.05, .52, .15], woodMat);
  for (const x of [1.78, 2.32]) for (const z of [-.12, .42]) box([.045, .5, .045], [x, .245, z], woodMat);
  box([1.25, .22, 1.6], [1.45, .23, -1.32], softMat);
  box([1.28, .08, 1.15], [1.45, .38, -1.07], roomMat);
  box([.82, .12, .32], [1.45, .40, -1.90], softMat);
  box([1.28, .72, .08], [1.45, .36, -2.15], woodMat);
  box([2.1, .012, 1.95], [0, .006, .28], matte(0xe4e6e6));
  // Armchair for the seated scenario.
  const chair = new T.Group(); chair.position.set(...CHAIR.position); chair.rotation.y = CHAIR.yaw; scene.add(chair);
  const chairMat = matte(0xb7bec4), cushion = matte(0xc9cfd3);
  box([.66, .3, .62], [0, .2, -.04], chairMat, chair); box([.58, .12, .54], [0, .41, .0], cushion, chair);
  box([.66, .62, .14], [0, .62, -.31], chairMat, chair); box([.12, .26, .62], [-.33, .47, -.04], chairMat, chair); box([.12, .26, .62], [.33, .47, -.04], chairMat, chair);

  // Articulated mannequin: every body part is parented to a skeleton bone and rotates with it.
  const skin = new T.MeshStandardMaterial({ color: 0xe6c6b0, roughness: .62 }), cardigan = new T.MeshStandardMaterial({ color: 0xb58d96, roughness: .9 });
  const slacks = new T.MeshStandardMaterial({ color: 0x56606d, roughness: .85 }), hair = new T.MeshStandardMaterial({ color: 0xe9e8e4, roughness: .7 });
  const shoe = new T.MeshStandardMaterial({ color: 0x343b44, roughness: .55 }), cream = new T.MeshStandardMaterial({ color: 0xf2ede4, roughness: .8 });
  const frames = new T.MeshStandardMaterial({ color: 0x3d4650, roughness: .35, metalness: .4 });
  const nodes = {};
  const mannequin = new T.Group(); scene.add(mannequin);
  for (const [name] of BONES) { const node = new T.Group(); node.matrixAutoUpdate = false; node.name = name; mannequin.add(node); nodes[name] = node; }
  const sphere = new T.SphereGeometry(1, 32, 20);
  function part(bone, geometry, mat, position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0]) {
    const mesh = new T.Mesh(geometry, mat); mesh.position.set(...position); mesh.scale.set(...scale); mesh.rotation.set(...rotation);
    mesh.castShadow = true; mesh.receiveShadow = true; nodes[bone].add(mesh); return mesh;
  }
  const ellipsoid = (bone, mat, position, semi, rotation) => part(bone, sphere, mat, position, semi, rotation);
  function limb(length, top, bottom, bulge = 0) { // tapered, capped segment hanging down the bone's -y axis
    const points = [];
    for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + i / 8 * Math.PI / 2; points.push(new T.Vector2(Math.max(1e-4, bottom * Math.cos(a)), -length + bottom * Math.sin(a))); }
    for (let i = 1; i < 12; i++) { const k = i / 12; points.push(new T.Vector2(bottom + (top - bottom) * k + bulge * Math.sin(Math.PI * k) ** 1.5, -length + length * k)); }
    for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI / 2; points.push(new T.Vector2(Math.max(1e-4, top * Math.cos(a)), top * Math.sin(a))); }
    return new T.LatheGeometry(points, 28);
  }
  // Trunk: one continuous tapered cardigan silhouette split across the pelvis, spine and chest bones.
  const profile = (rings, segments = 40) => new T.LatheGeometry(rings.map(([r, y]) => new T.Vector2(Math.max(1e-4, r), y)), segments);
  ellipsoid('pelvis', slacks, [0, -.06, -.004], [.132, .075, .098]);
  part('pelvis', profile([[0, -.06], [.11, -.058], [.146, -.045], [.157, -.015], [.156, .025], [.148, .07], [.142, .1], [0, .105]]), cardigan, [0, 0, .002], [1, 1, .72]);
  part('spine', profile([[0, -.05], [.142, -.04], [.138, .02], [.135, .08], [.14, .14], [.147, .2], [0, .21]]), cardigan, [0, 0, .002], [1, 1, .72]);
  part('chest', profile([[0, -.04], [.147, -.03], [.153, .03], [.158, .09], [.161, .15], [.163, .185], [.152, .212], [.115, .232], [.06, .246], [0, .25]]), cardigan, [0, 0, -.004], [1, 1, .67]);
  ellipsoid('chest', cardigan, [0, .082, .05], [.122, .058, .062]);
  for (const x of [-1, 1]) ellipsoid('chest', cardigan, [x * .152, .182, -.006], [.05, .046, .05]);
  part('chest', new T.TorusGeometry(.052, .014, 10, 32), cream, [0, .232, .006], [1, 1, 1], [Math.PI / 2 - .2, 0, 0]);
  for (const y of [.02, .085, .15]) ellipsoid('chest', cream, [0, y, .112 - Math.abs(y - .085) * .12], [.009, .009, .005]);
  // Neck and head: silver hair in a low bun, reading glasses.
  part('neck', limb(.09, .046, .054), skin, [0, .085, .005]);
  ellipsoid('head', skin, [0, .112, .018], [.083, .104, .094]);
  ellipsoid('head', skin, [0, .06, .045], [.063, .058, .066]);
  ellipsoid('head', skin, [0, .105, .112], [.013, .021, .016]);
  const eyes = new T.MeshStandardMaterial({ color: 0x2d3540, roughness: .4 });
  for (const x of [-1, 1]) { ellipsoid('head', eyes, [x * .033, .116, .093], [.0085, .0095, .005]); ellipsoid('head', hair, [x * .034, .143, .093], [.019, .0045, .006], [0, 0, x * -.12]); }
  for (const x of [-1, 1]) ellipsoid('head', skin, [x * .083, .105, .012], [.012, .022, .016]);
  ellipsoid('head', hair, [0, .145, -.006], [.09, .084, .1]);
  ellipsoid('head', hair, [0, .12, -.04], [.087, .07, .082]);
  ellipsoid('head', hair, [0, .145, -.1], [.047, .044, .04]);
  for (const x of [-1, 1]) {
    part('head', new T.TorusGeometry(.026, .0035, 8, 28), frames, [x * .034, .112, .101], [1, .82, 1]);
    part('head', new T.BoxGeometry(.004, .004, .1), frames, [x * .061, .118, .055], [1, 1, 1], [0, x * .12, 0]);
  }
  part('head', new T.BoxGeometry(.018, .0035, .004), frames, [0, .116, .106]);
  // Limbs.
  for (const side of ['left', 'right']) {
    part(`${side}Shoulder`, limb(.27, .048, .039, .006), cardigan);
    part(`${side}Elbow`, limb(.215, .039, .03, .004), cardigan);
    part(`${side}Elbow`, limb(.022, .033, .033), cream, [0, -.205, 0]);
    ellipsoid(`${side}Hand`, skin, [0, -.06, .004], [.026, .058, .02]);
    ellipsoid(`${side}Hand`, skin, [side === 'left' ? -.018 : .018, -.035, .02], [.011, .03, .012], [0, 0, side === 'left' ? .5 : -.5]);
    part(`${side}Hip`, limb(.43, .074, .053, .006), slacks, [0, 0, 0], [1, 1, .94]);
    part(`${side}Knee`, limb(.41, .052, .038, .008), slacks);
    part(`${side}Foot`, limb(.035, .034, .036), slacks, [0, .02, 0]);
    ellipsoid(`${side}Foot`, shoe, [0, -.037, .046], [.042, .029, .108]);
    part(`${side}Foot`, new T.BoxGeometry(.084, .012, .2), shoe, [0, -.059, .045]);
  }
  stage.dataset.rig = 'elderly-woman-joint-rig';
  const nodeMatrix = new T.Matrix4(), nodePosition = new T.Vector3(), nodeQuaternion = new T.Quaternion(), unitScale = new T.Vector3(1, 1, 1);
  // Sensors render on top of the body so both placements stay readable from any angle.
  const sensors = {};
  for (const [id, color, size] of [['chest', 0x3d9bff, [.05, .064, .014]], ['waist', 0xe8a656, [.03, .05, .024]]]) {
    const group = new T.Group(); group.matrixAutoUpdate = false;
    const device = new T.Mesh(new T.BoxGeometry(...size), new T.MeshStandardMaterial({ color: id === 'chest' ? 0x1d2a3a : 0xf4f4f2, roughness: .4 }));
    const led = new T.Mesh(new T.SphereGeometry(.009, 12, 8), new T.MeshBasicMaterial({ color })); led.position.z = size[2] / 2 + .002;
    const halo = new T.Mesh(new T.RingGeometry(.045, .056, 48), new T.MeshBasicMaterial({ color, transparent: true, opacity: .85, depthTest: false, side: T.DoubleSide }));
    const glow = new T.Mesh(new T.CircleGeometry(.045, 40), new T.MeshBasicMaterial({ color, transparent: true, opacity: .16, depthTest: false, side: T.DoubleSide }));
    halo.renderOrder = glow.renderOrder = 10; halo.position.z = glow.position.z = .012;
    group.add(device, led, glow, halo); scene.add(group); sensors[id] = { group, halo, glow };
  }
  const floorRings = Array.from({ length: 3 }, () => {
    const ring = new T.Mesh(new T.RingGeometry(.97, 1, 64), new T.MeshBasicMaterial({ color: 0x438fea, transparent: true, opacity: .3, depthWrite: false, side: T.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .014; scene.add(ring); return ring;
  });
  let ringCentre = [0, 0, 0];
  renderPose = pose => {
    stage.dataset.motionScenario = scenario; stage.dataset.poseTime = t.toFixed(2);
    for (const [name, bone] of Object.entries(pose.bones)) {
      nodes[name].matrix.compose(nodePosition.fromArray(bone.position), nodeQuaternion.fromArray(bone.rotation), unitScale); nodes[name].matrixWorldNeedsUpdate = true;
    }
    for (const id of ['chest', 'waist']) {
      const { group } = sensors[id], s = pose.sensors[id];
      group.matrix.compose(nodePosition.fromArray(s.position), nodeQuaternion.fromArray(s.rotation), unitScale); group.matrixWorldNeedsUpdate = true;
    }
    ringCentre = pose.joints.hips;
  };
  renderPose(poseAt(scenario, t, day));
  new ResizeObserver(() => {
    const box = stage.getBoundingClientRect(); if (!box.width || !box.height) return;
    renderer.setSize(box.width, box.height); camera.aspect = box.width / box.height;
    // The landing embed overlays the trace and switcher on the lower scene; lift the subject above them.
    if (document.body.classList.contains('embedded')) camera.setViewOffset(box.width, box.height, 0, box.height * .17, box.width, box.height);
    camera.updateProjectionMatrix();
  }).observe(stage);
  new IntersectionObserver(entries => { sceneVisible = entries[0].isIntersecting; }).observe(stage);
  const goalTarget = new T.Vector3(), goalPosition = new T.Vector3();
  renderScene = () => {
    const clock = reduce.matches ? 0 : performance.now() / 1500;
    floorRings.forEach((ring, i) => {
      const p = (clock + i / 3) % 1; ring.scale.setScalar(.28 + p * 1.15);
      ring.position.x = ringCentre[0]; ring.position.z = ringCentre[2];
      ring.material.opacity = (1 - p) * .26;
    });
    for (const id of ['chest', 'waist']) { const pulse = .5 + .5 * Math.sin(clock * 4.2 + (id === 'waist' ? 1.6 : 0)); sensors[id].halo.scale.setScalar(1 + pulse * .22); sensors[id].glow.material.opacity = .1 + pulse * .12; }
    if (cameraGoal) {
      goalTarget.fromArray(cameraGoal.target); goalPosition.fromArray(cameraGoal.position);
      controls.target.lerp(goalTarget, .07); camera.position.lerp(goalPosition, .07);
      if (camera.position.distanceTo(goalPosition) < .01) cameraGoal = null;
    }
    controls.update(); renderer.render(scene, camera);
  };
  $('scene-message').hidden = true;
}
initScene().catch(() => { $('scene-message').textContent = '3D view unavailable. Sensor traces and time controls remain available.'; });
function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden || !sceneVisible) { lastFrame = null; return; }
  if (playing) {
    if (lastFrame !== null) t += Math.min(.05, (now - lastFrame) / 1000);
    if (t >= 8) t = 0; update();
  }
  lastFrame = now; renderScene?.();
}
requestAnimationFrame(frame);
// Respect reduced motion; playback can also be paused or scrubbed explicitly.
reduce.addEventListener('change', () => { if (reduce.matches) pause(); });
