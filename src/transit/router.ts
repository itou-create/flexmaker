// 乗り継ぎを考慮した経路探索（RAPTOR 方式の簡易実装）。
//
// 「乗り物に乗る回数」を1回ずつ増やしながら、各停留所への最早到着を更新していく。
// 1回の round で：
//   1. 路線バスなど時刻の決まった便を、前の round で着いた停留所から乗って先の停留所へ
//   2. デマンド交通（Flex）を、乗れる場所（停留所／区域の中の地点）から降りられる場所へ
//      — 時間帯の中なら呼んだ時刻に乗れるとみなし、距離から所要時間を見積もる
//   3. 徒歩で近くの停留所へ移る
// 到着先は「目的地まで歩ける停留所」か「目的地を含む Flex の降車区域」。
//
// 出すのは「到着が早い順に、乗り換え回数が少ないものだけ」（パレート）最大3件。
// 予約の締切（当日◯分前・前日◯時）も見て、間に合わない便は使わない。

import type { ViewBooking } from '../gtfs/flexReader.ts'
import {
  calendarRuns,
  distanceM,
  dowOf,
  flexRideSec,
  insideRings,
  walkSec,
  ymdOf,
  type TFlex,
  type TPattern,
  type TTrip,
  type Timetable,
} from './timetable.ts'

export interface Pt {
  lat: number
  lon: number
  name?: string
}

export type Leg =
  | { kind: 'walk'; from: Pt; to: Pt; sec: number; m: number }
  | { kind: 'bus'; pattern: TPattern; trip: TTrip; fromIdx: number; toIdx: number; dep: number; arr: number }
  | { kind: 'flex'; flex: TFlex; from: Pt; to: Pt; dep: number; arr: number; fromZone: boolean; toZone: boolean; booking?: ViewBooking }

export interface Journey {
  legs: Leg[]
  /** 家を出る時刻（秒） */
  dep: number
  /** 目的地に着く時刻（秒） */
  arr: number
  /** 乗り物に乗る回数 */
  rides: number
  /** 歩く距離の合計（m）。到着が同じなら歩きの少ない方を出す */
  walkM: number
}

export interface SearchOptions {
  /** 利用する日 */
  date: Date
  /** 出発したい時刻（0時からの秒） */
  depSec: number
  /** 予約の締切判定に使う「いま」。省略時は現在時刻 */
  now?: Date
  /** 乗る回数の上限（既定 3） */
  maxRounds?: number
  /** 出発地・目的地から歩く距離の上限（m。既定 1200） */
  accessM?: number
}

/** 乗り継ぎのときに見ておく余裕 */
const TRANSFER_SEC = 120
/** デマンド車両が来るまでの余裕（呼んだ時刻＝乗る時刻として、迎えの到着ぶん） */
const FLEX_BOARD_SEC = 300
/** これより近ければ徒歩区間を出さない */
const NO_WALK_M = 30

interface Label {
  time: number
  kind: 'access' | 'bus' | 'flex' | 'walk'
  round: number
  /** 乗った・歩いた元の停留所。-1 は出発地 */
  prevStop: number
  pattern?: number
  trip?: TTrip
  boardIdx?: number
  alightIdx?: number
  flex?: number
  dep?: number
  /** Flex の乗車地点（区域の中の出発地など、停留所でないとき） */
  fromPt?: Pt
  booking?: ViewBooking
}

/**
 * 予約ルールを当てはめて、実際に乗れる最早時刻を返す。予約が間に合わなければ null。
 * - 当日◯分前まで：利用日がきょうなら「いま＋◯分」より前には乗れない
 * - 前日◯時まで  ：締切（利用日の前日◯時）を過ぎていれば使えない
 */
function applyBooking(pickup: number, b: ViewBooking | undefined, date: Date, now: Date): number | null {
  if (!b || b.type === 0) return pickup
  const todayYmd = ymdOf(now)
  const dateYmd = ymdOf(date)
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60
  if (b.type === 1) {
    if (dateYmd === todayYmd) return Math.max(pickup, nowSec + (b.durationMin ?? 0) * 60)
    return dateYmd > todayYmd ? pickup : null
  }
  // type 2：前日（lastDay 日前）の lastTime まで
  const deadline = new Date(date)
  deadline.setDate(deadline.getDate() - (b.lastDay ?? 1))
  const dlYmd = ymdOf(deadline)
  if (dlYmd < todayYmd) return null
  if (dlYmd === todayYmd) {
    const m = /^(\d{1,2}):(\d{2})/.exec(b.lastTime ?? '')
    const lastSec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : 24 * 3600
    if (nowSec > lastSec) return null
  }
  return pickup
}

/** その日に走る、pattern の idx 番目を time 以降に出る最初の便 */
function earliestTrip(tt: Timetable, p: TPattern, idx: number, time: number, ymd: string, dow: number): TTrip | null {
  const cals = tt.calendars[p.feed]
  for (const t of p.trips) {
    if (t.dep[idx] < time) continue
    if (calendarRuns(cals.get(t.serviceId), ymd, dow)) return t
  }
  return null
}

export function search(tt: Timetable, origin: Pt, dest: Pt, opts: SearchOptions): Journey[] {
  const now = opts.now ?? new Date()
  const maxRounds = opts.maxRounds ?? 3
  const accessM = opts.accessM ?? 1200
  const ymd = ymdOf(opts.date)
  const dow = dowOf(opts.date)
  const n = tt.stops.length

  const labels: (Label | undefined)[][] = [new Array<Label | undefined>(n)]
  const best = new Array<number>(n).fill(Infinity)
  let marked = new Set<number>()

  // 出発地から歩ける停留所
  for (let s = 0; s < n; s++) {
    const st = tt.stops[s]
    const m = distanceM(origin.lat, origin.lon, st.lat, st.lon)
    if (m > accessM) continue
    const t = opts.depSec + (m < NO_WALK_M ? 0 : walkSec(m))
    labels[0][s] = { time: t, kind: 'access', round: 0, prevStop: -1 }
    best[s] = t
    marked.add(s)
  }
  // 目的地まで歩ける停留所
  const egress = new Map<number, number>()
  for (let s = 0; s < n; s++) {
    const st = tt.stops[s]
    const m = distanceM(dest.lat, dest.lon, st.lat, st.lon)
    if (m <= accessM) egress.set(s, m)
  }
  // 出発地を含む乗車区域 / 目的地を含む降車区域を持つ Flex
  const originZoneFlex = new Set<number>()
  const destZoneFlex = new Set<number>()
  tt.flex.forEach((f, fi) => {
    if (f.pickupZones.some((z) => insideRings(origin.lat, origin.lon, z))) originZoneFlex.add(fi)
    if (f.dropZones.some((z) => insideRings(dest.lat, dest.lon, z))) destZoneFlex.add(fi)
  })

  const candidates: Journey[] = []
  const ptOf = (s: number): Pt => ({ lat: tt.stops[s].lat, lon: tt.stops[s].lon, name: tt.stops[s].name })

  /** ラベルの連なりを出発地までたどって区間の列にする（出発地側が先頭） */
  function legsTo(label: Label, stop: number): Leg[] {
    const legs: Leg[] = []
    let cur: Label | undefined = label
    let curStop = stop
    while (cur) {
      if (cur.kind === 'access') {
        const to = ptOf(curStop)
        const m = distanceM(origin.lat, origin.lon, to.lat, to.lon)
        if (m >= NO_WALK_M) legs.push({ kind: 'walk', from: origin, to, sec: walkSec(m), m })
        break
      }
      if (cur.kind === 'walk') {
        const from = ptOf(cur.prevStop)
        const to = ptOf(curStop)
        const m = distanceM(from.lat, from.lon, to.lat, to.lon)
        legs.push({ kind: 'walk', from, to, sec: walkSec(m), m })
        curStop = cur.prevStop
        cur = labels[cur.round][curStop]
        continue
      }
      if (cur.kind === 'bus') {
        const p = tt.patterns[cur.pattern!]
        legs.push({
          kind: 'bus',
          pattern: p,
          trip: cur.trip!,
          fromIdx: cur.boardIdx!,
          toIdx: cur.alightIdx!,
          dep: cur.trip!.dep[cur.boardIdx!],
          arr: cur.trip!.arr[cur.alightIdx!],
        })
        curStop = cur.prevStop
        cur = labels[cur.round - 1][curStop]
        continue
      }
      // flex
      const f = tt.flex[cur.flex!]
      const fromZone = cur.prevStop < 0
      legs.push({
        kind: 'flex',
        flex: f,
        from: fromZone ? (cur.fromPt ?? origin) : ptOf(cur.prevStop),
        to: ptOf(curStop),
        dep: cur.dep!,
        arr: cur.time,
        fromZone,
        toZone: false,
        booking: cur.booking,
      })
      if (fromZone) break
      curStop = cur.prevStop
      cur = labels[cur.round - 1][curStop]
    }
    return legs.reverse()
  }

  function finish(legs: Leg[], arr: number): void {
    const rides = legs.filter((l) => l.kind !== 'walk').length
    if (rides === 0) return
    // 家を出る時刻：最初の乗り物の出発から、そこまでの徒歩を引く
    const first = legs.findIndex((l) => l.kind !== 'walk')
    const firstRide = legs[first] as Exclude<Leg, { kind: 'walk' }>
    const dep = firstRide.dep - (first > 0 ? (legs[0] as { sec: number }).sec : 0)
    const walkM = legs.reduce((a, l) => a + (l.kind === 'walk' ? l.m : 0), 0)
    candidates.push({ legs, dep, arr, rides, walkM })
  }

  for (let k = 1; k <= maxRounds && marked.size > 0; k++) {
    labels[k] = labels[k - 1].slice()
    const newMarked = new Set<number>()
    const buffer = (prev: Label): number => (prev.kind === 'access' || prev.kind === 'walk' ? 0 : TRANSFER_SEC)

    // 1. 時刻の決まった便
    const queue = new Map<number, number>()
    for (const s of marked) {
      for (const pi of tt.patternsByStop[s]) {
        const idx = tt.patterns[pi].stops.indexOf(s)
        const cur = queue.get(pi)
        if (cur === undefined || idx < cur) queue.set(pi, idx)
      }
    }
    for (const [pi, startIdx] of queue) {
      const p = tt.patterns[pi]
      let trip: TTrip | null = null
      let boardIdx = -1
      for (let i = startIdx; i < p.stops.length; i++) {
        const s = p.stops[i]
        if (trip && i > boardIdx && trip.arr[i] < best[s]) {
          labels[k][s] = { time: trip.arr[i], kind: 'bus', round: k, prevStop: p.stops[boardIdx], pattern: pi, trip, boardIdx, alightIdx: i }
          best[s] = trip.arr[i]
          newMarked.add(s)
        }
        const prev = labels[k - 1][s]
        if (prev && (!trip || prev.time + buffer(prev) < trip.dep[i])) {
          const t2 = earliestTrip(tt, p, i, prev.time + buffer(prev), ymd, dow)
          if (t2 && (!trip || t2.dep[i] < trip.dep[i])) {
            trip = t2
            boardIdx = i
          }
        }
      }
    }

    // 2. デマンド交通
    tt.flex.forEach((f, fi) => {
      if (!calendarRuns(f.calendar, ymd, dow)) return
      const boards: { time: number; fromStop: number; pt: Pt }[] = []
      for (const s of marked) {
        if (!f.pickupStops.includes(s)) continue
        const prev = labels[k - 1][s]
        if (prev) boards.push({ time: prev.time + buffer(prev), fromStop: s, pt: ptOf(s) })
      }
      if (k === 1 && originZoneFlex.has(fi)) boards.push({ time: opts.depSec, fromStop: -1, pt: origin })
      if (boards.length === 0) return
      for (const b of boards) {
        for (const w of f.windows) {
          const rule = w.booking ?? f.booking
          const pickup = applyBooking(Math.max(b.time, w.start), rule, opts.date, now)
          if (pickup === null || pickup > w.end) continue
          for (const d of f.dropStops) {
            if (d === b.fromStop) continue
            const st = tt.stops[d]
            const arr = pickup + FLEX_BOARD_SEC + flexRideSec(distanceM(b.pt.lat, b.pt.lon, st.lat, st.lon))
            if (arr > w.end || arr >= best[d]) continue
            labels[k][d] = { time: arr, kind: 'flex', round: k, prevStop: b.fromStop, flex: fi, dep: pickup, fromPt: b.pt, booking: rule }
            best[d] = arr
            newMarked.add(d)
          }
          // 目的地が降車区域の中なら、そのまま目的地まで
          if (destZoneFlex.has(fi)) {
            const arr = pickup + FLEX_BOARD_SEC + flexRideSec(distanceM(b.pt.lat, b.pt.lon, dest.lat, dest.lon))
            if (arr > w.end) continue
            const head = b.fromStop >= 0 ? legsTo(labels[k - 1][b.fromStop]!, b.fromStop) : []
            head.push({ kind: 'flex', flex: f, from: b.pt, to: dest, dep: pickup, arr, fromZone: b.fromStop < 0, toZone: true, booking: rule })
            finish(head, arr)
          }
        }
      }
    })

    // 3. 徒歩で近くの停留所へ
    for (const s of [...newMarked]) {
      const from = labels[k][s]!
      if (from.kind === 'walk') continue
      for (const { to, sec } of tt.transfers[s] ?? []) {
        const t = from.time + sec
        if (t >= best[to]) continue
        labels[k][to] = { time: t, kind: 'walk', round: k, prevStop: s }
        best[to] = t
        newMarked.add(to)
      }
    }

    // 目的地まで歩ける停留所に着いたら経路として記録
    for (const s of newMarked) {
      const m = egress.get(s)
      if (m === undefined) continue
      const label = labels[k][s]!
      if (label.kind === 'walk') continue // 歩いて着いた停留所からまた歩くのは無駄
      const legs = legsTo(label, s)
      if (m >= NO_WALK_M) legs.push({ kind: 'walk', from: ptOf(s), to: dest, sec: walkSec(m), m })
      finish(legs, label.time + (m >= NO_WALK_M ? walkSec(m) : 0))
    }

    marked = newMarked
  }

  // パレート：到着が早い順に並べ、それまでより乗る回数が少ないものだけ残す
  candidates.sort((a, b) => a.arr - b.arr || a.rides - b.rides || a.walkM - b.walkM || b.dep - a.dep)
  const out: Journey[] = []
  let minRides = Infinity
  for (const j of candidates) {
    if (j.rides >= minRides) continue
    minRides = j.rides
    out.push(j)
  }
  return out.slice(0, 3)
}

export interface SearchResult {
  journeys: Journey[]
  /** 実際に探した日（指定日に無ければ後ろの日） */
  date: Date
  /** 指定日に行き方が無く、別の日の結果を返したとき true */
  shifted: boolean
}

/**
 * 指定の日時で探し、無ければ翌日以降（最大 days 日）を朝から探して最初に見つかった日を返す。
 * 「きょうは運休」「もう終バスが出た」でも、利用者に何かしらの行き方を見せるため。
 */
export function searchNextDays(tt: Timetable, origin: Pt, dest: Pt, opts: SearchOptions, days = 7): SearchResult {
  const first = search(tt, origin, dest, opts)
  if (first.length > 0) return { journeys: first, date: opts.date, shifted: false }
  for (let i = 1; i <= days; i++) {
    const d = new Date(opts.date)
    d.setDate(d.getDate() + i)
    const js = search(tt, origin, dest, { ...opts, date: d, depSec: 5 * 3600 })
    if (js.length > 0) return { journeys: js, date: d, shifted: true }
  }
  return { journeys: [], date: opts.date, shifted: false }
}
