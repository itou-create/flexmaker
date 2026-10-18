// 取ってきた GTFS の zip を端末（IndexedDB）に置いておく。
//
// 都営バスのように 7MB を超える zip もあるので、開くたびに落とさない。
// 時刻表は事業者が更新するので、1日たったら取り直す（ODPT の開発者ガイドラインは
// 「更新の通知から1週間以内に反映」。1日なら十分）。
// IndexedDB が使えない環境（プライベートモード等）では黙って素通りする。

const DB_NAME = 'flexmaker-zips'
const STORE = 'zips'
export const ZIP_CACHE_MS = 24 * 3600 * 1000

interface Entry {
  key: string
  at: number
  buf: ArrayBuffer
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 置いてあって新しければ返す。無い・古い・読めないときは null */
export async function getCachedZip(key: string, maxAgeMs = ZIP_CACHE_MS): Promise<{ buf: ArrayBuffer; at: number } | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => {
        const e = req.result as Entry | undefined
        db.close()
        if (!e || Date.now() - e.at > maxAgeMs) return resolve(null)
        resolve({ buf: e.buf, at: e.at })
      }
      req.onerror = () => {
        db.close()
        resolve(null)
      }
    } catch {
      resolve(null)
    }
  })
}

export async function putCachedZip(key: string, buf: ArrayBuffer): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ key, at: Date.now(), buf } satisfies Entry)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        resolve()
      }
    } catch {
      resolve()
    }
  })
}
