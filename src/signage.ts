// デジタルサイネージ表示。役場・病院・公民館の待合モニタに映しっぱなしにする全画面ページ。
// 遠くから読める大きな文字で「いま予約できる？」と予約電話を出し、
// エリアが複数あれば 15秒ごとに順繰りに切り替える。判定は1分ごとに引き直す。
//
// 入口：マイページの「サイネージ表示」またはこの URL を直接モニタのブラウザで開く。
// データは住民ページと同じ2通り（同梱デモ / #preview）。サーバ不要。

import './styles.css'
import { normalizeView, type FlexView, type ViewArea } from './gtfs/flexReader.ts'
import { loadPreview } from './preview'
import { areaColor } from './areaColors'
import { bookingNow } from './bookingNow'
import { daysText, windowsText } from './viewText'

interface DemoData {
  source?: { municipality: string; serviceName: string; provider: string }
  view: FlexView
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const ROTATE_SEC = 15

const app = document.getElementById('app')!
let data: DemoData
let index = 0

function render(): void {
  const areas = data.view.areas
  const a: ViewArea = areas[index % areas.length]
  const i = index % areas.length
  const now = new Date()
  const ns = bookingNow(a, now)
  const phone = a.booking?.phone ?? data.view.agencyPhone ?? ''
  const title = data.source ? data.source.serviceName : data.view.agencyName || 'デマンド交通'
  const clock = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`

  app.innerHTML = `
  <div class="sg">
    <header class="sg-head">
      <div class="sg-title">${esc(title)}</div>
      <div class="sg-clock">${clock}</div>
    </header>
    <div class="sg-area" style="border-color:${areaColor(i)}">
      <div class="sg-area-name"><span class="area-dot" style="background:${areaColor(i)}"></span>${esc(a.name)}</div>
      <div class="sg-status ${ns.cls}">${esc(ns.title)}</div>
      ${ns.detail ? `<div class="sg-detail">${esc(ns.detail)}</div>` : ''}
      <div class="sg-row">
        <div class="sg-days">${esc(daysText(a.days))}<br><b>${esc(windowsText(a))}</b></div>
        <div class="sg-phone"><span>予約のお電話</span><strong>${esc(phone)}</strong></div>
      </div>
    </div>
    <footer class="sg-foot">
      <div class="sg-dots">${areas.map((_, j) => `<span class="${j === i ? 'on' : ''}"></span>`).join('')}</div>
      <div class="sg-note">スマホでも調べられます：itou-create.github.io/flexmaker/check.html ／ この表示は目安です</div>
      <button type="button" id="sg-full" class="no-print">全画面</button>
    </footer>
  </div>`

  document.getElementById('sg-full')?.addEventListener('click', () => {
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
  })
}

async function main(): Promise<void> {
  if (location.hash === '#preview') {
    const p = loadPreview()
    if (!p || p.view.areas.length === 0) {
      app.innerHTML = '<div class="sg"><p style="padding:40px">表示するデータが見つかりません。作成画面かマイページから開き直してください。</p></div>'
      return
    }
    data = { view: normalizeView(p.view) }
  } else {
    const res = await fetch('./data/mizuho_town_mizuho_area.json')
    if (!res.ok) {
      app.innerHTML = '<div class="sg"><p style="padding:40px">データを読み込めませんでした。</p></div>'
      return
    }
    data = (await res.json()) as DemoData
    data.view = normalizeView(data.view)
  }
  document.title = `サイネージ表示 — ${data.source?.serviceName ?? data.view.agencyName ?? ''}`
  render()
  setInterval(() => {
    index++
    render()
  }, ROTATE_SEC * 1000)
  // 分が変わったら判定・時計を引き直す（エリア切替と重なっても害はない）
  setInterval(render, 60 * 1000)
  // 画面のどこを押しても次のエリアへ（モニタ設置時の確認用）
  app.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'sg-full') return
    index++
    render()
  })
}

void main()
