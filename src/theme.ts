const preference = matchMedia('(prefers-color-scheme: dark)');
const key = 'paper-theme';

export function applyTheme() {
  const saved = localStorage.getItem(key);
  const dark = saved ? saved === 'dark' : preference.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  return dark;
}

export function watchTheme(update: () => void = applyTheme) {
  update();
  preference.addEventListener('change', update);
  window.addEventListener('storage', event => { if (event.key === key) update(); });
}

export function toggleTheme() {
  localStorage.setItem(key, document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}
