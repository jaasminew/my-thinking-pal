// H1 — Local (signed-out) persistence layer for Project Memory.
//
// Dumb IndexedDB storage only: no AI, no retrieval, no title/description
// generation. Files are keyed by `id` and indexed by `(scopeKind, scopeId)` so
// scope queries are cheap; blobs and extracted text live in IndexedDB — never
// localStorage. Instructions are keyed by `(scopeKind, scopeId)` exactly as the
// LocalStore interface specifies.
//
// Caps are NOT applied here — this layer stores whatever it is given. Extraction
// (H2/H7) and retrieval (Lead-owned) own the char/token caps.

import type {
  CreateLocalStore,
  LocalStore,
  ProjectInstructions,
  ProjectMemoryFile,
  ProjectMemoryScope
} from './types'
import { scopeKey } from './types'

const DEFAULT_DB_NAME = 'thinking-pal-project-memory'
const DB_VERSION = 1

const STORE_FILES = 'files'
const STORE_TEXTS = 'texts'
const STORE_BLOBS = 'blobs'
const STORE_INSTRUCTIONS = 'instructions'
const INDEX_BY_SCOPE = 'byScope'

/** An instructions record carrying its scope compound key. */
type InstructionRecord = ProjectInstructions & {
  scopeKind: string
  scopeId: string
  updatedAt: string
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const files = db.createObjectStore(STORE_FILES, { keyPath: 'id' })
        files.createIndex(INDEX_BY_SCOPE, ['scopeKind', 'scopeId'], { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_TEXTS)) {
        db.createObjectStore(STORE_TEXTS, { keyPath: 'fileId' })
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'fileId' })
      }
      if (!db.objectStoreNames.contains(STORE_INSTRUCTIONS)) {
        db.createObjectStore(STORE_INSTRUCTIONS, { keyPath: ['scopeKind', 'scopeId'] })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Resolve a single IDBRequest into a promise. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Resolve when a readwrite transaction has committed. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export const createLocalStore: CreateLocalStore = (dbName = DEFAULT_DB_NAME) => {
  let dbPromise: Promise<IDBDatabase> | null = null
  const db = () => (dbPromise ??= openDb(dbName))

  const store: LocalStore = {
    async createFile(meta) {
      const d = await db()
      const tx = d.transaction(STORE_FILES, 'readwrite')
      await request(tx.objectStore(STORE_FILES).put(meta))
      await committed(tx)
    },

    async listFiles(scope) {
      const { scopeKind, scopeId } = scopeKey(scope)
      const d = await db()
      const tx = d.transaction(STORE_FILES, 'readonly')
      const index = tx.objectStore(STORE_FILES).index(INDEX_BY_SCOPE)
      const rows = (await request(
        index.getAll(IDBKeyRange.only([scopeKind, scopeId]))
      )) as ProjectMemoryFile[]
      // Newest first (createdAt desc); stable for equal timestamps.
      return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    },

    async getFile(id) {
      const d = await db()
      const tx = d.transaction(STORE_FILES, 'readonly')
      const row = (await request(tx.objectStore(STORE_FILES).get(id))) as
        | ProjectMemoryFile
        | undefined
      return row ?? undefined
    },

    async updateFile(meta) {
      const d = await db()
      const tx = d.transaction(STORE_FILES, 'readwrite')
      await request(tx.objectStore(STORE_FILES).put(meta))
      await committed(tx)
    },

    async deleteFile(id) {
      const d = await db()
      const tx = d.transaction([STORE_FILES, STORE_TEXTS, STORE_BLOBS], 'readwrite')
      tx.objectStore(STORE_FILES).delete(id)
      tx.objectStore(STORE_TEXTS).delete(id)
      tx.objectStore(STORE_BLOBS).delete(id)
      await committed(tx)
    },

    async putText(fileId, text) {
      const d = await db()
      const tx = d.transaction(STORE_TEXTS, 'readwrite')
      await request(tx.objectStore(STORE_TEXTS).put({ fileId, text }))
      await committed(tx)
    },

    async getText(fileId) {
      const d = await db()
      const tx = d.transaction(STORE_TEXTS, 'readonly')
      const row = (await request(tx.objectStore(STORE_TEXTS).get(fileId))) as
        | { text: string }
        | undefined
      return row?.text
    },

    async putBlob(fileId, blob) {
      const d = await db()
      const tx = d.transaction(STORE_BLOBS, 'readwrite')
      await request(tx.objectStore(STORE_BLOBS).put({ fileId, blob }))
      await committed(tx)
    },

    async getBlob(fileId) {
      const d = await db()
      const tx = d.transaction(STORE_BLOBS, 'readonly')
      const row = (await request(tx.objectStore(STORE_BLOBS).get(fileId))) as
        | { blob: Blob }
        | undefined
      return row?.blob
    },

    async getInstructions(scope) {
      const { scopeKind, scopeId } = scopeKey(scope)
      const d = await db()
      const tx = d.transaction(STORE_INSTRUCTIONS, 'readonly')
      const row = (await request(
        tx.objectStore(STORE_INSTRUCTIONS).get([scopeKind, scopeId])
      )) as InstructionRecord | undefined
      if (!row) return undefined
      const { transcriptionSummary, coCreation, aiCommand } = row
      return { transcriptionSummary, coCreation, aiCommand }
    },

    async putInstructions(scope, ins) {
      const { scopeKind, scopeId } = scopeKey(scope)
      const d = await db()
      const tx = d.transaction(STORE_INSTRUCTIONS, 'readwrite')
      await request(
        tx.objectStore(STORE_INSTRUCTIONS).put({
          scopeKind,
          scopeId,
          ...ins,
          updatedAt: new Date().toISOString()
        } as InstructionRecord)
      )
      await committed(tx)
    },

    async deleteScope(scope) {
      const { scopeKind, scopeId } = scopeKey(scope)
      const d = await db()
      const tx = d.transaction(
        [STORE_FILES, STORE_TEXTS, STORE_BLOBS, STORE_INSTRUCTIONS],
        'readwrite'
      )
      const filesStore = tx.objectStore(STORE_FILES)
      const textsStore = tx.objectStore(STORE_TEXTS)
      const blobsStore = tx.objectStore(STORE_BLOBS)
      // Cascade: gather every file row in scope, then drop its text + blob.
      const index = filesStore.index(INDEX_BY_SCOPE)
      const rows = (await request(
        index.getAll(IDBKeyRange.only([scopeKind, scopeId]))
      )) as ProjectMemoryFile[]
      for (const row of rows) {
        filesStore.delete(row.id)
        textsStore.delete(row.id)
        blobsStore.delete(row.id)
      }
      tx.objectStore(STORE_INSTRUCTIONS).delete([scopeKind, scopeId])
      await committed(tx)
    }
  }

  return store
}
