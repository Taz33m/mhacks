(() => {
  'use strict';
  if (location.hash === '#calibration') { location.replace('/dashboard#calibration'); return; }
  const body = document.body;
  const story = document.getElementById('story');
  const stage = document.getElementById('story-stage');
  const canvas = document.getElementById('story-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const poster = document.getElementById('story-poster');
  const fallbackPoster = poster.getAttribute('src');
  poster.addEventListener('error', () => {
    if (poster.getAttribute('src') !== fallbackPoster) poster.src = fallbackPoster;
  });
  const nav = document.getElementById('story-nav');
  const hero = document.getElementById('sequence-hero');
  const utility = document.getElementById('story-utility');
  const captions = [...document.querySelectorAll('.story-caption')];
  const phone = document.getElementById('story-phone');
  const thread = document.getElementById('phone-thread');
  const messages = [...thread.querySelectorAll('[data-message]')];
  const ownership = document.getElementById('phone-ownership');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = innerWidth <= 760;
  const rendition = mobile ? 'mobile' : 'desktop';
  const maxDecoded = mobile ? 18 : 26;
  const prefetchRadius = mobile ? 4 : 6;
  const blobs = new Map(), decoded = new Map(), fetching = new Map(), decoding = new Map();
  const failed = new Set(), pinned = new Set();
  let manifest, enabled = false, progress = 0, requested = 0, drawn = -1;
  let renderId = 0, fetchCount = 0, backgroundCursor = 0, backgroundScheduled = false;
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  const interval = (n, a, b) => clamp((n - a) / (b - a));
  const ease = n => n * n * (3 - 2 * n);
  const sceneAt = p => manifest.scenes.findIndex(scene => p < scene.end);
  const deviceSound = document.getElementById('device-sound');
  deviceSound.setAttribute('viewBox', mobile ? '0 0 648 1152' : '0 0 1280 720');
  const wave = document.querySelector('.voice-wave');
  for (let i = 0; i < 24; i++) wave.appendChild(document.createElement('i'));
  function coordination(t, visible) {
    const entry = ease(interval(t, .025, .17)), exit = ease(interval(t, .89, 1));
    phone.style.opacity = visible ? String(entry * (1 - exit)) : '0';
    phone.style.transform = `translate(${(1 - entry) * -24 + exit * 26}px, ${(1 - entry) * 18 - exit * 12}px) scale(${.82 + entry * .18 - exit * .07})`;
    phone.style.filter = `blur(${(1 - entry) * 7 + exit * 10}px)`;
    phone.dataset.visible = String(visible && entry > 0 && exit < 1);
    let shift = 0, current = -1;
    const viewport = phone.querySelector('.phone-viewport');
    messages.forEach((message, i) => {
      const start = .11 + i * .105, reveal = ease(interval(t, start, start + .06));
      const overshoot = Math.sin(interval(t, start, start + .09) * Math.PI) * .035;
      const old = ease(interval(t, start + .36, start + .50));
      message.style.opacity = String(reveal * (1 - old * .35));
      message.style.transform = `translate(${(1 - reveal) * (message.classList.contains('system') ? 22 : -18)}px, ${(1 - reveal) * 20}px) scale(${.76 + reveal * .24 + overshoot})`;
      message.style.filter = `blur(${(1 - reveal) * 5 + old * .6}px)`;
      if (reveal > 0) {
        current = i;
        const destination = Math.max(0, message.offsetTop + message.offsetHeight - viewport.clientHeight + 6);
        shift += (destination - shift) * reveal;
      }
    });
    thread.style.transform = `translateY(${-shift}px)`;
    phone.dataset.message = String(current);
    const accepted = t >= .61, departed = t >= .715;
    ownership.classList.toggle('accepted', accepted);
    ownership.querySelector('span').textContent = departed ? 'MAYA — ON WAY' : accepted ? 'MAYA ACCEPTED · NOT YET DEPARTED' : 'Waiting for someone to accept';
    phone.dataset.state = departed ? 'en-route' : accepted ? 'accepted' : 'unassigned';
  }
  function gate(element, visible) { element.inert = !visible; element.setAttribute('aria-hidden', String(!visible)); }
  function schedule() { if (enabled && !renderId) renderId = requestAnimationFrame(render); }
  function evict() {
    if (decoded.size <= maxDecoded) return;
    for (const [index, bitmap] of decoded) {
      if (decoded.size <= maxDecoded) break;
      if (pinned.has(index) || index === drawn || Math.abs(index - requested) < 3) continue;
      bitmap.close(); decoded.delete(index);
    }
  }
  async function decode(index) {
    if (decoded.has(index)) return decoded.get(index);
    if (decoding.has(index)) return decoding.get(index);
    if (!blobs.has(index)) return null;
    const promise = createImageBitmap(blobs.get(index)).then(bitmap => {
      if (!enabled) { bitmap.close(); return null; }
      decoded.set(index, bitmap); evict(); schedule(); return bitmap;
    }).catch(() => null).finally(() => decoding.delete(index));
    decoding.set(index, promise); return promise;
  }
  async function load(index, wantDecode = false) {
    if (index < 0 || index >= manifest.totalFrames || failed.has(index)) return;
    if (blobs.has(index)) { if (wantDecode) await decode(index); return; }
    if (fetching.has(index)) { await fetching.get(index); if (wantDecode) await decode(index); return; }
    // Reserve a slot for a scrubbed-to frame even during the background preload.
    if (fetchCount >= (wantDecode ? 7 : 4)) return;
    fetchCount++;
    const name = String(index).padStart(4, '0');
    const promise = fetch(`/media/story/${rendition}/frame_${name}.webp?v=${manifest.revision}`).then(response => {
      if (!response.ok) throw new Error('Frame unavailable');
      return response.blob();
    }).then(blob => { blobs.set(index, blob); }).catch(() => { failed.add(index); }).finally(() => {
      fetchCount--; fetching.delete(index); schedule(); preloadBackground();
    });
    fetching.set(index, promise);
    await promise;
    if (wantDecode) await decode(index);
  }
  function preloadBackground() {
    if (!enabled || backgroundScheduled || document.hidden) return;
    backgroundScheduled = true;
    const idle = window.requestIdleCallback || (callback => setTimeout(callback, 80));
    idle(() => {
      backgroundScheduled = false;
      if (!enabled || document.hidden) return;
      let budget = 4 - fetchCount;
      while (budget > 0 && backgroundCursor < manifest.totalFrames) {
        const index = backgroundCursor++;
        if (!blobs.has(index) && !fetching.has(index) && !failed.has(index)) { load(index); budget--; }
      }
    });
  }
  function draw(index) {
    const bitmap = decoded.get(index);
    if (!bitmap || (drawn === index && canvas.classList.contains('has-frame'))) return;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    drawn = index;
    canvas.classList.add('has-frame');
    stage.dataset.drawnFrame = String(index);
  }
  function geometry(r) {
    const w = stage.clientWidth, h = stage.clientHeight, narrow = w <= 760;
    const margin = narrow ? 20 : Math.max(36, w * .045);
    const width = narrow ? w - 2 * margin : w * .48;
    const height = narrow ? Math.min(h * .38, width * .94) : width * 9 / 16;
    const left = narrow ? margin : w - margin - width;
    const top = narrow ? h * .51 : (h - height) * .52;
    const inset = margin * ease(interval(r, 0, .32));
    const settle = ease(interval(r, .24, 1));
    const initialWidth = w - inset * 2, initialHeight = h - inset * 2;
    stage.style.setProperty('--art-left', `${inset + (left - inset) * settle}px`);
    stage.style.setProperty('--art-top', `${inset + (top - inset) * settle}px`);
    stage.style.setProperty('--art-width', `${initialWidth + (width - initialWidth) * settle}px`);
    stage.style.setProperty('--art-height', `${initialHeight + (height - initialHeight) * settle}px`);
    stage.style.setProperty('--art-radius', `${24 * ease(interval(r, .18, .66))}px`);
    stage.style.setProperty('--reframe', r);
    stage.style.setProperty('--nav-reveal', interval(r, .42, .68));
    stage.style.setProperty('--hero-reveal', interval(r, narrow ? .84 : .70, 1));
    gate(nav, r > .68); gate(hero, r > .99); gate(utility, r <= .68);
  }
  function render() {
    renderId = 0;
    if (!enabled || !manifest) return;
    progress = clamp(-story.getBoundingClientRect().top / Math.max(1, story.offsetHeight - stage.offsetHeight));
    const sceneIndex = sceneAt(progress);
    const holding = sceneIndex === -1;
    const scene = holding ? manifest.scenes.at(-1) : manifest.scenes[sceneIndex];
    const sceneProgress = holding ? 1 : interval(progress, scene.start, scene.end);
    requested = holding ? manifest.totalFrames - 1 : scene.first + Math.min(scene.count - 1, Math.floor(sceneProgress * scene.count));
    // Speech uses the first 62% of this expanded beat; the last pose holds while
    // HELP REQUESTED appears. Pausing or reversing still owns the exact frame.
    if (!holding && scene.id === 'words') requested = scene.first
      + Math.min(scene.count - 1, Math.floor(interval(sceneProgress, 0, .62) * scene.count));
    // Settle the return shot promptly, then hold the calm closed-mouth pose.
    if (!holding && scene.id === 'waiting') requested = scene.first
      + Math.min(scene.count - 1, Math.floor(interval(sceneProgress, 0, .40) * scene.count));
    // Give the live DOM conversation a stable human pose; keys follow departure.
    if (!holding && scene.id === 'responder') requested = sceneProgress < .17
      ? 160 + Math.floor(interval(sceneProgress, 0, .17) * 15)
      : sceneProgress < .78 ? 175 + Math.floor(interval(sceneProgress, .17, .78) * 10)
      : 185 + Math.min(34, Math.floor(interval(sceneProgress, .78, 1) * 35));
    stage.dataset.scene = holding ? 'hold' : scene.id;
    stage.dataset.requestedFrame = String(requested);
    stage.dataset.progress = progress.toFixed(4);
    const reframe = ease(interval(progress, manifest.holdStart, manifest.reframeEnd));
    geometry(reframe);
    // A momentary loss of focus bridges the incident cuts, then resolves on the rug.
    // Scroll owns the envelope, so pausing or reversing never starts a timed effect.
    const visionPulse = (cut, before, after) => ease(interval(progress, cut - before, cut))
      * (1 - ease(interval(progress, cut, cut + after)));
    const imbalance = manifest.scenes.find(item => item.id === 'imbalance');
    const impact = manifest.scenes.find(item => item.id === 'impact');
    const checkin = manifest.scenes.find(item => item.id === 'checkin');
    const vision = Math.max(
      imbalance ? visionPulse(imbalance.start, .012, .018) * .4 : 0,
      impact ? visionPulse(impact.start, .016, .025) : 0,
      visionPulse(checkin.start, .012, .022) * .8);
    // The check-in voice radiates from WILi. Scroll owns each ripple's phase.
    const speaking = !holding && scene.id === 'checkin';
    const voiceEnvelope = speaking ? ease(interval(sceneProgress, .08, .22))
      * (1 - ease(interval(sceneProgress, .83, 1))) : 0;
    deviceSound.style.opacity = String(voiceEnvelope);
    deviceSound.querySelectorAll('circle').forEach((ring, i) => {
      const phase = (sceneProgress * 3 + i / 3) % 1;
      ring.setAttribute('cx', mobile ? '456' : '1037');
      ring.setAttribute('cy', mobile ? '638' : '399');
      ring.setAttribute('r', String((mobile ? 24 : 16) + phase * (mobile ? 85 : 55)));
      ring.style.opacity = String((1 - phase) * .45);
    });
    stage.style.setProperty('--incident-vision', vision);
    stage.style.setProperty('--incident-blur', `${vision * (mobile ? 7 : 9)}px`);
    // Acceptance is the first meaningful color change; reassurance carries it back.
    const connecting = scene.id === 'responder' && sceneProgress >= .61 && sceneProgress < .89
      ? Math.sin(interval(sceneProgress, .61, .89) * Math.PI) * .8
      : scene.id === 'waiting' && !holding ? Math.sin(sceneProgress * Math.PI) * .45 : 0;
    stage.style.setProperty('--bloom', connecting);
    captions.forEach(el => {
      const ids = el.dataset.scene.split(',');
      const first = manifest.scenes.find(item => item.id === ids[0]);
      const last = manifest.scenes.find(item => item.id === ids.at(-1));
      const visible = !holding && ids.includes(scene.id);
      const reveal = ease(interval(progress, first.start, first.start + .025));
      const fade = 1 - ease(interval(progress, last.end - .015, last.end));
      el.classList.toggle('is-visible', visible);
      el.style.opacity = visible ? String(reveal * fade) : '0';
      el.style.transform = `translateY(${(1 - reveal) * 12}px)`;
    });
    const answer = document.querySelector('[data-answer]');
    const words = manifest.scenes.find(item => item.id === 'words');
    const answerReveal = ease(interval(interval(progress, words.start, words.end), .015, .10));
    answer.style.opacity = answerReveal;
    const wordsProgress = interval(progress, words.start, words.end);
    const contextReveal = ease(interval(wordsProgress, .64, .76));
    const prompt = document.querySelector('.checkin-caption > p');
    const promptFade = scene.id === 'words' ? ease(interval(wordsProgress, 0, .32)) : 0;
    prompt.style.opacity = String(1 - promptFade);
    prompt.style.maxHeight = `${(1 - promptFade) * 140}px`;
    prompt.style.overflow = 'hidden';
    prompt.style.marginTop = `${(1 - promptFade) * (mobile ? 13 : 25)}px`;
    prompt.style.marginBottom = `${(1 - promptFade) * (mobile ? 18 : 35)}px`;
    answer.style.maxHeight = `${answerReveal * (1 - contextReveal) * 155}px`;
    answer.style.opacity = String(answerReveal * (1 - contextReveal * .55));
    answer.style.transform = `translateY(${-contextReveal * 6}px) scale(${1 - contextReveal * .04})`;
    const context = document.querySelector('[data-context]');
    context.style.opacity = contextReveal;
    context.style.maxHeight = `${contextReveal * 140}px`;
    wave.querySelectorAll('i').forEach((bar, i) => {
      bar.style.height = `${4 + (Math.sin(i * 1.7 + interval(wordsProgress, 0, .62) * 18) + 1) * Math.sin((i + 1) / 25 * Math.PI) * 12}px`;
    });
    const responder = manifest.scenes.find(item => item.id === 'responder');
    const responseProgress = interval(progress, responder.start, responder.end);
    coordination(responseProgress, scene.id === 'responder' && !holding);
    stage.style.setProperty('--phone-focus', scene.id === 'responder' && !holding
      ? ease(interval(responseProgress, .025, .17)) * (1 - ease(interval(responseProgress, .89, 1))) : 0);
    document.getElementById('story-progress-bar').style.transform = `scaleX(${progress})`;
    // No interpolation or elapsed-time playhead: a stopped scroll owns this exact still.
    load(requested, true);
    if (decoded.has(requested)) draw(requested);
    else {
      const available = [...decoded.keys()].filter(index => index >= scene.first && index < scene.first + scene.count);
      if (available.length) draw(available.reduce((a, b) => Math.abs(a - requested) < Math.abs(b - requested) ? a : b));
    }
    for (let offset = 1; offset <= prefetchRadius; offset++) {
      for (const index of [requested + offset, requested - offset]) {
        if (index >= scene.first && index < scene.first + scene.count) load(index, true);
      }
    }
    evict(); preloadBackground();
  }
  function staticMode() {
    enabled = false;
    body.classList.remove('sequence-ready');
    stage.removeAttribute('style');
    deviceSound.style.opacity = '0';
    canvas.classList.remove('has-frame');
    poster.src = mobile ? '/media/story/mobile/frame_0259.webp' : '/media/story/held.webp';
    captions.forEach(el => { el.classList.remove('is-visible'); el.style.opacity = '0'; });
    poster.alt = 'An illustrated patient sits awake beside his sofa, listening to a reassuring reply.';
    gate(nav, true); gate(hero, true); gate(utility, false);
    phone.style.opacity = '0';
    if (renderId) cancelAnimationFrame(renderId);
    renderId = 0;
    decoded.forEach(bitmap => bitmap.close()); decoded.clear(); drawn = -1;
  }
  function sizeCanvas() {
    const source = manifest.renditions[rendition], ratio = source.width / source.height;
    const coverWidth = Math.max(innerWidth, innerHeight * ratio);
    const width = Math.min(source.width, Math.round(coverWidth * Math.min(devicePixelRatio || 1, 2)));
    if (canvas.width === width) return;
    canvas.width = width;
    canvas.height = Math.round(width / ratio);
    drawn = -1;
  }
  async function start() {
    if (reduce.matches || !ctx || !window.createImageBitmap) { staticMode(); return; }
    enabled = true;
    body.classList.add('sequence-ready');
    geometry(0);
    poster.src = mobile ? '/media/story/mobile/frame_0000.webp' : '/media/story/opening.webp';
    poster.alt = 'An illustrated story of a patient at home and a responder preparing to help.';
    try {
      if (!manifest) {
        const response = await fetch('/media/story/manifest.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error('Sequence unavailable');
        manifest = await response.json();
        // A cached revision-3 manifest remains usable while the new assets roll out.
        const previousIds = ['ordinary', 'imbalance', 'checkin', 'words', 'responder', 'waiting'];
        manifest.scenes.forEach((scene, index) => { scene.id ||= previousIds[index]; });
        manifest.reframeEnd ||= .96;
      }
      if (reduce.matches) return;
      sizeCanvas();
      manifest.scenes.forEach(scene => pinned.add(scene.first));
      pinned.add(manifest.totalFrames - 1);
      // Intentional scene compositions are fetched first; remaining compressed frames preload at idle.
      await load(0, true);
      if (!decoded.has(0)) { staticMode(); return; }
      draw(0); schedule();
      for (const index of [...pinned].slice(1)) load(index, true);
      preloadBackground();
      if (location.hash && location.hash !== '#story') {
        document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    } catch { staticMode(); }
  }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', () => { if (enabled && manifest) sizeCanvas(); schedule(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { schedule(); preloadBackground(); } });
  reduce.addEventListener('change', () => reduce.matches ? staticMode() : start());
  function initSignals() {
    const section = document.querySelector('.signal-scroll'), pin = section.querySelector('.signal-pin');
    const plot = document.getElementById('signal-canvas'), stills = document.getElementById('signal-static');
    const chapters = [...section.querySelectorAll('[data-signal-chapter]')];
    const families = [
      { name: 'A fall', unit: 'g', x: 'Time (seconds)', y: 'Acceleration (g)', duration: 12, scope: 'Synthetic sketch · fall pattern', detail: 'A short window. A sudden change.' },
      { name: 'Seizure-like motion', unit: 'g', x: 'Time (seconds)', y: 'Acceleration (g)', duration: 8, scope: 'Unusual movement → patient check-in', detail: 'A different rhythm. A closer look.' },
      { name: 'Gait over time', unit: '%', x: 'Time (days)', y: 'Step interval variability (%)', duration: 28, scope: 'Synthetic sketch · exploratory gait trend', detail: 'Small changes become visible over time.' }
    ];
    let chartRequest = 0;
    const normal = t => 1 + Math.sin(t * 89) * .012 + Math.sin(t * 143) * .009;
    function value(type, t) {
      if (type === 0) return normal(t) + .88 * Math.exp(-Math.pow((t - .61) / .013, 2)) - .11 * Math.exp(-Math.pow((t - .66) / .03, 2));
      if (type === 1) return normal(t) + ease(interval(t, .38, .47)) * (.30 * Math.sin(t * 210) + .065 * Math.sin(t * 427));
      return 5 + Math.sin(t * 65) * .55 + Math.sin(t * 111) * .25 + 20 * Math.pow(interval(t, .34, 1), 1.35);
    }
    function drawTrace(target, type, at) {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const ratio = Math.min(devicePixelRatio || 1, 2), width = rect.width, height = rect.height;
      if (target.width !== Math.round(width * ratio) || target.height !== Math.round(height * ratio)) {
        target.width = Math.round(width * ratio); target.height = Math.round(height * ratio);
      }
      const c = target.getContext('2d'); if (!c) return;
      c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, width, height);
      const left = width < 500 ? 42 : 58, right = width - 18, top = 20, bottom = height - 36;
      const expansion = ease(interval(at, .28, .58));
      const min = type === 2 ? 0 : type === 1 ? .85 - expansion * .4 : .85 - expansion * .1;
      const max = type === 2 ? 10 + expansion * 20 : type === 1 ? 1.15 + expansion * .4 : 1.15 + expansion * .85;
      const px = n => left + n * (right - left), py = v => bottom - (v - min) / (max - min) * (bottom - top);
      const end = .18 + .82 * at;
      c.lineWidth = 1; c.strokeStyle = '#e5e4df'; c.fillStyle = '#83847d'; c.font = '11px Aspekta, Arial, sans-serif';
      for (let i = 0; i <= 4; i++) {
        const v = min + (max - min) * i / 4, y = py(v);
        c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
        c.textAlign = 'right'; c.fillText(type === 2 ? v.toFixed(0) : v.toFixed(2), left - 10, y + 4);
      }
      c.textAlign = 'center';
      for (let i = 0; i <= 4; i++) c.fillText(String(families[type].duration * i / 4), px(i / 4), height - 10);
      const gradient = c.createLinearGradient(left, 0, right, 0); gradient.addColorStop(0, '#8ca3a9'); gradient.addColorStop(.4, '#468ab1'); gradient.addColorStop(1, '#126dd8');
      c.save(); c.beginPath(); c.rect(left, top - 5, right - left + 4, bottom - top + 10); c.clip();
      c.beginPath(); c.moveTo(px(0), py(value(type, 0)));
      for (let i = 1; i <= 500; i++) { const t = end * i / 500; c.lineTo(px(t), py(value(type, t))); }
      c.lineWidth = width < 500 ? 2 : 2.4; c.strokeStyle = gradient; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke();
      const current = value(type, end), x = px(end), y = py(current);
      c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.lineWidth = 1; c.strokeStyle = '#126dd824'; c.stroke();
      c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fillStyle = '#126dd8'; c.fill(); c.restore();
      return { current, min, max };
    }
    function renderSignals() {
      chartRequest = 0;
      if (reduce.matches) {
        section.classList.add('is-static'); stills.hidden = false;
        if (!stills.children.length) families.forEach((family, index) => {
          const figure = document.createElement('figure'), title = document.createElement('figcaption'), drawing = document.createElement('canvas'), label = document.createElement('p');
          title.textContent = family.name; drawing.setAttribute('role', 'img'); drawing.setAttribute('aria-label', `${family.name}: ${family.y} against ${family.x}.`);
          drawing.dataset.family = index; label.textContent = `${family.y} / ${family.x} · ${family.scope}`;
          figure.append(title, drawing, label); stills.append(figure);
        });
        stills.querySelectorAll('canvas').forEach(target => drawTrace(target, Number(target.dataset.family), 1)); return;
      }
      section.classList.remove('is-static'); stills.hidden = true;
      const rect = section.getBoundingClientRect();
      const p = clamp(-rect.top / Math.max(1, section.offsetHeight - pin.offsetHeight));
      const phase = Math.min(2, Math.floor(p * 3)), local = p === 1 ? 1 : (p * 3) - phase;
      const result = drawTrace(plot, phase, local); if (!result) return;
      section.dataset.phase = String(phase); section.dataset.progress = p.toFixed(4);
      section.dataset.scale = `${result.min.toFixed(2)}:${result.max.toFixed(2)}`;
      chapters.forEach((chapter, index) => chapter.classList.toggle('active', index === phase));
      const family = families[phase], evolved = local > .53;
      document.getElementById('signal-pattern').textContent = !evolved ? 'Normal movement' : phase === 0 ? 'A sudden spike' : phase === 1 ? 'Rhythmic movement' : 'Increasing variability';
      document.getElementById('signal-value').textContent = result.current.toFixed(phase === 2 ? 1 : 2);
      document.getElementById('signal-unit').textContent = family.unit;
      document.getElementById('signal-x-label').textContent = family.x;
      document.getElementById('signal-y-label').textContent = family.y;
      document.getElementById('signal-scope').textContent = family.scope;
      document.getElementById('signal-detail').textContent = family.detail;
    }
    const chartSchedule = () => { if (!chartRequest) chartRequest = requestAnimationFrame(renderSignals); };
    addEventListener('scroll', chartSchedule, { passive: true }); addEventListener('resize', chartSchedule, { passive: true });
    reduce.addEventListener('change', chartSchedule); document.fonts?.ready.then(chartSchedule);
    renderSignals();
  }
  function initCareConversation() {
    const section = document.getElementById('care-conversation');
    if (!section) return;
    const phones = [...section.querySelectorAll('.care-phone')];
    const lanes = phones.map((phone, index) => ({ phone, viewport: phone.querySelector('.care-message-viewport'),
      thread: phone.querySelector('.care-phone-messages, .care-team-thread'), typing: phone.querySelector('.care-typing'),
      starts: index === 0 ? [1.0, 3.0, 11.7] : [4.4, 5.4, 7.0, 8.3, 10.1],
      windows: index === 0 ? [[.2, 1], [10.9, 11.7]] : [[3.7, 4.4], [6.3, 7], [7.7, 8.3], [9.3, 10.1]] }));
    let visible = false, animation = 0, previous = null, elapsed = 0;
    function paint(seconds, staticView = false) {
      const reset = staticView ? 1 : 1 - ease(interval(seconds, 14.4, 15.1));
      lanes.forEach(lane => {
        let shift = 0;
        [...lane.thread.children].forEach((message, index) => {
          const start = lane.starts[index], reveal = staticView ? 1 : ease(interval(seconds, start, start + .42));
          const spring = staticView ? 0 : Math.sin(interval(seconds, start, start + .62) * Math.PI) * .035;
          const outgoing = message.classList.contains('care-patient-text') || message.classList.contains('care-team-agent');
          message.style.opacity = String(reveal * reset);
          message.style.transform = `translate(${(1 - reveal) * (outgoing ? 18 : -16)}px, ${(1 - reveal) * 16}px) scale(${.82 + reveal * .18 + spring})`;
          message.style.filter = `blur(${(1 - reveal) * 4 + (1 - reset) * 3}px)`;
          if (reveal > 0) shift = Math.max(shift, (message.offsetTop + message.offsetHeight - lane.viewport.clientHeight + 10) * reveal);
        });
        lane.viewport.style.overflowY = staticView ? 'auto' : 'hidden';
        lane.thread.style.transform = staticView ? 'none' : `translateY(${-Math.max(0, shift)}px)`;
        const typing = !staticView && lane.windows.some(([start, end]) => seconds >= start && seconds < end);
        lane.typing.style.opacity = typing ? '1' : '0';
        [...lane.typing.children].forEach((dot, index) => dot.style.transform = typing ? `translateY(${Math.sin(seconds * 9 - index * 1.2) * 2}px)` : '');
      });
      section.dataset.conversationTime = seconds.toFixed(2);
    }
    function frame(now) {
      animation = 0;
      if (reduce.matches) { previous = null; paint(0, true); return; }
      if (!visible || document.hidden) { previous = null; return; }
      if (previous !== null) elapsed += Math.min(.08, (now - previous) / 1000);
      previous = now; paint(elapsed % 16); animation = requestAnimationFrame(frame);
    }
    function resume() {
      if (reduce.matches) { if (animation) cancelAnimationFrame(animation); animation = 0; previous = null; paint(0, true); }
      else if (visible && !document.hidden && !animation) { previous = null; animation = requestAnimationFrame(frame); }
    }
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; resume(); }, { threshold: 0 }).observe(section);
    document.addEventListener('visibilitychange', resume);
    reduce.addEventListener('change', resume);
    paint(0, true); resume();
  }
  initCareConversation();
  initSignals();
  start();
})();
