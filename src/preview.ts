// 作成画面 → 住民向け確認ページの「プレビュー連携」。
// 作りかけのデータを保存せずに、住民向け画面（check.html#preview）でそのまま見るための受け渡し。
// localStorage は同一サイトの別タブから読めるので、サーバ無しの方針のまま成立する。
//
// 渡すのは入力モデルではなく FlexView（flexWriter で書き出し → flexReader で読み戻したもの）。
// zip に入るのと同じ経路を通すので、プレビューで見えるものと出力されるデータが食い違わない。

import type { FlexView } from './gtfs/flexReader.ts'

const PREVIEW_KEY = 'flexmaker:preview'

export interface PreviewPayload {
  savedAt: string
  view: FlexView
}

/** プレビュー用データを置く。プライベートモード等で localStorage が使えなければ false */
export function savePreview(view: FlexView): boolean {
  try {
    const payload: PreviewPayload = { savedAt: new Date().toISOString(), view }
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function loadPreview(): PreviewPayload | null {
  try {
    const raw = localStorage.getItem(PREVIEW_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PreviewPayload
    if (!p || !p.view || !Array.isArray(p.view.areas)) return null
    return p
  } catch {
    return null
  }
}
