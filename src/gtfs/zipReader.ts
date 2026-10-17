// zip をブラウザで展開する（読む専用。書く側は zip.ts）。
// GTFS の zip は「ファイル名 → テキスト」の辞書にできれば足りるので、
// 中央ディレクトリを後ろから読んで、各エントリを stored / deflate の2方式だけ展開する。
// deflate はブラウザ組み込みの DecompressionStream('deflate-raw') を使う（依存ゼロ）。
// ZIP64・暗号化・分割 zip は対象外（GTFS では使われない）。

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

interface Entry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

function readEntries(view: DataView): Entry[] {
  // EOCD は末尾 22 バイト＋コメント（最大 64KB）のどこかにある。後ろから探す
  let eocd = -1
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip ファイルではありません（末尾の目印が見つかりません）')
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const dec = new TextDecoder('utf-8')
  const entries: Entry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('zip の中央ディレクトリが壊れています')
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const name = dec.decode(new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen))
    entries.push({ name, method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザは zip の展開に対応していません（新しいブラウザでお試しください）')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * zip のバイト列 → { ファイル名: 中身 } の辞書。
 * フォルダに入っている場合（foo/stops.txt）はフォルダ名を落として stops.txt にする。
 * テキストでないファイルは無視する。
 */
export async function readZip(buf: ArrayBuffer): Promise<Record<string, string>> {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  const out: Record<string, string> = {}
  const dec = new TextDecoder('utf-8')
  for (const e of readEntries(view)) {
    if (e.name.endsWith('/')) continue
    const base = e.name.split('/').pop()!
    if (!/\.(txt|geojson|json|csv)$/i.test(base)) continue
    if (view.getUint32(e.localOffset, true) !== SIG_LOCAL) continue
    const nameLen = view.getUint16(e.localOffset + 26, true)
    const extraLen = view.getUint16(e.localOffset + 28, true)
    const start = e.localOffset + 30 + nameLen + extraLen
    const raw = bytes.subarray(start, start + e.compressedSize)
    let data: Uint8Array
    if (e.method === 0) data = raw
    else if (e.method === 8) data = await inflateRaw(raw)
    else continue
    // 先頭の BOM は落とす（Excel 由来の GTFS に多い）
    out[base] = dec.decode(data).replace(/^﻿/, '')
  }
  return out
}
