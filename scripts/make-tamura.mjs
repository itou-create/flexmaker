// 田村市デマンドタクシー「田村らくらくタクシー」の GTFS-Flex zip を生成する。
// データ定義は src/gtfs/tamura.ts（画面の「実例を読み込む」と共通）。
// 画面と同じ変換エンジン（flexWriter → validate → zip）を通す。
//
// 使い方: node scripts/make-tamura.mjs [出力フォルダ]   （省略時 samples/）

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildFlexFiles } from '../src/gtfs/flexWriter.ts'
import { validateFlexFiles } from '../src/gtfs/validate.ts'
import { buildZip } from '../src/gtfs/zip.ts'
import { tamuraService } from '../src/gtfs/tamura.ts'

const outDir = process.argv[2] ?? join(process.cwd(), 'samples')
await mkdir(outDir, { recursive: true })

const files = buildFlexFiles(tamuraService())
const issues = validateFlexFiles(files)
for (const i of issues) console.log(`[${i.level}] ${i.file}: ${i.message}`)
if (issues.some((i) => i.level === 'error')) {
  console.error('エラーがあるため zip は出力しない')
  process.exit(1)
}

const zipPath = join(outDir, 'tamura_rakuraku.zip')
await writeFile(zipPath, buildZip(files))
console.log(`[ok] ${zipPath}`)
console.log(`ファイル: ${Object.keys(files).join(', ')}`)
