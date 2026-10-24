const open = (q = '', domain = '') => {
  const u = new URL(browser.runtime.getURL('src/results.html'));
  if (q) u.searchParams.set('q', q);
  if (domain) u.searchParams.set('d', domain);
  return browser.tabs.create({ url: u.toString() });
};

browser.browserAction.onClicked.addListener(() => open());
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'open-results') return open(msg.query, msg.domain);
});
