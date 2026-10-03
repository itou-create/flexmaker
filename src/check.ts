// 住民向け確認ページ「うちから乗れる？」。
// 地図で自宅などの地点を押すと、乗れる区域の中か／近くの乗り場／予約の締切と電話番号 が分かる。
//
// 作成画面（main.ts）とは入口を分け、GTFS の読み側（flexReader の FlexView）だけを共有する。
// 画面に GTFS の項目名は出さない（CLAUDE.md 設計原則1）。高齢の方が読める文字と言葉で。
// データは2通り：
//   - デモ用に同梱した public/data/*.json（ODPT・CC BY 4.0。出典表示は必須）
//   - #preview で開かれたとき：作成画面が localStorage に置いた作りかけデータ（src/preview.ts）

import './styles.css'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { normalizeView, type FlexView, type ViewArea, type ViewStop } from './gtfs/flexReader.ts'
import { loadPreview } from './preview'
import { areaColor } from './areaColors'
import { bookingText, daysText, windowsText } from './viewText'
import { bookingNow } from './bookingNow'
import { getGoogleMapsKey } from './mapsKey'
import type { NoticeItem } from './types'

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
  /** 同梱データのときだけある。無ければプレビュー表示 */
  source?: DemoSource
  view: FlexView
  notices?: NoticeItem[]
}

/** いちばん近い乗り場がこれより遠ければ「エリアの外」と伝える（徒歩約25分） */
const FAR_M = 2000

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

// 「いま予約できる？」の判定は src/bookingNow.ts（サイネージと共用）

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

// ── 地図エンジン ─────────────────────────────
// Google マップ（運営側キーがあり Maps JavaScript API が使えるとき）を優先し、
// 使えなければ Leaflet ＋ 地理院タイルに自動で切り替える（キー無し・API未有効・
// 社内ネットワークで Google がブロック、どの場合でもページは動く）。

let lmap: L.Map | null = null
let lHome: L.CircleMarker | null = null
let lLines: L.Polyline[] = []
const lStopLayer = L.layerGroup()

// Google 側。型パッケージを増やさないため any で扱う
/* eslint-disable @typescript-eslint/no-explicit-any */
let gmap: any = null
let gShapes: any[] = []
let gHome: any = null
let gLines: any[] = []

const gapi = (): any => (window as unknown as { google?: unknown }).google

/** 地図のタップ（両エンジン共通の処理） */
function handleTap(lat: number, lon: number): void {
  picked = { lat, lon }
  // 押した場所が別のエリアの区域の中なら、そのエリアに切り替える
  // （住民はエリアの境目を知らないので、地図に任せる）
  const hit = data.view.areas.find((x) =>
    [...x.board.zones, ...x.alight.zones].some((z) => insideZone(lat, lon, z.rings)),
  )
  if (hit && hit !== area) area = hit
  renderMap()
  renderPanel()
  document.getElementById('map-hint')?.setAttribute('hidden', '')
}

function loadGoogleScript(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 7000)
    const w = window as unknown as Record<string, unknown>
    w.__gmapsReady = () => {
      clearTimeout(t)
      resolve(true)
    }
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=ja&region=JP&loading=async&callback=__gmapsReady`
    s.onerror = () => {
      clearTimeout(t)
      resolve(false)
    }
    document.head.appendChild(s)
  })
}

/** Google の地図を試す。キー無し・読み込み失敗・認証エラー（API未有効等）なら false */
async function tryGoogleMap(el: HTMLElement): Promise<boolean> {
  const key = getGoogleMapsKey()
  if (!key) return false
  let failed = false
  ;(window as unknown as Record<string, unknown>).gm_authFailure = () => {
    failed = true
  }
  if (!(await loadGoogleScript(key))) return false
  const g = gapi()
  if (!g?.maps) return false
  gmap = new g.maps.Map(el, {
    center: { lat: 36.2, lng: 138.3 },
    zoom: 5,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: 'greedy',
  })
  gmap.addListener('click', (e: any) => handleTap(e.latLng.lat(), e.latLng.lng()))
  // 認証エラー（ApiNotActivatedMapError 等）は読み込みの少し後に届くので、短く待って判定
  await new Promise((r) => setTimeout(r, 1500))
  if (failed) {
    gmap = null
    el.innerHTML = ''
    return false
  }
  return true
}

function mountLeaflet(el: HTMLElement): void {
  // ビューを決める前にマーカーを足すと全部同じ点に描かれるので、仮のビューを先に設定しておく
  lmap = L.map(el, { zoomControl: true }).setView([36.2, 138.3], 5)
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    maxZoom: 18,
  }).addTo(lmap)
  lStopLayer.addTo(lmap)
  lmap.on('click', (e: L.LeafletMouseEvent) => handleTap(e.latlng.lat, e.latlng.lng))
}

async function mountMap(): Promise<void> {
  const el = document.getElementById('map')!
  if (await tryGoogleMap(el)) return
  mountLeaflet(el)
}

function nearestStops(lat: number, lon: number, stops: ViewStop[], n: number): { stop: ViewStop; m: number }[] {
  return stops
    .map((stop) => ({ stop, m: distanceM(lat, lon, stop.lat, stop.lon) }))
    .sort((a, b) => a.m - b.m)
    .slice(0, n)
}

/** いま見ているエリアの乗降場所（乗る側＋降りる側、重複なし） */
function mapStopsOf(a: ViewArea): ViewStop[] {
  const out = [...a.board.stops]
  for (const st of a.alight.stops) if (!out.some((x) => x.id === st.id)) out.push(st)
  return out
}

function renderMap(): void {
  if (gmap) renderGoogleMap()
  else renderLeafletMap()
}

function renderGoogleMap(): void {
  const g = gapi()
  for (const s of gShapes) s.setMap(null)
  gShapes = []
  // 区域は全エリア分を色分けで描く。見ているエリアだけ濃く
  data.view.areas.forEach((x, i) => {
    const active = x === area
    for (const z of [...x.board.zones, ...x.alight.zones]) {
      gShapes.push(
        new g.maps.Polygon({
          map: gmap,
          paths: z.rings.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
          strokeColor: areaColor(i),
          strokeWeight: active ? 3 : 1.5,
          strokeOpacity: active ? 1 : 0.55,
          fillColor: areaColor(i),
          fillOpacity: active ? 0.14 : 0.05,
          clickable: false,
        }),
      )
    }
  })
  for (const st of mapStopsOf(area)) {
    gShapes.push(
      new g.maps.Marker({
        map: gmap,
        position: { lat: st.lat, lng: st.lon },
        title: st.name,
        clickable: false,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#ffffff', fillOpacity: 1, strokeColor: '#4a80e0', strokeWeight: 2 },
      }),
    )
  }

  if (gHome) gHome.setMap(null)
  gHome = null
  for (const l of gLines) l.setMap(null)
  gLines = []
  if (picked) {
    gHome = new g.maps.Marker({
      map: gmap,
      position: { lat: picked.lat, lng: picked.lon },
      title: '乗りたい場所',
      clickable: false,
      zIndex: 10,
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#f3a4c0', fillOpacity: 0.9, strokeColor: '#b0416f', strokeWeight: 4 },
    })
    for (const { stop } of nearestStops(picked.lat, picked.lon, area.board.stops, 3).filter(({ m }) => m <= FAR_M)) {
      gLines.push(
        new g.maps.Polyline({
          map: gmap,
          path: [
            { lat: picked.lat, lng: picked.lon },
            { lat: stop.lat, lng: stop.lon },
          ],
          clickable: false,
          strokeOpacity: 0,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: '#b0416f', strokeWeight: 3, scale: 3 }, offset: '0', repeat: '14px' }],
        }),
      )
    }
  }
}

function renderLeafletMap(): void {
  if (!lmap) return
  lStopLayer.clearLayers()
  // 区域は全エリア分を色分けで描く（全体が見える）。見ているエリアだけ濃く、他は薄く点線で
  data.view.areas.forEach((x, i) => {
    const active = x === area
    for (const z of [...x.board.zones, ...x.alight.zones]) {
      L.polygon(
        z.rings.map((ring) => ring.map(([lng, lat]) => [lat, lng] as L.LatLngExpression)),
        active
          ? { color: areaColor(i), weight: 3, fillOpacity: 0.14 }
          : { color: areaColor(i), weight: 1.5, dashArray: '4 5', fillOpacity: 0.05 },
      )
        .bindTooltip(x.name || z.name)
        .addTo(lStopLayer)
    }
  })
  for (const st of mapStopsOf(area)) {
    L.circleMarker([st.lat, st.lon], { radius: 6, color: '#4a80e0', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(st.name, { direction: 'top', offset: [0, -6] })
      .addTo(lStopLayer)
  }

  if (lHome) lHome.remove()
  lHome = null
  for (const l of lLines) l.remove()
  lLines = []
  if (picked) {
    lHome = L.circleMarker([picked.lat, picked.lon], {
      radius: 11,
      color: '#b0416f',
      weight: 4,
      fillColor: '#f3a4c0',
      fillOpacity: 0.9,
    })
      .bindTooltip('乗りたい場所', { permanent: true, direction: 'top', offset: [0, -10], className: 'stop-label' })
      .addTo(lmap)
    for (const { stop } of nearestStops(picked.lat, picked.lon, area.board.stops, 3).filter(({ m }) => m <= FAR_M)) {
      lLines.push(
        L.polyline(
          [
            [picked.lat, picked.lon],
            [stop.lat, stop.lon],
          ],
          { color: '#b0416f', weight: 3, dashArray: '4 7', opacity: 0.8 },
        ).addTo(lmap),
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
  // 決まった乗り場が無い形態（区域内どこでも乗車）は、区域の中か外かだけを伝える
  if (area.board.stops.length === 0 && zones.length > 0) {
    return `<section class="check-card">
      <h2>この場所から乗れる？</h2>
      ${zoneLine}
      <p class="check-small">この乗りものは決まった乗り場がなく、色のついた範囲の中から乗れます（予約制）。</p>
    </section>`
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
  const windows = windowsText(area)
  const closedNote = area.closedDates.length > 0 ? '（年末年始などお休みの日があります）' : ''

  const phone = b?.phone ?? data.view.agencyPhone
  // 一部の便だけ違う締切（朝の便は前日まで等）は、代表ルールの下に補足として出す
  const extraNotes = area.otherBookings
    .map((x) => (x.message ? `<p class="check-small">※ ${esc(x.message)}</p>` : ''))
    .join('')
  const bookingLines = [
    b?.message ? `<p>${esc(b.message)}</p>` : '',
    `<p class="check-big">${esc(bookingText(area))}</p>`,
    extraNotes,
    phone
      ? `<a class="check-call" href="tel:${esc(phone.replace(/[^\d+-]/g, ''))}">📞 電話で予約する<span>${esc(phone)}</span></a>`
      : '',
    b?.bookingUrl ? `<p><a href="${esc(b.bookingUrl)}" target="_blank" rel="noopener">インターネットで予約する</a></p>` : '',
    b?.infoUrl ? `<p><a href="${esc(b.infoUrl)}" target="_blank" rel="noopener">くわしい案内を見る</a></p>` : '',
  ].join('')

  const flyerLink = `<p class="check-small"><a href="flyer.html${location.hash === '#preview' ? '#preview' : ''}" target="_blank" rel="noopener">🖨 このご案内をチラシ（A4）にして印刷する</a></p>`
  const footer = s
    ? `<footer class="check-foot">
      <p>このページは公式の案内ではありません。最新の運行・予約方法は ${esc(s.provider)} の案内でご確認ください。</p>
      <p>データ出典：${esc(s.provider)}「${esc(s.serviceName)}」（<a href="${esc(s.datasetUrl)}" target="_blank" rel="noopener">公共交通オープンデータセンター</a>、<a href="${esc(s.licenseUrl)}" target="_blank" rel="noopener">${esc(s.license)}</a>）／ ${esc(s.fetchedOn)} 取得</p>
    </footer>`
    : `<footer class="check-foot">
      <p>これは作成画面で入力中のデータのプレビューです。保存も公開もされていません。内容を直すときは、作成画面のタブに戻ってください。</p>
    </footer>`

  // エリア（路線）が複数あるときは、色分けの凡例を兼ねたチップで切り替えられるようにする
  const areaChips =
    data.view.areas.length > 1
      ? `<div class="check-areas">${data.view.areas
          .map(
            (x, i) =>
              `<button type="button" class="check-area-chip ${x === area ? 'active' : ''}" data-area="${i}" ${x === area ? `style="border-color:${areaColor(i)}"` : ''}><span class="area-dot" style="background:${areaColor(i)}"></span>${esc(x.name || `エリア${i + 1}`)}</button>`,
          )
          .join('')}<button type="button" class="check-area-chip" data-area-fit-all>全体を見る</button></div>`
      : ''

  // いま予約できるかの目安（この端末の時計で判定）
  const now = new Date()
  const ns = bookingNow(area, now)
  const nowCard = `<section class="check-card">
    <h2>いま予約できる？</h2>
    <p class="check-big ${ns.cls === 'ok' ? 'check-yes' : ns.cls === 'warn' ? 'check-no' : ''}"><b>${esc(ns.title)}</b></p>
    ${ns.detail ? `<p>${esc(ns.detail)}</p>` : ''}
    <p class="check-small">${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} 時点の目安です。確かなことは電話でご確認ください。</p>
  </section>`

  // お知らせ（広報）。新しいものから最大2件
  const noticeBands = (data.notices ?? [])
    .slice(0, 2)
    .map(
      (n) =>
        `<div class="check-notice">🔔 <b>${esc(n.date.slice(5).replace('-', '/'))}</b> ${esc(n.text)}</div>`,
    )
    .join('')

  panel.innerHTML = `
    ${s ? '' : '<div class="check-preview-band">プレビュー — 作成中のデータを表示しています</div>'}
    ${noticeBands}
    ${areaChips}
    ${nowCard}
    ${pickedCard()}
    <section class="check-card">
      <h2>いつ走っている？</h2>
      <p class="check-big"><b>${esc(daysText(area.days))}</b>の <b>${esc(windows)}</b> ${closedNote}</p>
    </section>
    <section class="check-card">
      <h2>予約のしかた</h2>
      ${bookingLines}
    </section>
    ${flyerLink}
    ${footer}
  `
}

async function main(): Promise<void> {
  if (location.hash === '#preview') {
    // 作成画面からのプレビュー（src/preview.ts が localStorage に置いたデータ）
    const p = loadPreview()
    if (!p || p.view.areas.length === 0) {
      sub.textContent = 'プレビューのデータが見つかりません'
      panel.innerHTML = `<section class="check-card">
        <h2>プレビューのデータがありません</h2>
        <p class="check-big">作成画面の「住民ページで見る」ボタンから開いてください。</p>
      </section>`
      return
    }
    data = { view: normalizeView(p.view), notices: p.notices }
    area = data.view.areas[0]
    const name = area.name || '作成中のサービス'
    sub.textContent = `${p.view.agencyName ? p.view.agencyName + ' ' : ''}「${name}」のプレビュー`
    document.title = `うちから乗れる？ — ${name}（プレビュー）`
  } else {
    const res = await fetch('./data/mizuho_town_mizuho_area.json')
    if (!res.ok) {
      sub.textContent = 'データを読み込めませんでした'
      return
    }
    data = (await res.json()) as DemoData
    data.view = normalizeView(data.view)
    area = data.view.areas[0]
    sub.textContent = `${data.source!.municipality}「${data.source!.serviceName}」`
    document.title = `うちから乗れる？ — ${data.source!.serviceName}`
  }
  // 文面を先に出してから地図を起こす（Google の判定に1〜2秒かかるため）
  renderPanel()
  await mountMap()
  renderMap()

  // エリア切り替え・全体表示（エリアが複数あるときだけチップが出る）
  panel.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement
    if (t.closest('[data-area-fit-all]')) {
      fitAll()
      return
    }
    const btn = t.closest<HTMLElement>('[data-area]')
    if (!btn) return
    area = data.view.areas[Number(btn.dataset.area)]
    renderMap()
    renderPanel()
    fitArea()
  })

  // CSS の適用が一瞬遅れて、この時点でも地図のコンテナが 0px のことがある
  // （そのまま fitBounds すると最大ズームに飛ぶ）。サイズが付いてから一度だけ全体に寄せる
  const mapEl = document.getElementById('map')!
  let fitted = false
  const tryFit = (): void => {
    if (lmap) lmap.invalidateSize()
    if (!fitted && mapEl.clientHeight > 0) {
      fitted = true
      // エリアが複数あれば、まず全体（色分け）を見せる
      if (data.view.areas.length > 1) fitAll()
      else fitArea()
    }
  }
  new ResizeObserver(tryFit).observe(mapEl)
  tryFit()
}

function ptsOf(a: ViewArea): [number, number][] {
  const pts: [number, number][] = [...a.board.stops, ...a.alight.stops].map((st) => [st.lat, st.lon])
  for (const z of [...a.board.zones, ...a.alight.zones])
    for (const ring of z.rings) for (const [lng, lat] of ring) pts.push([lat, lng])
  return pts
}

/** [緯度, 経度] の列が全部入るように寄せる（両エンジン対応） */
function fitPts(pts: [number, number][]): void {
  if (pts.length === 0) return
  if (gmap) {
    const g = gapi()
    if (pts.length === 1) {
      gmap.setCenter({ lat: pts[0][0], lng: pts[0][1] })
      gmap.setZoom(14)
      return
    }
    const b = new g.maps.LatLngBounds()
    for (const [lat, lng] of pts) b.extend({ lat, lng })
    gmap.fitBounds(b, 20)
  } else if (lmap) {
    if (pts.length >= 2) lmap.fitBounds(L.latLngBounds(pts as L.LatLngExpression[]), { padding: [20, 20], animate: false })
    else lmap.setView(pts[0] as L.LatLngExpression, 14, { animate: false })
  }
}

/** 見ているエリアの乗り場と区域の全体が入るように寄せる */
function fitArea(): void {
  fitPts(ptsOf(area))
}

/** 全エリアが入るように寄せる（「全体を見る」） */
function fitAll(): void {
  const pts = data.view.areas.flatMap(ptsOf)
  if (pts.length >= 2) fitPts(pts)
  else fitArea()
}

void main()
