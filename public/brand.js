const motion = {
  idle: ['A quiet presence.', 'The three forms sit together. A steady identity, without asking for attention.'],
  incident: ['A moment needs attention.', 'A warm pulse appears around the person. One restrained change makes the check-in noticeable.'],
  reaching: ['A thread reaches outward.', 'The supporting forms open up. Three small dots carry the pause while a connection is being made.'],
  responder: ['Someone joins the loop.', 'A cool accent enters the mark, and a thread draws the forms together. Presence becomes connection.'],
  resolution: ['The connection holds.', 'The activation spectrum settles across the whole mark. Movement gives way to a calm, complete composition.'],
};
const states = Object.keys(motion);
document.querySelectorAll('.motion-states button').forEach(button => {
  button.addEventListener('click', () => {
    const state = button.dataset.state;
    if (!motion[state]) return;
    document.querySelector('.motion-stage').dataset.state = state;
    document.querySelector('#motion-number').textContent = `0${states.indexOf(state) + 1} / 05`;
    document.querySelector('#motion-title').textContent = motion[state][0];
    document.querySelector('#motion-description').textContent = motion[state][1];
    document.querySelectorAll('.motion-states button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  });
});
let toastTimer;
document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const value = button.dataset.copy;
    const toast = document.querySelector('.copy-toast');
    try {
      await navigator.clipboard.writeText(value);
      toast.textContent = `${value} copied`;
    } catch {
      toast.textContent = `Color: ${value}`;
    }
    clearTimeout(toastTimer);
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
  });
});
