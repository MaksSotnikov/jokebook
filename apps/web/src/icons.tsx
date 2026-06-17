import type { ReactNode } from 'react'

// Lightweight inline line-icon set (no dependency). Icons inherit the current
// text colour via `currentColor` and scale with the surrounding font-size, so
// `.icon`, `.row-move`, etc. style them through CSS. The 🎤 mic stays an emoji
// brand mark elsewhere — these cover the functional UI actions.
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const IconRefresh = () => (
  <Svg>
    <path d="M21 2v6h-6" />
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M3 22v-6h6" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
  </Svg>
)

export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
)

export const IconFolderPlus = () => (
  <Svg>
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v5" />
    <path d="M9.5 13.5h5" />
  </Svg>
)

export const IconTag = () => (
  <Svg>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 12.2V4a1 1 0 0 1 1-1h8.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8z" />
    <circle cx="7.5" cy="7.5" r="1.3" />
  </Svg>
)

export const IconImport = () => (
  <Svg>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
)

export const IconExport = () => (
  <Svg>
    <path d="M12 21V9" />
    <path d="m7 14 5-5 5 5" />
    <path d="M5 3h14" />
  </Svg>
)

// Combined import/export glyph for the data menu button: arrows pointing both
// ways (down = import, up = export).
export const IconImportExport = () => (
  <Svg>
    <path d="M8 3v13" />
    <path d="m4 7 4-4 4 4" />
    <path d="M16 21V8" />
    <path d="m12 17 4 4 4-4" />
  </Svg>
)

export const IconPin = () => (
  <Svg>
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
  </Svg>
)

export const IconLogout = () => (
  <Svg>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Svg>
)

export const IconChevronLeft = () => (
  <Svg>
    <path d="m15 18-6-6 6-6" />
  </Svg>
)

export const IconChevronDown = () => (
  <Svg>
    <path d="m6 9 6 6 6-6" />
  </Svg>
)

export const IconChevronRight = () => (
  <Svg>
    <path d="m9 18 6-6-6-6" />
  </Svg>
)

export const IconEye = () => (
  <Svg>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)

export const IconEdit = () => (
  <Svg>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
)

export const IconRename = () => (
  <Svg>
    <path d="M4 7V5h16v2" />
    <path d="M12 5v14" />
    <path d="M9 19h6" />
  </Svg>
)

export const IconMove = () => (
  <Svg>
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v5" />
    <path d="m9.5 14 2.5 2.5L14.5 14" />
  </Svg>
)

export const IconTrash = () => (
  <Svg>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
  </Svg>
)

export const IconClose = () => (
  <Svg>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
)

export const IconArrowUp = () => (
  <Svg>
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </Svg>
)

export const IconArrowDown = () => (
  <Svg>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </Svg>
)

export const IconCopy = () => (
  <Svg>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
)

export const IconHome = () => (
  <Svg>
    <path d="m3 11 9-8 9 8" />
    <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
  </Svg>
)

export const IconFolder = () => (
  <Svg>
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)

export const IconNote = () => (
  <Svg>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6" />
    <path d="M9 17h4" />
  </Svg>
)

export const IconLayers = () => (
  <Svg>
    <path d="m12 2 9 5-9 5-9-5 9-5z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </Svg>
)

export const IconSearch = () => (
  <Svg>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
)
