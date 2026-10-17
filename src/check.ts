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
import { createGoogleMap, gapi } from './gmaps'
import type { NoticeItem } from './types'
import {
  addFixedFeed,
  addFlexView,
  buildTransfers,
  createTimetable,
  legPath,
  type Timetable,
} from './transit/timetable.ts'
import { search, type Journey, type Leg, type Pt } from './transit/router.ts'
import { journeysHtml } from './transit/journeyView.ts'
import { REPO_TOP_URL, feedKey, loadFeedIndex, loadRepoFeed, pickNearbyFeeds, type IndexedFeed, type RepoFeed } from './transit/sources.ts'

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
      <div class="map-legend" id="map-legend" hidden>
        <span><i class="lg lg-bus"></i>バス</span>
        <span><i class="lg lg-flex"></i>デマンド</span>
        <span><i class="lg lg-walk"></i>歩く</span>
      </div>
    </div>
    <div id="check-panel" class="check-panel"></div>
  </div>
`

const panel = document.getElementById('check-panel')!
const sub = document.getElementById('check-sub')!

let data: DemoData
let area: ViewArea
let picked: { lat: number; lon: number } | null = null

// ── 乗り継ぎ検索（どこへ行く？）の状態 ─────────
// 行き先は地図を押すか、乗り降りできる場所の一覧から選ぶ。時刻表は Flex（この画面のデータ）に
// 公表されている路線バス等（gtfs-data.jp）を足して組み、乗り継ぎを考慮して探す（src/transit/）。
let pickMode: 'origin' | 'dest' = 'origin'
let dest: Pt | null = null
let tt: Timetable | null = null
let ttBuilding: Promise<Timetable> | null = null
/** いまの時刻表に入れた固定路線の組（キーの並び）。場所が変わって組が変われば組み直す */
let ttFeedKeys = ''
/** 読み込んだ固定路線の状態（表示用）。'none' は時刻表の無いデータ（デマンド等）で読み飛ばしたもの */
let feedStatus: { feed: RepoFeed; state: 'loading' | 'ok' | 'fail' | 'none'; detail?: string }[] = []
const loadedFiles = new Map<string, Record<string, string>>()
let journeys: Journey[] | null = null
/** 見つからなかったときの理由（出発地・行き先が乗り場から遠いなど） */
let noResultHint = ''
let searching = false
let selectedJourney = 0
const nowRounded = ((): { date: string; time: string } => {
  const d = new Date(Date.now() + 5 * 60000)
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return { date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: `${p2(d.getHours())}:${p2(d.getMinutes())}` }
})()
const when = { ...nowRounded }

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

/** 地図のタップ（両エンジン共通の処理） */
function handleTap(lat: number, lon: number): void {
  if (pickMode === 'dest') {
    dest = { lat, lon, name: '地図で選んだ場所' }
    pickMode = 'origin'
    document.getElementById('map-hint')?.setAttribute('hidden', '')
    void runSearch()
    renderMap()
    renderPanel()
    return
  }
  picked = { lat, lon }
  if (dest) void runSearch()
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

/** Google の地図を試す。キー無し・読み込み失敗・認証エラー（API未有効等）なら false */
async function tryGoogleMap(el: HTMLElement): Promise<boolean> {
  const key = getGoogleMapsKey()
  if (!key) return false
  gmap = await createGoogleMap(el, key)
  if (!gmap) return false
  gmap.addListener('click', (e: any) => handleTap(e.latLng.lat(), e.latLng.lng()))
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
  if (dest) {
    gLines.push(
      new g.maps.Marker({
        map: gmap,
        position: { lat: dest.lat, lng: dest.lon },
        title: '行き先',
        clickable: false,
        zIndex: 10,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 10, fillColor: '#cfeedb', fillOpacity: 0.95, strokeColor: '#227a4d', strokeWeight: 4 },
      }),
    )
  }
  const j = journeys?.[selectedJourney]
  if (j) {
    for (const leg of j.legs) {
      const st = legStyle(leg)
      const path = legPts(leg).map(([lat, lng]) => ({ lat, lng }))
      if (leg.kind === 'walk') {
        // 徒歩は点々（丸を並べる）。点線の icon は細くて見えないことがあるので丸にする
        gLines.push(
          new g.maps.Polyline({
            map: gmap,
            path,
            clickable: false,
            strokeOpacity: 0,
            zIndex: 6,
            icons: [{ icon: { path: g.maps.SymbolPath.CIRCLE, scale: 3, fillColor: st.color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1 }, offset: '0', repeat: '12px' }],
          }),
        )
        continue
      }
      // 縁取り（白）→ 本体（路線色）の2本重ね。薄い路線色でも地図から浮く
      gLines.push(new g.maps.Polyline({ map: gmap, path, clickable: false, strokeColor: '#ffffff', strokeWeight: st.weight + 6, strokeOpacity: 0.9, zIndex: 4 }))
      gLines.push(new g.maps.Polyline({ map: gmap, path, clickable: false, strokeColor: '#1f2a24', strokeWeight: st.weight + 3, strokeOpacity: 0.55, zIndex: 5 }))
      gLines.push(
        new g.maps.Polyline({
          map: gmap,
          path,
          clickable: false,
          strokeColor: st.color,
          strokeWeight: st.weight,
          strokeOpacity: st.dash ? 0 : 1,
          zIndex: 6,
          icons: st.dash
            ? [{ icon: { path: 'M 0,-2 0,2', strokeOpacity: 1, strokeColor: st.color, strokeWeight: st.weight, scale: 3 }, offset: '0', repeat: '18px' }]
            : undefined,
        }),
      )
    }
    // 乗る・降りる場所に番号の印
    for (const m of journeyMarks(j)) {
      gLines.push(
        new g.maps.Marker({
          map: gmap,
          position: { lat: m.lat, lng: m.lon },
          title: m.title,
          clickable: false,
          zIndex: 20,
          label: { text: String(m.n), color: '#fff', fontWeight: '700', fontSize: '13px' },
          icon: { path: g.maps.SymbolPath.CIRCLE, scale: 12, fillColor: m.color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 },
        }),
      )
    }
  }
  document.getElementById('map-legend')?.toggleAttribute('hidden', !j)
}

/** 経路の乗る場所・降りる場所（番号つきの印）。徒歩区間の端は乗り物の端と重なるので乗り物側だけ */
function journeyMarks(j: Journey): { lat: number; lon: number; n: number; title: string; color: string }[] {
  const out: { lat: number; lon: number; n: number; title: string; color: string }[] = []
  let n = 1
  for (const leg of j.legs) {
    if (leg.kind === 'walk') continue
    const pts = legPts(leg)
    const color = leg.kind === 'bus' ? '#4a80e0' : '#b0416f'
    const [fromName, toName] =
      leg.kind === 'bus'
        ? [tt!.stops[leg.pattern.stops[leg.fromIdx]].name, tt!.stops[leg.pattern.stops[leg.toIdx]].name]
        : [leg.from.name ?? '乗る場所', leg.to.name ?? '降りる場所']
    out.push({ lat: pts[0][0], lon: pts[0][1], n: n++, title: `${fromName}で乗る`, color })
    const last = pts[pts.length - 1]
    out.push({ lat: last[0], lon: last[1], n: n++, title: `${toName}で降りる`, color })
  }
  return out
}

/** 経路の区間ごとの線の見た目（両エンジン共通）。徒歩＝点々の灰、デマンド＝破線の桃、バス＝路線色の実線 */
function legStyle(leg: Leg): { color: string; weight: number; dash: boolean } {
  if (leg.kind === 'walk') return { color: '#4f6656', weight: 4, dash: true }
  if (leg.kind === 'flex') return { color: '#d2437f', weight: 6, dash: true }
  return { color: readableRouteColor(leg.pattern.color), weight: 7, dash: false }
}

/** 路線色が薄すぎる（白地図で読めない）ときは少し濃くする */
function readableRouteColor(hex: string | undefined): string {
  if (!hex) return '#4a80e0'
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return '#4a80e0'
  let [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  if (lum > 180) {
    const k = 170 / lum
    r = Math.round(r * k)
    g = Math.round(g * k)
    b = Math.round(b * k)
  }
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 区間を地図に描くための [緯度, 経度] の列。バスは shapes があれば道路に沿う */
function legPts(leg: Leg): [number, number][] {
  if (leg.kind === 'bus') return legPath(tt!, leg.pattern, leg.trip, leg.fromIdx, leg.toIdx)
  return [
    [leg.from.lat, leg.from.lon],
    [leg.to.lat, leg.to.lon],
  ]
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
  if (dest) {
    const d = L.circleMarker([dest.lat, dest.lon], { radius: 11, color: '#227a4d', weight: 4, fillColor: '#cfeedb', fillOpacity: 0.95 })
      .bindTooltip('行き先', { permanent: true, direction: 'top', offset: [0, -10], className: 'stop-label' })
      .addTo(lmap)
    lLines.push(d as unknown as L.Polyline)
  }
  const j = journeys?.[selectedJourney]
  if (j) {
    for (const leg of j.legs) {
      const st = legStyle(leg)
      const path = legPts(leg) as L.LatLngExpression[]
      if (leg.kind === 'walk') {
        lLines.push(L.polyline(path, { color: '#fff', weight: st.weight + 4, opacity: 0.9, dashArray: '1 10', lineCap: 'round' }).addTo(lmap))
        lLines.push(L.polyline(path, { color: st.color, weight: st.weight, opacity: 1, dashArray: '1 10', lineCap: 'round' }).addTo(lmap))
        continue
      }
      // 縁取り（白）→ 影（濃灰）→ 本体（路線色）
      lLines.push(L.polyline(path, { color: '#fff', weight: st.weight + 6, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(lmap))
      lLines.push(L.polyline(path, { color: '#1f2a24', weight: st.weight + 3, opacity: 0.55, lineCap: 'round', lineJoin: 'round' }).addTo(lmap))
      lLines.push(
        L.polyline(path, {
          color: st.color,
          weight: st.weight,
          opacity: 1,
          dashArray: st.dash ? '10 12' : undefined,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(lmap),
      )
    }
    for (const m of journeyMarks(j)) {
      const icon = L.divIcon({ className: 'jr-pin', html: `<span style="background:${m.color}">${m.n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] })
      lLines.push(
        L.marker([m.lat, m.lon], { icon, interactive: false, zIndexOffset: 1000 })
          .bindTooltip(m.title, { direction: 'top', offset: [0, -12] })
          .addTo(lmap) as unknown as L.Polyline,
      )
    }
  }
  document.getElementById('map-legend')?.toggleAttribute('hidden', !j)
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

// ── 乗り継ぎ検索 ──────────────────────────────

/** 近くのフィードを探す範囲：いま見ているエリアの乗り場・区域に、出発地と行き先を足した地点の集まり */
function searchPts(): { lat: number; lon: number }[] {
  const pts: { lat: number; lon: number }[] = []
  for (const st of [...area.board.stops, ...area.alight.stops]) pts.push({ lat: st.lat, lon: st.lon })
  for (const z of [...area.board.zones, ...area.alight.zones]) for (const ring of z.rings) for (const [lon, lat] of ring) pts.push({ lat, lon })
  if (picked) pts.push(picked)
  if (dest) pts.push(dest)
  return pts
}

/**
 * この場所で使う固定路線を索引から自動で選ぶ（利用者は選ばない）。
 * デマンド（Flex）のフィードは時刻表にならないので除く。
 */
async function fixedFeeds(): Promise<IndexedFeed[]> {
  const index = (await loadFeedIndex()).filter((f) => !f.flex)
  return pickNearbyFeeds(index, searchPts())
}

async function buildTimetable(feeds: IndexedFeed[]): Promise<Timetable> {
  const t = createTimetable()
  const s = data.source
  addFlexView(t, data.view, {
    label: s?.serviceName ?? (area.name || '作成中のデマンド交通'),
    provider: s?.provider ?? data.view.agencyName,
    url: s?.datasetUrl,
    license: s?.license,
    licenseUrl: s?.licenseUrl,
  })
  feedStatus = feeds.map((feed) => ({ feed, state: 'loading' as const }))
  renderPanel()
  // 近い順に並んでいるので順に読む。読めたものから時刻表に入る
  for (const st of feedStatus) {
    const key = feedKey(st.feed)
    try {
      let files = loadedFiles.get(key)
      if (!files) {
        files = await loadRepoFeed(st.feed)
        loadedFiles.set(key, files)
      }
      const n = addFixedFeed(t, files, {
        label: st.feed.label,
        provider: st.feed.provider,
        url: REPO_TOP_URL,
        license: st.feed.license,
        licenseUrl: st.feed.licenseUrl,
      })
      st.state = n > 0 ? 'ok' : 'none'
      st.detail = n > 0 ? `${n}便` : '時刻表なし'
    } catch (e) {
      st.state = 'fail'
      st.detail = e instanceof Error ? e.message : String(e)
    }
    renderPanel()
  }
  buildTransfers(t)
  return t
}

/** いまの場所に合う時刻表を返す。必要なフィードの組が変わっていれば組み直す */
function ensureTimetable(): Promise<Timetable> {
  if (ttBuilding) return ttBuilding
  ttBuilding = (async () => {
    const feeds = await fixedFeeds()
    const keys = feeds.map(feedKey).join('|')
    if (tt && keys === ttFeedKeys) return tt
    const t = await buildTimetable(feeds)
    tt = t
    ttFeedKeys = keys
    return t
  })().finally(() => {
    ttBuilding = null
  })
  return ttBuilding
}

async function runSearch(): Promise<void> {
  if (!picked || !dest) return
  searching = true
  journeys = null
  renderPanel()
  const t = await ensureTimetable()
  const [y, mo, d] = when.date.split('-').map(Number)
  const [h, mi] = when.time.split(':').map(Number)
  const date = new Date(y, mo - 1, d)
  journeys = search(t, { ...picked, name: '乗りたい場所' }, dest, { date, depSec: h * 3600 + mi * 60 })
  noResultHint = journeys.length === 0 ? whyNoResult(t) : ''
  selectedJourney = 0
  searching = false
  renderPanel()
  renderMap()
  const j = journeys[0]
  if (j) {
    fitPts(j.legs.flatMap(legPts))
    // スマホでは地図が上に固定されているので、結果の先頭（地図のすぐ下）まで戻して経路を見せる
    if (window.matchMedia('(max-width: 899px)').matches) {
      const card = panel.querySelector<HTMLElement>('.jr-card')
      if (card) panel.scrollTo({ top: Math.max(0, card.offsetTop - 8), behavior: 'smooth' })
    }
  }
}

/** 見つからなかった理由を言葉にする。乗り場までの距離が主な原因なので、それを先に伝える */
function whyNoResult(t: Timetable): string {
  if (!picked || !dest) return ''
  const nearestM = (p: { lat: number; lon: number }): number =>
    t.stops.reduce((best, st) => Math.min(best, distanceM(p.lat, p.lon, st.lat, st.lon)), Infinity)
  const km = (m: number): string => (m >= 9500 ? String(Math.round(m / 1000)) : (m / 1000).toFixed(1))
  const o = nearestM(picked)
  const d = nearestM(dest)
  const inZone = data.view.areas.some((a) => a.board.zones.some((z) => insideZone(picked!.lat, picked!.lon, z.rings)))
  if (o > 1200 && !inZone) return `乗りたい場所から、いちばん近い乗り場まで約${km(o)}km あります（歩ける目安は 1.2km まで）。もう少し乗り場の近くを押してみてください。`
  if (d > 1200) return `行き先から、いちばん近い乗り場・停留所まで約${km(d)}km あります（歩ける目安は 1.2km まで）。行き先を乗り場の近くにしてみてください。`
  return ''
}

/** 行き先の候補（この画面のデマンド交通で降りられる場所＋読み込んだ路線バスの停留所） */
function destOptions(): string {
  const groups: { label: string; items: { key: string; name: string }[] }[] = []
  const seen = new Set<string>()
  const flexItems: { key: string; name: string }[] = []
  for (const st of data.view.areas.flatMap((a) => a.alight.stops)) {
    if (seen.has(st.name)) continue
    seen.add(st.name)
    flexItems.push({ key: `f:${st.lat},${st.lon}`, name: st.name })
  }
  if (flexItems.length) groups.push({ label: 'デマンド交通で降りられる場所', items: flexItems })
  if (tt) {
    tt.sources.forEach((src, i) => {
      if (src.kind !== 'fixed') return
      const items: { key: string; name: string }[] = []
      for (const st of tt!.stops) {
        if (st.feed !== i || seen.has(st.name)) continue
        seen.add(st.name)
        items.push({ key: `f:${st.lat},${st.lon}`, name: st.name })
      }
      items.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
      if (items.length) groups.push({ label: `${src.label}の停留所`, items })
    })
  }
  const sel = dest ? `f:${dest.lat},${dest.lon}` : ''
  return groups
    .map(
      (g) =>
        `<optgroup label="${esc(g.label)}">${g.items
          .map((it) => `<option value="${esc(it.key)}" data-name="${esc(it.name)}" ${it.key === sel ? 'selected' : ''}>${esc(it.name)}</option>`)
          .join('')}</optgroup>`,
    )
    .join('')
}

/** 乗りつぎに使っている時刻表（自動で選んだもの）を小さく示す。時刻表の無いデータは出さない */
function feedStatusHtml(): string {
  const shown = feedStatus.filter((st) => st.state !== 'none')
  if (shown.length === 0) {
    return feedStatus.length === 0 && tt
      ? `<p class="check-small">この近くに公表されている路線バスの時刻表は見つからなかったので、デマンド交通だけで調べています。</p>`
      : ''
  }
  const lines = shown.map((st) => {
    const mark = st.state === 'ok' ? '✓' : st.state === 'fail' ? '✕' : '…'
    const txt = st.state === 'loading' ? '読み込んでいます' : st.state === 'ok' ? `（${st.detail}）` : '読み込めませんでした'
    return `<li class="${st.state}"><b>${mark}</b> ${esc(st.feed.label)}${txt}</li>`
  })
  return `<details class="jr-add"><summary>乗りつぎに使っている時刻表（近くのものを自動で選んでいます）</summary><ul class="jr-feeds">${lines.join('')}</ul></details>`
}

function searchCard(): string {
  if (!picked) return ''
  let destLine: string
  if (dest) {
    destLine = `<p class="jr-dest">行き先：<b>${esc(dest.name ?? '地図で選んだ場所')}</b>
      <button type="button" class="jr-mini" data-act="pick-dest">地図で選び直す</button>
      <button type="button" class="jr-mini" data-act="clear-dest">消す</button></p>`
  } else if (pickMode === 'dest') {
    destLine = `<p class="check-big jr-picking">上の地図で<b>「行き先」を指で押して</b>ください。<button type="button" class="jr-mini" data-act="cancel-dest">やめる</button></p>`
  } else {
    destLine = `<div class="jr-dest-pick">
      <button type="button" class="jr-btn" data-act="pick-dest">🗺 行き先を地図で押す</button>
      <label class="jr-or">または、場所の名前から
        <select data-act="dest-stop" class="jr-select"><option value="">選んでください</option>${destOptions()}</select>
      </label>
    </div>`
  }
  const whenLine = `<div class="jr-when">
    <label>日にち <input type="date" data-act="when-date" value="${esc(when.date)}"></label>
    <label>出発したい時刻 <input type="time" data-act="when-time" value="${esc(when.time)}" step="300"></label>
  </div>`
  // きょうの過ぎた時刻を調べているときは、その旨を添える（過ぎた便も表に出るため）
  const pastToday = when.date === nowRounded.date && when.time < nowRounded.time
  const pastNote = pastToday ? `<p class="check-small">※ もう過ぎた時刻です。きょうこれから乗るなら、時刻を今より後にしてください。</p>` : ''
  const tomorrowBtn = `<button type="button" class="jr-mini" data-act="when-tomorrow">あすの朝 8:00 で調べる</button>`
  let result = ''
  if (dest) {
    if (searching) result = `<p class="check-big">調べています…</p>`
    else if (journeys && journeys.length > 0) {
      result = `${pastNote}<div class="jr-list">${journeysHtml(journeys, (i) => tt?.stops[i]?.name ?? '')}</div>
        <p class="check-small">所要時間や歩く時間は目安です。デマンド交通は呼んでから迎えが来るまでを約5分、走る速さを約25km/hとして見積もっています。乗りかえには2分の余裕を見ています。</p>`
    } else if (journeys) {
      result = `<p class="check-no check-big">この日時では、行き方が見つかりませんでした。</p>
        ${noResultHint ? `<p>${esc(noResultHint)}</p>` : ''}
        ${pastNote}
        <p class="check-small">日にちや時刻を変えるか、別の行き先でお試しください。走っていない曜日や、予約の締切を過ぎている便は使えません。デマンド交通で行ける範囲の外かもしれません。</p>
        <p>${tomorrowBtn}</p>`
    }
  }
  return `<section class="check-card jr-card">
    <h2>どこへ行く？（乗りつぎ検索）</h2>
    <p class="check-small">デマンド交通と、近くの路線バスなど（公表されている時刻表）を乗り継いで行けるかを調べます。</p>
    ${destLine}
    ${dest || pickMode === 'dest' ? whenLine : ''}
    ${result}
    ${feedStatusHtml()}
  </section>`
}

/** 乗り継ぎに使った路線バス等の出典（CC BY の表示義務） */
function fixedSourcesHtml(): string {
  const ok = feedStatus.filter((st) => st.state === 'ok')
  if (ok.length === 0) return ''
  return `<p>乗りつぎ検索の時刻表：${ok
    .map(
      (st) =>
        `${esc(st.feed.provider)}「${esc(st.feed.label)}」${st.feed.license ? `（<a href="${esc(st.feed.licenseUrl ?? '#')}" target="_blank" rel="noopener">${esc(st.feed.license)}</a>）` : ''}`,
    )
    .join('、')}／ <a href="${REPO_TOP_URL}" target="_blank" rel="noopener">GTFS データリポジトリ</a>から取得。時刻は変わることがあります。</p>`
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
      ${fixedSourcesHtml()}
    </footer>`
    : `<footer class="check-foot">
      <p>これは作成画面で入力中のデータのプレビューです。保存も公開もされていません。内容を直すときは、作成画面のタブに戻ってください。</p>
      ${fixedSourcesHtml()}
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
    ${searchCard()}
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

function onSearchAction(btn: HTMLElement): void {
  switch (btn.dataset.act) {
    case 'pick-dest': {
      pickMode = 'dest'
      renderPanel()
      const hint = document.getElementById('map-hint')
      if (hint) {
        hint.textContent = '地図の「行き先」を指で押してください'
        hint.removeAttribute('hidden')
      }
      if (window.matchMedia('(max-width: 899px)').matches) panel.scrollTo({ top: 0 })
      break
    }
    case 'cancel-dest':
      pickMode = 'origin'
      document.getElementById('map-hint')?.setAttribute('hidden', '')
      renderPanel()
      break
    case 'clear-dest':
      dest = null
      journeys = null
      renderPanel()
      renderMap()
      break
    case 'when-tomorrow': {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      const p2 = (n: number): string => String(n).padStart(2, '0')
      when.date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      when.time = '08:00'
      void runSearch()
      break
    }
  }
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

  // 時刻表は先に組み始めておく（路線バスの読み込みに数秒かかるため）
  void ensureTimetable()

  // エリア切り替え・全体表示（エリアが複数あるときだけチップが出る）・乗り継ぎ検索の操作
  panel.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement
    if (t.closest('[data-area-fit-all]')) {
      fitAll()
      return
    }
    const act = t.closest<HTMLElement>('button[data-act]')
    if (act) {
      onSearchAction(act)
      return
    }
    const jr = t.closest<HTMLElement>('[data-jr-pick]')
    if (jr) {
      selectedJourney = Number(jr.dataset.jrPick)
      renderPanel()
      renderMap()
      const j = journeys?.[selectedJourney]
      if (j) fitPts(j.legs.flatMap(legPts))
      return
    }
    const btn = t.closest<HTMLElement>('[data-area]')
    if (!btn) return
    area = data.view.areas[Number(btn.dataset.area)]
    renderMap()
    renderPanel()
    fitArea()
    void ensureTimetable().then(() => (dest ? runSearch() : renderPanel()))
  })
  panel.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement | HTMLSelectElement
    switch (el.dataset.act) {
      case 'when-date':
        when.date = el.value || nowRounded.date
        void runSearch()
        break
      case 'when-time':
        when.time = el.value || nowRounded.time
        void runSearch()
        break
      case 'dest-stop': {
        const m = /^f:([-\d.]+),([-\d.]+)$/.exec(el.value)
        if (!m) return
        const opt = (el as HTMLSelectElement).selectedOptions[0]
        dest = { lat: Number(m[1]), lon: Number(m[2]), name: opt?.dataset.name ?? '選んだ場所' }
        pickMode = 'origin'
        void runSearch()
        renderMap()
        break
      }
    }
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
