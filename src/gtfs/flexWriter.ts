// 入力モデル（DemandService ＝ 事業者＋複数エリア）→ GTFS-Flex のファイル群。
//
// このファイルがツールの核心。運行形態（pattern）ごとに stop_times.txt をどう組むかを
// ここに閉じ込める。画面側は GTFS のことを知らなくてよい。
//
// エリアは route / trip / location_group に 1:1:1 で対応させる（ODPT の実データと同じ流儀。
// docs/gtfs-flex-reference.md §12）。service_id・booking_rule_id・zone id・stop_id は
// エリアの routeId から導出して全体で一意にする（エリア間で同じ入力があっても衝突しない）。
//
// 根拠にしている仕様：GTFS Schedule Reference（gtfs.org、Flex は 2024-03 に正式採用）
//   - stop_times に location_id / location_group_id を使うときは
//     start_pickup_drop_off_window / end_pickup_drop_off_window が必須、
//     arrival_time / departure_time は禁止
//   - 窓を使うとき pickup_type=0,3 と drop_off_type=0 は禁止（2=要予約 を使う）
//   - 同じ区域・同じグループ内での移動は、同じ location_id / location_group_id を
//     持つ stop_times レコードを2行書く
//   - locations.geojson の id、location_group_id、stop_id は全体で一意
// 詳細は docs/gtfs-flex-reference.md
//
// .ts 拡張子付きで import しているのは、Node（scripts/ の変換・生成スクリプト）からも
// そのまま実行できるようにするため（flexReader と同じ）

import type { BookingRule, DemandArea, DemandService, GtfsFiles, OperationPattern } from '../types.ts'
import { toCsv, type Row } from './csv.ts'

const STOP_TIMES_COLUMNS = [
  'trip_id',
  'stop_sequence',
  'stop_id',
  'location_group_id',
  'location_id',
  'start_pickup_drop_off_window',
  'end_pickup_drop_off_window',
  'pickup_type',
  'drop_off_type',
  'pickup_booking_rule_id',
  'drop_off_booking_rule_id',
]

/** "8:00" / "08:00" / "08:00:00" → "08:00:00" */
export function toGtfsTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim())
  if (!m) return t
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`
}

function closeRing(ring: [number, number][]): [number, number][] {
  if (ring.length === 0) return ring
  const [fx, fy] = ring[0]
  const [lx, ly] = ring[ring.length - 1]
  return fx === lx && fy === ly ? ring : [...ring, ring[0]]
}

interface Endpoint {
  kind: 'zone' | 'group'
  id: string
}

/**
 * 運行形態 → 便の乗車側・降車側がそれぞれ「区域」なのか「場所群」なのか。
 * stop_times は乗車側1行・降車側1行の2行構成にする（仕様の "two records" ルール）。
 */
function endpointsFor(pattern: OperationPattern, zoneId: string, groupId: string): [Endpoint, Endpoint] {
  const zone: Endpoint = { kind: 'zone', id: zoneId }
  const group: Endpoint = { kind: 'group', id: groupId }
  switch (pattern) {
    case 'zone_to_point':
      return [zone, group]
    case 'point_to_zone':
      return [group, zone]
    case 'zone_only':
      return [zone, zone]
    case 'checkpoint':
      return [group, group]
  }
}

function endpointCells(e: Endpoint): Pick<Row, 'stop_id' | 'location_group_id' | 'location_id'> {
  return e.kind === 'zone'
    ? { stop_id: '', location_group_id: '', location_id: e.id }
    : { stop_id: '', location_group_id: e.id, location_id: '' }
}

export function needsZone(p: OperationPattern): boolean {
  return p !== 'checkpoint'
}
export function needsStops(p: OperationPattern): boolean {
  return p !== 'zone_only'
}

function bookingRow(id: string, b: BookingRule): Row {
  return {
    booking_rule_id: id,
    booking_type: b.type,
    prior_notice_duration_min: b.type === 1 ? b.priorNoticeDurationMin : '',
    prior_notice_duration_max: b.type === 1 ? b.priorNoticeDurationMax : '',
    prior_notice_last_day: b.type === 2 ? b.priorNoticeLastDay : '',
    prior_notice_last_time: b.type === 2 && b.priorNoticeLastTime ? toGtfsTime(b.priorNoticeLastTime) : '',
    prior_notice_start_day: b.type === 0 ? '' : b.priorNoticeStartDay,
    prior_notice_start_time:
      b.type !== 0 && b.priorNoticeStartDay !== undefined && b.priorNoticeStartTime
        ? toGtfsTime(b.priorNoticeStartTime)
        : '',
    message: b.message ?? '',
    phone_number: b.phone ?? '',
    info_url: b.infoUrl ?? '',
    booking_url: b.bookingUrl ?? '',
  }
}

export function buildFlexFiles(s: DemandService, now = new Date()): GtfsFiles {
  const files: GtfsFiles = {}

  files['agency.txt'] = toCsv(
    ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang', 'agency_phone'],
    [
      {
        agency_id: s.agency.id,
        agency_name: s.agency.name,
        agency_url: s.agency.url,
        agency_timezone: 'Asia/Tokyo',
        agency_lang: 'ja',
        agency_phone: s.agency.phone ?? '',
      },
    ],
  )

  const routes: Row[] = []
  const calendars: Row[] = []
  const calendarDates: Row[] = []
  const trips: Row[] = []
  const stopTimes: Row[] = []
  const bookings: Row[] = []
  const stopRows: Row[] = []
  const groupRows: Row[] = []
  const groupStopRows: Row[] = []
  const geoFeatures: unknown[] = []

  // stop_id はエリアをまたいで一意でないといけない。別エリアで同じ id が使われていたら
  // routeId を頭に付けて逃がす（同じエリア内の重複はそのまま出して、検証で指摘させる）
  const usedStopIds = new Map<string, string>() // 出力 stop_id → routeId

  for (const a of s.areas) {
    const routeId = a.routeId
    const usesZone = needsZone(a.pattern) && !!a.zone
    const usesStops = needsStops(a.pattern) && a.stops.length > 0
    const groupId = `${routeId}_stops`
    const zoneId = usesZone && a.zone ? `${routeId}_${a.zone.id}` : ''
    const serviceId = `${routeId}_cal`

    // route_type=3（バス）。ODPT の Flex 実データ15件中14件が 3（§12）
    routes.push({
      route_id: routeId,
      agency_id: s.agency.id,
      route_short_name: '',
      route_long_name: a.routeName,
      route_type: 3,
    })

    const c = a.calendar
    calendars.push({
      service_id: serviceId,
      monday: c.days[0] ? 1 : 0,
      tuesday: c.days[1] ? 1 : 0,
      wednesday: c.days[2] ? 1 : 0,
      thursday: c.days[3] ? 1 : 0,
      friday: c.days[4] ? 1 : 0,
      saturday: c.days[5] ? 1 : 0,
      sunday: c.days[6] ? 1 : 0,
      start_date: c.startDate,
      end_date: c.endDate,
    })
    for (const d of c.extraDates ?? []) calendarDates.push({ service_id: serviceId, date: d, exception_type: 1 })
    for (const d of c.closedDates ?? []) calendarDates.push({ service_id: serviceId, date: d, exception_type: 2 })

    if (usesStops) {
      for (const st of a.stops) {
        const outId = usedStopIds.has(st.id) && usedStopIds.get(st.id) !== routeId ? `${routeId}_${st.id}` : st.id
        if (!usedStopIds.has(outId)) usedStopIds.set(outId, routeId)
        stopRows.push({
          stop_id: outId,
          stop_name: st.name,
          stop_lat: st.lat.toFixed(6),
          stop_lon: st.lon.toFixed(6),
          location_type: 0,
        })
        groupStopRows.push({ location_group_id: groupId, stop_id: outId })
      }
      groupRows.push({ location_group_id: groupId, location_group_name: `${a.routeName} 乗降場所` })
    }

    if (usesZone && a.zone) {
      geoFeatures.push({
        type: 'Feature',
        id: zoneId,
        properties: { stop_name: a.zone.name, stop_desc: '' },
        geometry: { type: 'Polygon', coordinates: [closeRing(a.zone.polygon)] },
      })
    }

    // 予約ルール：エリア共通が1つ＋便ごとの上書き（例：朝の便だけ前日締切）
    const mainBookingId = `${routeId}_b1`
    bookings.push(bookingRow(mainBookingId, a.bookingRule))
    let overrideSeq = 1

    const [from, to] = endpointsFor(a.pattern, zoneId, groupId)
    a.windows.forEach((w, i) => {
      let bookingId = mainBookingId
      if (w.booking) {
        bookingId = `${routeId}_b${++overrideSeq}`
        bookings.push(bookingRow(bookingId, w.booking))
      }
      const tripId = `${routeId}_t${i + 1}`
      trips.push({ route_id: routeId, service_id: serviceId, trip_id: tripId, trip_headsign: a.routeName })
      const start = toGtfsTime(w.start)
      const end = toGtfsTime(w.end)
      stopTimes.push({
        trip_id: tripId,
        stop_sequence: 1,
        ...endpointCells(from),
        start_pickup_drop_off_window: start,
        end_pickup_drop_off_window: end,
        pickup_type: 2,
        drop_off_type: 1,
        pickup_booking_rule_id: bookingId,
        drop_off_booking_rule_id: '',
      })
      stopTimes.push({
        trip_id: tripId,
        stop_sequence: 2,
        ...endpointCells(to),
        start_pickup_drop_off_window: start,
        end_pickup_drop_off_window: end,
        pickup_type: 1,
        drop_off_type: 2,
        pickup_booking_rule_id: '',
        drop_off_booking_rule_id: bookingId,
      })
    })
  }

  files['routes.txt'] = toCsv(['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'], routes)
  files['calendar.txt'] = toCsv(
    ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    calendars,
  )
  if (calendarDates.length > 0) {
    files['calendar_dates.txt'] = toCsv(['service_id', 'date', 'exception_type'], calendarDates)
  }

  // Flex だけのフィードでも stops.txt は GTFS 上「条件付き必須」。
  // 区域のみでどのエリアにも stop が無い場合は、ヘッダのみの空ファイルを出す。
  files['stops.txt'] = toCsv(['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'], stopRows)
  if (groupRows.length > 0) {
    files['location_groups.txt'] = toCsv(['location_group_id', 'location_group_name'], groupRows)
    files['location_group_stops.txt'] = toCsv(['location_group_id', 'stop_id'], groupStopRows)
  }
  if (geoFeatures.length > 0) {
    files['locations.geojson'] = JSON.stringify({ type: 'FeatureCollection', features: geoFeatures }, null, 2) + '\n'
  }

  files['booking_rules.txt'] = toCsv(
    [
      'booking_rule_id',
      'booking_type',
      'prior_notice_duration_min',
      'prior_notice_duration_max',
      'prior_notice_last_day',
      'prior_notice_last_time',
      'prior_notice_start_day',
      'prior_notice_start_time',
      'message',
      'phone_number',
      'info_url',
      'booking_url',
    ],
    bookings,
  )

  files['trips.txt'] = toCsv(['route_id', 'service_id', 'trip_id', 'trip_headsign'], trips)
  files['stop_times.txt'] = toCsv(STOP_TIMES_COLUMNS, stopTimes)

  // feed_start_date / feed_end_date は ODPT の実データ15件が全て記入していた（2026-09-26 突合）。
  // 有効期間は全エリアの calendar を覆う範囲にする
  const starts = s.areas.map((a) => a.calendar.startDate).filter((d) => d.length === 8)
  const ends = s.areas.map((a) => a.calendar.endDate).filter((d) => d.length === 8)
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  files['feed_info.txt'] = toCsv(
    ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version'],
    [
      {
        feed_publisher_name: s.feedPublisherName,
        feed_publisher_url: s.feedPublisherUrl,
        feed_lang: 'ja',
        feed_start_date: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : '',
        feed_end_date: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : '',
        feed_version: ymd,
      },
    ],
  )

  return files
}

/** エリア1つだけの DemandArea 既定値（画面の初期状態と「エリアを足す」で使う） */
export function emptyArea(n: number): DemandArea {
  const y = new Date().getFullYear()
  return {
    routeId: '',
    routeName: '',
    pattern: 'zone_to_point',
    zone: undefined,
    stops: [],
    bookingRule: { id: 'booking_1', type: 2, priorNoticeLastDay: 1, priorNoticeLastTime: '17:00' },
    calendar: {
      id: `service_${n}`,
      days: [true, true, true, true, true, false, false],
      startDate: `${y}0401`,
      endDate: `${y + 1}0331`,
      closedDates: [],
    },
    windows: [{ start: '08:00', end: '17:00' }],
  }
}
