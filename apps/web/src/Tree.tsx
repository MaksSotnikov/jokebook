import { useState } from 'react'

// Drag payload types, so drop zones can tell a note drag from a folder drag.
const NOTE_MIME = 'application/x-note-id'
const FOLDER_MIME = 'application/x-folder-path'

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
  /** Move a folder into `toParent` (`''` = vault root). */
  onMoveFolder: (folderPath: string, toParent: string) => void
  /** Open the folder-picker for a note (touch-friendly move; no drag needed). */
  onMoveRequest: (id: string) => void
  /** Open the folder-picker for a folder (touch-friendly move). */
  onMoveFolderRequest: (folderPath: string) => void
  /** Rename a note (prompts for a new name). */
  onRenameFile: (id: string) => void
  /** Rename a folder (prompts for a new name). */
  onRenameFolder: (folderPath: string) => void
}

/** Renders the vault tree; folders collapse and accept dropped notes/folders. */
export function Tree(props: TreeProps) {
  const { nodes, onMove, onMoveFolder } = props
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // Path of the folder being dragged, so we can refuse to highlight itself or
  // its own descendants as drop targets (getData isn't readable on dragover).
  const [dragFolder, setDragFolder] = useState<string | null>(null)

  /** A folder can't be dropped into itself or any folder beneath it. */
  function isValidFolderTarget(targetPath: string): boolean {
    if (dragFolder === null) return true
    return targetPath !== dragFolder && !targetPath.startsWith(`${dragFolder}/`)
  }

  function handleDrop(e: React.DragEvent, folderPath: string) {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const noteId = e.dataTransfer.getData(NOTE_MIME)
    if (noteId) {
      onMove(noteId, folderPath)
      return
    }
    const src = e.dataTransfer.getData(FOLDER_MIME)
    if (src && src !== folderPath && !folderPath.startsWith(`${src}/`)) {
      onMoveFolder(src, folderPath)
    }
  }

  /** True if a drag carries something this tree accepts. */
  function accepts(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes(NOTE_MIME) || e.dataTransfer.types.includes(FOLDER_MIME)
  }

  return (
    <ul
      className={`tree${dropTarget === '' ? ' drop-target' : ''}`}
      onDragOver={(e) => {
        if (!accepts(e)) return
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
          {...props}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
          handleDrop={handleDrop}
          accepts={accepts}
          dragFolder={dragFolder}
          setDragFolder={setDragFolder}
          isValidFolderTarget={isValidFolderTarget}
        />
      ))}
    </ul>
  )
}

interface TreeItemProps extends TreeProps {
  node: TreeNode
  depth: number
  dropTarget: string | null
  setDropTarget: (path: string | null) => void
  handleDrop: (e: React.DragEvent, folderPath: string) => void
  accepts: (e: React.DragEvent) => boolean
  dragFolder: string | null
  setDragFolder: (path: string | null) => void
  isValidFolderTarget: (targetPath: string) => boolean
}

function TreeItem(props: TreeItemProps) {
  const {
    node,
    depth,
    activeId,
    onSelect,
    onMoveRequest,
    onMoveFolderRequest,
    onRenameFile,
    onRenameFolder,
    dropTarget,
    setDropTarget,
    handleDrop,
    accepts,
    setDragFolder,
    isValidFolderTarget,
  } = props
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 14 + 10}px` }

  if (node.isDir) {
    const highlighted = dropTarget === node.path && isValidFolderTarget(node.path)
    return (
      <li>
        <div
          className={`tree-row folder${highlighted ? ' drop-target' : ''}`}
          style={pad}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_MIME, node.path)
            e.dataTransfer.effectAllowed = 'move'
            setDragFolder(node.path)
          }}
          onDragEnd={() => setDragFolder(null)}
          onClick={() => setOpen((o) => !o)}
          onDragOver={(e) => {
            if (!accepts(e) || !isValidFolderTarget(node.path)) return
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
          <button
            className="row-move"
            title="Rename folder"
            onClick={(e) => {
              e.stopPropagation()
              onRenameFolder(node.path)
            }}
          >
            ✏️
          </button>
          <button
            className="row-move"
            title="Move folder"
            onClick={(e) => {
              e.stopPropagation()
              onMoveFolderRequest(node.path)
            }}
          >
            📂
          </button>
        </div>
        {open && (
          <ul>
            {node.children.map((child) => (
              <TreeItem key={child.path} {...props} node={child} depth={depth + 1} />
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
        <button
          className="row-move"
          title="Rename note"
          onClick={(e) => {
            e.stopPropagation()
            if (node.id) onRenameFile(node.id)
          }}
        >
          ✏️
        </button>
        <button
          className="row-move"
          title="Move to folder"
          onClick={(e) => {
            e.stopPropagation()
            if (node.id) onMoveRequest(node.id)
          }}
        >
          📂
        </button>
      </div>
    </li>
  )
}
