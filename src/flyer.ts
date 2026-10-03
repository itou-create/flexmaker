// 簡易チラシページ。エリアごとに A4 1枚の案内を作り、そのまま印刷できる。
// 回覧板・公民館や病院の掲示板向け。大きな文字・大きな電話番号で。
//
// データの入口は住民ページ（check.ts）と同じ2通り：
//   - 同梱デモ（public/data/*.json）
//   - #preview：作成画面が localStorage に置いた作りかけデータ
// 地図はタイルを使わず、区域の形を SVG で描く（印刷時にタイルの読み込み待ちで欠けるのを避ける）。
// QR コードは外部サービス（api.qrserver.com）で画像化し、失敗したら URL の文字だけ残す。
// ※自前の QR 生成に置き換えるのは今後の課題（CLAUDE.md）

import './styles.css'
import type { FlexView, ViewArea } from './gtfs/flexReader.ts'
import { loadPreview } from './preview'
import { areaColor } from './areaColors'
import { bookingText, daysText, windowsText } from './viewText'

const PAGE_URL = 'https://itou-create.github.io/flexmaker/check.html'

interface DemoSource {
  municipality: string
  serviceName: string
  provider: string
  datasetUrl: string
  license: string
  fetchedOn: string
}
interface DemoData {
  source?: DemoSource
  view: FlexView
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 区域と乗り場を、タイル無しの小さな地図（SVG）にする */
function zoneSvg(a: ViewArea, colorIndex: number): string {
  const pts: [number, number][] = []
  for (const z of [...a.board.zones, ...a.alight.zones]) for (const ring of z.rings) pts.push(...ring)
  for (const st of [...a.board.stops, ...a.alight.stops]) pts.push([st.lon, st.lat])
  if (pts.length < 3) return ''
  const lons = pts.map((p) => p[0])
  const lats = pts.map((p) => p[1])
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  // 緯度方向と横方向の縮尺を合わせる（経度は cos(緯度) で縮む）
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180))
  const W = 460
  const spanX = (maxLon - minLon) * kx || 1e-6
  const spanY = maxLat - minLat || 1e-6
  const H = Math.max(200, Math.min(420, (W * spanY) / spanX))
  const sx = (lon: number): number => (((lon - minLon) * kx) / spanX) * (W - 20) + 10
  const sy = (lat: number): number => ((maxLat - lat) / spanY) * (H - 20) + 10
  const color = areaColor(colorIndex)

  const zonePaths = [...a.board.zones, ...a.alight.zones]
    .flatMap((z) => z.rings)
    .map((ring) => `M${ring.map(([lon, lat]) => `${sx(lon).toFixed(1)} ${sy(lat).toFixed(1)}`).join('L')}Z`)
    .map((d) => `<path d="${d}" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-width="2.5"/>`)
    .join('')
  const seen = new Set<string>()
  const stopDots = [...a.board.stops, ...a.alight.stops]
    .filter((st) => !seen.has(st.id) && seen.add(st.id))
    .map((st) => `<circle cx="${sx(st.lon).toFixed(1)}" cy="${sy(st.lat).toFixed(1)}" r="3" fill="#fff" stroke="${color}" stroke-width="1.6"/>`)
    .join('')
  return `<svg viewBox="0 0 ${W} ${Math.round(H)}" role="img" aria-label="運行範囲のかたち">${zonePaths}${stopDots}</svg>`
}

function flyerHtml(a: ViewArea, i: number, data: DemoData): string {
  const b = a.booking
  const phone = b?.phone ?? data.view.agencyPhone ?? ''
  const muni = data.source ? data.source.municipality : data.view.agencyName
  const closedNote = a.closedDates.length > 0 ? '（祝日・年末年始などお休みの日があります）' : ''
  const notes = a.otherBookings.map((x) => (x.message ? `<p class="flyer-note">※ ${esc(x.message)}</p>` : '')).join('')
  const stopCount = new Set([...a.board.stops, ...a.alight.stops].map((s) => s.id)).size
  const mapCaption =
    a.board.zones.length > 0
      ? '色のついた範囲の中から乗れます（自宅前など。予約制）'
      : `乗り降りできる場所は約${stopCount}か所あります`
  const src = data.source
    ? `データ出典：${esc(data.source.provider)}「${esc(data.source.serviceName)}」（公共交通オープンデータセンター、${esc(data.source.license)}）`
    : 'このチラシは作成中のデータから作られています（試作・公式の案内ではありません）'

  return `<article class="flyer">
    <header class="flyer-head" style="border-color:${areaColor(i)}">
      <div class="flyer-kicker">予約して乗る、のりあい交通のご案内</div>
      <h1>${esc(a.name)}</h1>
      ${muni ? `<div class="flyer-muni">${esc(muni)}</div>` : ''}
    </header>
    <div class="flyer-cols">
      <div class="flyer-map">
        ${zoneSvg(a, i)}
        <p class="flyer-caption">${esc(mapCaption)}</p>
      </div>
      <div class="flyer-info">
        <section><h2>走っている日</h2>
          <p class="flyer-big">${esc(daysText(a.days))}<br>${esc(windowsText(a))}</p>
          ${closedNote ? `<p class="flyer-note">${esc(closedNote)}</p>` : ''}
        </section>
        <section><h2>予約のしかた</h2>
          <p class="flyer-big">${esc(bookingText(a))}</p>
          ${b?.message ? `<p class="flyer-note">${esc(b.message)}</p>` : ''}
          ${notes}
        </section>
        <div class="flyer-phone">
          <span>予約のお電話</span>
          <strong>${esc(phone)}</strong>
        </div>
      </div>
    </div>
    <footer class="flyer-foot">
      <div class="flyer-qr">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(PAGE_URL)}" alt="確認ページのQRコード" onerror="this.remove()">
        <div class="flyer-qr-text"><b>スマホで「うちから乗れる？」を確認</b><br>${esc(PAGE_URL)}</div>
      </div>
      <div class="flyer-src">${src}</div>
    </footer>
  </article>`
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!
  let data: DemoData
  if (location.hash === '#preview') {
    const p = loadPreview()
    if (!p || p.view.areas.length === 0) {
      app.innerHTML = `<div class="flyer-toolbar"><p>チラシにするデータが見つかりません。作成画面から開き直してください。</p></div>`
      return
    }
    data = { view: p.view }
  } else {
    const res = await fetch('./data/mizuho_town_mizuho_area.json')
    if (!res.ok) {
      app.innerHTML = `<div class="flyer-toolbar"><p>データを読み込めませんでした。</p></div>`
      return
    }
    data = (await res.json()) as DemoData
  }

  document.title = `チラシ印刷 — ${data.source?.serviceName ?? data.view.areas[0]?.name ?? 'デマンド交通'}`
  app.innerHTML = `
    <div class="flyer-toolbar no-print">
      <div>
        <strong>チラシ印刷</strong>
        <span>エリアごとに A4 1枚です。プリント画面で必要なページだけ選べます。</span>
      </div>
      <button type="button" id="print-btn" class="primary">印刷する</button>
    </div>
    ${data.view.areas.map((a, i) => flyerHtml(a, i, data)).join('')}
  `
  document.getElementById('print-btn')?.addEventListener('click', () => window.print())
}

void main()
