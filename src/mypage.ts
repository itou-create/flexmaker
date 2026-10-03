// マイページ（試作）。担当者が「作ったあと」に戻ってくる場所の形を見せる。
//
// 2階建て：
//   - この端末でできることは本物として動く：自動保存データ（draft.ts）の一覧・編集の再開・
//     住民ページ/チラシでの確認（preview.ts 経由）・zip 出力・白紙に戻す
//   - サーバが要るもの（公開の固定URL・閲覧の分析・お知らせ配信）は「サンプル」と明記した
//     ダミーで構想を見せる（CLAUDE.md の構想。導入判断はまだ）

import './styles.css'
import { clearDraft, loadDraft, saveDraft } from './draft'
import type { NoticeItem } from './types'
import { buildFlexFiles } from './gtfs/flexWriter'
import { validateFlexFiles } from './gtfs/validate'
import { readFlexFiles } from './gtfs/flexReader.ts'
import { buildZip, downloadBytes } from './gtfs/zip'
import { savePreview } from './preview'
import { areaColor } from './areaColors'
import { hasPersonalKey, hasPublicKey, setGoogleMapsKey } from './mapsKey'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const app = document.getElementById('app')!

// 分析カードのダミーデータ（サーバ導入後の構想サンプル。本物の計測ではない）
const DEMO_VIEWS = [12, 18, 9, 23, 31, 44, 27]
const DEMO_DAYS = ['月', '火', '水', '木', '金', '土', '日']

function viewsChart(): string {
  const max = Math.max(...DEMO_VIEWS)
  const bars = DEMO_VIEWS.map((v, i) => {
    const h = Math.round((v / max) * 70)
    return `<g><rect x="${14 + i * 40}" y="${84 - h}" width="26" height="${h}" rx="4" fill="var(--green)" opacity="${i === 5 ? 1 : 0.55}"/>
      <text x="${27 + i * 40}" y="97" text-anchor="middle" font-size="10" fill="var(--muted)">${DEMO_DAYS[i]}</text></g>`
  }).join('')
  return `<svg viewBox="0 0 300 100" role="img" aria-label="1週間の閲覧数（ダミー）">${bars}</svg>`
}

function render(): void {
  const draft = loadDraft()
  const sv = draft?.service
  const savedAt = draft?.savedAt ? new Date(draft.savedAt) : null
  const savedTxt = savedAt
    ? `${savedAt.getMonth() + 1}月${savedAt.getDate()}日 ${savedAt.getHours()}:${String(savedAt.getMinutes()).padStart(2, '0')} 保存`
    : ''

  const myData = sv
    ? `
      <div class="mp-service">
        <div class="mp-service-head">
          <strong>${esc(sv.agency.name || '（事業者名が未入力）')}</strong>
          <span class="mp-saved">${esc(savedTxt)}</span>
        </div>
        <ul class="mp-areas">
          ${sv.areas
            .map(
              (a, i) => `<li><span class="area-dot" style="background:${areaColor(i)}"></span>${esc(a.routeName || `エリア${i + 1}`)}
                <small>${a.zone ? '区域あり' : ''}${a.zone && a.stops.length ? '・' : ''}${a.stops.length ? `乗り場${a.stops.length}` : ''}${!a.zone && !a.stops.length ? '未入力' : ''}</small></li>`,
            )
            .join('')}
        </ul>
        <div class="mp-actions">
          <a class="btn" href="./">編集を続ける</a>
          <a class="btn" href="check.html#preview" target="_blank" rel="noopener" data-act="preview">住民ページで見る</a>
          <a class="btn" href="flyer.html#preview" target="_blank" rel="noopener" data-act="preview">チラシを印刷</a>
          <a class="btn" href="signage.html#preview" target="_blank" rel="noopener" data-act="preview">サイネージ表示</a>
          <button type="button" class="secondary" data-act="zip">zip を出す</button>
          <button type="button" class="secondary small" data-act="reset">白紙に戻す</button>
        </div>`
    : `
      <p>まだ作成データがありません。作成画面で作り始めると、この端末に自動保存されてここに出ます。</p>
      <div class="mp-actions"><a class="btn" href="./">作成画面を開く</a></div>`

  app.innerHTML = `
  <div class="mp-wrap">
    <header class="mp-head">
      <h1>マイページ<span class="tag">試作</span></h1>
      <p class="lead">作ったデータの管理と、公開後の運用（構想）をここに集めます。</p>
    </header>

    <section class="mp-card">
      <h2>あなたの作成データ</h2>
      ${myData}
      <p class="check-small">データはこの端末の中にだけあります（サーバには送られていません）。</p>
    </section>

    <section class="mp-card">
      <h2>Google マップ連携</h2>
      <p>${
        hasPublicKey()
          ? 'このサイトには運営側のキーが設定済みです。<b>全員、何もしなくても Google マップで表示されます。</b>別のキーを使いたいときだけ、下に入力してください（この端末だけ上書き）。'
          : '運営側のキーが未設定のため、いまは地理院地図で表示しています。運営者は GitHub の Secrets（PUBLIC_GMAPS_KEY）にキーを登録すると全員が Google マップになります。お急ぎの場合は、お手持ちのキーを下に入力するとこの端末だけ Google になります。'
      }</p>
      <div class="mp-actions">
        <input type="password" id="gmaps-key" class="mp-key-input" placeholder="AIza…" autocomplete="off">
        <button type="button" class="secondary" data-act="gkey-save">保存</button>
        ${hasPersonalKey() ? '<button type="button" class="secondary small" data-act="gkey-clear">この端末の設定を消す</button>' : ''}
      </div>
      <p class="check-small">状態：${
        hasPersonalKey()
          ? 'この端末のキーで Google 表示中 ✓'
          : hasPublicKey()
            ? '運営側のキーで Google 表示中 ✓'
            : '未設定（地理院地図で表示中）'
      }</p>
    </section>

    <section class="mp-card mp-mock">
      <h2>公開と固定URL<span class="mock-tag">サンプル</span></h2>
      <p>公開すると住民ページの固定URLとQRが発行され、データを直しても同じURLが最新になります。</p>
      <div class="mp-url">https://flex.example.jp/<b>your-town</b>（例）</div>
      <div class="mp-actions"><button type="button" class="primary" data-act="mock">公開する</button></div>
    </section>

    <section class="mp-card mp-mock">
      <h2>閲覧の分析<span class="mock-tag">サンプル</span></h2>
      <div class="mp-stats">
        <div class="mp-stat"><b>164</b><span>今週の閲覧</span></div>
        <div class="mp-stat"><b>31</b><span>電話タップ</span></div>
        <div class="mp-stat"><b>9</b><span>区域外からの照会</span></div>
      </div>
      ${viewsChart()}
      <p class="check-small">「区域外からどこが多く調べられたか」は、区域を広げる検討の材料になります（地点は集計だけ・個人は特定しない方針）。</p>
    </section>

    <section class="mp-card">
      <h2>お知らせ（広報）</h2>
      <p>住民ページとサイネージの上部に出す短いお知らせです。いまは「住民ページで見る」「サイネージ表示」を
      開いたときに反映されます（公開サイトへの常時配信はサーバ検討後）。</p>
      ${
        sv
          ? `<ul class="mp-notices">
              ${
                (sv.notices ?? [])
                  .map(
                    (n, i) =>
                      `<li><span class="mp-date">${esc(n.date.slice(5).replace('-', '/'))}</span>${esc(n.text)}<button type="button" class="x" data-act="notice-del" data-i="${i}" aria-label="このお知らせを削除">×</button></li>`,
                  )
                  .join('') || '<li class="mp-empty">まだお知らせはありません</li>'
              }
            </ul>
            <div class="mp-actions">
              <input id="notice-text" class="mp-key-input" placeholder="例：年末年始（12/29〜1/3）は運休します" maxlength="60">
              <button type="button" class="secondary" data-act="notice-add">追加</button>
            </div>`
          : '<p class="check-small">作成データができると、ここでお知らせを書けます。</p>'
      }
    </section>

    <footer class="mp-foot">
      <p>「サンプル」の付いた機能はサーバ導入後の構想のダミーです（数字も架空）。導入する場合は、
      費用・維持の手間・応募条件（2027-03-12 までの無償公開）を添えて別途ご相談します。</p>
    </footer>
  </div>`
}

app.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (!btn) return
  const draft = loadDraft()
  switch (btn.dataset.act) {
    case 'preview': {
      // 住民ページ・チラシに渡す（作成画面の「住民ページで見る」と同じ経路）
      if (!draft) {
        e.preventDefault()
        return
      }
      const view = readFlexFiles(buildFlexFiles(draft.service))
      if (view.areas.length === 0 || !savePreview(view, draft.service.notices)) {
        e.preventDefault()
        window.alert('まだ表示できる内容がありません。作成画面でエリアの入力を進めてください。')
      }
      break
    }
    case 'zip': {
      if (!draft) return
      const files = buildFlexFiles(draft.service)
      const issues = validateFlexFiles(files)
      const errors = issues.filter((i) => i.level === 'error')
      if (errors.length > 0) {
        window.alert(`エラーが ${errors.length} 件あるため出力できません。作成画面の「検証する」で確認してください。`)
        return
      }
      downloadBytes(buildZip(files), `${draft.service.agency.id || 'gtfs-flex'}.zip`)
      break
    }
    case 'reset': {
      if (!window.confirm('入力をすべて消して白紙に戻しますか？')) return
      clearDraft()
      render()
      break
    }
    case 'notice-add': {
      if (!draft) return
      const input = document.getElementById('notice-text') as HTMLInputElement | null
      const text = input?.value.trim() ?? ''
      if (!text) return
      const notice: NoticeItem = { date: new Date().toISOString().slice(0, 10), text }
      draft.service.notices = [notice, ...(draft.service.notices ?? [])].slice(0, 10)
      saveDraft(draft.service, draft.activeArea)
      render()
      break
    }
    case 'notice-del': {
      if (!draft) return
      const i = Number(btn.dataset.i)
      draft.service.notices = (draft.service.notices ?? []).filter((_, j) => j !== i)
      saveDraft(draft.service, draft.activeArea)
      render()
      break
    }
    case 'gkey-save': {
      const input = document.getElementById('gmaps-key') as HTMLInputElement | null
      if (!input) return
      if (!setGoogleMapsKey(input.value)) {
        window.alert('キーの形式が違うようです（AIza で始まる39文字）。')
        return
      }
      render()
      break
    }
    case 'gkey-clear':
      setGoogleMapsKey('')
      render()
      break
    case 'mock':
      window.alert('この機能はサーバ導入後の構想サンプルです（まだ動きません）。')
      break
  }
})

render()
