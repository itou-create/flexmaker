// 地図。Leaflet ＋ 地理院タイル。
// 区域はタップで頂点を置いていく方式（描画ライブラリは入れない。指でも押しやすい）。
// 乗降場所はタップで置き、名前をその場で聞く。

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { activeArea, getState, setState, subscribe, updateArea } from '../state'
import { areaColor } from '../areaColors'
import type { Stop } from '../types'

let map: L.Map
let zoneLayers = L.layerGroup()
let draftLayer: L.Polyline | null = null
let draftVertices: L.CircleMarker[] = []
let stopLayer = L.layerGroup()

export function mountMap(el: HTMLElement): void {
  map = L.map(el, { zoomControl: true }).setView([38.30, 141.06], 13)
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    maxZoom: 18,
  }).addTo(map)
  zoneLayers.addTo(map)
  stopLayer.addTo(map)

  map.on('click', (e: L.LeafletMouseEvent) => {
    const s = getState()
    const a = activeArea()
    if (s.mapMode === 'zone') {
      setState({ draftPolygon: [...s.draftPolygon, [e.latlng.lng, e.latlng.lat]] })
    } else if (s.mapMode === 'stop') {
      const name = window.prompt('この場所の名前（例：町立病院）')
      if (!name) return
      const id = `stop_${String(a.stops.length + 1).padStart(3, '0')}`
      const stop: Stop = { id, name, lat: round(e.latlng.lat), lon: round(e.latlng.lng) }
      updateArea({ stops: [...a.stops, stop] })
    }
  })

  subscribe(render)
  render()
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export function fitToService(): void {
  const a = activeArea()
  const pts: L.LatLngExpression[] = []
  if (a.zone) for (const [lng, lat] of a.zone.polygon) pts.push([lat, lng])
  for (const st of a.stops) pts.push([st.lat, st.lon])
  if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] })
  else if (pts.length === 1) map.setView(pts[0], 14)
}

function render(): void {
  const s = getState()
  const a = activeArea()

  // 区域は全エリア分を色分けで描く（全体が見える）。編集中のエリアだけ濃く、他は薄く点線で
  zoneLayers.clearLayers()
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
      .addTo(zoneLayers)
  })

  // 描画途中の区域
  if (draftLayer) draftLayer.remove()
  draftLayer = null
  for (const v of draftVertices) v.remove()
  draftVertices = []
  if (s.draftPolygon.length > 0) {
    const ll = s.draftPolygon.map(([lng, lat]) => [lat, lng] as L.LatLngExpression)
    draftLayer = L.polyline(ll, { color: '#f08a3c', weight: 3, dashArray: '6 6' }).addTo(map)
    draftVertices = ll.map((p, i) =>
      L.circleMarker(p, { radius: i === 0 ? 8 : 5, color: '#f08a3c', weight: 3, fillColor: '#fff', fillOpacity: 1 }).addTo(map),
    )
  }

  // 乗降場所（編集中のエリアのもの）
  stopLayer.clearLayers()
  for (const st of a.stops) {
    L.circleMarker([st.lat, st.lon], { radius: 8, color: '#4a80e0', weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(st.name, { permanent: true, direction: 'top', offset: [0, -8], className: 'stop-label' })
      .addTo(stopLayer)
  }

  el().classList.toggle('mode-zone', s.mapMode === 'zone')
  el().classList.toggle('mode-stop', s.mapMode === 'stop')
}

function el(): HTMLElement {
  return map.getContainer()
}
