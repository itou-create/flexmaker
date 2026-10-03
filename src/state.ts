// 単純なストア。フレームワーク無しで足りる規模。

import type { DemandArea, DemandService, ValidationIssue } from './types'

export type MapMode = 'none' | 'zone' | 'stop'

export interface AppState {
  service: DemandService
  /** いま編集中のエリア（service.areas の添字） */
  activeArea: number
  mapMode: MapMode
  /** 描画途中の区域の頂点（[lng, lat]） */
  draftPolygon: [number, number][]
  issues: ValidationIssue[] | null
}

type Listener = (s: AppState) => void

const listeners = new Set<Listener>()
let state: AppState

export function initState(initial: AppState): void {
  state = initial
}

export function getState(): AppState {
  return state
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  for (const l of listeners) l(state)
}

export function updateService(patch: Partial<DemandService>): void {
  setState((s) => ({ service: { ...s.service, ...patch }, issues: null }))
}

/** いま編集中のエリア。パネル・地図はこれを触る */
export function activeArea(): DemandArea {
  return state.service.areas[state.activeArea]
}

export function updateArea(patch: Partial<DemandArea>): void {
  setState((s) => ({
    service: {
      ...s.service,
      areas: s.service.areas.map((a, i) => (i === s.activeArea ? { ...a, ...patch } : a)),
    },
    issues: null,
  }))
}

export function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
