// useProjectMemory (M1/M5, Lead-owned): the app-facing hook for two-level
// Project Memory. Every canvas has its OWN bucket, and a canvas nested inside
// a project ALSO reads the project's shared bucket (merged semantics):
//   - AI instructions merge project-first, canvas-appended;
//   - retrieval builds ONE catalog from both buckets' files.
// Each bucket binds to a storage backend (helper's IndexedDB LocalStore when
// signed out, MemoryClient when signed in) and exposes upload/delete/retry/
// instructions. All AI (title/description, Stage-A selection) runs in the
// browser with the user's own provider — the server is a dumb store.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExtractTextBrowser,
  LocalStore,
  MemoryBucket,
  MemoryClient,
  ProjectInstructions,
  ProjectMemoryContext,
  ProjectMemoryFile,
  ProjectMemoryScope,
  UseProjectMemoryResult
} from '../../../services/project-memory/types'
import {
  EMPTY_INSTRUCTIONS,
  PM_MAX_UPLOAD_BYTES,
  PM_TEXT_CHAR_CAP,
  mergeInstructions,
  scopeKey
} from '../../../services/project-memory/types'
import { resolveMemoryScopes, scopeDisplayName, type ScopeTreeNode } from '../../../services/project-memory/scope'
import {
  SelectionCache,
  buildProjectMemoryContext,
  defaultStageACall,
  isImageFile,
  type StageACall
} from '../../../services/project-memory/retrieve'
import { defaultDescribeFile, fallbackDescription, type DescribeFile } from '../../../services/project-memory/describe'
import {
  blobToDataUrl,
  defaultDescribeImage,
  fallbackImageDescription,
  type DescribeImage
} from '../../../services/project-memory/vision'

export interface ProjectMemoryDeps {
  /** Helper H1 output; null until wired (feature inert). */
  localStore: LocalStore | null
  /** Helper H4 output; non-null only when signed in — takes priority over localStore. */
  client: MemoryClient | null
  /** Helper H2 output; null until wired. */
  extractText: ExtractTextBrowser | null
  /** AI seams (default: user's active provider from settings). Injectable for tests. */
  describeFile?: DescribeFile
  /** Vision seam for image uploads (title/description/OCR). Injectable for tests. */
  describeImage?: DescribeImage
  stageACall?: StageACall
}

const sameScope = (a: ProjectMemoryScope | null, b: ProjectMemoryScope | null) =>
  !!a && !!b && a.kind === b.kind && scopeKey(a).scopeId === scopeKey(b).scopeId

interface BucketState extends Omit<MemoryBucket, 'scope' | 'name'> {
  loading: boolean
  busy: boolean
  error: string | null
}

/**
 * One storage bucket bound to one scope. Always called (hooks rule); inert
 * when `scope` is null — empty data, no-op mutations. Exported so App can
 * drive a project-scope-only modal (sidebar toolbox) without a canvas.
 */
export function useMemoryBucket(scope: ProjectMemoryScope | null, deps: ProjectMemoryDeps): BucketState {
  const [files, setFiles] = useState<ProjectMemoryFile[]>([])
  const [instructions, setInstructions] = useState<ProjectInstructions>(EMPTY_INSTRUCTIONS)
  const [instructionsSaved, setInstructionsSaved] = useState(true)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { localStore, client, extractText } = deps
  const describe = deps.describeFile ?? describeDefault
  const describeImg = deps.describeImage ?? describeImageDefault
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const store = client ?? localStore // signed-in wins; both null = inert

  // Files-only refetch: used after upload/delete/retry, which never touch
  // instructions. Kept separate from `refresh` so those actions can't clobber
  // an unsaved draft the user is mid-typing on the modal's Instructions tab —
  // the modal resyncs its local draft any time the `instructions` prop changes,
  // so refreshing instructions here would silently discard in-progress edits.
  const refreshFiles = useCallback(async () => {
    const s = scopeRef.current
    if (!s || !store) {
      setFiles([])
      return
    }
    setLoading(true)
    try {
      const list = await (client ? client.listFiles(s) : localStore!.listFiles(s))
      if (!sameScope(scopeRef.current, s)) return // scope changed mid-flight
      setFiles(list)
      setError(null)
    } catch (e: any) {
      if (sameScope(scopeRef.current, s)) setError(e?.message || 'failed to load project memory')
    } finally {
      setLoading(false)
    }
  }, [client, localStore, store])

  // Full refetch (files + instructions): only for scope entry, where resetting
  // the instructions draft to the persisted value is the correct behavior.
  const refresh = useCallback(async () => {
    const s = scopeRef.current
    if (!s || !store) {
      setFiles([])
      setInstructions(EMPTY_INSTRUCTIONS)
      return
    }
    setLoading(true)
    try {
      const [list, ins] = await Promise.all([
        client ? client.listFiles(s) : localStore!.listFiles(s),
        client ? client.getInstructions(s) : localStore!.getInstructions(s)
      ])
      if (!sameScope(scopeRef.current, s)) return // scope changed mid-flight
      setFiles(list)
      setInstructions(ins ?? EMPTY_INSTRUCTIONS)
      setInstructionsSaved(true)
      setError(null)
    } catch (e: any) {
      if (sameScope(scopeRef.current, s)) setError(e?.message || 'failed to load project memory')
    } finally {
      setLoading(false)
    }
  }, [client, localStore, store])

  useEffect(() => {
    void refresh()
    // Re-load whenever the bound bucket changes (canvas switch or move).
  }, [refresh, scope?.kind, scope ? scopeKey(scope).scopeId : ''])

  // ---- ingestion ----

  const ingestLocal = useCallback(
    async (s: ProjectMemoryScope, f: File) => {
      const { scopeKind, scopeId } = scopeKey(s)
      const now = new Date().toISOString()
      const meta: ProjectMemoryFile = {
        id: crypto.randomUUID(),
        scopeKind,
        scopeId,
        name: f.name,
        mimeType: f.type || 'application/octet-stream',
        size: f.size,
        title: f.name,
        description: '',
        status: 'extracting',
        createdAt: now,
        updatedAt: now
      }
      await localStore!.createFile(meta)
      await localStore!.putBlob(meta.id, f)
      // Images skip text extraction: a vision call OCRs them for the catalog,
      // and the pixels (kept in the blob) re-attach at AI-call time.
      if (isImageFile(meta)) {
        const desc = (await describeImg(f.name, await blobToDataUrl(f))) ?? fallbackImageDescription(f.name)
        await localStore!.putText(meta.id, desc.ocrText)
        await localStore!.updateFile({
          ...meta,
          title: desc.title,
          description: desc.description,
          status: 'indexed',
          updatedAt: new Date().toISOString()
        })
        return
      }
      const result = extractText ? await extractText(f, f.name, meta.mimeType) : null
      if (!result || !result.ok) {
        const reason = result?.reason === 'unsupported' ? 'unsupported file type' : 'could not read file'
        await localStore!.updateFile({ ...meta, status: 'failed', error: reason, updatedAt: new Date().toISOString() })
        return
      }
      const text = result.text.slice(0, PM_TEXT_CHAR_CAP)
      await localStore!.putText(meta.id, text)
      const desc = (await describe(f.name, text)) ?? fallbackDescription(f.name, text)
      await localStore!.updateFile({
        ...meta,
        title: desc.title,
        description: desc.description,
        status: 'indexed',
        updatedAt: new Date().toISOString()
      })
    },
    [localStore, extractText, describe, describeImg]
  )

  const ingestRemote = useCallback(
    async (s: ProjectMemoryScope, f: File) => {
      const mimeType = f.type || 'application/octet-stream'
      // Images: vision OCR in the browser; the (possibly empty) OCR text is
      // the stored text, so it always rides up as extractedText.
      if (isImageFile({ mimeType, name: f.name })) {
        const desc = (await describeImg(f.name, await blobToDataUrl(f))) ?? fallbackImageDescription(f.name)
        await client!.uploadFile(s, {
          blob: f,
          name: f.name,
          mimeType,
          title: desc.title,
          description: desc.description,
          extractedText: desc.ocrText
        })
        return
      }
      // Browser extracts the simple formats + PDF; Office goes up raw and the
      // server parses it synchronously during upload.
      const result = extractText ? await extractText(f, f.name, mimeType) : null
      const extractedText = result?.ok ? result.text.slice(0, PM_TEXT_CHAR_CAP) : undefined
      const desc = extractedText
        ? ((await describe(f.name, extractedText)) ?? fallbackDescription(f.name, extractedText))
        : { title: f.name, description: `${f.name} (${mimeType}) awaiting server-side text extraction.` }
      await client!.uploadFile(s, {
        blob: f,
        name: f.name,
        mimeType,
        title: desc.title,
        description: desc.description,
        extractedText
      })
    },
    [client, extractText, describe, describeImg]
  )

  const uploadFiles = useCallback(
    async (picked: File[]) => {
      const s = scopeRef.current
      if (!s || !store) return
      setBusy(true)
      setError(null)
      try {
        for (const f of picked) {
          if (f.size > PM_MAX_UPLOAD_BYTES) {
            setError(`"${f.name}" exceeds the 20 MB limit`)
            continue
          }
          if (client) await ingestRemote(s, f)
          else await ingestLocal(s, f)
        }
      } catch (e: any) {
        setError(e?.message || 'upload failed')
      } finally {
        setBusy(false)
        await refreshFiles()
      }
    },
    [store, client, ingestLocal, ingestRemote, refreshFiles]
  )

  const deleteFile = useCallback(
    async (id: string) => {
      if (!store) return
      setBusy(true)
      try {
        if (client) await client.deleteFile(id)
        else await localStore!.deleteFile(id)
        setError(null)
      } catch (e: any) {
        setError(e?.message || 'delete failed')
      } finally {
        setBusy(false)
        await refreshFiles()
      }
    },
    [store, client, localStore, refreshFiles]
  )

  const retryFile = useCallback(
    async (id: string) => {
      const s = scopeRef.current
      if (!s) return
      if (client) {
        // v1: the server keeps the blob but exposes no re-extract route;
        // synced failures need a fresh upload.
        setError('Retry is not available for synced files yet — delete and re-upload.')
        return
      }
      if (!localStore) return
      setBusy(true)
      try {
        const meta = await localStore.getFile(id)
        const blob = await localStore.getBlob(id)
        if (meta && blob) {
          await localStore.deleteFile(id)
          await ingestLocal(s, new File([blob], meta.name, { type: meta.mimeType }))
        }
        setError(null)
      } catch (e: any) {
        setError(e?.message || 'retry failed')
      } finally {
        setBusy(false)
        await refreshFiles()
      }
    },
    [client, localStore, ingestLocal, refreshFiles]
  )

  const saveInstructions = useCallback(
    async (ins: ProjectInstructions) => {
      const s = scopeRef.current
      if (!s || !store) return
      setBusy(true)
      setInstructions(ins)
      setInstructionsSaved(false)
      try {
        if (client) await client.putInstructions(s, ins)
        else await localStore!.putInstructions(s, ins)
        setInstructionsSaved(true)
        setError(null)
      } catch (e: any) {
        setError(e?.message || 'failed to save instructions')
      } finally {
        setBusy(false)
      }
    },
    [store, client, localStore]
  )

  return useMemo(
    () => ({
      files,
      instructions,
      instructionsSaved,
      loading,
      busy,
      error,
      uploadFiles,
      deleteFile,
      retryFile,
      saveInstructions
    }),
    [files, instructions, instructionsSaved, loading, busy, error, uploadFiles, deleteFile, retryFile, saveInstructions]
  )
}

export function useProjectMemory(
  tree: ScopeTreeNode[],
  activeSpaceId: string,
  deps: ProjectMemoryDeps
): UseProjectMemoryResult {
  const scopes = useMemo(
    () => (activeSpaceId ? resolveMemoryScopes(tree, activeSpaceId) : null),
    [tree, activeSpaceId]
  )
  const projectScope = scopes?.project ?? null
  const canvasScope = scopes?.canvas ?? null
  const projectName = useMemo(
    () => (projectScope ? scopeDisplayName(tree, projectScope) : ''),
    [tree, projectScope]
  )
  const canvasName = useMemo(
    () => (canvasScope ? scopeDisplayName(tree, canvasScope) : ''),
    [tree, canvasScope]
  )

  // Both buckets always mount (hooks rule); the project one is inert when the
  // canvas is top-level.
  const projectBucket = useMemoryBucket(projectScope, deps)
  const canvasBucket = useMemoryBucket(canvasScope, deps)

  const { localStore, client } = deps
  const store = client ?? localStore
  const stageA = deps.stageACall ?? stageADefault
  const cacheRef = useRef(new SelectionCache())

  // Merged instructions for AI calls: project's standing guidance first, the
  // canvas's own additions after (specific reads last).
  const instructions = useMemo(
    () =>
      mergeInstructions(
        projectScope ? projectBucket.instructions : undefined,
        canvasScope ? canvasBucket.instructions : undefined
      ),
    [projectScope, canvasScope, projectBucket.instructions, canvasBucket.instructions]
  )

  // Merged retrieval: ONE catalog over both buckets' files. File ids are
  // unique across buckets, and getText is id-keyed, so plain concatenation is
  // the whole merge.
  const mergedFiles = useMemo(
    () => [...(projectScope ? projectBucket.files : []), ...(canvasScope ? canvasBucket.files : [])],
    [projectScope, canvasScope, projectBucket.files, canvasBucket.files]
  )

  const buildMemoryContext = useCallback(
    async (
      task: string,
      options?: { call?: StageACall; allowWebSearch?: boolean }
    ): Promise<ProjectMemoryContext | null> => {
      if (!store) return null
      const getText = client
        ? async (id: string) => {
            try {
              return await client.getText(id)
            } catch {
              return undefined
            }
          }
        : (id: string) => localStore!.getText(id)
      // Selected images re-attach as pixels: blob (local IndexedDB or the
      // server's blob route) → data URL. Failures skip the image, never throw.
      const getImageDataUrl = async (id: string) => {
        try {
          const blob = client ? await client.getBlob(id) : await localStore!.getBlob(id)
          return blob ? await blobToDataUrl(blob) : undefined
        } catch {
          return undefined
        }
      }
      return buildProjectMemoryContext({
        files: mergedFiles,
        task,
        getText,
        getImageDataUrl,
        call: options?.call ?? stageA,
        cache: cacheRef.current,
        allowWebSearch: options?.allowWebSearch
      })
    },
    [store, client, localStore, mergedFiles, stageA]
  )

  const project = useMemo<MemoryBucket | null>(
    () => (projectScope ? { scope: projectScope, name: projectName, ...bucketApi(projectBucket) } : null),
    [projectScope, projectName, projectBucket]
  )
  const canvas = useMemo<MemoryBucket | null>(
    () => (canvasScope ? { scope: canvasScope, name: canvasName, ...bucketApi(canvasBucket) } : null),
    [canvasScope, canvasName, canvasBucket]
  )

  return useMemo(
    () => ({
      project,
      canvas,
      instructions,
      loading: projectBucket.loading || canvasBucket.loading,
      busy: projectBucket.busy || canvasBucket.busy,
      error: projectBucket.error ?? canvasBucket.error,
      buildMemoryContext
    }),
    [project, canvas, instructions, projectBucket, canvasBucket, buildMemoryContext]
  )
}

/** The MemoryBucket surface of a bucket's state (drops loading/busy/error). */
function bucketApi(b: BucketState): Omit<MemoryBucket, 'scope' | 'name'> {
  return {
    files: b.files,
    instructions: b.instructions,
    instructionsSaved: b.instructionsSaved,
    uploadFiles: b.uploadFiles,
    deleteFile: b.deleteFile,
    retryFile: b.retryFile,
    saveInstructions: b.saveInstructions
  }
}

// Resolved lazily so importing the hook never touches settings at module load.
const describeDefault = defaultDescribeFile()
const describeImageDefault = defaultDescribeImage()
const stageADefault = defaultStageACall()
