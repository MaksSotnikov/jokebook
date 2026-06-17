/** Build a ZIP archive (store / no compression) entirely in the browser — no
 * dependency. Good enough to round-trip a vault of notes back into Obsidian or
 * any other editor: each entry becomes a file at its `path` inside the zip. */

// Precomputed CRC-32 table (polynomial 0xEDB88320).
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  path: string
  content: string
}

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
const u32 = (n: number) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// A fixed, valid DOS date/time (2021-01-01 00:00) so extractors that validate
// the timestamp don't choke on a zero date.
const DOS_TIME = 0
const DOS_DATE = ((2021 - 1980) << 9) | (1 << 5) | 1

export function makeZip(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const name = enc.encode(e.path)
    const data = enc.encode(e.content)
    const crc = crc32(data)
    const local = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: store
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(name.length),
      u16(0), // extra length
      name,
      data,
    ])
    chunks.push(local)
    central.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // method: store
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0), // extra length
        u16(0), // comment length
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        name,
      ]),
    )
    offset += local.length
  }

  const cdStart = offset
  let cdSize = 0
  for (const c of central) {
    chunks.push(c)
    cdSize += c.length
  }
  chunks.push(
    concat([
      u32(0x06054b50), // end of central directory signature
      u16(0), // disk number
      u16(0), // disk with central directory
      u16(central.length), // entries on this disk
      u16(central.length), // total entries
      u32(cdSize),
      u32(cdStart),
      u16(0), // comment length
    ]),
  )

  return new Blob(chunks as BlobPart[], { type: 'application/zip' })
}
