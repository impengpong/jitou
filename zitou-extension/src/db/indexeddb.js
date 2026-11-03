// IndexedDB 封装 — 简历图片 + 设置存储
const DB_NAME = 'zitou';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('resumes')) {
        db.createObjectStore('resumes', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode) {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}

// ── 简历图片 ──
async function saveResumeImages(files) {
  const store = await withStore('resumes', 'readwrite');
  await new Promise((resolve, reject) => {
    // 清空旧图片再存新的
    const clearReq = store.clear();
    clearReq.onsuccess = () => {
      let count = 0;
      for (const file of files) {
        const addReq = store.add({ blob: file, name: file.name, time: Date.now() });
        addReq.onsuccess = () => { count++; if (count === files.length) resolve(); };
        addReq.onerror = () => reject(addReq.error);
      }
      if (files.length === 0) resolve();
    };
    clearReq.onerror = () => reject(clearReq.error);
  });
}

async function getResumeImages() {
  const store = await withStore('resumes', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── 设置 ──
async function saveSetting(key, value) {
  const store = await withStore('settings', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getSetting(key) {
  const store = await withStore('settings', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function saveSettings(obj) {
  const store = await withStore('settings', 'readwrite');
  return new Promise((resolve, reject) => {
    let count = 0;
    const entries = Object.entries(obj);
    if (entries.length === 0) resolve();
    for (const [key, value] of entries) {
      const req = store.put({ key, value });
      req.onsuccess = () => { count++; if (count === entries.length) resolve(); };
      req.onerror = () => reject(req.error);
    }
  });
}
