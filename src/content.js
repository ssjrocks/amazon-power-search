// Adds a "Power search" button on Amazon search pages that opens the
// extension's results page for the same query.
(() => {
  const query = new URLSearchParams(location.search).get('k');
  if (!query || document.getElementById('aps-button')) return;
  const domain = location.hostname.replace(/^www\.amazon\./, '');
  const b = document.createElement('button');
  b.id = 'aps-button';
  b.textContent = 'Power search';
  b.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 16px;border:0;border-radius:8px;' +
    'background:#1a73e8;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px #0005';
  b.addEventListener('click', () => browser.runtime.sendMessage({ type: 'open-results', query, domain }));
  document.body.appendChild(b);
})();
