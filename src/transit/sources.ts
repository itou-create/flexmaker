// 乗り継ぎ検索で使う「公表されている GTFS」の取り先。
//
// 取り先は2つ。どちらもブラウザから直接 zip を読める（CORS 許可）のでサーバは要らない。
//  1. 国交省の GTFS データリポジトリ（gtfs-data.jp）
//     一覧 API・zip（302 → S3）とも CORS 許可を 2026-10-17 に確認。
//  2. 公共交通オープンデータセンター（ODPT）の「認証なし」で公開されているデータ（api-public.odpt.org）
//     CC BY 4.0 / CC0 のもの。302 → Azure Blob（CORS 許可・Range 可）を 2026-10-18 に確認。
//     都営バスなど、リポジトリに無い大手事業者はこちらにある。
//     「公共交通オープンデータ基本ライセンス」のデータ（西武バス・西東京バス・京王バス等）は
//     アクセストークンが要る。トークンはソースにもサイトにも置かない（CLAUDE.md の方針）。
//     担当者が自分の端末にだけ保存したとき（src/odptToken.ts）に限って使う。
//
// 利用者にデータを選ばせない：同梱の索引 public/data/feed-index.json
// （scripts/build-feed-index.mjs が両方の取り先の全フィードについて停留所の範囲を調べたもの）から、
// 出発地・行き先・いま見ているエリアの近くにあるフィードを自動で選ぶ。
//
// 同じ事業者のデータが両方にあること（瑞穂町コミュニティバス等）があるので、
// 停留所数と範囲がほぼ同じものは1つしか選ばない。

import { readZip } from '../gtfs/zipReader.ts'
import { distanceM } from './timetable.ts'
import { getOdptToken } from '../odptToken.ts'
import { getCachedZip, putCachedZip } from './zipCache.ts'

export interface RepoFeed {
  /** gtfs-data.jp の organization_id。ODPT のものは 'odpt' */
  org: string
  /** gtfs-data.jp の feed_id。ODPT のものはデータセットの slug（複数ファイルなら slug#資源ID） */
  feed: string
  /** 画面に出す名前（例：瑞穂町コミュニティバス） */
  label: string
  /** 提供者（出典表示用） */
  provider: string
  license?: string
  licenseUrl?: string
  /** zip の直接 URL（ODPT）。無ければ gtfs-data.jp の URL を組み立てる */
  url?: string
  /** ODPT 基本ライセンス：アクセストークンが無いと取れない */
  token?: boolean
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
export const ODPT_TOP_URL = 'https://www.odpt.org/'

export const isOdpt = (f: RepoFeed): boolean => f.org === 'odpt'
/** 出典として示す取り先のページ */
export const feedSiteUrl = (f: RepoFeed): string => (isOdpt(f) ? ODPT_TOP_URL : REPO_TOP_URL)
export const feedSiteName = (f: RepoFeed): string => (isOdpt(f) ? '公共交通オープンデータセンター' : 'GTFS データリポジトリ')

export const repoZipUrl = (f: RepoFeed): string =>
  `https://api.gtfs-data.jp/v2/organizations/${encodeURIComponent(f.org)}/feeds/${encodeURIComponent(f.feed)}/files/feed.zip?rid=current`

/** 実際に取りに行く URL。トークンが要るものは端末に保存したトークンを付ける（無ければ null） */
export function zipUrl(f: RepoFeed): string | null {
  if (!f.url) return repoZipUrl(f)
  if (!f.token) return f.url
  const token = getOdptToken()
  if (!token) return null
  const base = f.url.replace(/[?&]acl:consumerKey=[^&]*/, '').replace(/\?$/, '')
  return `${base}${base.includes('?') ? '&' : '?'}acl:consumerKey=${encodeURIComponent(token)}`
}

export const feedKey = (f: RepoFeed): string => `${f.org}/${f.feed}`

export interface LoadedFeed {
  files: Record<string, string>
  /** zip を取った時刻（端末に置いてあったものはその時刻）。ガイドラインの「取得日時の表示」に使う */
  fetchedAt: number
}

/** zip を取って「ファイル名 → テキスト」にする。端末に置いた 1 日以内のものがあればそれを使う */
export async function loadRepoFeed(f: RepoFeed): Promise<LoadedFeed> {
  const key = feedKey(f)
  const cached = await getCachedZip(key)
  if (cached) return { files: await readZip(cached.buf), fetchedAt: cached.at }
  const url = zipUrl(f)
  if (!url) throw new Error('アクセストークンがありません')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  const files = await readZip(buf)
  void putCachedZip(key, buf)
  return { files, fetchedAt: Date.now() }
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

export type Box = [number, number, number, number]

/** 地点の集まりを囲む箱（余白 marginM）。[西, 南, 東, 北] */
export function boxAround(pts: { lat: number; lon: number }[], marginM: number): Box {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  const dLat = marginM / 111000
  const dLon = marginM / (111000 * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)))
  return [minLon - dLon, minLat - dLat, maxLon + dLon, maxLat + dLat]
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
  /** トークンの要るフィードも候補に入れる（端末にトークンがあるとき） */
  allowToken?: boolean
}

/** 同じデータが両方の取り先にあるか（停留所数と範囲がほぼ同じ） */
function sameData(a: IndexedFeed, b: IndexedFeed): boolean {
  if (Math.abs(a.stops - b.stops) > 2) return false
  return a.bbox.every((v, i) => Math.abs(v - b.bbox[i]) < 0.002)
}

/**
 * 地点の集まり（出発地・行き先・エリアの乗り場など）を囲む箱に重なるフィードを選ぶ。
 * 近いもの・範囲の小さいもの（＝その地域のバス）を先に、合計サイズの上限まで。
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

  const [minLon, minLat, maxLon, maxLat] = boxAround(pts, marginM)
  const cLat = (minLat + maxLat) / 2
  const cLon = (minLon + maxLon) / 2

  const hits = index
    .filter((f) => !chosen.includes(f))
    .filter((f) => !f.token || opts.allowToken)
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
    if (chosen.some((c) => sameData(c, f))) continue
    chosen.push(f)
    bytes += f.zipBytes
  }
  return chosen
}
