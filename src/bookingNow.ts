// 「いま予約できる？」の判定（住民ページ check.ts とサイネージ signage.ts で共用）。
// 端末の時計で、きょうこのエリアが走っているか・いまから予約が間に合うかを判定する。
// あくまで目安（受付電話の営業時間までは GTFS に無い）。最終確認は電話で。

import type { ViewArea } from './gtfs/flexReader.ts'

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymdOf = (d: Date): string => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
const minOf = (t: string): number => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}
const fmtMin = (m: number): string => `${Math.floor(m / 60)}:${pad2(m % 60)}`

export function runsOn(a: ViewArea, d: Date): boolean {
  const ymd = ymdOf(d)
  if (a.extraDates.includes(ymd)) return true
  if (a.closedDates.includes(ymd)) return false
  if (a.dateRange && a.dateRange.start.length === 8 && (ymd < a.dateRange.start || ymd > a.dateRange.end)) return false
  return a.days[(d.getDay() + 6) % 7]
}

export interface NowStatus {
  cls: 'ok' | 'warn' | 'off'
  title: string
  detail: string
}

export function bookingNow(a: ViewArea, now: Date): NowStatus {
  if (!runsOn(a, now)) {
    let next: Date | null = null
    for (let i = 1; i <= 14; i++) {
      const d = new Date(now)
      d.setDate(d.getDate() + i)
      if (runsOn(a, d)) {
        next = d
        break
      }
    }
    const nextTxt = next ? `次に走るのは ${next.getMonth() + 1}月${next.getDate()}日（${'日月火水木金土'[next.getDay()]}）です。` : ''
    return { cls: 'off', title: 'きょうは走っていません', detail: nextTxt }
  }

  const nowMin = now.getHours() * 60 + now.getMinutes()
  for (const w of a.windows) {
    const r = w.booking ?? a.booking
    const end = minOf(w.end)
    if (!r) continue
    if (r.type === 0 && nowMin < end) {
      return { cls: 'ok', title: 'いま呼べます', detail: `きょうは ${w.end} まで走っています。予約なしで電話してください。` }
    }
    if (r.type === 1) {
      const need = r.durationMin ?? 0
      if (nowMin + need <= end) {
        const earliest = Math.max(nowMin + need, minOf(w.start))
        return {
          cls: 'ok',
          title: 'いま予約できます',
          detail: `いま電話すると、早ければ ${fmtMin(earliest)} ごろに乗れます（きょうの運行は ${w.end} まで）。`,
        }
      }
    }
  }

  // きょうの便にはもう乗れない。前日締切型なら、あすの便の締切を案内する
  const r2 = [...a.windows.map((w) => w.booking), a.booking].find((r) => r?.type === 2)
  if (r2?.lastTime) {
    const dayWord = (r2.lastDay ?? 1) === 1 ? 'あすの便' : `${r2.lastDay}日後の便`
    if (nowMin < minOf(r2.lastTime)) {
      return { cls: 'warn', title: 'きょうの便は予約できません', detail: `${dayWord}は、きょう ${r2.lastTime} までに電話で予約してください。` }
    }
    return { cls: 'warn', title: 'きょうの受付は終わりました', detail: `予約の締切は利用日の前日 ${r2.lastTime} です。` }
  }
  return { cls: 'warn', title: 'きょうの受付は終わりました', detail: 'あすの便の予約は、電話でご確認ください。' }
}
