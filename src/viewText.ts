// 住民向けの言い回し（住民ページ check.ts とチラシ flyer.ts で共用）。
// GTFS の項目名は出さない（CLAUDE.md 設計原則1）。

import type { ViewArea } from './gtfs/flexReader.ts'

const DAY_NAMES = ['月', '火', '水', '木', '金', '土', '日']

export function daysText(days: readonly boolean[]): string {
  if (days.every(Boolean)) return '毎日'
  if (days.slice(0, 5).every(Boolean) && !days[5] && !days[6]) return '月曜日から金曜日'
  return days.map((on, i) => (on ? DAY_NAMES[i] : null)).filter(Boolean).join('・') + '曜日'
}

export function bookingText(a: ViewArea): string {
  const b = a.booking
  if (!b) return ''
  if (b.type === 0) return '予約なしで、その場で呼べます。'
  if (b.type === 2) {
    const day = b.lastDay === 1 ? '前の日' : `${b.lastDay ?? 1}日前`
    return b.lastTime ? `${day}の ${b.lastTime} までに予約してください。` : `${day}までに予約してください。`
  }
  if (b.durationMin && b.durationMin > 0) return `乗りたい時刻の ${b.durationMin}分前 までに予約してください。`
  return '当日でも予約できます。'
}

export function windowsText(a: ViewArea): string {
  return a.windows.map((w) => `${w.start}〜${w.end}`).join('、')
}
