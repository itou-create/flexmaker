// ODPT の GTFS-Flex データセット（CC BY 4.0）を samples/ にダウンロードする。
// 使い方: npm run fetch-samples
// ネットワーク制限のある環境（社内プロキシ等）では動かないことがある。その場合はブラウザで
// https://ckan.odpt.org/dataset/?tags=GTFS-Flex から手で落として samples/ に置く。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const IDS = [
  'swat_hakuba_demand_taxi',
  'ai-hakuba-village-on-demand-taxi-fure-ai',
  'miraishare_fukuchi_fukurubus',
  'miraishare_maebashi_demand',
  'nextmobility_umi_knowroute',
  'munakata-city-on-demand-bus-knowroute',
  'junpuzi_kawagoe_kawamaru',
  'kinokawa-city-demand-shared-transportation-norinori-transportation',
  'monet_annaka_ai_shinkotsu',
  'monet_tomioka_ai_taku',
  'ai-showa-village-ai-on-demand-bus-veggie-bus',
  'go-tamamura-town-on-demand-taxi-tama-go',
  'sakai-city-on-demand-transportation-etaku',
  'monet_hirakawa_norassa',
  'mizuho_town_mizuho_area',
]

const out = join(process.cwd(), 'samples')
await mkdir(out, { recursive: true })

for (const id of IDS) {
  try {
    const res = await fetch(`https://ckan.odpt.org/api/3/action/package_show?id=${id}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const pkg = (await res.json()).result
    const zips = pkg.resources.filter((r) => /zip/i.test(r.format) || /\.zip($|\?)/i.test(r.url))
    if (zips.length === 0) {
      console.warn(`[skip] ${id}: zip リソースが見つからない（resources: ${pkg.resources.map((r) => r.format).join(', ')}）`)
      continue
    }
    for (const r of zips) {
      const bin = await fetch(r.url)
      if (!bin.ok) throw new Error(`HTTP ${bin.status} (${r.url})`)
      const name = zips.length === 1 ? `${id}.zip` : `${id}__${r.name.replace(/[^\w.-]+/g, '_')}.zip`
      await writeFile(join(out, name), Buffer.from(await bin.arrayBuffer()))
      console.log(`[ok] ${name}  (${pkg.title} / ${pkg.license_title ?? 'license?'})`)
    }
  } catch (e) {
    console.error(`[fail] ${id}: ${e.message}`)
  }
}
