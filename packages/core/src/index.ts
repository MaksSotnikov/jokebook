export {
  parseNote,
  parseWikiLinks,
  parseTags,
  TAG_PATTERN,
  type ParsedNote,
  type WikiLink,
} from './parse.js'

export {
  hashContent,
  resolvePushItem,
  conflictCopyPath,
  type NoteRecord,
  type PushItem,
  type PushOutcome,
} from './sync.js'

export { buildLinkGraph, noteName, type IndexedNote, type LinkGraph } from './links.js'

export {
  parseJokes,
  setVersionStars,
  addJokeVersion,
  removeJokeVersion,
  moveJoke,
  wrapJoke,
  appendJokes,
  wordCount,
  performedVersion,
  jokeSetSeconds,
  jokeSummary,
  WORDS_PER_MINUTE,
  type JokeVersion,
  type JokeSegment,
  type TextSegment,
  type Segment,
  type JokeSummary,
} from './jokes.js'

export {
  parseSet,
  isSetNote,
  renderSet,
  addBitToSet,
  removeBitFromSet,
  moveBitInSet,
} from './sets.js'

export {
  runSync,
  emptySyncState,
  type ApiNote,
  type PushResult,
  type SyncTransport,
  type SyncFs,
  type LocalNote,
  type NoteSyncMeta,
  type SyncState,
  type SyncSummary,
  type SyncOptions,
} from './client-sync.js'
