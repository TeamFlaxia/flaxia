import type { Post } from '../types/post.ts';

export interface GameFile {
  path: string;
  bytes: ArrayBuffer;
}
export interface DownloadedGame {
  id: string;
  owner: string;
  post: Post;
  revision: string;
  savedAt: number;
  files: GameFile[];
  size: number;
}
export interface OfflineGameStore {
  activate(owner: string | null): Promise<void>;
  list(owner: string): Promise<Omit<DownloadedGame, 'files'>[]>;
  get(id: string, owner: string): Promise<DownloadedGame | undefined>;
  put(game: DownloadedGame, valid: () => boolean): Promise<void>;
  delete(id: string): Promise<void>;
}

const MAX_BYTES = 250 * 1024 * 1024;

/** Bookmarked downloads are never evicted to make room for transient TL reads. */
export function createOfflineGameStore(factory: IDBFactory = indexedDB): OfflineGameStore {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('flaxia-downloaded-games-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('games', { keyPath: 'id' });
        request.result.createObjectStore('account');
        request.result.createObjectStore('files');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
    return database;
  };
  async function write(action: (tx: IDBTransaction) => void) {
    const db = await open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['games', 'account', 'files'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Download cancelled'));
      tx.onerror = () => reject(tx.error);
      action(tx);
    });
  }
  return {
    activate(owner) {
      return write((tx) => {
        const account = tx.objectStore('account');
        const request = account.get('owner');
        request.onsuccess = () => {
          if (owner === null || request.result !== owner) {
            tx.objectStore('games').clear();
            tx.objectStore('files').clear();
          }
          account.put(owner, 'owner');
        };
      });
    },
    async get(id, owner) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['games', 'files']);
        const game = tx.objectStore('games').get(id);
        const files = tx.objectStore('files').get(id);
        tx.oncomplete = () =>
          resolve(
            game.result?.owner === owner && files.result
              ? ({ ...game.result, files: files.result } as DownloadedGame)
              : undefined,
          );
        tx.onerror = () => reject(tx.error);
      });
    },
    async list(owner) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('games').objectStore('games').getAll();
        request.onsuccess = () => resolve((request.result as DownloadedGame[]).filter((game) => game.owner === owner));
        request.onerror = () => reject(request.error);
      });
    },
    put(game, valid) {
      return write((tx) => {
        const account = tx.objectStore('account').get('owner');
        account.onsuccess = () => {
          if (account.result !== game.owner || !valid()) return tx.abort();
          const games = tx.objectStore('games');
          const request = games.getAll();
          request.onsuccess = () => {
            const size = (request.result as DownloadedGame[])
              .filter((item) => item.id !== game.id)
              .reduce((total, item) => total + item.size, game.size);
            if (size > MAX_BYTES || !valid()) return tx.abort();
            const { files, ...summary } = game;
            games.put(summary);
            tx.objectStore('files').put(files, game.id);
          };
        };
      });
    },
    delete: (id) =>
      write((tx) => {
        tx.objectStore('games').delete(id);
        tx.objectStore('files').delete(id);
      }),
  };
}
