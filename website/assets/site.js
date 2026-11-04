document.documentElement.classList.add('js');
const revealTargets = document.querySelectorAll('.workflow-section, .context-section, .readiness-section, .start-section, .requirements-bar');
revealTargets.forEach(el => el.classList.add('reveal'));
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); }
  }), { threshold: 0.12 });
  revealTargets.forEach(el => revealObserver.observe(el));
} else {
  revealTargets.forEach(el => el.classList.add('is-visible'));
}

const screens = {
  network: { file: './assets/product-network.png', alt: 'Actual MemoryNet network of original public Vercel repositories and pull request sources.', caption: 'Actual app. Original Vercel repository and PR evidence.' },
  work: { file: './assets/product-work.png', alt: 'Actual review queue of candidates imported from Vercel pull requests.', caption: 'Actual app. Real Vercel PR evidence. Candidates remain pending review.' },
  decision: { file: './assets/product-decision.png', alt: 'Actual source browser showing original Next.js files at a GitHub-verified commit.', caption: 'Actual app. Original Next.js source and commit provenance.' },
};

document.querySelectorAll('[data-screen]').forEach(button => {
  button.addEventListener('click', () => {
    const screen = screens[button.dataset.screen];
    if (!screen) return;
    const image = document.querySelector('#screen-image');
    image.src = screen.file;
    image.alt = screen.alt;
    document.querySelector('#screen-caption').textContent = screen.caption;
    const expanded = document.querySelector('#expand-screen');
    expanded.href = screen.file;
    expanded.setAttribute('aria-label', `Open full-size ${button.textContent.toLowerCase()} screenshot`);
    document.querySelectorAll('[data-screen]').forEach(other => {
      other.setAttribute('aria-pressed', String(other === button));
      other.closest('.screen-choice')?.classList.toggle('is-active', other === button);
    });
  });
});

document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    const feedback = button.parentElement.querySelector('[role="status"]');
    if (!code || !feedback) return;
    button.setAttribute('aria-busy', 'true');
    try {
      await navigator.clipboard.writeText(code.textContent);
      feedback.textContent = 'Copied.';
    } catch {
      feedback.textContent = 'Copy unavailable. Select the commands below to copy them.';
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
});


document.addEventListener('click', event => {
  const link = event.target.closest('[data-show-screen]');
  if (link && screens[link.dataset.showScreen]) document.querySelector(`[data-screen="${link.dataset.showScreen}"]`)?.click();
});

document.querySelectorAll('[data-tabs]').forEach(group => {
  const buttons = group.querySelectorAll('[data-tab-btn]');
  const panels = group.querySelectorAll('[data-tab-panel]');
  buttons.forEach(button => button.addEventListener('click', () => {
    buttons.forEach(other => other.setAttribute('aria-selected', String(other === button)));
    panels.forEach(panel => { panel.hidden = panel.dataset.tabPanel !== button.dataset.tabBtn; });
  }));
});

const menuToggle = document.querySelector('.nav-toggle');
const mainNavigation = document.querySelector('#main-navigation');
if (menuToggle && mainNavigation) {
  menuToggle.hidden = false;
  menuToggle.closest('header').classList.add('nav-enhanced');
  const closeMenu = () => menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.addEventListener('click', () => menuToggle.setAttribute('aria-expanded', String(menuToggle.getAttribute('aria-expanded') !== 'true')));
  mainNavigation.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') { closeMenu(); menuToggle.focus(); }
  });
  document.addEventListener('click', event => { if (!menuToggle.closest('header').contains(event.target)) closeMenu(); });
}

window.hallmarkSlots = replacements => {
  for (const [name, value] of Object.entries(replacements)) {
    const slot = [...document.querySelectorAll('[data-slot]')].find(item => item.dataset.slot === name);
    if (!slot) continue;
    const image = new Image();
    image.src = typeof value === 'string' ? value : value.src;
    image.alt = (typeof value === 'object' && value.alt) || slot.dataset.alt || '';
    slot.querySelectorAll(':scope > img').forEach(previous => previous.remove());
    slot.prepend(image);
  }
};
