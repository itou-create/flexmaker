// Google Maps Static API の URL を組み立てる（チラシ・サイネージの下図用）。
// 区域は path（エンコード済みポリライン）、乗り場は markers で渡す。
// 中心とズームは指定せず、Google 側の自動フィットに任せる。

import type { ViewArea } from './gtfs/flexReader.ts'
import { areaColor } from './areaColors'

/** Google のポリラインエンコーディング（点は [経度, 緯度] で受けて lat,lng で符号化） */
export function encodePath(points: [number, number][]): string {
  let out = ''
  let prevLat = 0
  let prevLng = 0
  const enc = (v: number): string => {
    let n = v < 0 ? ~(v << 1) : v << 1
    let s = ''
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63)
      n >>= 5
    }
    return s + String.fromCharCode(n + 63)
  }
  for (const [lon, lat] of points) {
    const la = Math.round(lat * 1e5)
    const ln = Math.round(lon * 1e5)
    out += enc(la - prevLat) + enc(ln - prevLng)
    prevLat = la
    prevLng = ln
  }
  return out
}

/** エリア1つ分の静的地図 URL。サイズは px（scale=2 で2倍解像度になる） */
export function staticMapUrl(a: ViewArea, colorIndex: number, w: number, h: number, key: string): string {
  const color = areaColor(colorIndex).replace('#', '')
  const params: string[] = [
    `size=${Math.min(640, Math.round(w))}x${Math.min(640, Math.round(h))}`,
    'scale=2',
    'language=ja',
    'region=JP',
    'maptype=roadmap',
  ]
  const seenZone = new Set<string>()
  for (const z of [...a.board.zones, ...a.alight.zones]) {
    if (seenZone.has(z.id)) continue
    seenZone.add(z.id)
    for (const ring of z.rings) {
      params.push(`path=${encodeURIComponent(`color:0x${color}ff|weight:3|fillcolor:0x${color}26|enc:${encodePath([...ring, ring[0]])}`)}`)
    }
  }
  const seenStop = new Set<string>()
  const stops = [...a.board.stops, ...a.alight.stops].filter((st) => !seenStop.has(st.id) && seenStop.add(st.id))
  if (stops.length > 0) {
    const pts = stops.map((st) => `${st.lat.toFixed(5)},${st.lon.toFixed(5)}`).join('|')
    params.push(`markers=${encodeURIComponent(`size:tiny|color:0x${color}|${pts}`)}`)
  }
  params.push(`key=${encodeURIComponent(key)}`)
  return `https://maps.googleapis.com/maps/api/staticmap?${params.join('&')}`
}
