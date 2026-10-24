// Tiny IndexedDB wrapper: one record per (domain, query) scan.
const open = () => new Promise((resolve, reject) => {
  const r = indexedDB.open('amazon-power-search', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('scans', { keyPath: 'key' });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const run = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('scans', mode);
    const req = fn(tx.objectStore('scans'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
};

export const scanKey = (domain, query) => `${domain}|${query.trim().toLowerCase()}`;
export const saveScan = (scan) => run('readwrite', (s) => s.put({ ...scan, updated: Date.now() }));
export const loadScan = (key) => run('readonly', (s) => s.get(key));
export const listScans = () => run('readonly', (s) => s.getAll());
export const deleteScan = (key) => run('readwrite', (s) => s.delete(key));
