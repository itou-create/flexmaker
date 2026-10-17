// 乗り継ぎ検索の結果を、住民向けの言葉で HTML にする（check.ts から使う）。
// GTFS の項目名は出さない。高齢の方が読める大きさ・言い回しで。

import type { ViewBooking } from '../gtfs/flexReader.ts'
import type { Journey, Leg } from './router.ts'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 秒 → "9:05"。24時を超えたら「翌0:10」 */
export function fmtTime(sec: number): string {
  const total = Math.round(sec / 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  const mm = String(m).padStart(2, '0')
  return h >= 24 ? `翌${h - 24}:${mm}` : `${h}:${mm}`
}

export function fmtDuration(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60))
  if (min < 60) return `${min}分`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}時間` : `${h}時間${m}分`
}

function fmtDist(m: number): string {
  return m >= 950 ? `${(m / 1000).toFixed(1)}km` : `${Math.max(10, Math.round(m / 10) * 10)}m`
}

/** 予約ルールを一言で（journey の Flex 区間に添える） */
export function bookingNote(b: ViewBooking | undefined, dep: number): string {
  if (!b) return '予約が必要です。'
  if (b.type === 0) return '予約なしで、その場で呼べます。'
  if (b.type === 2) {
    const day = (b.lastDay ?? 1) === 1 ? '前の日' : `${b.lastDay}日前`
    return b.lastTime ? `${day}の ${b.lastTime} までに予約してください。` : `${day}までに予約してください。`
  }
  if (b.durationMin && b.durationMin > 0) {
    return `乗る ${b.durationMin}分前（${fmtTime(dep - b.durationMin * 60)} ごろ）までに電話で予約してください。`
  }
  return '当日でも予約できます。'
}

function legHtml(leg: Leg): string {
  if (leg.kind === 'walk') {
    return `<li class="jr-leg jr-walk">
      <span class="jr-ico" aria-hidden="true">🚶</span>
      <div class="jr-body"><div class="jr-main">歩く <b>約${fmtDuration(leg.sec)}</b><span class="jr-sub">（${fmtDist(leg.m)}）</span></div></div>
    </li>`
  }
  if (leg.kind === 'bus') {
    const p = leg.pattern
    const from = p.stops[leg.fromIdx]
    const to = p.stops[leg.toIdx]
    const nStops = leg.toIdx - leg.fromIdx
    const head = leg.trip.headsign ? `${esc(leg.trip.headsign)} 行き` : ''
    const color = p.color ? `style="--line-color:${esc(p.color)}"` : ''
    return `<li class="jr-leg jr-bus" ${color} data-from="${from}" data-to="${to}">
      <span class="jr-ico" aria-hidden="true">🚌</span>
      <div class="jr-body">
        <div class="jr-route"><span class="jr-chip">${esc(p.routeName)}</span> ${head}</div>
        <div class="jr-main"><b>${fmtTime(leg.dep)}</b> <span class="jr-stop" data-stop="${from}"></span></div>
        <div class="jr-sub">↓ ${nStops}つめ（約${fmtDuration(leg.arr - leg.dep)}）</div>
        <div class="jr-main"><b>${fmtTime(leg.arr)}</b> <span class="jr-stop" data-stop="${to}"></span></div>
      </div>
    </li>`
  }
  const f = leg.flex
  const fromName = leg.fromZone ? '乗りたい場所（区域の中）' : (leg.from.name ?? '乗り場')
  const toName = leg.toZone ? '行き先（区域の中）' : (leg.to.name ?? '降り場')
  const tel = f.phone ? `<a class="jr-tel" href="tel:${esc(f.phone.replace(/[^\d+-]/g, ''))}">📞 ${esc(f.phone)}</a>` : ''
  return `<li class="jr-leg jr-flex">
    <span class="jr-ico" aria-hidden="true">🚕</span>
    <div class="jr-body">
      <div class="jr-route"><span class="jr-chip jr-chip-flex">${esc(f.areaName || f.serviceName)}</span> 予約制</div>
      <div class="jr-main"><b>${fmtTime(leg.dep)}</b> ${esc(fromName)}</div>
      <div class="jr-sub">↓ 約${fmtDuration(leg.arr - leg.dep)}（迎えの時間を含む目安）</div>
      <div class="jr-main"><b>${fmtTime(leg.arr)}</b> ${esc(toName)}</div>
      <div class="jr-note">${esc(bookingNote(leg.booking ?? f.booking, leg.dep))} ${tel}</div>
    </div>
  </li>`
}

/**
 * 経路の一覧。停留所名は <span class="jr-stop" data-stop="添字"> で空けてあるので、
 * 呼び出し側が tt.stops の名前を埋める（この部品は Timetable を知らなくてよい）。
 */
export function journeysHtml(journeys: Journey[], stopName: (idx: number) => string): string {
  const html = journeys
    .map((j, i) => {
      const transfers = Math.max(0, j.rides - 1)
      const kinds = j.legs.filter((l) => l.kind !== 'walk').map((l) => (l.kind === 'bus' ? '🚌' : '🚕'))
      return `<article class="jr" data-jr="${i}">
        <button type="button" class="jr-head" data-jr-pick="${i}" aria-expanded="${i === 0 ? 'true' : 'false'}">
          <div class="jr-times"><b>${fmtTime(j.dep)}</b> 出発 → <b>${fmtTime(j.arr)}</b> 着</div>
          <div class="jr-meta">所要 約${fmtDuration(j.arr - j.dep)}・乗りかえ ${transfers}回 <span class="jr-kinds">${kinds.join(' → ')}</span></div>
        </button>
        <ol class="jr-legs" ${i === 0 ? '' : 'hidden'}>${j.legs.map(legHtml).join('')}</ol>
      </article>`
    })
    .join('')
  // 停留所名を埋める
  return html.replace(/<span class="jr-stop" data-stop="(\d+)"><\/span>/g, (_, idx: string) => esc(stopName(Number(idx))))
}
