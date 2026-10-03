// 田村市の旧5町村（滝根・大越・都路・常葉・船引）の行政区域ポリゴンを取得し、
// 頂点を間引いて src/gtfs/tamura-zones.ts を生成する。
//
// 使い方: node scripts/fetch-tamura-zones.mjs [キャッシュフォルダ]
//   キャッシュフォルダに <コード>.geojson があればそれを使う（サーバは連続アクセスを切ることがある）
//
// 出典：「歴史的行政区域データセットβ版」（人文学オープンデータ共同利用センター CODH 作成、
// 国土数値情報 行政区域データを加工したもの、CC BY-SA 4.0）
// https://geoshape.ex.nii.ac.jp/city/
// 2005年の合併直前（2000-10-01 時点）の旧町村界を使う。
// 頂点は Douglas-Peucker で約40〜80mまで間引く（デマンド交通の区域表示には十分な精度）。

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const TOWNS = [
  { code: '07523', key: 'takine', name: '滝根町' },
  { code: '07524', key: 'ogoe', name: '大越町' },
  { code: '07525', key: 'miyakoji', name: '都路村' },
  { code: '07526', key: 'tokiwa', name: '常葉町' },
  { code: '07527', key: 'funehiki', name: '船引町' },
]

/** 線分 ab から点 p までの距離（度のままの近似で十分） */
function perpDist(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Douglas-Peucker。eps は度（緯度1度 ≒ 111km なので 0.0005 ≒ 55m） */
function simplify(points, eps) {
  if (points.length <= 2) return points
  let maxD = 0
  let maxI = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1])
    if (d > maxD) {
      maxD = d
      maxI = i
    }
  }
  if (maxD <= eps) return [points[0], points[points.length - 1]]
  const left = simplify(points.slice(0, maxI + 1), eps)
  const right = simplify(points.slice(maxI), eps)
  return [...left.slice(0, -1), ...right]
}

const round5 = (n) => Math.round(n * 1e5) / 1e5

const cacheDir = process.argv[2]
const out = []
for (const t of TOWNS) {
  let gj
  if (cacheDir) {
    try {
      gj = JSON.parse(await readFile(join(cacheDir, `${t.code}.geojson`), 'utf8'))
    } catch {
      /* キャッシュに無ければ取りに行く */
    }
  }
  if (!gj) {
    const url = `https://geoshape.ex.nii.ac.jp/city/geojson/20001001/07/${t.code}A1968.geojson`
    for (let tryN = 1; ; tryN++) {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        gj = await res.json()
        break
      } catch (e) {
        if (tryN >= 3) throw new Error(`${e.message} (${url})`)
        await sleep(2000)
      }
    }
    await sleep(1000)
  }
  const f = gj.features ? gj.features[0] : gj
  // MultiPolygon から最大のポリゴンの外環だけ使う（飛び地は無視）
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  const outer = polys.map((p) => p[0]).sort((a, b) => b.length - a.length)[0]
  // 閉じの重複点を外してから間引き、点数が多すぎれば eps を上げる
  const ring = outer.slice(0, -1)
  let eps = 0.0004
  let simplified = simplify([...ring, ring[0]], eps).slice(0, -1)
  while (simplified.length > 120) {
    eps *= 1.5
    simplified = simplify([...ring, ring[0]], eps).slice(0, -1)
  }
  out.push({ ...t, points: simplified.map(([x, y]) => [round5(x), round5(y)]) })
  console.log(`${t.name}: ${outer.length - 1} → ${simplified.length} 点 (eps=${eps})`)
}

const ts = `// 田村市の旧5町村の区域ポリゴン（[経度, 緯度]）。scripts/fetch-tamura-zones.mjs が生成する。手で編集しない。
//
// 出典：「歴史的行政区域データセットβ版」（CODH 作成、国土数値情報 行政区域データを加工、CC BY-SA 4.0）
// https://geoshape.ex.nii.ac.jp/city/ の 2000-10-01 時点の旧町村界。
// 頂点は約40〜80mに間引き済み（表示・区域内判定用。測量成果ではない）。

export const TAMURA_ZONES: Record<string, [number, number][]> = {
${out.map((t) => `  // ${t.name}（${t.points.length}点）\n  ${t.key}: ${JSON.stringify(t.points)},`).join('\n')}
}
`
const outPath = join(process.cwd(), 'src', 'gtfs', 'tamura-zones.ts')
await writeFile(outPath, ts)
console.log(`[ok] ${outPath}`)
