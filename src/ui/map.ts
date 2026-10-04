// 作成画面の地図。Google マップ（運営側キーがあり使えるとき）を優先し、
// 使えなければ Leaflet ＋ 地理院タイルに自動で切り替える（住民ページと同じ二段構え）。
// 区域はタップで頂点を置いていく方式（描画ライブラリは入れない。指でも押しやすい）。
// 乗降場所はタップで置き、名前をその場で聞く。

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { activeArea, getState, setState, subscribe, updateArea } from '../state'
import { areaColor } from '../areaColors'
import { getGoogleMapsKey } from '../mapsKey'
import { createGoogleMap, gapi } from '../gmaps'
import type { Stop } from '../types'

// Leaflet 側
let lmap: L.Map | null = null
let lDraft: L.Polyline | null = null
let lDraftVertices: L.CircleMarker[] = []
const lLayers = L.layerGroup()

// Google 側（型は any。@types を増やさない）
/* eslint-disable @typescript-eslint/no-explicit-any */
let gmap: any = null
let gShapes: any[] = []

/** 地図タップ（両エンジン共通）。区域の頂点を置く／場所を置く */
function handleTap(lat: number, lon: number): void {
  const s = getState()
  const a = activeArea()
  if (s.mapMode === 'zone') {
    setState({ draftPolygon: [...s.draftPolygon, [lon, lat]] })
  } else if (s.mapMode === 'stop') {
    const name = window.prompt('この場所の名前（例：町立病院）')
    if (!name) return
    const id = `stop_${String(a.stops.length + 1).padStart(3, '0')}`
    const stop: Stop = { id, name, lat: round(lat), lon: round(lon) }
    updateArea({ stops: [...a.stops, stop] })
  }
}

export function mountMap(el: HTMLElement): void {
  void (async () => {
    const key = getGoogleMapsKey()
    if (key) {
      gmap = await createGoogleMap(el, key)
      if (gmap) gmap.addListener('click', (e: any) => handleTap(e.latLng.lat(), e.latLng.lng()))
    }
    if (!gmap) {
      lmap = L.map(el, { zoomControl: true }).setView([36.2, 138.3], 5)
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
        maxZoom: 18,
      }).addTo(lmap)
      lLayers.addTo(lmap)
      lmap.on('click', (e: L.LeafletMouseEvent) => handleTap(e.latlng.lat, e.latlng.lng))
    }
    render()
    // 前回の続き（自動保存）から開いたときは、置いてあるものが見えるところまで寄せる
    if (hasAnyGeometry()) fitToAll()
  })()
  subscribe(render)
}

function hasAnyGeometry(): boolean {
  return getState().service.areas.some((a) => (a.zone && a.zone.polygon.length >= 3) || a.stops.length > 0)
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// ── 寄せる（両エンジン対応）──────────────────────

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
    gmap.fitBounds(b, 24)
  } else if (lmap) {
    if (pts.length >= 2) lmap.fitBounds(L.latLngBounds(pts as L.LatLngExpression[]), { padding: [24, 24] })
    else lmap.setView(pts[0] as L.LatLngExpression, 14)
  }
}

export function fitToService(): void {
  const a = activeArea()
  const pts: [number, number][] = []
  if (a.zone) for (const [lng, lat] of a.zone.polygon) pts.push([lat, lng])
  for (const st of a.stops) pts.push([st.lat, st.lon])
  fitPts(pts)
}

/** 全エリアが入るように寄せる（「全体を見る」ボタン） */
export function fitToAll(): void {
  const pts: [number, number][] = []
  for (const a of getState().service.areas) {
    if (a.zone) for (const [lng, lat] of a.zone.polygon) pts.push([lat, lng])
    for (const st of a.stops) pts.push([st.lat, st.lon])
  }
  fitPts(pts)
}

// ── 描画 ───────────────────────────────────────

function render(): void {
  const s = getState()
  const mapEl = document.getElementById('map')
  if (mapEl) {
    mapEl.classList.toggle('mode-zone', s.mapMode === 'zone')
    mapEl.classList.toggle('mode-stop', s.mapMode === 'stop')
  }
  if (gmap) {
    // Google は内部要素にカーソルを当てるので、オプションで切り替える
    gmap.setOptions({ draggableCursor: s.mapMode === 'none' ? null : 'crosshair' })
    renderGoogle()
  } else if (lmap) {
    renderLeaflet()
  }
}

function renderGoogle(): void {
  const g = gapi()
  const s = getState()
  for (const x of gShapes) x.setMap(null)
  gShapes = []

  // 区域は全エリア分を色分けで描く。編集中のエリアだけ濃く
  s.service.areas.forEach((area, i) => {
    if (!area.zone || area.zone.polygon.length < 3) return
    const active = i === s.activeArea
    gShapes.push(
      new g.maps.Polygon({
        map: gmap,
        paths: area.zone.polygon.map(([lng, lat]) => ({ lat, lng })),
        strokeColor: areaColor(i),
        strokeWeight: active ? 3 : 1.5,
        strokeOpacity: active ? 1 : 0.55,
        fillColor: areaColor(i),
        fillOpacity: active ? 0.16 : 0.05,
        clickable: false,
      }),
    )
  })

  // 描画途中の区域（みかん色の点線と頂点）
  if (s.draftPolygon.length > 0) {
    const path = s.draftPolygon.map(([lng, lat]) => ({ lat, lng }))
    gShapes.push(
      new g.maps.Polyline({
        map: gmap,
        path,
        clickable: false,
        strokeOpacity: 0,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#f08a3c', strokeWeight: 3, scale: 3 }, offset: '0', repeat: '12px' }],
      }),
    )
    path.forEach((p, i) => {
      gShapes.push(
        new g.maps.Marker({
          map: gmap,
          position: p,
          clickable: false,
          icon: { path: g.maps.SymbolPath.CIRCLE, scale: i === 0 ? 8 : 5, fillColor: '#ffffff', fillOpacity: 1, strokeColor: '#f08a3c', strokeWeight: 3 },
        }),
      )
    })
  }

  // 乗降場所（編集中のエリアのもの。名前を上に出す）
  for (const st of activeArea().stops) {
    gShapes.push(
      new g.maps.Marker({
        map: gmap,
        position: { lat: st.lat, lng: st.lon },
        clickable: false,
        label: { text: st.name, fontSize: '12px', fontWeight: '700', className: 'gmap-stop-label' },
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#ffffff',
          fillOpacity: 1,
          strokeColor: '#4a80e0',
          strokeWeight: 3,
          labelOrigin: new g.maps.Point(0, -2.2),
        },
      }),
    )
  }
}

function renderLeaflet(): void {
  if (!lmap) return
  const m = lmap
  const s = getState()
  lLayers.clearLayers()

  // 区域は全エリア分を色分けで描く。編集中のエリアだけ濃く、他は薄く点線で
  s.service.areas.forEach((area, i) => {
    if (!area.zone || area.zone.polygon.length < 3) return
    const active = i === s.activeArea
    L.polygon(
      area.zone.polygon.map(([lng, lat]) => [lat, lng] as L.LatLngExpression),
      active
        ? { color: areaColor(i), weight: 3, fillOpacity: 0.16 }
        : { color: areaColor(i), weight: 1.5, dashArray: '4 5', fillOpacity: 0.05 },
    )
      .bindTooltip(area.routeName || area.zone.name, { permanent: false })
      .addTo(lLayers)
  })

  // 描画途中の区域
  if (lDraft) lDraft.remove()
  lDraft = null
  for (const v of lDraftVertices) v.remove()
  lDraftVertices = []
  if (s.draftPolygon.length > 0) {
    const ll = s.draftPolygon.map(([lng, lat]) => [lat, lng] as L.LatLngExpression)
    lDraft = L.polyline(ll, { color: '#f08a3c', weight: 3, dashArray: '6 6' }).addTo(m)
    lDraftVertices = ll.map((p, i) =>
      L.circleMarker(p, { radius: i === 0 ? 8 : 5, color: '#f08a3c', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(m),
    )
  }

  // 乗降場所（編集中のエリアのもの）
  for (const st of activeArea().stops) {
    L.circleMarker([st.lat, st.lon], { radius: 8, color: '#4a80e0', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(st.name, { permanent: true, direction: 'top', offset: [0, -8], className: 'stop-label' })
      .addTo(lLayers)
  }
}
