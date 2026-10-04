import { SCENARIOS, TWIN_SCHEMA, poseAt, sampleAt, traceFor, gaitDays, timingGate } from './kinematics.js';
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
  $('gait-controls').hidden = scenario !== 'gait'; update();
}));
$('twin-time').addEventListener('input', event => { pause(); t = Number(event.target.value); update(); });
$('gait-day').addEventListener('input', event => { day = Number(event.target.value); trace = traceFor(scenario, day); update(); });
$('play').addEventListener('click', () => {
  if (playing) { pause(); return; }
  if (t >= 8) t = 0;
  playing = true; lastFrame = null; $('play').textContent = 'Pause'; $('play').setAttribute('aria-label', 'Pause motion');
});
$('export-trace').addEventListener('click', () => {
  const documentData = { schema: TWIN_SCHEMA, provenance: 'synthetic-kinematic', notForTraining: true,
    rigStatus: 'articulated-elderly-woman-mannequin', scenario, sampleHz: 60, day, samples: trace,
    ...(scenario === 'gait' ? { dailyIllustrativeMetrics: days } : {}),
    limitations: ['Scripted articulation; no contact-force model', 'Not measured or clinically validated', 'No live detector connection'] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(documentData, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `lifeline-offline-${scenario}-day-${day}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});
new ResizeObserver(update).observe($('twin-chart'));
update();

async function initScene() {
  const T = await import('/vendor/location-engine.js'), stage = $('twin-stage');
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7)); renderer.setClearColor(0, 0);
  renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping;
  stage.append(renderer.domElement);
  const scene = new T.Scene(), camera = new T.PerspectiveCamera(43, 1, .05, 100);
  camera.position.set(2.8, 2.8, 4.4);
  const controls = new T.OrbitControls(camera, renderer.domElement); controls.target.set(.1, .85, 0);
  controls.enableDamping = true; controls.minDistance = 1.5; controls.maxDistance = 13; controls.maxPolarAngle = Math.PI * .49;
  scene.add(new T.HemisphereLight(0xc2deff, 0x152a40, 3));
  const key = new T.DirectionalLight(0xffffff, 3); key.position.set(3, 6, 4); scene.add(key);
  // A quiet, rearranged apartment vignette keeps the articulated subject primary.
  const roomMat = new T.MeshStandardMaterial({ color: 0xbac0c4, roughness: 1 });
  const softMat = new T.MeshStandardMaterial({ color: 0xcdd0d0, roughness: 1 });
  const woodMat = new T.MeshStandardMaterial({ color: 0xa5adb0, roughness: .9 });
  function box(size, position, mat = roomMat) {
    const mesh = new T.Mesh(new T.BoxGeometry(...size), mat); mesh.position.set(...position); scene.add(mesh); return mesh;
  }
  box([5, .08, 4.5], [0, -.07, -.15]);
  box([5, .75, .10], [0, .34, -2.35]);
  box([.10, .75, 4.5], [-2.5, .34, -.15]);
  box([1.55, .27, .65], [-1.45, .23, -1.35], softMat);
  box([1.55, .55, .15], [-1.45, .56, -1.62], softMat);
  for (const x of [-2.18, -.72]) box([.12, .4, .7], [x, .41, -1.35], softMat);
  box([.65, .055, .65], [2.05, .52, .15], woodMat);
  for (const x of [1.78, 2.32]) for (const z of [-.12, .42]) box([.045, .5, .045], [x, .245, z], woodMat);
  box([1.25, .22, 1.6], [1.45, .23, -1.32], softMat);
  box([1.28, .08, 1.15], [1.45, .38, -1.07], roomMat);
  box([.82, .12, .32], [1.45, .40, -1.90], softMat);
  box([1.28, .72, .08], [1.45, .36, -2.15], woodMat);
  const carpet = box([2.0, .012, 1.9], [0, -.018, .25], new T.MeshStandardMaterial({ color: 0xd9dcdd, roughness: 1 }));
  const mannequin = new T.Group(); scene.add(mannequin);
  const boneMaterial = new T.MeshStandardMaterial({ color: 0xdacdc0, roughness: .72 });
  const clothing = new T.MeshStandardMaterial({ color: 0x8c9d9a, roughness: .95 });
  const trousers = new T.MeshStandardMaterial({ color: 0x68777d, roughness: .9 });
  const hair = new T.MeshStandardMaterial({ color: 0xcbd0d2, roughness: 1 });
  const pairs = [['hips', 'chest'], ['chest', 'head'], ...['left', 'right'].flatMap(side =>
    [[`${side}Hip`, `${side}Knee`], [`${side}Knee`, `${side}Foot`],
      [`${side}Shoulder`, `${side}Elbow`], [`${side}Elbow`, `${side}Hand`]])];
  const rig = new T.Bone(); rig.name = 'Elderly woman mannequin'; mannequin.add(rig);
  const bones = pairs.map((pair, index) => {
    const bone = new T.Bone(); bone.name = pair.join(' → '); rig.add(bone);
    const radius = index === 0 ? .18 : index === 1 ? .065 : (index - 2) % 4 < 2 ? .085 : .055;
    const material = index === 0 ? clothing : index === 1 ? boneMaterial : (index - 2) % 4 < 2 ? trousers : clothing;
    const mesh = new T.Mesh(new T.SphereGeometry(1, 20, 14), material);
    mesh.scale.set(radius, .5, index === 0 ? .13 : radius); bone.add(mesh);
    return { pair, mesh, bone, radius };
  });
  const skeleton = new T.Skeleton([rig, ...bones.map(item => item.bone)]);
  mannequin.userData.rig = skeleton;
  const head = new T.Group(); mannequin.add(head);
  function oval(parent, size, position, mat) {
    const mesh = new T.Mesh(new T.SphereGeometry(1, 24, 18), mat); mesh.scale.set(...size); mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  oval(head, [.12, .15, .115], [0, 0, 0], boneMaterial);
  oval(head, [.125, .075, .12], [0, .105, -.012], hair);
  oval(head, [.065, .068, .06], [0, .06, -.125], hair);
  oval(head, [.023, .035, .035], [0, -.015, .108], boneMaterial);
  const spectacles = new T.MeshStandardMaterial({ color: 0x606b73, roughness: .6 });
  for (const x of [-.05, .05]) {
    const rim = new T.Mesh(new T.TorusGeometry(.035, .004, 6, 24), spectacles); rim.position.set(x, .023, .109); head.add(rim);
  }
  const hipsMesh = oval(mannequin, [.19, .15, .125], [0, 0, 0], clothing);
  const hands = {}, shoes = {};
  for (const side of ['left', 'right']) {
    hands[side] = oval(mannequin, [.048, .065, .035], [0, 0, 0], boneMaterial);
    shoes[side] = oval(mannequin, [.065, .04, .105], [0, 0, 0], trousers);
  }
  stage.dataset.rig = 'elderly-woman-joint-rig';
  const sensors = {};
  for (const [id, color] of [['chest', 0x54a9ff], ['waist', 0xe5b373]]) {
    const group = new T.Group(); group.add(new T.Mesh(new T.BoxGeometry(.10, .10, .045), new T.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .7 })));
    const ring = new T.Mesh(new T.RingGeometry(.09, .105, 48), new T.MeshBasicMaterial({ color, transparent: true, opacity: .55, side: T.DoubleSide })); group.add(ring);
    const axes = new T.AxesHelper(.09); group.add(axes); scene.add(group); sensors[id] = group;
  }
  const up = new T.Vector3(0, 1, 0), start = new T.Vector3(), end = new T.Vector3(), delta = new T.Vector3();
  const floorRings = Array.from({ length: 3 }, () => {
    const ring = new T.Mesh(new T.RingGeometry(.97, 1, 64), new T.MeshBasicMaterial({ color: 0x438fea, transparent: true, opacity: .3, depthWrite: false, side: T.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .008; scene.add(ring); return ring;
  });
  renderPose = pose => {
    stage.dataset.motionScenario = scenario; stage.dataset.poseTime = t.toFixed(2);
    bones.forEach(({ pair, mesh, bone }) => {
      start.fromArray(pose.joints[pair[0]]); end.fromArray(pose.joints[pair[1]]); delta.subVectors(end, start);
      bone.position.copy(start).add(end).multiplyScalar(.5); mesh.scale.y = Math.max(.001, delta.length() * .55); bone.quaternion.setFromUnitVectors(up, delta.normalize());
    });
    head.position.fromArray(pose.joints.head); head.rotation.z = pose.sensors.chest.angle;
    hipsMesh.position.fromArray(pose.joints.hips); hipsMesh.rotation.z = pose.sensors.waist.angle;
    for (const side of ['left', 'right']) { hands[side].position.fromArray(pose.joints[`${side}Hand`]); shoes[side].position.fromArray(pose.joints[`${side}Foot`]); shoes[side].rotation.z = pose.sensors.waist.angle; }
    skeleton.update();
    for (const id of ['chest', 'waist']) { sensors[id].position.fromArray(pose.sensors[id].position); sensors[id].rotation.z = pose.sensors[id].angle; }
  };
  renderPose(poseAt(scenario, t, day));
  new ResizeObserver(() => { const box = stage.getBoundingClientRect(); if (!box.width || !box.height) return; renderer.setSize(box.width, box.height); camera.aspect = box.width / box.height; camera.updateProjectionMatrix(); }).observe(stage);
  new IntersectionObserver(entries => { sceneVisible = entries[0].isIntersecting; }).observe(stage);
  renderScene = () => {
    const clock = reduce.matches ? 0 : performance.now() / 1500;
    floorRings.forEach((ring, i) => {
      const p = (clock + i / 3) % 1; ring.scale.setScalar(.28 + p * 1.25);
      ring.position.x = poseAt(scenario, t, day).joints.hips[0];
      ring.material.opacity = (1 - p) * .30;
    });
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
