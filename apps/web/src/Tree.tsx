import { useState } from 'react'

// Drag payload type, so folder/root drop zones accept only note drags.
const NOTE_MIME = 'application/x-note-id'

/** A node in the web vault tree: a folder, or a note (carrying its sync id). */
export interface TreeNode {
  name: string
  /** Vault-relative path (folder path, or the note's path). */
  path: string
  isDir: boolean
  /** Note sync id (files only). */
  id?: string
  children: TreeNode[]
}

interface TreeFile {
  id: string
  path: string
}

/**
 * Build a folder/file tree from notes plus an explicit folder list (so empty
 * folders synced as markers still appear). Folders before files at each level,
 * both sorted case-insensitively.
 */
export function buildTree(files: TreeFile[], folders: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }

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

  for (const folder of folders) ensureDir(folder)
  for (const file of files) {
    const dir = file.path.split('/').slice(0, -1).join('/')
    const name = file.path.split('/').pop()!.replace(/\.md$/i, '')
    ensureDir(dir).children.push({ name, path: file.path, isDir: false, id: file.id, children: [] })
  }

  sortTree(root.children)
  return root.children
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  for (const node of nodes) if (node.children.length) sortTree(node.children)
}

interface TreeProps {
  nodes: TreeNode[]
  activeId: string | null
  onSelect: (id: string) => void
  /** Move a note into `toFolder` (`''` = vault root). */
  onMove: (id: string, toFolder: string) => void
}

/** Renders the vault tree; folders collapse and accept dropped notes. */
export function Tree({ nodes, activeId, onSelect, onMove }: TreeProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  function handleDrop(e: React.DragEvent, folderPath: string) {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const id = e.dataTransfer.getData(NOTE_MIME)
    if (id) onMove(id, folderPath)
  }

  return (
    <ul
      className={`tree${dropTarget === '' ? ' drop-target' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(NOTE_MIME)) return
        e.preventDefault()
        setDropTarget('')
      }}
      onDragLeave={() => setDropTarget((p) => (p === '' ? null : p))}
      onDrop={(e) => handleDrop(e, '')}
    >
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          activeId={activeId}
          onSelect={onSelect}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
          handleDrop={handleDrop}
        />
      ))}
    </ul>
  )
}

interface TreeItemProps {
  node: TreeNode
  depth: number
  activeId: string | null
  onSelect: (id: string) => void
  dropTarget: string | null
  setDropTarget: (path: string | null) => void
  handleDrop: (e: React.DragEvent, folderPath: string) => void
}

function TreeItem({
  node,
  depth,
  activeId,
  onSelect,
  dropTarget,
  setDropTarget,
  handleDrop,
}: TreeItemProps) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 14 + 10}px` }

  if (node.isDir) {
    return (
      <li>
        <div
          className={`tree-row folder${dropTarget === node.path ? ' drop-target' : ''}`}
          style={pad}
          onClick={() => setOpen((o) => !o)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(NOTE_MIME)) return
            e.preventDefault()
            e.stopPropagation()
            setDropTarget(node.path)
          }}
          onDragLeave={(e) => {
            e.stopPropagation()
            setDropTarget(dropTarget === node.path ? null : dropTarget)
          }}
          onDrop={(e) => handleDrop(e, node.path)}
        >
          <span className="twisty">{open ? '▾' : '▸'}</span>
          <span className="label">{node.name}</span>
        </div>
        {open && (
          <ul>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activeId={activeId}
                onSelect={onSelect}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
                handleDrop={handleDrop}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <li>
      <div
        className={`tree-row file${activeId === node.id ? ' active' : ''}`}
        style={pad}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(NOTE_MIME, node.id!)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => node.id && onSelect(node.id)}
      >
        <span className="label">{node.name}</span>
      </div>
    </li>
  )
}
