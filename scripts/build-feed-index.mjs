// 国交省 GTFS データリポジトリ（gtfs-data.jp）の全フィードについて、
// 「停留所の範囲（緯度経度の箱）・停留所数・zip の大きさ」の索引を作る。
// 住民ページの乗りつぎ検索は、この索引から出発地・行き先の近くのフィードだけを自動で読み込む
// （利用者にデータを選ばせない）。
//
// 使い方: npm run build-feed-index   → public/data/feed-index.json
//
// 工夫：zip を丸ごと落とさず、HTTP Range で「末尾 128KB（中央ディレクトリ）」と
// 「stops.txt の部分」だけを取る。600件でも数十 MB で済む。
// S3 の署名付き URL（302 先）は Range に対応している。

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipEntries, readZipEntry } from '../src/gtfs/zipReader.ts'
import { parseCsv } from '../src/gtfs/csv.ts'

const API = 'https://api.gtfs-data.jp/v2'
const CONCURRENCY = 6
const TAIL = 128 * 1024

const outDir = join(process.cwd(), 'public', 'data')
const outPath = join(outDir, 'feed-index.json')

async function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`timeout ${label}`)), ms)))
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(t)
  }
}

/** 302 を自分で追って、Range が効く最終 URL を得る */
async function resolveZipUrl(org, feed) {
  const url = `${API}/organizations/${encodeURIComponent(org)}/feeds/${encodeURIComponent(feed)}/files/feed.zip?rid=current`
  const res = await fetch(url, { redirect: 'manual' })
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) return res.headers.get('location')
  if (res.ok) return url
  throw new Error(`HTTP ${res.status}`)
}

async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} (range)`)
  const total = res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]) : Number(res.headers.get('content-length'))
  return { buf: await res.arrayBuffer(), total, full: res.status === 200 }
}

async function indexOne(f) {
  const url = await resolveZipUrl(f.organization_id, f.feed_id)
  // 末尾（中央ディレクトリ）。小さい zip は全体が返る
  const tail = await fetchRange(url, -TAIL, '')
  const total = tail.total
  const entries = zipEntries(tail.buf, tail.full ? tail.buf.byteLength : total)
  const names = new Set(entries.map((e) => e.name.split('/').pop()))
  const stopsEntry = entries.find((e) => e.name.split('/').pop() === 'stops.txt')
  if (!stopsEntry) throw new Error('stops.txt が無い')
  // Flex（予約制）のフィードは時刻表として使えないので印を付ける（検索側は読み飛ばす）
  const flex = names.has('booking_rules.txt') || names.has('location_groups.txt') || names.has('locations.geojson')
  let text
  if (tail.full) {
    text = await readZipEntry(stopsEntry, tail.buf)
  } else {
    const start = stopsEntry.localOffset
    const end = Math.min(total - 1, start + 30 + 1024 + stopsEntry.compressedSize)
    const part = await fetchRange(url, start, end)
    text = await readZipEntry(stopsEntry, part.buf, start)
  }
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180, n = 0
  for (const r of parseCsv(text)) {
    if (r.location_type && r.location_type !== '0') continue
    const lat = Number(r.stop_lat), lon = Number(r.stop_lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) continue
    n++
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  if (n === 0) throw new Error('座標のある停留所が無い')
  const r4 = (x) => Math.round(x * 1e4) / 1e4
  return {
    org: f.organization_id,
    feed: f.feed_id,
    label: f.feed_name,
    provider: f.organization_name,
    prefId: Number(f.feed_pref_id),
    license: f.feed_license || undefined,
    licenseUrl: f.feed_license_url || undefined,
    end: f.latest_feed_end_date || undefined,
    bbox: [r4(minLon), r4(minLat), r4(maxLon), r4(maxLat)],
    stops: n,
    zipBytes: total,
    flex: flex || undefined,
  }
}

const listRes = await fetch(`${API}/feeds`)
if (!listRes.ok) throw new Error(`一覧の取得に失敗 HTTP ${listRes.status}`)
const listJson = await listRes.json()
const feeds = (Array.isArray(listJson) ? listJson : listJson.body ?? []).filter((f) => !f.feed_is_discontinued)
console.log(`フィード ${feeds.length} 件（提供終了を除く）`)

// 前回の索引があれば、失敗したものは前回の値で補う
let previous = new Map()
try {
  const prev = JSON.parse(await readFile(outPath, 'utf8'))
  for (const f of prev.feeds ?? []) previous.set(`${f.org}/${f.feed}`, f)
} catch {
  /* 初回 */
}

const results = []
const failed = []
let i = 0
async function worker() {
  while (i < feeds.length) {
    const f = feeds[i++]
    const key = `${f.organization_id}/${f.feed_id}`
    try {
      const r = await withTimeout(indexOne(f), 60000, key)
      results.push(r)
      process.stdout.write(`[ok] ${key} stops=${r.stops} zip=${Math.round(r.zipBytes / 1024)}KB\n`)
    } catch (e) {
      const prev = previous.get(key)
      if (prev) {
        results.push(prev)
        process.stdout.write(`[prev] ${key}: ${e.message}（前回の値を使用）\n`)
      } else {
        failed.push({ key, error: e.message })
        process.stdout.write(`[fail] ${key}: ${e.message}\n`)
      }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

results.sort((a, b) => a.prefId - b.prefId || a.org.localeCompare(b.org) || a.feed.localeCompare(b.feed))
await mkdir(outDir, { recursive: true })
await writeFile(
  outPath,
  JSON.stringify({ builtOn: new Date().toISOString().slice(0, 10), source: 'https://www.gtfs-data.jp/', feeds: results }, null, 0) + '\n',
)
console.log(`\n[done] ${results.length} 件を ${outPath} に書き出し。失敗 ${failed.length} 件`)
for (const f of failed) console.log(`  ${f.key}: ${f.error}`)
