// 入力の自動保存（この端末の localStorage）。
// 役場の作業は中断が多いので、開き直したとき続きから始められるようにする。
// サーバには何も送らない。「入力を白紙に戻す」で消える。

import type { DemandService } from './types'
import { emptyArea } from './gtfs/flexWriter'

const DRAFT_KEY = 'flexmaker:draft'

export function emptyService(): DemandService {
  return {
    agency: { id: '', name: '', url: '', phone: '' },
    areas: [emptyArea(1)],
    feedPublisherName: '',
    feedPublisherUrl: '',
  }
}

export interface Draft {
  service: DemandService
  activeArea: number
  /** 最後に保存した日時（ISO。マイページの表示用） */
  savedAt?: string
}

export function saveDraft(service: DemandService, activeArea: number): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ service, activeArea, savedAt: new Date().toISOString() }))
  } catch {
    /* プライベートモード等で保存できなくても、画面の動作は止めない */
  }
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Draft
    if (!d?.service || !Array.isArray(d.service.areas) || d.service.areas.length === 0) return null
    const activeArea = Math.min(Math.max(0, d.activeArea ?? 0), d.service.areas.length - 1)
    return { service: d.service, activeArea }
  } catch {
    return null
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* 消せなくても害はない */
  }
}
