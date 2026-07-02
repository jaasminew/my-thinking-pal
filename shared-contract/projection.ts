import type { CanvasNode, CanvasOperation } from './domain'

/**
 * SHARED CONTRACT — Fold the append-only operation log into current canvas state.
 *
 * This projection is always derivable from the log (the source of truth). Both
 * tracks use the SAME fold so a canvas rebuilt on the web demo and one rebuilt
 * in the Electron app from the same operation log are byte-identical. If you
 * change how an operation kind mutates state, it changes HERE, once, for both.
 */
export interface CanvasState {
  nodes: Map<string, CanvasNode>
}

export function foldOperations(operations: CanvasOperation[]): CanvasState {
  const nodes = new Map<string, CanvasNode>()

  for (const op of [...operations].sort((a, b) => a.seq - b.seq)) {
    switch (op.kind) {
      case 'node.create': {
        const node = op.payload as CanvasNode
        nodes.set(node.id, node)
        break
      }
      case 'node.update':
      case 'node.move': {
        const patch = op.payload as Partial<CanvasNode> & { id: string }
        const existing = nodes.get(patch.id)
        if (existing) nodes.set(patch.id, { ...existing, ...patch, updatedAt: op.createdAt })
        break
      }
      case 'node.delete': {
        const { id } = op.payload as { id: string }
        nodes.delete(id)
        break
      }
      default:
        break
    }
  }

  return { nodes }
}
