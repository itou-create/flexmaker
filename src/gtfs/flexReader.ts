// 既存の GTFS-Flex ファイル群 → 住民向け確認ページで使う表示モデル（FlexView）。
// flexWriter の逆向き。担当者画面・住民画面のどちらもこのモデル経由で読む。
//
// import に .ts 拡張子を付けているのは、Node（scripts/convert-sample.mjs）からも
// そのまま import できるようにするため（Node 24 の型除去実行は拡張子省略を解決しない）。
//
// 実データの癖（docs/gtfs-flex-reference.md §12）：
// - 時刻は "8:30:00" のように時が1桁のことがある → 正規化して読む
// - stop_times は「1便2行、両行同じグループ」が実データの全件。ただし flexWriter の
//   zone 系3形態（乗車側と降車側が違う行）も読めるように、行ごとの pickup/drop_off で
//   「乗れる側」「降りられる側」に振り分ける

import { parseCsv } from './csv.ts'

export interface ViewStop {
  id: string
  name: string
  lat: number
  lon: number
}

/** 乗降できる区域。rings は [経度, 緯度] の環の列（穴も含む。偶奇規則で内外判定する） */
export interface ViewZone {
  id: string
  name: string
  rings: [number, number][][]
}

export interface ViewBooking {
  /** 0 = その場で、1 = 当日でも可（◯分前まで）、2 = 前日まで */
  type: 0 | 1 | 2
  durationMin?: number
  startDay?: number
  lastDay?: number
  /** "17:00" 形式 */
  lastTime?: string
  message?: string
  phone?: string
  infoUrl?: string
  bookingUrl?: string
}

/** 乗れる（または降りられる）場所のあつまり */
export interface ViewPlaces {
  stops: ViewStop[]
  zones: ViewZone[]
}

/**
 * 1つの運行エリア（≒1 route）。
 * 実データはエリアごとに route / trip / location_group を 1:1:1 で作るのが通例なので、
 * route 単位でまとめる。
 */
export interface ViewArea {
  routeId: string
  name: string
  board: ViewPlaces
  alight: ViewPlaces
  /** "9:00"〜"17:00" 形式。便（時間帯）ごとに1つ。booking はその便の予約ルール */
  windows: { start: string; end: string; booking?: ViewBooking }[]
  /** 月〜日 */
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean]
  /** YYYYMMDD */
  dateRange?: { start: string; end: string }
  /** calendar_dates で運休になる日（YYYYMMDD） */
  closedDates: string[]
  /** calendar_dates で臨時に走る日（YYYYMMDD） */
  extraDates: string[]
  /** 代表の予約ルール（いちばん長い時間帯の便のもの） */
  booking?: ViewBooking
  /** 一部の便だけ違う予約ルール（例：朝の便は前日締切）。案内の補足に使う */
  otherBookings: ViewBooking[]
}

export interface FlexView {
  agencyName: string
  agencyUrl?: string
  agencyPhone?: string
  feedVersion?: string
  areas: ViewArea[]
}

/**
 * 外から来た FlexView（同梱JSON・localStorage のプレビュー）に、後から増えた
 * フィールドの既定値を埋める。古いデータを読んでもページが落ちないようにする。
 */
export function normalizeView(v: FlexView): FlexView {
  for (const a of v.areas ?? []) {
    a.otherBookings ??= []
    a.closedDates ??= []
    a.extraDates ??= []
    a.windows ??= []
    a.board ??= { stops: [], zones: [] }
    a.alight ??= { stops: [], zones: [] }
  }
  return v
}

/** "9:00:00" / "09:00:00" / "9:00" → "9:00"（表示用。先頭の 0 は付けない） */
export function toDisplayTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t.trim())
  if (!m) return t
  return `${Number(m[1])}:${m[2]}`
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

interface GeoJsonGeometry {
  type: string
  coordinates: unknown
}
interface GeoJsonFeature {
  id?: string | number
  properties?: { stop_name?: string }
  geometry?: GeoJsonGeometry
}

function zonesFromGeojson(text: string): Map<string, ViewZone> {
  const zones = new Map<string, ViewZone>()
  let parsed: { features?: GeoJsonFeature[] }
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return zones
  }
  for (const f of parsed.features ?? []) {
    const id = String(f.id ?? '')
    if (!id || !f.geometry) continue
    const rings: [number, number][][] = []
    if (f.geometry.type === 'Polygon') {
      for (const ring of f.geometry.coordinates as [number, number][][]) rings.push(ring)
    } else if (f.geometry.type === 'MultiPolygon') {
      for (const poly of f.geometry.coordinates as [number, number][][][]) for (const ring of poly) rings.push(ring)
    } else continue
    zones.set(id, { id, name: f.properties?.stop_name ?? id, rings })
  }
  return zones
}

function bookingFrom(r: Record<string, string>): ViewBooking {
  const type = (num(r.booking_type) ?? 2) as 0 | 1 | 2
  return {
    type,
    durationMin: num(r.prior_notice_duration_min),
    startDay: num(r.prior_notice_start_day),
    lastDay: num(r.prior_notice_last_day),
    lastTime: r.prior_notice_last_time ? toDisplayTime(r.prior_notice_last_time) : undefined,
    message: r.message || undefined,
    phone: r.phone_number || undefined,
    infoUrl: r.info_url || undefined,
    bookingUrl: r.booking_url || undefined,
  }
}

const NO_DAYS: ViewArea['days'] = [false, false, false, false, false, false, false]

/**
 * ファイル名 → テキスト の辞書（zip を展開したもの）から表示モデルを作る。
 * 足りないファイルがあっても読める範囲で返す（読み込み画面でエラーにするのは呼び出し側）。
 */
export function readFlexFiles(files: Record<string, string>): FlexView {
  const table = (name: string): Record<string, string>[] => (files[name] ? parseCsv(files[name]) : [])

  const agency = table('agency.txt')[0] ?? {}
  const feedInfo = table('feed_info.txt')[0] ?? {}

  const stops = new Map<string, ViewStop>()
  for (const r of table('stops.txt')) {
    const lat = num(r.stop_lat)
    const lon = num(r.stop_lon)
    if (r.stop_id === undefined || lat === undefined || lon === undefined) continue
    stops.set(r.stop_id, { id: r.stop_id, name: r.stop_name ?? '', lat, lon })
  }

  const groupName = new Map<string, string>()
  for (const r of table('location_groups.txt')) groupName.set(r.location_group_id, r.location_group_name ?? '')
  const groupStops = new Map<string, ViewStop[]>()
  for (const r of table('location_group_stops.txt')) {
    const st = stops.get(r.stop_id)
    if (!st) continue
    const list = groupStops.get(r.location_group_id) ?? []
    list.push(st)
    groupStops.set(r.location_group_id, list)
  }

  const zones = files['locations.geojson'] ? zonesFromGeojson(files['locations.geojson']) : new Map<string, ViewZone>()

  const bookings = new Map<string, ViewBooking>()
  for (const r of table('booking_rules.txt')) bookings.set(r.booking_rule_id, bookingFrom(r))

  interface Cal {
    days: ViewArea['days']
    start: string
    end: string
  }
  const calendars = new Map<string, Cal>()
  for (const r of table('calendar.txt')) {
    calendars.set(r.service_id, {
      days: [r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday, r.sunday].map((v) => v === '1') as ViewArea['days'],
      start: r.start_date ?? '',
      end: r.end_date ?? '',
    })
  }
  const closed = new Map<string, string[]>()
  const extra = new Map<string, string[]>()
  for (const r of table('calendar_dates.txt')) {
    const m = r.exception_type === '2' ? closed : extra
    m.set(r.service_id, [...(m.get(r.service_id) ?? []), r.date])
  }

  const routeName = new Map<string, string>()
  for (const r of table('routes.txt')) routeName.set(r.route_id, r.route_long_name || r.route_short_name || r.route_id)
  const tripInfo = new Map<string, { routeId: string; serviceId: string }>()
  for (const r of table('trips.txt')) tripInfo.set(r.trip_id, { routeId: r.route_id, serviceId: r.service_id })

  // stop_times を trip ごとにまとめ、行ごとの pickup/drop_off で乗車側・降車側へ振り分ける
  const areas = new Map<string, ViewArea>()
  const addPlaces = (into: ViewPlaces, row: Record<string, string>): void => {
    if (row.location_id && zones.has(row.location_id)) {
      const z = zones.get(row.location_id)!
      if (!into.zones.some((x) => x.id === z.id)) into.zones.push(z)
    }
    if (row.location_group_id) {
      for (const st of groupStops.get(row.location_group_id) ?? []) {
        if (!into.stops.some((x) => x.id === st.id)) into.stops.push(st)
      }
    }
    if (row.stop_id && stops.has(row.stop_id)) {
      const st = stops.get(row.stop_id)!
      if (!into.stops.some((x) => x.id === st.id)) into.stops.push(st)
    }
  }

  const byTrip = new Map<string, Record<string, string>[]>()
  for (const r of table('stop_times.txt')) byTrip.set(r.trip_id, [...(byTrip.get(r.trip_id) ?? []), r])

  // エリアごとの予約ルール候補：booking_rule_id → その窓の長さ（分）。
  // 一部の便だけ違うルール（朝だけ前日締切など）があるので、
  // いちばん長い時間帯のルールを「代表」に、残りを補足として持つ
  const minutes = (t: string): number => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t)
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0
  }
  const bookingSpans = new Map<string, Map<string, number>>()

  for (const [tripId, rows] of byTrip) {
    const info = tripInfo.get(tripId)
    if (!info) continue
    let area = areas.get(info.routeId)
    if (!area) {
      const cal = calendars.get(info.serviceId)
      area = {
        routeId: info.routeId,
        name: routeName.get(info.routeId) ?? info.routeId,
        board: { stops: [], zones: [] },
        alight: { stops: [], zones: [] },
        windows: [],
        days: cal?.days ?? NO_DAYS,
        dateRange: cal ? { start: cal.start, end: cal.end } : undefined,
        closedDates: closed.get(info.serviceId) ?? [],
        extraDates: extra.get(info.serviceId) ?? [],
        booking: undefined,
        otherBookings: [],
      }
      areas.set(info.routeId, area)
    }
    for (const row of rows) {
      if (row.pickup_type === '2' || row.pickup_type === '0') addPlaces(area.board, row)
      if (row.drop_off_type === '2' || row.drop_off_type === '0' || row.drop_off_type === '3') addPlaces(area.alight, row)
      const start = row.start_pickup_drop_off_window
      const end = row.end_pickup_drop_off_window
      const bookingId = row.pickup_booking_rule_id || row.drop_off_booking_rule_id
      if (bookingId && bookings.has(bookingId)) {
        const spans = bookingSpans.get(info.routeId) ?? new Map<string, number>()
        const span = start && end ? Math.max(0, minutes(end) - minutes(start)) : 0
        spans.set(bookingId, Math.max(spans.get(bookingId) ?? 0, span))
        bookingSpans.set(info.routeId, spans)
      }
      if (start && end) {
        const w = {
          start: toDisplayTime(start),
          end: toDisplayTime(end),
          booking: bookingId ? bookings.get(bookingId) : undefined,
        }
        if (!area.windows.some((x) => x.start === w.start && x.end === w.end)) area.windows.push(w)
      }
    }
  }

  // 代表の予約ルールを決める（いちばん長い時間帯のもの）。残りは補足へ
  for (const [routeId, spans] of bookingSpans) {
    const area = areas.get(routeId)
    if (!area) continue
    const sorted = [...spans.entries()].sort((a, b) => b[1] - a[1])
    area.booking = bookings.get(sorted[0][0])
    area.otherBookings = sorted.slice(1).map(([id]) => bookings.get(id)!).filter(Boolean)
  }

  return {
    agencyName: agency.agency_name ?? '',
    agencyUrl: agency.agency_url || undefined,
    agencyPhone: agency.agency_phone || undefined,
    feedVersion: feedInfo.feed_version || undefined,
    areas: [...areas.values()],
  }
}
