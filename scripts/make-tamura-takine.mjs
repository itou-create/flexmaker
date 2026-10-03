// 田村市デマンドタクシー「田村らくらくタクシー」の滝根エリア（町内移動）を、
// flexmaker の入力モデルに起こして GTFS-Flex zip を生成する試作スクリプト。
// 画面と同じ変換エンジン（flexWriter → validate → zip）を通す。
//
// 使い方: node scripts/make-tamura-takine.mjs [出力フォルダ]   （省略時 samples/）
//
// 出典（2026-10-03 閲覧）：田村市「田村らくらくタクシー」利用ガイド（令和6年4月1日発行）
// https://www.city.tamura.lg.jp/soshiki/1/rakuraku.html
//   - 予約：利用30分前まで電話/LINE。受付 7:00〜17:30。6:30〜7:30発の便は前日16:30まで
//   - 運休：日曜・祝日・年末年始（12/29〜1/3）
//   - 乗降：自宅付近の公道まで迎えに来る（＝区域方式）
//   - 滝根町内の移動 300円。時刻表制（町内便 7:30〜17:00、時刻は目安）
//
// このスクリプトで表しきれていないこと（flexmaker の今の制限）：
//   - 5エリア（滝根・大越・都路・常葉・船引）のうち滝根町内だけ。エリア間の便は未対応（複数区域はロードマップ）
//   - 祝日・年末年始の運休（calendar_dates 未出力）→ 予約案内文に書いて補う
//   - 6:30〜7:30発の前日締切の例外（予約ルールは1つ）→ 同上
//   - 区域ポリゴンは滝根町のおおよその範囲。正確な行政界ではない

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildFlexFiles } from '../src/gtfs/flexWriter.ts'
import { validateFlexFiles } from '../src/gtfs/validate.ts'
import { buildZip } from '../src/gtfs/zip.ts'

/** @type {import('../src/types.ts').DemandService} */
const service = {
  agency: {
    id: 'tamura_city',
    name: '田村市（田村市公共交通活性化協議会）',
    url: 'https://www.city.tamura.lg.jp/soshiki/1/rakuraku.html',
    phone: '0247-82-3000',
  },
  routeId: 'tamura_rakuraku_takine',
  routeName: '田村らくらくタクシー（滝根町内）',
  pattern: 'zone_only',
  zone: {
    id: 'zone_takine',
    name: '滝根町内（おおよその範囲）',
    // [経度, 緯度]。滝根町の概形（行政界の正確なトレースではない）
    polygon: [
      [140.625, 37.33],
      [140.635, 37.365],
      [140.675, 37.375],
      [140.715, 37.355],
      [140.735, 37.32],
      [140.715, 37.285],
      [140.675, 37.27],
      [140.64, 37.29],
    ],
  },
  stops: [],
  bookingRule: {
    id: 'booking_1',
    type: 1,
    priorNoticeDurationMin: 30,
    message:
      '予約は乗る30分前まで（電話受付 7:00〜17:30、LINEは24時間）。朝6:30〜7:30発の便は前日16:30までに予約。日曜・祝日・年末年始（12/29〜1/3）は運休。町内の移動は300円',
    phone: '0247-82-3000',
    infoUrl: 'https://www.city.tamura.lg.jp/soshiki/1/rakuraku.html',
  },
  calendar: {
    id: 'service_1',
    // 月〜土（祝日・年末年始の運休は calendar_dates 未対応のため表せていない）
    days: [true, true, true, true, true, true, false],
    startDate: '20260401',
    endDate: '20270331',
  },
  // 町内便は 7:30〜17:00 の時刻表制（時刻は目安）。ODPT の実データ流儀に合わせて1日1窓で表す
  windows: [{ start: '07:30', end: '17:30' }],
  feedPublisherName: '田村市',
  feedPublisherUrl: 'https://www.city.tamura.lg.jp/',
}

const outDir = process.argv[2] ?? join(process.cwd(), 'samples')
await mkdir(outDir, { recursive: true })

const files = buildFlexFiles(service)
const issues = validateFlexFiles(files)
for (const i of issues) console.log(`[${i.level}] ${i.file}: ${i.message}`)
if (issues.some((i) => i.level === 'error')) {
  console.error('エラーがあるため zip は出力しない')
  process.exit(1)
}

const zipPath = join(outDir, 'tamura_rakuraku_takine.zip')
await writeFile(zipPath, buildZip(files))
console.log(`[ok] ${zipPath}`)
for (const [name, text] of Object.entries(files)) {
  console.log(`---- ${name} ----`)
  console.log(text.trimEnd())
}
