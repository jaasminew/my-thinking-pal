import { IndexeddbPersistence } from 'y-indexeddb'
import type * as Y from 'yjs'
import { openBoard, type BoardPersistence, type PlainNote } from '../../../packages/core/doc'
import type { KeywordNote } from './canvas-types'

// Browser glue between packages/core/doc (environment-free) and the frontend.
// Local-first persistence is IndexedDB via y-indexeddb — no ~5MB localStorage
// quota, so pasted/dropped images (data URLs) no longer risk silent save loss.
export function indexeddbPersistence(doc: Y.Doc, docId: string): BoardPersistence {
  const provider = new IndexeddbPersistence(`thinking-pal.board.${docId}`, doc)
  return {
    whenSynced: provider.whenSynced,
    destroy: () => provider.destroy()
  }
}

// PlainNote (CRDT projection) → KeywordNote (render model). Mirrors the original
// localStorage restore transform: transient flags reset, empty bullets and empty
// notes pruned — a restored note is settled content, not a live session.
export function hydrateNotes(plain: PlainNote[]): KeywordNote[] {
  return plain
    .map(
      (n) =>
        ({
          ...n,
          keywordEditing: false,
          aiRunning: false,
          items: n.items
            .filter((it) => it.kind !== 'bullet' || it.text.trim() !== '')
            .map((it) => (it.kind === 'bullet' ? { ...it, editing: false } : it))
        }) as KeywordNote
    )
    .filter((n) => n.keyword.trim() !== '' || n.items.length > 0)
}

// Stable per-space document id. The original ('default') space used the
// un-suffixed storage keys; keep it distinct from named spaces (`.<id>`).
export function boardDocId(storageSuffix: string): string {
  return storageSuffix ? storageSuffix.replace(/^\./, '') : 'default'
}

const DB_PREFIX = 'thinking-pal.board.'

// "Clear saved" wipes localStorage; boards live in IndexedDB, so they must be
// deleted too or cleared content would resurrect on reload. Best-effort across
// all spaces (enumerate + drop every board DB). No-op where unsupported.
export async function clearAllBoards(): Promise<void> {
  try {
    const anyIdb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
    const dbs = anyIdb.databases ? await anyIdb.databases() : []
    await Promise.all(
      dbs
        .map((d) => d.name)
        .filter((name): name is string => !!name && name.startsWith(DB_PREFIX))
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name)
              req.onsuccess = req.onerror = req.onblocked = () => resolve()
            })
        )
    )
  } catch {
    // storage disabled / unsupported — nothing to clear
  }
}

// Copy all board content (notes + images) from one local space to another.
// Opens both boards transiently, reads source content, writes to destination,
// then destroys the temporary providers — IndexedDB retains the data.
export async function copyBoard(sourceDocId: string, destDocId: string): Promise<void> {
  const src = openBoard(sourceDocId, { persistence: indexeddbPersistence })
  await src.whenSynced
  const content = src.content()
  await src.destroy()

  const dst = openBoard(destDocId, { persistence: indexeddbPersistence })
  await dst.whenSynced
  dst.replaceContent(content)
  await dst.destroy()
}

// Delete a single space's IndexedDB board data.
export async function deleteBoard(docId: string): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`${DB_PREFIX}${docId}`)
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
  } catch {
    // storage disabled / unsupported — nothing to delete
  }
}
