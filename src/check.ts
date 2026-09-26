// 住民向け確認ページ「うちから乗れる？」。
// 地図で自宅などの地点を押すと、乗れる区域の中か／近くの乗り場／予約の締切と電話番号 が分かる。
//
// 作成画面（main.ts）とは入口を分け、GTFS の読み側（flexReader の FlexView）だけを共有する。
// 画面に GTFS の項目名は出さない（CLAUDE.md 設計原則1）。高齢の方が読める文字と言葉で。
// データはデモ用に同梱した public/data/*.json（ODPT・CC BY 4.0。出典表示は必須）。

import './styles.css'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { FlexView, ViewArea, ViewStop } from './gtfs/flexReader.ts'

interface DemoSource {
  municipality: string
  serviceName: string
  provider: string
  datasetUrl: string
  license: string
  licenseUrl: string
  fetchedOn: string
}
interface DemoData {
  source: DemoSource
  view: FlexView
}

const DAY_NAMES = ['月', '火', '水', '木', '金', '土', '日']

/** いちばん近い乗り場がこれより遠ければ「エリアの外」と伝える（徒歩約25分） */
const FAR_M = 2000

function daysText(days: readonly boolean[]): string {
  if (days.every(Boolean)) return '毎日'
  if (days.slice(0, 5).every(Boolean) && !days[5] && !days[6]) return '月曜日から金曜日'
  return days.map((on, i) => (on ? DAY_NAMES[i] : null)).filter(Boolean).join('・') + '曜日'
}

function bookingText(a: ViewArea): string {
  const b = a.booking
  if (!b) return ''
  if (b.type === 0) return '予約なしで、その場で呼べます。'
  if (b.type === 2) {
    const day = b.lastDay === 1 ? '前の日' : `${b.lastDay ?? 1}日前`
    return b.lastTime ? `${day}の ${b.lastTime} までに予約してください。` : `${day}までに予約してください。`
  }
  if (b.durationMin && b.durationMin > 0) return `乗りたい時刻の ${b.durationMin}分前 までに予約してください。`
  return '当日でも予約できます。'
}

/** 地点間の距離（メートル）。近所の徒歩距離なので簡易式で足りる */
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const x = dLon * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  return R * Math.sqrt(dLat * dLat + x * x)
}

/** [経度, 緯度] の環の集まりに対する内外判定（偶奇規則。穴にも対応） */
function insideZone(lat: number, lon: number, rings: [number, number][][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── 画面 ──────────────────────────────────────

const app = document.getElementById('app')!
app.innerHTML = `
  <div class="check-layout">
    <header class="check-head">
      <div class="check-title">うちから乗れる？</div>
      <div class="check-sub" id="check-sub">読み込んでいます…</div>
    </header>
    <div class="check-map-wrap">
      <div id="map" class="map" role="application" aria-label="地図"></div>
      <div class="check-map-hint" id="map-hint">地図の、自宅など「乗りたい場所」を指で押してください</div>
    </div>
    <div id="check-panel" class="check-panel"></div>
  </div>
`

const panel = document.getElementById('check-panel')!
const sub = document.getElementById('check-sub')!

let data: DemoData
let area: ViewArea
let picked: { lat: number; lon: number } | null = null

let map: L.Map
let homeMarker: L.CircleMarker | null = null
let nearLines: L.Polyline[] = []
const stopLayer = L.layerGroup()

function mountMap(): void {
  // ビューを決める前にマーカーを足すと全部同じ点に描かれるので、仮のビューを先に設定しておく
  map = L.map(document.getElementById('map')!, { zoomControl: true }).setView([36.2, 138.3], 5)
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    maxZoom: 18,
  }).addTo(map)
  stopLayer.addTo(map)
  map.on('click', (e: L.LeafletMouseEvent) => {
    picked = { lat: e.latlng.lat, lon: e.latlng.lng }
    renderMap()
    renderPanel()
    document.getElementById('map-hint')?.setAttribute('hidden', '')
  })
}

function nearestStops(lat: number, lon: number, stops: ViewStop[], n: number): { stop: ViewStop; m: number }[] {
  return stops
    .map((stop) => ({ stop, m: distanceM(lat, lon, stop.lat, stop.lon) }))
    .sort((a, b) => a.m - b.m)
    .slice(0, n)
}

function renderMap(): void {
  stopLayer.clearLayers()
  for (const z of [...area.board.zones, ...area.alight.zones]) {
    L.polygon(
      z.rings.map((ring) => ring.map(([lng, lat]) => [lat, lng] as L.LatLngExpression)),
      { color: '#34a06a', weight: 3, fillOpacity: 0.14 },
    ).addTo(stopLayer)
  }
  for (const st of area.board.stops) {
    L.circleMarker([st.lat, st.lon], { radius: 6, color: '#4a80e0', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(st.name, { direction: 'top', offset: [0, -6] })
      .addTo(stopLayer)
  }

  if (homeMarker) homeMarker.remove()
  homeMarker = null
  for (const l of nearLines) l.remove()
  nearLines = []
  if (picked) {
    homeMarker = L.circleMarker([picked.lat, picked.lon], {
      radius: 11,
      color: '#b0416f',
      weight: 4,
      fillColor: '#f3a4c0',
      fillOpacity: 0.9,
    })
      .bindTooltip('乗りたい場所', { permanent: true, direction: 'top', offset: [0, -10], className: 'stop-label' })
      .addTo(map)
    for (const { stop } of nearestStops(picked.lat, picked.lon, area.board.stops, 3).filter(({ m }) => m <= FAR_M)) {
      nearLines.push(
        L.polyline(
          [
            [picked.lat, picked.lon],
            [stop.lat, stop.lon],
          ],
          { color: '#b0416f', weight: 3, dashArray: '4 7', opacity: 0.8 },
        ).addTo(map),
      )
    }
  }
}

function pickedCard(): string {
  if (!picked) {
    return `<section class="check-card">
      <h2>つかいかた</h2>
      <p class="check-big">上の地図で、自宅など<b>「乗りたい場所」を指で押して</b>ください。近くの乗り場をお知らせします。</p>
    </section>`
  }
  const zones = area.board.zones
  let zoneLine = ''
  if (zones.length > 0) {
    const inside = zones.some((z) => insideZone(picked!.lat, picked!.lon, z.rings))
    zoneLine = inside
      ? `<p class="check-yes">この場所は、乗れる範囲の<b>中</b>です 🙆</p>`
      : `<p class="check-no">この場所は、乗れる範囲の<b>外</b>のようです。下の乗り場までお越しください。</p>`
  }
  const near = nearestStops(picked.lat, picked.lon, area.board.stops, 3)

  // いちばん近い乗り場まで歩けない距離なら、徒歩何分とは言わずに「エリアの外」と伝える
  if (near.length > 0 && near[0].m > FAR_M) {
    const km = near[0].m >= 9500 ? String(Math.round(near[0].m / 1000)) : (near[0].m / 1000).toFixed(1)
    return `<section class="check-card">
      <h2>近くの乗り場</h2>
      <p class="check-no check-big">この場所は、このサービスが走っている<b>エリアの外</b>のようです。</p>
      <p>いちばん近い乗り場は <b>${esc(near[0].stop.name)}</b>（約${km}km 先）です。</p>
      <p class="check-small">別の場所を調べるときは、もう一度地図を押してください。</p>
    </section>`
  }

  const items = near
    .map(({ stop, m }) => {
      const min = Math.max(1, Math.ceil(m / 80))
      const walk =
        m < 30
          ? 'すぐそば'
          : `歩いて約${min}分（${m >= 950 ? `${(m / 1000).toFixed(1)}km` : `${Math.max(10, Math.round(m / 10) * 10)}m`}）`
      return `<li><b>${esc(stop.name)}</b><span class="check-walk">${walk}</span></li>`
    })
    .join('')
  return `<section class="check-card">
    <h2>近くの乗り場</h2>
    ${zoneLine}
    <ol class="check-near">${items}</ol>
    <p class="check-small">歩く時間はまっすぐ測った目安です。道のりではもう少しかかることがあります。</p>
  </section>`
}

function renderPanel(): void {
  const s = data.source
  const b = area.booking
  const windows = area.windows.map((w) => `${w.start}〜${w.end}`).join('、')
  const closedNote = area.closedDates.length > 0 ? '（年末年始などお休みの日があります）' : ''

  const phone = b?.phone ?? data.view.agencyPhone
  const bookingLines = [
    b?.message ? `<p>${esc(b.message)}</p>` : '',
    `<p class="check-big">${esc(bookingText(area))}</p>`,
    phone
      ? `<a class="check-call" href="tel:${esc(phone.replace(/[^\d+-]/g, ''))}">📞 電話で予約する<span>${esc(phone)}</span></a>`
      : '',
    b?.bookingUrl ? `<p><a href="${esc(b.bookingUrl)}" target="_blank" rel="noopener">インターネットで予約する</a></p>` : '',
    b?.infoUrl ? `<p><a href="${esc(b.infoUrl)}" target="_blank" rel="noopener">くわしい案内を見る</a></p>` : '',
  ].join('')

  panel.innerHTML = `
    ${pickedCard()}
    <section class="check-card">
      <h2>いつ走っている？</h2>
      <p class="check-big"><b>${esc(daysText(area.days))}</b>の <b>${esc(windows)}</b> ${closedNote}</p>
    </section>
    <section class="check-card">
      <h2>予約のしかた</h2>
      ${bookingLines}
    </section>
    <footer class="check-foot">
      <p>このページは公式の案内ではありません。最新の運行・予約方法は ${esc(s.provider)} の案内でご確認ください。</p>
      <p>データ出典：${esc(s.provider)}「${esc(s.serviceName)}」（<a href="${esc(s.datasetUrl)}" target="_blank" rel="noopener">公共交通オープンデータセンター</a>、<a href="${esc(s.licenseUrl)}" target="_blank" rel="noopener">${esc(s.license)}</a>）／ ${esc(s.fetchedOn)} 取得</p>
    </footer>
  `
}

async function main(): Promise<void> {
  mountMap()
  const res = await fetch('./data/mizuho_town_mizuho_area.json')
  if (!res.ok) {
    sub.textContent = 'データを読み込めませんでした'
    return
  }
  data = (await res.json()) as DemoData
  area = data.view.areas[0]
  sub.textContent = `${data.source.municipality}「${data.source.serviceName}」`
  document.title = `うちから乗れる？ — ${data.source.serviceName}`
  renderMap()
  renderPanel()

  // CSS の適用が一瞬遅れて、この時点でも地図のコンテナが 0px のことがある
  // （そのまま fitBounds すると最大ズームに飛ぶ）。サイズが付いてから一度だけ全体に寄せる。
  // ResizeObserver は画面回転やパネルの伸縮でも invalidateSize してくれる
  const fitArea = (): void => {
    const pts = area.board.stops.map((st) => [st.lat, st.lon] as L.LatLngExpression)
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), { padding: [20, 20], animate: false })
    else map.setView([35.77, 139.35], 13, { animate: false })
  }
  let fitted = false
  const tryFit = (): void => {
    map.invalidateSize()
    if (!fitted && map.getSize().y > 0) {
      fitted = true
      fitArea()
    }
  }
  new ResizeObserver(tryFit).observe(document.getElementById('map')!)
  tryFit()
}

void main()
