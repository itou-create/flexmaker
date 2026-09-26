// 展開済みの GTFS-Flex フィード（txt / geojson の入ったフォルダ）を、
// 住民向け確認ページで使う JSON（public/data/<id>.json）に変換する。
//
// 使い方:
//   1. samples/ の zip をフォルダに展開する（例: PowerShell の Expand-Archive）
//   2. node scripts/convert-sample.mjs <展開したフォルダ> <データセットID>
//      例: node scripts/convert-sample.mjs C:\tmp\mizuho mizuho_town_mizuho_area
//
// 変換ロジックは src/gtfs/flexReader.ts と共通（Node 24 は .ts をそのまま実行できる）。
// 出典情報（CC BY 4.0 の表示義務）は下の SOURCES に持つ。画面はこれを必ず表示する。

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readFlexFiles } from '../src/gtfs/flexReader.ts'

// データセットID → 出典表示。ODPT データカタログ（https://ckan.odpt.org/dataset/<id>）の記載に合わせる
const SOURCES = {
  mizuho_town_mizuho_area: {
    municipality: '瑞穂町（東京都）',
    serviceName: 'チョイソコみずほまち',
    provider: '瑞穂町',
    datasetUrl: 'https://ckan.odpt.org/dataset/mizuho_town_mizuho_area',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
  },
}

const [dir, id] = process.argv.slice(2)
if (!dir || !id) {
  console.error('使い方: node scripts/convert-sample.mjs <展開したフォルダ> <データセットID>')
  process.exit(1)
}
const source = SOURCES[id]
if (!source) {
  console.error(`SOURCES に ${id} の出典情報が無い。scripts/convert-sample.mjs に追記してから実行する`)
  process.exit(1)
}

const files = {}
for (const f of await readdir(dir)) {
  if (f.endsWith('.txt') || f.endsWith('.geojson')) files[f] = await readFile(join(dir, f), 'utf8')
}
const view = readFlexFiles(files)
if (view.areas.length === 0) {
  console.error('エリアが1つも読めなかった（stop_times.txt / trips.txt を確認）')
  process.exit(1)
}

const out = {
  source: { ...source, fetchedOn: new Date().toISOString().slice(0, 10), feedVersion: view.feedVersion },
  view,
}
const outDir = join(process.cwd(), 'public', 'data')
await mkdir(outDir, { recursive: true })
const outPath = join(outDir, `${id}.json`)
await writeFile(outPath, JSON.stringify(out, null, 1) + '\n')
console.log(`[ok] ${outPath}`)
for (const a of view.areas) {
  console.log(`  ${a.name}: 乗り場 ${a.board.stops.length} / 降り場 ${a.alight.stops.length} / 区域 ${a.board.zones.length + a.alight.zones.length} / 便 ${a.windows.length}`)
}
