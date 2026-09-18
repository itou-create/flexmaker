// 入力モデル（DemandService）→ GTFS-Flex のファイル群。
//
// このファイルがツールの核心。運行形態（pattern）ごとに stop_times.txt をどう組むかを
// ここに閉じ込める。画面側は GTFS のことを知らなくてよい。
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

import type { DemandService, GtfsFiles, OperationPattern } from '../types'
import { toCsv, type Row } from './csv'

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

/** 乗降場所グループの ID。checkpoint 型など、決まった場所群を1つのグループとして扱う */
function locationGroupId(s: DemandService): string {
  return `${s.routeId}_stops`
}

interface Endpoint {
  kind: 'zone' | 'group'
  id: string
}

/**
 * 運行形態 → 便の乗車側・降車側がそれぞれ「区域」なのか「場所群」なのか。
 * stop_times は乗車側1行・降車側1行の2行構成にする（仕様の "two records" ルール）。
 */
function endpointsFor(s: DemandService, pattern: OperationPattern): [Endpoint, Endpoint] {
  const zone: Endpoint = { kind: 'zone', id: s.zone?.id ?? '' }
  const group: Endpoint = { kind: 'group', id: locationGroupId(s) }
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

export function buildFlexFiles(s: DemandService, now = new Date()): GtfsFiles {
  const files: GtfsFiles = {}
  const usesZone = needsZone(s.pattern) && !!s.zone
  const usesStops = needsStops(s.pattern) && s.stops.length > 0
  const groupId = locationGroupId(s)

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

  // route_type=3（バス）を既定にしている。乗合タクシーでも GTFS 上はバス扱いが通例だが、
  // GTFS-JP 第4.0版での推奨値は要確認（docs/gtfs-flex-reference.md の「要確認」参照）
  files['routes.txt'] = toCsv(
    ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
    [
      {
        route_id: s.routeId,
        agency_id: s.agency.id,
        route_short_name: '',
        route_long_name: s.routeName,
        route_type: 3,
      },
    ],
  )

  const c = s.calendar
  files['calendar.txt'] = toCsv(
    ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    [
      {
        service_id: c.id,
        monday: c.days[0] ? 1 : 0,
        tuesday: c.days[1] ? 1 : 0,
        wednesday: c.days[2] ? 1 : 0,
        thursday: c.days[3] ? 1 : 0,
        friday: c.days[4] ? 1 : 0,
        saturday: c.days[5] ? 1 : 0,
        sunday: c.days[6] ? 1 : 0,
        start_date: c.startDate,
        end_date: c.endDate,
      },
    ],
  )

  if (usesStops) {
    files['stops.txt'] = toCsv(
      ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'],
      s.stops.map((st) => ({
        stop_id: st.id,
        stop_name: st.name,
        stop_lat: st.lat.toFixed(6),
        stop_lon: st.lon.toFixed(6),
        location_type: 0,
      })),
    )
    files['location_groups.txt'] = toCsv(
      ['location_group_id', 'location_group_name'],
      [{ location_group_id: groupId, location_group_name: `${s.routeName} 乗降場所` }],
    )
    files['location_group_stops.txt'] = toCsv(
      ['location_group_id', 'stop_id'],
      s.stops.map((st) => ({ location_group_id: groupId, stop_id: st.id })),
    )
  } else {
    // Flex だけのフィードでも stops.txt は GTFS 上「条件付き必須」。
    // 区域のみ運行（zone_only）では stop が無いため、ヘッダのみの空ファイルを出す。
    // これで受け入れられるかはバリデータと消費側（OTP 等）で要確認。
    files['stops.txt'] = toCsv(['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'], [])
  }

  if (usesZone && s.zone) {
    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: s.zone.id,
          properties: { stop_name: s.zone.name, stop_desc: '' },
          geometry: { type: 'Polygon', coordinates: [closeRing(s.zone.polygon)] },
        },
      ],
    }
    files['locations.geojson'] = JSON.stringify(geojson, null, 2) + '\n'
  }

  const b = s.bookingRule
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
    [
      {
        booking_rule_id: b.id,
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
      },
    ],
  )

  // 運行時間帯ごとに1便。乗車側・降車側の2行。
  const [from, to] = endpointsFor(s, s.pattern)
  const trips: Row[] = []
  const stopTimes: Row[] = []
  s.windows.forEach((w, i) => {
    const tripId = `${s.routeId}_t${i + 1}`
    trips.push({ route_id: s.routeId, service_id: c.id, trip_id: tripId, trip_headsign: s.routeName })
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
      pickup_booking_rule_id: b.id,
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
      drop_off_booking_rule_id: b.id,
    })
  })
  files['trips.txt'] = toCsv(['route_id', 'service_id', 'trip_id', 'trip_headsign'], trips)
  files['stop_times.txt'] = toCsv(STOP_TIMES_COLUMNS, stopTimes)

  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  files['feed_info.txt'] = toCsv(
    ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_version'],
    [
      {
        feed_publisher_name: s.feedPublisherName,
        feed_publisher_url: s.feedPublisherUrl,
        feed_lang: 'ja',
        feed_version: ymd,
      },
    ],
  )

  return files
}
