export interface OfflineRecord {
  key: string;
  body: Blob;
  savedAt: number;
}

export interface OfflineStore {
  get(key: string): Promise<OfflineRecord | undefined>;
  put(record: OfflineRecord): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

const MAX_ENTRIES = 100;
const MAX_BYTES = 20 * 1024 * 1024;
const STORE_NAME = 'responses';

/** A separate database: clearing offline content never touches vault keys. */
export function createOfflineStore(factory: IDBFactory = indexedDB): OfflineStore {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('flaxia-offline-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
    return database;
  };
  async function write(action: (store: IDBObjectStore) => void): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
      action(transaction.objectStore(STORE_NAME));
    });
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result as OfflineRecord | undefined);
        request.onerror = () => reject(request.error);
      });
    },
    put(record) {
      return write((store) => {
        store.put(record);
        const request = store.getAll();
        request.onsuccess = () => {
          const records = request.result as OfflineRecord[];
          let bytes = records.reduce((total, item) => total + item.body.size, 0);
          let count = records.length;
          for (const item of records.sort((a, b) => a.savedAt - b.savedAt)) {
            if (count <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
            if (item.key === 'identity') continue;
            store.delete(item.key);
            bytes -= item.body.size;
            count--;
          }
        };
      });
    },
    delete: (key) => write((store) => store.delete(key)),
    clear: () => write((store) => store.clear()),
  };
}
