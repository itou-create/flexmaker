// 「公表されている GTFS」の索引を作る。取り先は2つ：
//   1. 国交省 GTFS データリポジトリ（gtfs-data.jp）の全フィード
//   2. 公共交通オープンデータセンター（ODPT, ckan.odpt.org）の GTFS/GTFS-JP データセット
//      - 「認証なし」（api-public.odpt.org。CC BY 4.0 / CC0）はそのまま索引に入れる
//      - 「公共交通オープンデータ基本ライセンス」（api.odpt.org。トークン必須）は、環境変数 ODPT_TOKEN が
//        あるときだけ範囲を調べて入れる（索引にトークンは書かない。url は置き場所だけ、token: true を付ける）。
//        担当者が端末にトークンを保存した場合に限って画面側が使う（src/odptToken.ts）
// 各フィードについて「停留所の範囲（緯度経度の箱）・停留所数・zip の大きさ」を調べる。
// 住民ページの乗りつぎ検索は、この索引から出発地・行き先の近くのフィードだけを自動で読み込む
// （利用者にデータを選ばせない）。
//
// 使い方: npm run build-feed-index   → public/data/feed-index.json
//         ODPT_TOKEN=xxxx npm run build-feed-index  （基本ライセンスのデータも索引に入れる）
//         ONLY=odpt npm run build-feed-index        （ODPT だけ調べ直し、リポジトリ分は前回の索引を使う。数分→1分）
//
// 工夫：zip を丸ごと落とさず、HTTP Range で「末尾 128KB（中央ディレクトリ）」と
// 「stops.txt（と agency.txt）の部分」だけを取る。700件でも数十 MB で済む。
// S3 / Azure Blob の署名付き URL（302 先）は Range に対応している。
// ODPT のカタログ（CKAN）は API が閉じているので、一覧ページと資源ページの HTML から拾う。

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipEntries, readZipEntry } from '../src/gtfs/zipReader.ts'
import { parseCsv } from '../src/gtfs/csv.ts'

const API = 'https://api.gtfs-data.jp/v2'
const ODPT_CKAN = 'https://ckan.odpt.org'
const CONCURRENCY = 6
const TAIL = 128 * 1024
const ODPT_TOKEN = process.env.ODPT_TOKEN ?? ''
const ONLY = process.env.ONLY ?? ''
const UA = { 'User-Agent': 'Mozilla/5.0 flexmaker-feed-index (+https://github.com/itou-create/flexmaker)' }

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
async function resolveUrl(url) {
  const res = await fetch(url, { redirect: 'manual', headers: UA })
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) return res.headers.get('location')
  if (res.ok) return url
  throw new Error(`HTTP ${res.status}`)
}

async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { ...UA, Range: `bytes=${start}-${end}` } })
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} (range)`)
  const total = res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]) : Number(res.headers.get('content-length'))
  return { buf: await res.arrayBuffer(), total, full: res.status === 200 }
}

/**
 * zip の中の1ファイルを Range で取って読む（zip 全体が返ってきたときはそこから）
 */
async function readEntryRemote(url, entry, tail, total) {
  if (tail.full) return readZipEntry(entry, tail.buf)
  const start = entry.localOffset
  const end = Math.min(total - 1, start + 30 + 1024 + entry.compressedSize)
  const part = await fetchRange(url, start, end)
  return readZipEntry(entry, part.buf, start)
}

/** zip の URL から「範囲・停留所数・大きさ・Flex 印・事業者名」を調べる */
async function probeZip(zipUrl) {
  const url = await resolveUrl(zipUrl)
  // 末尾（中央ディレクトリ）。小さい zip は全体が返る。
  // Azure Blob（ODPT）は「bytes=-N」の後ろから指定を受け付けない（400）ので、先に大きさを聞いてから取る
  let tail
  try {
    tail = await fetchRange(url, -TAIL, '')
  } catch (e) {
    if (!/HTTP 4\d\d/.test(e.message)) throw e
    const head = await fetchRange(url, 0, 0)
    const size = head.total
    if (!Number.isFinite(size) || size <= 0) throw e
    tail = size <= TAIL ? await fetchRange(url, 0, size - 1) : await fetchRange(url, size - TAIL, size - 1)
    if (size <= TAIL) tail.full = true
  }
  const total = tail.total
  const entries = zipEntries(tail.buf, tail.full ? tail.buf.byteLength : total)
  const byName = new Map(entries.map((e) => [e.name.split('/').pop(), e]))
  const stopsEntry = byName.get('stops.txt')
  if (!stopsEntry) throw new Error('stops.txt が無い')
  // Flex（予約制）のフィードは時刻表として使えないので印を付ける（検索側は読み飛ばす）
  const flex = byName.has('booking_rules.txt') || byName.has('location_groups.txt') || byName.has('locations.geojson')
  const text = await readEntryRemote(url, stopsEntry, tail, total)
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
  let agency
  const agencyEntry = byName.get('agency.txt')
  if (agencyEntry && agencyEntry.compressedSize < 64 * 1024) {
    try {
      const rows = parseCsv(await readEntryRemote(url, agencyEntry, tail, total))
      agency = rows.map((r) => r.agency_name).filter(Boolean).join('・') || undefined
    } catch {
      /* 事業者名は無くてもよい */
    }
  }
  const r4 = (x) => Math.round(x * 1e4) / 1e4
  return { bbox: [r4(minLon), r4(minLat), r4(maxLon), r4(maxLat)], stops: n, zipBytes: total, flex: flex || undefined, agency }
}

// ── 1. 国交省リポジトリ ─────────────────────────

async function indexRepoFeed(f) {
  const url = `${API}/organizations/${encodeURIComponent(f.organization_id)}/feeds/${encodeURIComponent(f.feed_id)}/files/feed.zip?rid=current`
  const p = await probeZip(url)
  return {
    org: f.organization_id,
    feed: f.feed_id,
    label: f.feed_name,
    provider: f.organization_name,
    prefId: Number(f.feed_pref_id),
    license: f.feed_license || undefined,
    licenseUrl: f.feed_license_url || undefined,
    end: f.latest_feed_end_date || undefined,
    bbox: p.bbox,
    stops: p.stops,
    zipBytes: p.zipBytes,
    flex: p.flex,
  }
}

async function listRepoFeeds() {
  const res = await fetch(`${API}/feeds`, { headers: UA })
  if (!res.ok) throw new Error(`一覧の取得に失敗 HTTP ${res.status}`)
  const json = await res.json()
  return (Array.isArray(json) ? json : json.body ?? []).filter((f) => !f.feed_is_discontinued)
}

// ── 2. ODPT（CKAN の HTML から拾う）──────────────

const getHtml = async (u) => {
  const res = await fetch(u, { headers: UA })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`)
  return res.text()
}
const unescapeHtml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function shortLicense(name) {
  if (/CC0/i.test(name)) return 'CC0 1.0'
  if (/CC BY 4\.0|Attribution 4\.0/i.test(name)) return 'CC BY 4.0'
  if (/基本ライセンス/.test(name)) return '公共交通オープンデータ基本ライセンス'
  if (/チャレンジ限定/.test(name)) return 'チャレンジ限定ライセンス'
  return name.split(' / ')[0].trim() || undefined
}

/** GTFS/GTFS-JP 形式のデータセット一覧 → 資源（zip）の一覧 */
async function listOdptResources() {
  const slugs = new Set()
  for (let page = 1; page <= 20; page++) {
    const html = await getHtml(`${ODPT_CKAN}/dataset/?res_format=GTFS%2FGTFS-JP&page=${page}`)
    let n = 0
    for (const m of html.matchAll(/href="\/dataset\/([^"\/?#]+)"/g)) {
      if (m[1] !== 'activity' && !slugs.has(m[1])) n++
      slugs.add(m[1])
    }
    slugs.delete('activity')
    if (n === 0) break
  }
  const out = []
  const work = [...slugs]
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (work.length) {
        const slug = work.shift()
        try {
          const d = await getHtml(`${ODPT_CKAN}/dataset/${slug}`)
          const title = unescapeHtml((/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/.exec(d) || [])[1] || slug).trim()
          const licM = /<a[^>]*href="([^"]*)"[^>]*rel="dc:rights"[^>]*>([^<]+)</.exec(d)
          const licenseName = licM ? unescapeHtml(licM[2]).trim() : ''
          const licenseUrl = licM ? licM[1] : undefined
          const resIds = [...new Set([...d.matchAll(new RegExp(`/dataset/${escRe(slug)}/resource/([0-9a-f-]+)`, 'g'))].map((m) => m[1]))]
          const resources = []
          for (const rid of resIds) {
            const rp = await getHtml(`${ODPT_CKAN}/dataset/${slug}/resource/${rid}`)
            const name = unescapeHtml((/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/.exec(rp) || [])[1] || '').trim()
            const urls = [...new Set([...rp.matchAll(/https?:\/\/[^"<\s]+\.zip[^"<\s]*/g)].map((m) => unescapeHtml(m[0])))]
            resources.push({ rid, name, urls })
          }
          out.push({ slug, title, licenseName, licenseUrl, resources })
        } catch (e) {
          process.stdout.write(`[odpt skip] ${slug}: ${e.message}\n`)
        }
      }
    }),
  )
  return out
}

/** データセット → 索引に入れる候補（1資源＝1フィード） */
function odptCandidates(datasets) {
  const cands = []
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  for (const d of datasets) {
    if (/提供終了|廃止/.test(d.title)) continue
    let live = d.resources.filter((r) => !/提供終了|廃止/.test(r.name))
    // 「◯◯-20261001」のように日付付きの版が並ぶデータセットは、きょう以前でいちばん新しい版だけ
    // （無ければいちばん早い将来版）。古い版は時刻表の期限が切れていて、選ばれると何も出ない
    const dated = live.map((r) => ({ r, d: /-(\d{8})\b/.exec(r.name)?.[1] })).filter((x) => x.d)
    if (dated.length > 0) {
      const past = dated.filter((x) => x.d <= today).sort((a, b) => b.d.localeCompare(a.d))
      const pick = past[0] ?? dated.sort((a, b) => a.d.localeCompare(b.d))[0]
      live = [pick.r, ...live.filter((r) => !dated.some((x) => x.r === r))]
    }
    const labelBase = d.title.split(' / ')[0].trim()
    for (const r of live) {
      const pub = r.urls.find((u) => u.includes('api-public.odpt.org'))
      const tokenUrl = r.urls.find((u) => /^https:\/\/api\.odpt\.org\//.test(u))
      if (!pub && !tokenUrl) continue
      if (!pub && !ODPT_TOKEN) continue // トークンが無いと範囲を調べられない
      const feed = live.length > 1 ? `${d.slug}#${r.rid.slice(0, 8)}` : d.slug
      const rName = r.name.split(' / ')[0].replace(/-\d{8}\b/, '').trim()
      const label = live.length > 1 && rName && rName !== labelBase ? `${labelBase}（${rName}）` : labelBase
      const base = (pub ?? tokenUrl).replace(/[?&]acl:consumerKey=[^&]*/, '').replace(/\?$/, '')
      cands.push({
        org: 'odpt',
        feed,
        label,
        slug: d.slug,
        license: shortLicense(d.licenseName),
        licenseUrl: d.licenseUrl,
        url: base,
        token: pub ? undefined : true,
        probeUrl: pub ?? `${base}${base.includes('?') ? '&' : '?'}acl:consumerKey=${encodeURIComponent(ODPT_TOKEN)}`,
      })
    }
  }
  return cands
}

async function indexOdptFeed(c) {
  const p = await probeZip(c.probeUrl)
  // 「東京都交通局 バス関連情報」のような題名は、提供者＝題名の前半、名前＝agency.txt の事業者名（都営バス）にする
  const generic = /^(.+?)\s*(バス|鉄道|フェリー|船舶)関連情報/.exec(c.label)
  const provider = generic ? generic[1].trim() : (p.agency ?? c.label)
  const label = generic ? (p.agency ?? `${generic[1].trim()}（${generic[2]}）`) : c.label
  return {
    org: c.org,
    feed: c.feed,
    label,
    provider,
    prefId: 0,
    license: c.license,
    licenseUrl: c.licenseUrl,
    url: c.url,
    token: c.token,
    bbox: p.bbox,
    stops: p.stops,
    zipBytes: p.zipBytes,
    flex: p.flex,
  }
}

// ── 実行 ────────────────────────────────────────

// 前回の索引があれば、失敗したものは前回の値で補う
const previous = new Map()
try {
  const prev = JSON.parse(await readFile(outPath, 'utf8'))
  for (const f of prev.feeds ?? []) previous.set(`${f.org}/${f.feed}`, f)
} catch {
  /* 初回 */
}

const repoFeeds = ONLY === 'odpt' ? [] : await listRepoFeeds()
if (ONLY !== 'odpt') console.log(`リポジトリ：フィード ${repoFeeds.length} 件（提供終了を除く）`)
const odptDatasets = ONLY === 'repo' ? [] : await listOdptResources()
const odptCands = odptCandidates(odptDatasets)
if (ONLY !== 'repo') console.log(`ODPT：データセット ${odptDatasets.length} 件 → 候補 ${odptCands.length} 件${ODPT_TOKEN ? '（トークンあり）' : '（認証なしのみ）'}`)

const jobs = [
  ...repoFeeds.map((f) => ({ key: `${f.organization_id}/${f.feed_id}`, run: () => indexRepoFeed(f) })),
  ...odptCands.map((c) => ({ key: `${c.org}/${c.feed}`, run: () => indexOdptFeed(c) })),
]
const results = []
// 片側だけ調べ直すときは、もう片側は前回の値をそのまま使う
if (ONLY === 'odpt') for (const [, f] of previous) if (f.org !== 'odpt') results.push(f)
if (ONLY === 'repo') for (const [, f] of previous) if (f.org === 'odpt') results.push(f)
const failed = []
let i = 0
async function worker() {
  while (i < jobs.length) {
    const job = jobs[i++]
    try {
      const r = await withTimeout(job.run(), 90000, job.key)
      results.push(r)
      process.stdout.write(`[ok] ${job.key} stops=${r.stops} zip=${Math.round(r.zipBytes / 1024)}KB${r.token ? ' (token)' : ''}\n`)
    } catch (e) {
      const prev = previous.get(job.key)
      if (prev) {
        results.push(prev)
        process.stdout.write(`[prev] ${job.key}: ${e.message}（前回の値を使用）\n`)
      } else {
        failed.push({ key: job.key, error: e.message })
        process.stdout.write(`[fail] ${job.key}: ${e.message}\n`)
      }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

// 今回トークン無しで作ったときも、前回トークン付きで調べた基本ライセンスのフィードは残す
if (!ODPT_TOKEN) {
  const have = new Set(results.map((r) => `${r.org}/${r.feed}`))
  for (const [key, f] of previous) if (f.token && !have.has(key)) results.push(f)
}

// リポジトリ（県順）→ ODPT の順。重複（同じデータが両方にある）は画面側で停留所数と範囲を見て1つにする
results.sort((a, b) => (a.org === 'odpt') - (b.org === 'odpt') || a.prefId - b.prefId || a.org.localeCompare(b.org) || a.feed.localeCompare(b.feed))
await mkdir(outDir, { recursive: true })
await writeFile(
  outPath,
  JSON.stringify(
    { builtOn: new Date().toISOString().slice(0, 10), sources: ['https://www.gtfs-data.jp/', 'https://www.odpt.org/'], feeds: results },
    null,
    0,
  ) + '\n',
)
console.log(`\n[done] ${results.length} 件（うち ODPT ${results.filter((r) => r.org === 'odpt').length} 件）を ${outPath} に書き出し。失敗 ${failed.length} 件`)
for (const f of failed) console.log(`  ${f.key}: ${f.error}`)
