// 乗り継ぎ検索で使う「公表されている GTFS」の取り先。
//
// 国交省の GTFS データリポジトリ（gtfs-data.jp）は、一覧 API も zip のダウンロードも
// ブラウザから直接読める（CORS 許可。2026-10-17 に確認）。サーバを置かずに済む。
// Flex 側のデータ（同梱 JSON／作成中プレビュー）と、ここで取る路線バス等を同じ時刻表に載せる。
//
// 利用者にデータを選ばせない：同梱の索引 public/data/feed-index.json
// （scripts/build-feed-index.mjs が全フィードの停留所の範囲を調べたもの）から、
// 出発地・行き先・いま見ているエリアの近くにあるフィードを自動で選ぶ。
//
// ODPT（api-public.odpt.org）側は CORS が無いのでブラウザから直接は読めない。
// Flex データは scripts/convert-sample.mjs で変換した同梱 JSON を使う（従来どおり）。

import { readZip } from '../gtfs/zipReader.ts'
import { distanceM } from './timetable.ts'

export interface RepoFeed {
  /** gtfs-data.jp の organization_id */
  org: string
  /** gtfs-data.jp の feed_id */
  feed: string
  /** 画面に出す名前（例：瑞穂町コミュニティバス） */
  label: string
  /** 提供者（出典表示用） */
  provider: string
  license?: string
  licenseUrl?: string
}

/** 索引の1件。bbox は [西端の経度, 南端の緯度, 東端の経度, 北端の緯度] */
export interface IndexedFeed extends RepoFeed {
  prefId: number
  end?: string
  bbox: [number, number, number, number]
  stops: number
  zipBytes: number
  /** 予約制（GTFS-Flex）のフィード。時刻表としては使えない */
  flex?: boolean
}

export const REPO_TOP_URL = 'https://www.gtfs-data.jp/'

export const repoZipUrl = (f: RepoFeed): string =>
  `https://api.gtfs-data.jp/v2/organizations/${encodeURIComponent(f.org)}/feeds/${encodeURIComponent(f.feed)}/files/feed.zip?rid=current`

export const feedKey = (f: RepoFeed): string => `${f.org}/${f.feed}`

/** リポジトリから zip を取って「ファイル名 → テキスト」にする */
export async function loadRepoFeed(f: RepoFeed): Promise<Record<string, string>> {
  const res = await fetch(repoZipUrl(f))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readZip(await res.arrayBuffer())
}

let indexCache: Promise<IndexedFeed[]> | null = null

/** 同梱の索引を読む（失敗したら空。乗りつぎはデマンド交通だけで調べる） */
export function loadFeedIndex(): Promise<IndexedFeed[]> {
  if (!indexCache) {
    indexCache = fetch('./data/feed-index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { feeds?: IndexedFeed[] }) => j.feeds ?? [])
      .catch(() => [])
  }
  return indexCache
}

export interface PickOptions {
  /** 範囲の外側に見る余白（m）。既定 3000 */
  marginM?: number
  /** 読み込むフィード数の上限。既定 6 */
  maxFeeds?: number
  /** 読み込む zip の合計バイト数の上限。既定 12MB（スマホ回線を考えて） */
  maxBytes?: number
  /** 必ず入れるもの（同梱データに紐づく相手など） */
  always?: RepoFeed[]
}

/**
 * 地点の集まり（出発地・行き先・エリアの乗り場など）を囲む箱に重なるフィードを選ぶ。
 * 近い順・小さい順に、上限の件数と容量まで。地点が無ければ空。
 */
export function pickNearbyFeeds(index: IndexedFeed[], pts: { lat: number; lon: number }[], opts: PickOptions = {}): IndexedFeed[] {
  const marginM = opts.marginM ?? 3000
  const maxFeeds = opts.maxFeeds ?? 6
  const maxBytes = opts.maxBytes ?? 12 * 1024 * 1024
  const chosen: IndexedFeed[] = []
  let bytes = 0
  for (const a of opts.always ?? []) {
    const f = index.find((x) => x.org === a.org && x.feed === a.feed)
    if (f) {
      chosen.push(f)
      bytes += f.zipBytes
    }
  }
  if (pts.length === 0) return chosen

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  const dLat = marginM / 111000
  const dLon = marginM / (111000 * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)))
  minLat -= dLat
  maxLat += dLat
  minLon -= dLon
  maxLon += dLon
  const cLat = (minLat + maxLat) / 2
  const cLon = (minLon + maxLon) / 2

  const hits = index
    .filter((f) => !chosen.includes(f))
    .filter((f) => f.bbox[0] <= maxLon && f.bbox[2] >= minLon && f.bbox[1] <= maxLat && f.bbox[3] >= minLat)
    .map((f) => {
      // 箱の中心までの距離と、箱の大きさ（広域事業者ほど後回し）
      const fc = { lat: (f.bbox[1] + f.bbox[3]) / 2, lon: (f.bbox[0] + f.bbox[2]) / 2 }
      const span = distanceM(f.bbox[1], f.bbox[0], f.bbox[3], f.bbox[2])
      return { f, span, score: distanceM(cLat, cLon, fc.lat, fc.lon) + span * 0.5 }
    })
    // 県をまたぐ高速バスなどは、箱が重なっても近所の停留所が無いことが多いので外す
    .filter((h) => h.span <= 150000)
    .sort((a, b) => a.score - b.score)
  for (const { f } of hits) {
    if (chosen.length >= maxFeeds) break
    if (bytes + f.zipBytes > maxBytes) continue
    chosen.push(f)
    bytes += f.zipBytes
  }
  return chosen
}
