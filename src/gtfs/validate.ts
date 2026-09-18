// GTFS-Flex の条件付き必須／禁止ルールを、出力ファイル群に対して機械的に確認する。
//
// これは MobilityData の正規バリデータ（gtfs-validator）の代わりではない。
// 正規バリデータは Java 製で、ブラウザでは動かない。ここでは「手で書くとまず壊れる」
// Flex 固有の条件だけを、画面上でその場で指摘できるようにしている。
// 本番データは必ず正規バリデータにもかけること（docs/gtfs-flex-reference.md）。
//
// ルールの出典：GTFS Schedule Reference（google/transit）stop_times.txt / booking_rules.txt /
// location_groups.txt / location_group_stops.txt / locations.geojson の Presence 列。

import type { GtfsFiles, ValidationIssue } from '../types'
import { parseCsv } from './csv'

const TIME_RE = /^\d{1,2}:\d{2}:\d{2}$/

function timeToSec(t: string): number {
  const [h, m, s] = t.split(':').map(Number)
  return h * 3600 + m * 60 + s
}

export function validateFlexFiles(files: GtfsFiles): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (file: string, message: string) => issues.push({ level: 'error', file, message })
  const warn = (file: string, message: string) => issues.push({ level: 'warning', file, message })

  const table = (name: string) => (files[name] ? parseCsv(files[name]) : [])

  for (const required of ['agency.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) {
    if (!files[required]) err(required, 'ファイルがありません')
  }
  if (!files['calendar.txt'] && !files['calendar_dates.txt']) {
    err('calendar.txt', 'calendar.txt か calendar_dates.txt のどちらかが必要です')
  }

  // --- ID の一意性（stops.stop_id / locations.geojson id / location_group_id は全体で一意） ---
  const stopIds = new Set(table('stops.txt').map((r) => r.stop_id))
  const groupIds = new Set(table('location_groups.txt').map((r) => r.location_group_id))
  const locationIds = new Set<string>()
  if (files['locations.geojson']) {
    try {
      const g = JSON.parse(files['locations.geojson'])
      if (g.type !== 'FeatureCollection') err('locations.geojson', 'type は "FeatureCollection" である必要があります')
      for (const f of g.features ?? []) {
        if (f.id === undefined || f.id === '') {
          err('locations.geojson', 'id の無い Feature があります')
          continue
        }
        const id = String(f.id)
        if (locationIds.has(id)) err('locations.geojson', `id "${id}" が重複しています`)
        locationIds.add(id)
        const gt = f.geometry?.type
        if (gt !== 'Polygon' && gt !== 'MultiPolygon') {
          err('locations.geojson', `id "${id}": geometry.type は Polygon か MultiPolygon である必要があります`)
        }
        if (gt === 'Polygon') {
          for (const ring of f.geometry.coordinates ?? []) {
            if (!Array.isArray(ring) || ring.length < 4) {
              err('locations.geojson', `id "${id}": ポリゴンの頂点が足りません（閉じた環で4点以上）`)
            } else {
              const [a, b] = [ring[0], ring[ring.length - 1]]
              if (a[0] !== b[0] || a[1] !== b[1]) err('locations.geojson', `id "${id}": 環が閉じていません`)
            }
          }
        }
        if (!f.properties) err('locations.geojson', `id "${id}": properties がありません`)
      }
    } catch {
      err('locations.geojson', 'JSON として読めません')
    }
  }
  for (const id of locationIds) {
    if (stopIds.has(id)) err('locations.geojson', `id "${id}" が stops.stop_id と重複しています`)
    if (groupIds.has(id)) err('locations.geojson', `id "${id}" が location_group_id と重複しています`)
  }
  for (const id of groupIds) {
    if (stopIds.has(id)) err('location_groups.txt', `location_group_id "${id}" が stops.stop_id と重複しています`)
  }

  // --- location_group_stops ---
  for (const r of table('location_group_stops.txt')) {
    if (!groupIds.has(r.location_group_id)) {
      err('location_group_stops.txt', `location_group_id "${r.location_group_id}" が location_groups.txt にありません`)
    }
    if (!stopIds.has(r.stop_id)) err('location_group_stops.txt', `stop_id "${r.stop_id}" が stops.txt にありません`)
  }

  // --- booking_rules ---
  const bookingIds = new Set<string>()
  for (const r of table('booking_rules.txt')) {
    const id = r.booking_rule_id
    bookingIds.add(id)
    const t = r.booking_type
    if (!['0', '1', '2'].includes(t)) {
      err('booking_rules.txt', `${id}: booking_type は 0/1/2 のいずれかです`)
      continue
    }
    const has = (k: string) => (r[k] ?? '') !== ''
    if (t === '1' && !has('prior_notice_duration_min')) {
      err('booking_rules.txt', `${id}: booking_type=1 では prior_notice_duration_min が必須です`)
    }
    if (t !== '1' && has('prior_notice_duration_min')) {
      err('booking_rules.txt', `${id}: prior_notice_duration_min は booking_type=1 のときだけ使えます`)
    }
    if (t !== '1' && has('prior_notice_duration_max')) {
      err('booking_rules.txt', `${id}: prior_notice_duration_max は booking_type=1 のときだけ使えます`)
    }
    if (t === '2' && !has('prior_notice_last_day')) {
      err('booking_rules.txt', `${id}: booking_type=2 では prior_notice_last_day が必須です`)
    }
    if (t !== '2' && has('prior_notice_last_day')) {
      err('booking_rules.txt', `${id}: prior_notice_last_day は booking_type=2 のときだけ使えます`)
    }
    if (has('prior_notice_last_day') !== has('prior_notice_last_time')) {
      err('booking_rules.txt', `${id}: prior_notice_last_day と prior_notice_last_time は両方書くか両方空にします`)
    }
    if (t === '0' && has('prior_notice_start_day')) {
      err('booking_rules.txt', `${id}: booking_type=0 では prior_notice_start_day は使えません`)
    }
    if (t === '1' && has('prior_notice_duration_max') && has('prior_notice_start_day')) {
      err('booking_rules.txt', `${id}: prior_notice_duration_max と prior_notice_start_day は同時に使えません`)
    }
    if (has('prior_notice_start_day') !== has('prior_notice_start_time')) {
      err('booking_rules.txt', `${id}: prior_notice_start_day と prior_notice_start_time は両方書くか両方空にします`)
    }
    if (t !== '2' && has('prior_notice_service_id')) {
      err('booking_rules.txt', `${id}: prior_notice_service_id は booking_type=2 のときだけ使えます`)
    }
    for (const k of ['prior_notice_last_time', 'prior_notice_start_time']) {
      if (has(k) && !TIME_RE.test(r[k])) err('booking_rules.txt', `${id}: ${k} は HH:MM:SS 形式です`)
    }
    if (!has('phone_number') && !has('booking_url') && !has('info_url')) {
      warn('booking_rules.txt', `${id}: 電話番号・予約URL・案内URLのどれも無いと、利用者は予約方法が分かりません`)
    }
  }

  // --- trips / stop_times ---
  const routeIds = new Set(table('routes.txt').map((r) => r.route_id))
  const serviceIds = new Set(table('calendar.txt').map((r) => r.service_id))
  const tripIds = new Set<string>()
  for (const r of table('trips.txt')) {
    tripIds.add(r.trip_id)
    if (!routeIds.has(r.route_id)) err('trips.txt', `${r.trip_id}: route_id "${r.route_id}" が routes.txt にありません`)
    if (serviceIds.size && !serviceIds.has(r.service_id)) {
      err('trips.txt', `${r.trip_id}: service_id "${r.service_id}" が calendar.txt にありません`)
    }
  }

  const stopTimes = table('stop_times.txt')
  const perTrip = new Map<string, number>()
  for (const r of stopTimes) {
    const tag = `${r.trip_id}#${r.stop_sequence}`
    perTrip.set(r.trip_id, (perTrip.get(r.trip_id) ?? 0) + 1)
    if (!tripIds.has(r.trip_id)) err('stop_times.txt', `${tag}: trip_id が trips.txt にありません`)

    const refs = ['stop_id', 'location_group_id', 'location_id'].filter((k) => (r[k] ?? '') !== '')
    if (refs.length !== 1) {
      err('stop_times.txt', `${tag}: stop_id / location_group_id / location_id はちょうど1つだけ指定します（今は ${refs.length} 個）`)
    }
    if (r.stop_id && !stopIds.has(r.stop_id)) err('stop_times.txt', `${tag}: stop_id "${r.stop_id}" が stops.txt にありません`)
    if (r.location_group_id && !groupIds.has(r.location_group_id)) {
      err('stop_times.txt', `${tag}: location_group_id "${r.location_group_id}" が location_groups.txt にありません`)
    }
    if (r.location_id && !locationIds.has(r.location_id)) {
      err('stop_times.txt', `${tag}: location_id "${r.location_id}" が locations.geojson にありません`)
    }

    const hasStart = (r.start_pickup_drop_off_window ?? '') !== ''
    const hasEnd = (r.end_pickup_drop_off_window ?? '') !== ''
    const flexRef = !!(r.location_group_id || r.location_id)
    if (flexRef && !(hasStart && hasEnd)) {
      err('stop_times.txt', `${tag}: location_group_id / location_id を使うときは start/end_pickup_drop_off_window が必須です`)
    }
    if (hasStart !== hasEnd) err('stop_times.txt', `${tag}: 窓の開始と終了は両方書きます`)
    const windowed = hasStart || hasEnd
    if (windowed) {
      if ((r.arrival_time ?? '') !== '' || (r.departure_time ?? '') !== '') {
        err('stop_times.txt', `${tag}: 窓を使うときは arrival_time / departure_time は書けません`)
      }
      if (r.pickup_type === '0' || r.pickup_type === '' || r.pickup_type === undefined || r.pickup_type === '3') {
        err('stop_times.txt', `${tag}: 窓を使うとき pickup_type は 1 か 2 です（0・空・3 は禁止）`)
      }
      if (r.drop_off_type === '0' || r.drop_off_type === '' || r.drop_off_type === undefined) {
        err('stop_times.txt', `${tag}: 窓を使うとき drop_off_type は 1・2・3 のいずれかです（0・空は禁止）`)
      }
      if (hasStart && hasEnd) {
        if (!TIME_RE.test(r.start_pickup_drop_off_window) || !TIME_RE.test(r.end_pickup_drop_off_window)) {
          err('stop_times.txt', `${tag}: 窓の時刻は HH:MM:SS 形式です`)
        } else if (timeToSec(r.end_pickup_drop_off_window) <= timeToSec(r.start_pickup_drop_off_window)) {
          err('stop_times.txt', `${tag}: 窓の終了が開始より前です`)
        }
      }
    }
    for (const k of ['pickup_booking_rule_id', 'drop_off_booking_rule_id']) {
      if ((r[k] ?? '') !== '' && !bookingIds.has(r[k])) {
        err('stop_times.txt', `${tag}: ${k} "${r[k]}" が booking_rules.txt にありません`)
      }
    }
    if (r.pickup_type === '2' && !r.pickup_booking_rule_id) {
      warn('stop_times.txt', `${tag}: pickup_type=2（要予約）なら pickup_booking_rule_id を付けることが推奨されています`)
    }
    if (r.drop_off_type === '2' && !r.drop_off_booking_rule_id) {
      warn('stop_times.txt', `${tag}: drop_off_type=2（要予約）なら drop_off_booking_rule_id を付けることが推奨されています`)
    }
  }
  for (const [trip, n] of perTrip) {
    if (n < 2) err('stop_times.txt', `${trip}: 便には乗車側・降車側の2行以上が必要です`)
  }
  for (const t of tripIds) if (!perTrip.has(t)) err('trips.txt', `${t}: stop_times.txt に行がありません`)

  return issues
}
