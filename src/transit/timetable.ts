// 乗り継ぎ検索のための時刻表モデル。
// 路線バスなどの「時刻の決まった GTFS」と、デマンド交通の「時間帯で呼ぶ GTFS-Flex」を
// 同じ器に載せる。経路探索（router.ts）はこのモデルだけを見る。
//
// - 固定路線：trip を「同じ停留所の並び」ごとに束ねた pattern にする（RAPTOR の定石）
// - Flex    ：エリア（route）ごとに「乗れる場所／降りられる場所／時間帯／予約ルール」を持つ
// - 停留所の ID はフィードごとに前置きを付けて衝突を避ける。別フィードの同じ場所どうしは
//   距離で結ぶ（transfers）ので、ID が違っても乗り継げる

import { parseCsv } from '../gtfs/csv.ts'
import type { FlexView, ViewBooking } from '../gtfs/flexReader.ts'

export type Rings = [number, number][][]

export interface TStop {
  id: string
  name: string
  lat: number
  lon: number
  feed: number
}

export interface TCalendar {
  /** 月〜日 */
  days: boolean[]
  /** YYYYMMDD。空なら無期限 */
  start: string
  end: string
  added: Set<string>
  removed: Set<string>
}

export interface TTrip {
  id: string
  serviceId: string
  headsign: string
  /** 停留所ごとの到着・出発（0時からの秒） */
  arr: number[]
  dep: number[]
  /** 走る道筋（tt.shapes のキー）。無ければ停留所を直線で結ぶ */
  shapeId?: string
}

export interface TPattern {
  feed: number
  routeId: string
  routeName: string
  color?: string
  textColor?: string
  /** 停留所の添字（tt.stops） */
  stops: number[]
  /** 始発停留所の出発順 */
  trips: TTrip[]
}

export interface TWindow {
  start: number
  end: number
  booking?: ViewBooking
}

export interface TFlex {
  feed: number
  id: string
  serviceName: string
  areaName: string
  pickupStops: number[]
  pickupZones: Rings[]
  dropStops: number[]
  dropZones: Rings[]
  windows: TWindow[]
  calendar: TCalendar
  booking?: ViewBooking
  phone?: string
}

export interface TSource {
  kind: 'flex' | 'fixed'
  label: string
  provider?: string
  url?: string
  license?: string
  licenseUrl?: string
}

export interface Timetable {
  stops: TStop[]
  stopIndex: Map<string, number>
  patterns: TPattern[]
  patternsByStop: number[][]
  flex: TFlex[]
  flexByStop: number[][]
  /** フィードごとの service_id → カレンダー */
  calendars: Map<string, TCalendar>[]
  sources: TSource[]
  /** 徒歩で移れる停留所（buildTransfers で作る） */
  transfers: { to: number; sec: number }[][]
  /** 便の走る道筋（shapes.txt）。キーは "フィード番号:shape_id"、値は [緯度, 経度] の列 */
  shapes: Map<string, [number, number][]>
}

// ── 単位と目安 ─────────────────────────────────
/** 徒歩 80m/分（住民ページの表示と同じ）。直線距離に 1.3 を掛けて道のりの目安にする */
export const WALK_M_PER_MIN = 80
export const DETOUR = 1.3
export const walkSec = (m: number): number => Math.round((m * DETOUR) / WALK_M_PER_MIN) * 60
/** デマンド車両の目安速度（市街地の道のり換算で約 25km/h） */
export const FLEX_M_PER_SEC = 25000 / 3600
export const flexRideSec = (m: number): number => Math.round((m * DETOUR) / FLEX_M_PER_SEC / 60) * 60

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const x = dLon * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  return R * Math.sqrt(dLat * dLat + x * x)
}

/** [経度, 緯度] の環の集まりに対する内外判定（偶奇規則） */
export function insideRings(lat: number, lon: number, rings: Rings): boolean {
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

/** "7:05" / "07:05:00" / "25:10:00"（翌日）→ 秒。読めなければ undefined */
export function parseTime(t: string | undefined): number | undefined {
  if (!t) return undefined
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(t)
  if (!m) return undefined
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
export const ymdOf = (d: Date): string => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
/** 月曜=0 … 日曜=6 */
export const dowOf = (d: Date): number => (d.getDay() + 6) % 7

export function calendarRuns(cal: TCalendar | undefined, ymd: string, dow: number): boolean {
  if (!cal) return false
  if (cal.added.has(ymd)) return true
  if (cal.removed.has(ymd)) return false
  if (cal.start.length === 8 && (ymd < cal.start || ymd > cal.end)) return false
  return cal.days[dow] === true
}

// ── 組み立て ───────────────────────────────────

export function createTimetable(): Timetable {
  return {
    stops: [],
    stopIndex: new Map(),
    patterns: [],
    patternsByStop: [],
    flex: [],
    flexByStop: [],
    calendars: [],
    sources: [],
    transfers: [],
    shapes: new Map(),
  }
}

function addStop(tt: Timetable, feed: number, id: string, name: string, lat: number, lon: number): number {
  const key = `${feed}:${id}`
  const found = tt.stopIndex.get(key)
  if (found !== undefined) return found
  const idx = tt.stops.length
  tt.stops.push({ id: key, name, lat, lon, feed })
  tt.stopIndex.set(key, idx)
  tt.patternsByStop.push([])
  tt.flexByStop.push([])
  return idx
}

function readCalendars(files: Record<string, string>): Map<string, TCalendar> {
  const table = (name: string): Record<string, string>[] => (files[name] ? parseCsv(files[name]) : [])
  const cals = new Map<string, TCalendar>()
  const get = (id: string): TCalendar => {
    let c = cals.get(id)
    if (!c) {
      c = { days: [false, false, false, false, false, false, false], start: '', end: '', added: new Set(), removed: new Set() }
      cals.set(id, c)
    }
    return c
  }
  for (const r of table('calendar.txt')) {
    const c = get(r.service_id)
    c.days = [r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday, r.sunday].map((v) => v === '1')
    c.start = r.start_date ?? ''
    c.end = r.end_date ?? ''
  }
  for (const r of table('calendar_dates.txt')) {
    const c = get(r.service_id)
    if (r.exception_type === '1') c.added.add(r.date)
    else if (r.exception_type === '2') c.removed.add(r.date)
  }
  return cals
}

/** 1行を列に分ける。引用符が無ければ split だけで済ませる（stop_times.txt は百万行になるので速さ優先） */
function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',')
  const cells: string[] = []
  let cell = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuote = false
      } else cell += ch
    } else if (ch === '"') inQuote = true
    else if (ch === ',') {
      cells.push(cell)
      cell = ''
    } else cell += ch
  }
  cells.push(cell)
  return cells
}

/** 大きな CSV の本文（見出しの次の行から）を、行オブジェクトを作らずに1行ずつ回す */
function eachCsvLine(text: string, fn: (cells: string[]) => void): void {
  let pos = text.indexOf('\n') + 1 // 見出し行を飛ばす
  if (pos <= 0) return
  while (pos < text.length) {
    let end = text.indexOf('\n', pos)
    if (end < 0) end = text.length
    let line = text.slice(pos, end)
    pos = end + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.trim() === '') continue
    fn(splitCsvLine(line))
  }
}

export interface FixedFeedOptions {
  /**
   * この箱 [西, 南, 東, 北] に停留所が1つも無い便は読み飛ばす。
   * 都営バスのように都内全域の時刻表（stop_times が 75MB）でも、見ている地域の便だけを持てばスマホで動く。
   * 便に含まれる停留所は箱の外でも全部残す（箱の外へ行く便もそのまま乗れる）
   */
  within?: [number, number, number, number]
}

/**
 * 時刻の決まった GTFS（路線バス・鉄道など）を足す。
 * 戻り値は読めた便数（0 なら時刻表として使えない）。
 */
export function addFixedFeed(tt: Timetable, files: Record<string, string>, source: Omit<TSource, 'kind'>, opts: FixedFeedOptions = {}): number {
  const feed = tt.sources.length
  tt.sources.push({ kind: 'fixed', ...source })
  tt.calendars[feed] = readCalendars(files)
  const table = (name: string): Record<string, string>[] => (files[name] ? parseCsv(files[name]) : [])

  for (const r of table('stops.txt')) {
    // 駅・乗り場の親（location_type=1）や出入口は乗り降りしないので除く
    if (r.location_type && r.location_type !== '0') continue
    const lat = Number(r.stop_lat)
    const lon = Number(r.stop_lon)
    if (!r.stop_id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    addStop(tt, feed, r.stop_id, r.stop_name ?? '', lat, lon)
  }

  const routes = new Map<string, { name: string; color?: string; textColor?: string }>()
  for (const r of table('routes.txt')) {
    const short = (r.route_short_name ?? '').trim()
    const long = (r.route_long_name ?? '').trim()
    routes.set(r.route_id, {
      name: long && short ? `${short} ${long}` : long || short || r.route_id,
      color: r.route_color ? `#${r.route_color}` : undefined,
      textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    })
  }
  const trips = new Map<string, { routeId: string; serviceId: string; headsign: string; shapeId?: string }>()
  for (const r of table('trips.txt')) {
    trips.set(r.trip_id, { routeId: r.route_id, serviceId: r.service_id, headsign: r.trip_headsign ?? '', shapeId: r.shape_id || undefined })
  }

  // stop_times を便ごとにまとめる。何十 MB にもなるので行オブジェクトを作らず1行ずつ読む
  interface Row {
    seq: number
    stop: number
    arr: number
    dep: number
  }
  const stText = files['stop_times.txt'] ?? ''
  const col = (header: string[], name: string): number => header.indexOf(name)
  const headerOf = (text: string): string[] =>
    splitCsvLine((text.split('\n', 1)[0] ?? '').replace(/^﻿/, '').replace(/\r$/, '')).map((h) => h.trim())

  // 箱の指定があれば、まず「箱の中の停留所を通る便」だけ拾う（1回目の読み）
  let keep: Set<string> | null = null
  if (opts.within) {
    const [w, s, e, n] = opts.within
    const inBox = (i: number): boolean => {
      const st = tt.stops[i]
      return st.lon >= w && st.lon <= e && st.lat >= s && st.lat <= n
    }
    const set = new Set<string>()
    const header = headerOf(stText)
    const iTrip = col(header, 'trip_id')
    const iStop = col(header, 'stop_id')
    if (iTrip >= 0 && iStop >= 0) {
      eachCsvLine(stText, (c) => {
        const stop = tt.stopIndex.get(`${feed}:${(c[iStop] ?? '').trim()}`)
        if (stop !== undefined && inBox(stop)) set.add((c[iTrip] ?? '').trim())
      })
    }
    keep = set
  }

  const byTrip = new Map<string, Row[]>()
  {
    const header = headerOf(stText)
    const iTrip = col(header, 'trip_id')
    const iStop = col(header, 'stop_id')
    const iSeq = col(header, 'stop_sequence')
    const iArr = col(header, 'arrival_time')
    const iDep = col(header, 'departure_time')
    if (iTrip >= 0 && iStop >= 0) {
      eachCsvLine(stText, (c) => {
        const tripId = (c[iTrip] ?? '').trim()
        if (keep && !keep.has(tripId)) return
        const stop = tt.stopIndex.get(`${feed}:${(c[iStop] ?? '').trim()}`)
        if (stop === undefined) return
        const arr = parseTime(c[iArr]) ?? parseTime(c[iDep])
        const dep = parseTime(c[iDep]) ?? arr
        if (arr === undefined || dep === undefined) return // 時刻の無い行（通過・補間待ち）は飛ばす
        const list = byTrip.get(tripId) ?? []
        list.push({ seq: Number(c[iSeq]), stop, arr, dep })
        byTrip.set(tripId, list)
      })
    }
  }

  // 走る道筋（shapes.txt）。地図に道路に沿った線を描くためだけに使う。残す便のものだけ持つ
  const usedShapes = new Set<string>()
  for (const tripId of byTrip.keys()) {
    const sid = trips.get(tripId)?.shapeId
    if (sid) usedShapes.add(sid)
  }
  const shapeRows = new Map<string, { seq: number; lat: number; lon: number }[]>()
  if (files['shapes.txt'] && usedShapes.size > 0) {
    const header = headerOf(files['shapes.txt'])
    const iId = col(header, 'shape_id')
    const iLat = col(header, 'shape_pt_lat')
    const iLon = col(header, 'shape_pt_lon')
    const iSeq = col(header, 'shape_pt_sequence')
    if (iId >= 0 && iLat >= 0 && iLon >= 0) {
      eachCsvLine(files['shapes.txt'], (c) => {
        const id = (c[iId] ?? '').trim()
        if (!usedShapes.has(id)) return
        const lat = Number(c[iLat])
        const lon = Number(c[iLon])
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
        const list = shapeRows.get(id) ?? []
        list.push({ seq: Number(c[iSeq]), lat, lon })
        shapeRows.set(id, list)
      })
    }
  }
  for (const [id, rows] of shapeRows) {
    rows.sort((a, b) => a.seq - b.seq)
    tt.shapes.set(`${feed}:${id}`, rows.map((x) => [x.lat, x.lon] as [number, number]))
  }

  const patternOf = new Map<string, number>()
  let count = 0
  for (const [tripId, rows] of byTrip) {
    const info = trips.get(tripId)
    if (!info || rows.length < 2) continue
    rows.sort((a, b) => a.seq - b.seq)
    const stops = rows.map((x) => x.stop)
    const key = `${info.routeId}|${stops.join(',')}`
    let pi = patternOf.get(key)
    if (pi === undefined) {
      pi = tt.patterns.length
      const route = routes.get(info.routeId)
      tt.patterns.push({
        feed,
        routeId: info.routeId,
        routeName: route?.name ?? info.routeId,
        color: route?.color,
        textColor: route?.textColor,
        stops,
        trips: [],
      })
      patternOf.set(key, pi)
      for (const s of new Set(stops)) tt.patternsByStop[s].push(pi)
    }
    tt.patterns[pi].trips.push({
      id: tripId,
      serviceId: info.serviceId,
      headsign: info.headsign,
      arr: rows.map((x) => x.arr),
      dep: rows.map((x) => x.dep),
      shapeId: info.shapeId && tt.shapes.has(`${feed}:${info.shapeId}`) ? `${feed}:${info.shapeId}` : undefined,
    })
    count++
  }
  for (const p of tt.patterns) if (p.feed === feed) p.trips.sort((a, b) => a.dep[0] - b.dep[0])
  return count
}

/**
 * GTFS-Flex の表示モデル（flexReader の FlexView）を足す。
 * 同梱データ・作成中プレビューのどちらもこの形なので、zip を読み直さずに済む。
 */
export function addFlexView(tt: Timetable, view: FlexView, source: Omit<TSource, 'kind'>): void {
  const feed = tt.sources.length
  tt.sources.push({ kind: 'flex', ...source })
  tt.calendars[feed] = new Map()
  for (const a of view.areas) {
    const pickupStops = a.board.stops.map((s) => addStop(tt, feed, s.id, s.name, s.lat, s.lon))
    const dropStops = a.alight.stops.map((s) => addStop(tt, feed, s.id, s.name, s.lat, s.lon))
    const windows: TWindow[] = []
    for (const w of a.windows) {
      const start = parseTime(w.start)
      const end = parseTime(w.end)
      if (start === undefined || end === undefined) continue
      windows.push({ start, end, booking: w.booking })
    }
    if (windows.length === 0) continue
    const fi = tt.flex.length
    tt.flex.push({
      feed,
      id: a.routeId,
      serviceName: view.agencyName ? `${view.agencyName}のデマンド交通` : 'デマンド交通',
      areaName: a.name,
      pickupStops,
      pickupZones: a.board.zones.map((z) => z.rings),
      dropStops,
      dropZones: a.alight.zones.map((z) => z.rings),
      windows,
      calendar: {
        days: [...a.days],
        start: a.dateRange?.start ?? '',
        end: a.dateRange?.end ?? '',
        added: new Set(a.extraDates),
        removed: new Set(a.closedDates),
      },
      booking: a.booking,
      phone: a.booking?.phone ?? view.agencyPhone,
    })
    for (const s of new Set(pickupStops)) tt.flexByStop[s].push(fi)
  }
}

/** 停留所どうしの徒歩乗り継ぎ（直線 maxM 以内）を全停留所について作る */
export function buildTransfers(tt: Timetable, maxM = 500): void {
  const n = tt.stops.length
  const out: { to: number; sec: number }[][] = Array.from({ length: n }, () => [])
  // 緯度でざっくり絞ってから距離を測る（停留所が数千あっても一瞬で終わる）
  const order = tt.stops.map((_, i) => i).sort((a, b) => tt.stops[a].lat - tt.stops[b].lat)
  const latSpan = maxM / 111000
  for (let a = 0; a < n; a++) {
    const i = order[a]
    const si = tt.stops[i]
    for (let b = a + 1; b < n; b++) {
      const j = order[b]
      const sj = tt.stops[j]
      if (sj.lat - si.lat > latSpan) break
      const m = distanceM(si.lat, si.lon, sj.lat, sj.lon)
      if (m > maxM) continue
      const sec = Math.max(60, walkSec(m))
      out[i].push({ to: j, sec })
      out[j].push({ to: i, sec })
    }
  }
  tt.transfers = out
}

/**
 * バス区間の道筋（[緯度, 経度] の列）。shapes があれば、乗る停留所と降りる停留所に
 * いちばん近い形状点の間を切り出す。無ければ途中の停留所を直線で結ぶ。
 */
export function legPath(tt: Timetable, p: TPattern, trip: TTrip, fromIdx: number, toIdx: number): [number, number][] {
  const viaStops = (): [number, number][] => p.stops.slice(fromIdx, toIdx + 1).map((s) => [tt.stops[s].lat, tt.stops[s].lon])
  const shape = trip.shapeId ? tt.shapes.get(trip.shapeId) : undefined
  if (!shape || shape.length < 2) return viaStops()
  const nearest = (s: number, startAt: number): number => {
    const st = tt.stops[s]
    let best = startAt
    let bestD = Infinity
    for (let i = startAt; i < shape.length; i++) {
      const d = distanceM(st.lat, st.lon, shape[i][0], shape[i][1])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return bestD <= 300 ? best : -1 // 形状と停留所が 300m 以上離れていたら形状を信用しない
  }
  const a = nearest(p.stops[fromIdx], 0)
  if (a < 0) return viaStops()
  const b = nearest(p.stops[toIdx], a)
  if (b < 0 || b <= a) return viaStops()
  const from = tt.stops[p.stops[fromIdx]]
  const to = tt.stops[p.stops[toIdx]]
  return [[from.lat, from.lon], ...shape.slice(a, b + 1), [to.lat, to.lon]]
}
