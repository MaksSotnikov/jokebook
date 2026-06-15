import { useState } from 'react'
import type { TreeNode } from '../lib/tree'

interface FileTreeProps {
  nodes: TreeNode[]
  activePath: string | null
  onSelect: (path: string) => void
}

/** Renders the vault file tree; folders are collapsible. */
export function FileTree({ nodes, activePath, onSelect }: FileTreeProps) {
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <TreeItem key={node.path} node={node} depth={0} activePath={activePath} onSelect={onSelect} />
      ))}
    </ul>
  )
}

interface TreeItemProps {
  node: TreeNode
  depth: number
  activePath: string | null
  onSelect: (path: string) => void
}

function TreeItem({ node, depth, activePath, onSelect }: TreeItemProps) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 14 + 8}px` }

  if (node.isDir) {
    return (
      <li>
        <div className="tree-row folder" style={pad} onClick={() => setOpen((o) => !o)}>
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
                activePath={activePath}
                onSelect={onSelect}
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
        className={`tree-row file${activePath === node.path ? ' active' : ''}`}
        style={pad}
        onClick={() => onSelect(node.path)}
      >
        <span className="label">{node.name}</span>
      </div>
    </li>
  )
}
