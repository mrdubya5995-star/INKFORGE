// IndexedDB wrapper for InkForge's local library.
const InkDB = (() => {
  const DB_NAME = 'InkForgeDB';
  const DB_VERSION = 1;
  const STORE = 'books';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('favorite', 'favorite');
          store.createIndex('finished', 'finished');
          store.createIndex('addedDate', 'addedDate');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode) {
    const db = await open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async function addBook(book) {
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.add(book);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllBooks() {
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getBook(id) {
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function updateBook(id, changes) {
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const book = getReq.result;
        if (!book) return resolve(null);
        Object.assign(book, changes);
        const putReq = store.put(book);
        putReq.onsuccess = () => resolve(book);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function deleteBook(id) {
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteBooks(ids) {
    const store = await tx('readwrite');
    await Promise.all(ids.map(id => new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    })));
  }

  async function clearAll() {
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  return { addBook, getAllBooks, getBook, updateBook, deleteBook, deleteBooks, clearAll };
})();
