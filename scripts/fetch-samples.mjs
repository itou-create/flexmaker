// ODPT の GTFS-Flex データセット（CC BY 4.0）を samples/ にダウンロードする。
// 使い方: npm run fetch-samples
//
// 2026-09-26 変更：ckan.odpt.org の CKAN API（/api/3/action/…）が JSON を返さなくなった
// （どのパスでもカタログの HTML が返る）。データセットページ → リソースページとたどり、
// api-public.odpt.org の直リンクを拾う方式に変更。
//
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

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`)
  return res.text()
}

for (const id of IDS) {
  try {
    const page = await fetchText(`https://ckan.odpt.org/dataset/${id}`)
    const resourcePaths = [...page.matchAll(new RegExp(`href="(/dataset/${id}/resource/[0-9a-f-]+)"`, 'g'))]
      .map((m) => m[1])
    const unique = [...new Set(resourcePaths)]
    if (unique.length === 0) {
      console.warn(`[skip] ${id}: リソースページへのリンクが見つからない`)
      continue
    }
    const urls = new Set()
    for (const path of unique) {
      const rpage = await fetchText(`https://ckan.odpt.org${path}`)
      // 認証不要の api-public 直リンクだけ拾う（acl:consumerKey 付きの api.odpt.org は使わない）
      for (const m of rpage.matchAll(/href="(https:\/\/api-public\.odpt\.org\/[^"]+\.zip[^"]*)"/g)) {
        urls.add(m[1].replaceAll('&amp;', '&'))
      }
    }
    if (urls.size === 0) {
      console.warn(`[skip] ${id}: api-public の zip リンクが見つからない`)
      continue
    }
    let i = 0
    for (const url of urls) {
      const bin = await fetch(url)
      if (!bin.ok) throw new Error(`HTTP ${bin.status} (${url})`)
      const name = urls.size === 1 ? `${id}.zip` : `${id}__${++i}.zip`
      await writeFile(join(out, name), Buffer.from(await bin.arrayBuffer()))
      console.log(`[ok] ${name}`)
    }
  } catch (e) {
    console.error(`[fail] ${id}: ${e.message}`)
  }
}
