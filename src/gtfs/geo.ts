// 区域ポリゴンの道具：GeoJSON からの取り込みと、頂点の間引き（Douglas-Peucker）。
// 行政界データ（国土数値情報など）は数千頂点あるので、手で描く代わりにファイルから
// 取り込んで自動で間引く（scripts/fetch-tamura-zones.mjs と同じやり方）。

/** 線分 ab から点 p までの距離（度のままの近似。区域の間引きには十分） */
function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Douglas-Peucker。eps は度（緯度1度 ≒ 111km なので 0.0005 ≒ 55m） */
export function simplify(points: [number, number][], eps: number): [number, number][] {
  if (points.length <= 2) return points
  let maxD = 0
  let maxI = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1])
    if (d > maxD) {
      maxD = d
      maxI = i
    }
  }
  if (maxD <= eps) return [points[0], points[points.length - 1]]
  const left = simplify(points.slice(0, maxI + 1), eps)
  const right = simplify(points.slice(maxI), eps)
  return [...left.slice(0, -1), ...right]
}

/** 環を maxPoints 以下になるまで間引く（閉じの重複点なしで渡す） */
export function simplifyRing(ring: [number, number][], maxPoints = 120): [number, number][] {
  let eps = 0.0004
  let out = simplify([...ring, ring[0]], eps).slice(0, -1)
  while (out.length > maxPoints) {
    eps *= 1.5
    out = simplify([...ring, ring[0]], eps).slice(0, -1)
  }
  return out.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5])
}

export interface ImportedZone {
  polygon: [number, number][]
  name?: string
  /** 元の頂点数（画面で「◯点→◯点に間引きました」と言うため） */
  originalPoints: number
}

/**
 * GeoJSON のテキストから、いちばん大きいポリゴンの外環を区域として取り出す。
 * FeatureCollection / Feature / Polygon / MultiPolygon を受ける。飛び地と穴は無視。
 * 読めなければ Error を投げる（メッセージは画面にそのまま出せる日本語）。
 */
export function zoneFromGeojson(text: string): ImportedZone {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('GeoJSON として読めませんでした（JSON の形式エラー）')
  }
  interface GjGeometry {
    type?: string
    coordinates?: unknown
  }
  interface GjFeature {
    geometry?: GjGeometry
    properties?: Record<string, unknown>
  }
  const rings: { ring: [number, number][]; name?: string }[] = []
  const addGeometry = (g: GjGeometry | null | undefined, name?: string): void => {
    if (!g) return
    if (g.type === 'Polygon') {
      const outer = (g.coordinates as [number, number][][] | undefined)?.[0]
      if (outer && outer.length >= 4) rings.push({ ring: outer, name })
    } else if (g.type === 'MultiPolygon') {
      for (const poly of (g.coordinates as [number, number][][][] | undefined) ?? []) {
        if (poly?.[0]?.length >= 4) rings.push({ ring: poly[0], name })
      }
    }
  }
  const root = parsed as { type?: string; features?: GjFeature[] } & GjFeature & GjGeometry
  if (root.type === 'FeatureCollection') {
    for (const f of root.features ?? []) {
      const p = f.properties ?? {}
      const name = [p.N03_004, p.name, p.NAME, p.stop_name, p.S_NAME].find((v) => typeof v === 'string') as
        | string
        | undefined
      addGeometry(f.geometry, name)
    }
  } else if (root.type === 'Feature') {
    addGeometry(root.geometry)
  } else {
    addGeometry(root)
  }
  if (rings.length === 0) throw new Error('ポリゴン（Polygon / MultiPolygon）が見つかりませんでした')

  const largest = rings.sort((a, b) => b.ring.length - a.ring.length)[0]
  // 閉じの重複点を外す
  const ring = largest.ring.slice()
  const [f0, l0] = [ring[0], ring[ring.length - 1]]
  if (f0[0] === l0[0] && f0[1] === l0[1]) ring.pop()
  // 座標の並びが [緯度, 経度] になっていそうなら入れ替える（日本国内なら経度 > 緯度）
  const looksLatLng = ring.every(([x, y]) => x >= 20 && x <= 46 && y >= 122 && y <= 154)
  const fixed = looksLatLng ? ring.map(([x, y]) => [y, x] as [number, number]) : ring
  return { polygon: simplifyRing(fixed), name: largest.name, originalPoints: ring.length }
}
