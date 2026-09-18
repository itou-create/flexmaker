// 地図。Leaflet ＋ 地理院タイル。
// 区域はタップで頂点を置いていく方式（描画ライブラリは入れない。指でも押しやすい）。
// 乗降場所はタップで置き、名前をその場で聞く。

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getState, setState, subscribe, updateService } from '../state'
import type { Stop } from '../types'

let map: L.Map
let zoneLayer: L.Polygon | null = null
let draftLayer: L.Polyline | null = null
let draftVertices: L.CircleMarker[] = []
let stopLayer = L.layerGroup()

export function mountMap(el: HTMLElement): void {
  map = L.map(el, { zoomControl: true }).setView([38.30, 141.06], 13)
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    maxZoom: 18,
  }).addTo(map)
  stopLayer.addTo(map)

  map.on('click', (e: L.LeafletMouseEvent) => {
    const s = getState()
    if (s.mapMode === 'zone') {
      setState({ draftPolygon: [...s.draftPolygon, [e.latlng.lng, e.latlng.lat]] })
    } else if (s.mapMode === 'stop') {
      const name = window.prompt('この場所の名前（例：町立病院）')
      if (!name) return
      const id = `stop_${String(s.service.stops.length + 1).padStart(3, '0')}`
      const stop: Stop = { id, name, lat: round(e.latlng.lat), lon: round(e.latlng.lng) }
      updateService({ stops: [...s.service.stops, stop] })
    }
  })

  subscribe(render)
  render()
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export function fitToService(): void {
  const s = getState().service
  const pts: L.LatLngExpression[] = []
  if (s.zone) for (const [lng, lat] of s.zone.polygon) pts.push([lat, lng])
  for (const st of s.stops) pts.push([st.lat, st.lon])
  if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] })
  else if (pts.length === 1) map.setView(pts[0], 14)
}

function render(): void {
  const s = getState()

  // 確定した区域
  if (zoneLayer) zoneLayer.remove()
  zoneLayer = null
  if (s.service.zone && s.service.zone.polygon.length >= 3) {
    zoneLayer = L.polygon(
      s.service.zone.polygon.map(([lng, lat]) => [lat, lng] as L.LatLngExpression),
      { color: '#1f6b41', weight: 2, fillOpacity: 0.14 },
    ).addTo(map)
    zoneLayer.bindTooltip(s.service.zone.name, { permanent: false })
  }

  // 描画途中の区域
  if (draftLayer) draftLayer.remove()
  draftLayer = null
  for (const v of draftVertices) v.remove()
  draftVertices = []
  if (s.draftPolygon.length > 0) {
    const ll = s.draftPolygon.map(([lng, lat]) => [lat, lng] as L.LatLngExpression)
    draftLayer = L.polyline(ll, { color: '#c2620c', weight: 2, dashArray: '6 4' }).addTo(map)
    draftVertices = ll.map((p, i) =>
      L.circleMarker(p, { radius: i === 0 ? 8 : 5, color: '#c2620c', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(map),
    )
  }

  // 乗降場所
  stopLayer.clearLayers()
  for (const st of s.service.stops) {
    L.circleMarker([st.lat, st.lon], { radius: 7, color: '#2148a8', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(st.name, { permanent: true, direction: 'top', offset: [0, -8], className: 'stop-label' })
      .addTo(stopLayer)
  }

  el().classList.toggle('mode-zone', s.mapMode === 'zone')
  el().classList.toggle('mode-stop', s.mapMode === 'stop')
}

function el(): HTMLElement {
  return map.getContainer()
}
