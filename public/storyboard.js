(() => {
  const seq = document.querySelector('.motion-sequence');
  const stage = document.querySelector('.motion-stage');
  const shots = [...document.querySelectorAll('.shot-marker')];
  const titles = shots.map(s => s.querySelector('h2').textContent);
  const captions = [
    'Full-bleed film. No headline yet. A person, a room and everyday life.',
    'A cut before impact. Then a held shot, with the person awake on the floor.',
    'The wearable checks in. Exact words are composed as accessible website text.',
    'A blue signal crosses the frame through translucent spectrum layers.',
    'A human reply arrives. An iMessage panel becomes part of the scene.',
    'Departure, then reassurance. The wearer remains seated while help is on its way.',
    'The camera holds. Its frame shrinks and opens space for navigation and a headline.',
    'The film unpins into the page. The response loop and dashboard follow.'
  ];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = n => Math.max(0, Math.min(1, n));
  let scheduled = false;
  function draw() {
    scheduled = false;
    const rect = seq.getBoundingClientRect();
    const progress = clamp(-rect.top / (seq.offsetHeight - innerHeight));
    const shot = Math.min(7, Math.floor(progress * 8));
    const integration = clamp((progress - .70) / .20);
    stage.style.setProperty('--integration', reduce.matches ? (shot >= 6 ? 1 : 0) : integration);
    stage.dataset.shot = shot;
    document.querySelector('#board-frame').textContent = `${String(shot + 1).padStart(2,'0')} / 08`;
    document.querySelector('#board-caption').textContent = titles[shot];
    document.querySelector('#board-transition').textContent = captions[shot];
    document.querySelector('#board-progress').style.width = `${progress * 100}%`;
    document.querySelector('#board-percent').textContent = `${Math.round(progress * 100)}%`;
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(draw); } }
  addEventListener('scroll', schedule, { passive:true });
  addEventListener('resize', schedule);
  reduce.addEventListener('change', schedule);
  draw();
})();
