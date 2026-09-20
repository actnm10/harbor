'use strict';

(() => {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try { const saved = localStorage.getItem('harbor-theme'); if (saved === 'dark' || saved === 'light') preference = saved; } catch { /* The device theme still works when storage is unavailable. */ }
  function apply() {
    const dark = preference ? preference === 'dark' : systemTheme.matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141b27' : '#f5f6f2');
    document.querySelectorAll('.theme-toggle').forEach(button => {
      button.setAttribute('aria-pressed', String(dark));
      button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelectorAll('.theme-toggle').forEach(button => button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('harbor-theme', preference); } catch { /* Keep the preference for this page. */ }
      apply();
    }));
  });
  systemTheme.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== 'harbor-theme') return;
    preference = ['dark', 'light'].includes(event.newValue) ? event.newValue : null;
    apply();
  });
})();
