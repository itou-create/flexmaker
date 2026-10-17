// zip をブラウザで展開する（読む専用。書く側は zip.ts）。
// GTFS の zip は「ファイル名 → テキスト」の辞書にできれば足りるので、
// 中央ディレクトリを後ろから読んで、各エントリを stored / deflate の2方式だけ展開する。
// deflate はブラウザ組み込みの DecompressionStream('deflate-raw') を使う（依存ゼロ。Node 18+ でも動く）。
// ZIP64・暗号化・分割 zip は対象外（GTFS では使われない）。
//
// エントリ一覧と1ファイルの取り出しを分けて公開しているのは、scripts/build-feed-index.mjs が
// HTTP の Range 要求で「zip の末尾」と「stops.txt の部分」だけを取って索引を作るため。

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

export interface ZipEntry {
  name: string
  /** 0 = 無圧縮、8 = deflate */
  method: number
  compressedSize: number
  uncompressedSize: number
  /** ローカルヘッダの位置（zip 先頭から） */
  localOffset: number
}

/**
 * 中央ディレクトリを読んでエントリ一覧を返す。
 * `tail` は zip 全体でも、末尾だけ（Range で取った断片）でもよい。末尾だけのときは
 * `totalSize` に zip 全体のバイト数を渡す（オフセットを合わせるため）。
 */
export function zipEntries(tail: ArrayBuffer, totalSize = tail.byteLength): ZipEntry[] {
  const view = new DataView(tail)
  const base = totalSize - tail.byteLength // 断片の先頭が zip 全体のどこか
  let eocd = -1
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip ファイルではありません（末尾の目印が見つかりません）')
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true) - base
  if (p < 0) throw new Error('zip の末尾断片が短すぎます（中央ディレクトリが入っていません）')
  const dec = new TextDecoder('utf-8')
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('zip の中央ディレクトリが壊れています')
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const uncompressedSize = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const name = dec.decode(new Uint8Array(tail, p + 46, nameLen))
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザは zip の展開に対応していません（新しいブラウザでお試しください）')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** ローカルヘッダの長さ（30 + 名前 + 拡張）。これだけ余分に読めばデータ本体に届く */
export const LOCAL_HEADER_MAX = 30 + 65535 + 65535

/**
 * 1エントリをテキストにする。`chunk` はローカルヘッダから始まるバイト列
 * （zip 全体なら `chunkOffset` = 0、Range で取った断片なら断片の先頭位置）。
 */
export async function readZipEntry(e: ZipEntry, chunk: ArrayBuffer, chunkOffset = 0): Promise<string> {
  const view = new DataView(chunk)
  const p = e.localOffset - chunkOffset
  if (p < 0 || p + 30 > view.byteLength || view.getUint32(p, true) !== SIG_LOCAL) {
    throw new Error(`zip のローカルヘッダが見つかりません（${e.name}）`)
  }
  const nameLen = view.getUint16(p + 26, true)
  const extraLen = view.getUint16(p + 28, true)
  const start = p + 30 + nameLen + extraLen
  const raw = new Uint8Array(chunk, start, e.compressedSize)
  let data: Uint8Array
  if (e.method === 0) data = raw
  else if (e.method === 8) data = await inflateRaw(raw)
  else throw new Error(`対応していない圧縮方式です（${e.method}）`)
  // 先頭の BOM は落とす（Excel 由来の GTFS に多い）
  return new TextDecoder('utf-8').decode(data).replace(/^﻿/, '')
}

/**
 * zip のバイト列 → { ファイル名: 中身 } の辞書。
 * フォルダに入っている場合（foo/stops.txt）はフォルダ名を落として stops.txt にする。
 * テキストでないファイルは無視する。
 */
export async function readZip(buf: ArrayBuffer): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const e of zipEntries(buf)) {
    if (e.name.endsWith('/')) continue
    const base = e.name.split('/').pop()!
    if (!/\.(txt|geojson|json|csv)$/i.test(base)) continue
    if (e.method !== 0 && e.method !== 8) continue
    out[base] = await readZipEntry(e, buf)
  }
  return out
}
