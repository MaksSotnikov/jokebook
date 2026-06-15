import type { NoteEntry } from './api'

/** A node in the vault file tree: either a folder or a note. */
export interface TreeNode {
  /** Display name (folder name, or note name without `.md`). */
  name: string
  /** Vault-relative path (folder path, or the note's `.md` path). */
  path: string
  /** `true` for folders. */
  isDir: boolean
  /** Child nodes (folders first, then notes; both alphabetical). */
  children: TreeNode[]
}

/**
 * Build a nested folder/file tree. Folders come from two sources: the explicit
 * `folders` list (so empty folders still appear and can be drop targets) and the
 * `/`-separated note paths. At each level folders are listed before files, both
 * sorted case-insensitively.
 */
export function buildTree(notes: NoteEntry[], folders: string[] = []): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }

  // Find-or-create the folder node for a vault-relative dir path (`''` = root).
  function ensureDir(dirPath: string): TreeNode {
    let cursor = root
    if (!dirPath) return cursor
    const segments = dirPath.split('/')
    for (let i = 0; i < segments.length; i++) {
      const folderPath = segments.slice(0, i + 1).join('/')
      let next = cursor.children.find((c) => c.isDir && c.path === folderPath)
      if (!next) {
        next = { name: segments[i], path: folderPath, isDir: true, children: [] }
        cursor.children.push(next)
      }
      cursor = next
    }
    return cursor
  }

  // Seed explicit folders first so empty ones survive even with no notes.
  for (const folder of folders) ensureDir(folder)

  for (const note of notes) {
    const dir = note.path.split('/').slice(0, -1).join('/')
    ensureDir(dir).children.push({ name: note.name, path: note.path, isDir: false, children: [] })
  }

  sortTree(root.children)
  return root.children
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  for (const node of nodes) {
    if (node.children.length) sortTree(node.children)
  }
}
