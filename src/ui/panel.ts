// 入力パネル。1画面に全部を縦に並べる（スマホで上から順に埋める前提）。
// 入力は change イベントで拾う（input だと再描画でフォーカスが飛ぶ）。
// 地図の上に浮かぶ操作チップ（区域を描く／場所を置く）も、ここから同じ状態で描く。

import { buildFlexFiles, needsStops, needsZone } from '../gtfs/flexWriter'
import { exampleService } from '../gtfs/example'
import { validateFlexFiles } from '../gtfs/validate'
import { buildZip, downloadBytes } from '../gtfs/zip'
import { getState, setState, subscribe, updateService } from '../state'
import { PATTERN_LABEL, type DemandService, type OperationPattern, type ValidationIssue } from '../types'
import { fitToService } from './map'
import { LOGO_SVG, showIntro } from './intro'

const DAY_LABEL = ['月', '火', '水', '木', '金', '土', '日']

function esc(s: string | number | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// 運行形態ごとの補足と図。図は「区域（点線の塊）」「決まった場所（点）」「向き（矢印）」だけで描く。
const PATTERN_SUB: Record<OperationPattern, string> = {
  zone_to_point: '自宅前などで乗って、病院・役場・駅で降りる',
  point_to_zone: '病院・役場・駅で乗って、自宅前などで降りる',
  zone_only: '区域の中ならどこからどこへでも',
  checkpoint: '決まった場所の間を、時刻表なしで結ぶ',
}
const PATTERN_ICON: Record<OperationPattern, string> = {
  zone_to_point: `<svg viewBox="0 0 64 36" aria-hidden="true">
      <path class="z" d="M4 12 C8 4 20 4 24 10 C28 16 26 26 18 30 C10 34 2 26 4 12 Z"/>
      <path class="a" d="M30 18 H46"/><path class="ah" d="M45 13 L53 18 L45 23 Z"/>
      <circle class="p" cx="58" cy="18" r="4"/>
    </svg>`,
  point_to_zone: `<svg viewBox="0 0 64 36" aria-hidden="true">
      <circle class="p" cx="6" cy="18" r="4"/>
      <path class="a" d="M12 18 H28"/><path class="ah" d="M27 13 L35 18 L27 23 Z"/>
      <path class="z" d="M40 12 C44 4 56 4 60 10 C64 16 62 26 54 30 C46 34 38 26 40 12 Z"/>
    </svg>`,
  zone_only: `<svg viewBox="0 0 64 36" aria-hidden="true">
      <path class="z" d="M14 8 C26 0 48 2 56 12 C62 20 54 32 40 33 C26 34 8 28 8 18 C8 14 10 10 14 8 Z"/>
      <path class="a" d="M22 20 H42"/><path class="ah" d="M41 15 L49 20 L41 25 Z"/><path class="ah" d="M23 15 L15 20 L23 25 Z"/>
    </svg>`,
  checkpoint: `<svg viewBox="0 0 64 36" aria-hidden="true">
      <path class="a" d="M10 26 L32 8 L54 26 M10 26 H54"/>
      <circle class="p" cx="10" cy="26" r="4"/><circle class="p" cx="32" cy="8" r="4"/><circle class="p" cx="54" cy="26" r="4"/>
    </svg>`,
}

interface Step {
  key: string
  label: string
  done: boolean
  skip?: boolean
}

// 手順の進み具合。番号は本当に順番があるので使う。
function steps(s: DemandService, issues: ValidationIssue[] | null): Step[] {
  const b = s.bookingRule
  const zoneNeeded = needsZone(s.pattern)
  const stopsNeeded = needsStops(s.pattern)
  const datesOk = s.calendar.startDate.length === 8 && s.calendar.endDate.length === 8
  return [
    { key: 'basic', label: '事業者', done: !!(s.agency.name && s.agency.id && s.routeName && s.routeId) },
    { key: 'pattern', label: '運行形態', done: true },
    { key: 'zone', label: '区域', done: !zoneNeeded || (!!s.zone && s.zone.polygon.length >= 3), skip: !zoneNeeded },
    { key: 'stops', label: '乗降場所', done: !stopsNeeded || s.stops.length > 0, skip: !stopsNeeded },
    { key: 'booking', label: '予約', done: b.type === 0 || !!(b.phone || b.bookingUrl) },
    { key: 'calendar', label: '運行日', done: s.calendar.days.some(Boolean) && s.windows.length > 0 && datesOk },
    { key: 'export', label: '出力', done: !!issues && !issues.some((i) => i.level === 'error') },
  ]
}

let panelRoot: HTMLElement
let overlayRoot: HTMLElement

export function mountPanel(root: HTMLElement, overlay: HTMLElement): void {
  panelRoot = root
  overlayRoot = overlay
  root.addEventListener('change', onChange)
  root.addEventListener('click', onClick)
  overlay.addEventListener('click', onClick)
  subscribe(() => {
    render()
    renderOverlay()
  })
  render()
  renderOverlay()
}

// ── 地図の上のチップ ─────────────────────────────

function renderOverlay(): void {
  const { mapMode, draftPolygon } = getState()
  if (mapMode === 'zone') {
    overlayRoot.innerHTML = `
      <div class="map-chip zone" role="status">
        <span class="dot"></span>
        <span><strong>区域を描いています</strong> <span class="count">${draftPolygon.length}点</span></span>
        <button type="button" data-act="zone-finish" class="primary" ${draftPolygon.length < 3 ? 'disabled' : ''}>閉じて確定</button>
        <button type="button" data-act="zone-undo" class="secondary" ${draftPolygon.length === 0 ? 'disabled' : ''}>1点戻す</button>
        <button type="button" data-act="zone-cancel" class="secondary">やめる</button>
      </div>`
  } else if (mapMode === 'stop') {
    overlayRoot.innerHTML = `
      <div class="map-chip stop" role="status">
        <span class="dot"></span>
        <span><strong>地図をタップして場所を置く</strong></span>
        <button type="button" data-act="stop-done" class="primary">置き終わり</button>
      </div>`
  } else {
    overlayRoot.innerHTML = ''
  }
}

// ── パネル本体 ────────────────────────────────────

function render(): void {
  const { service: s, mapMode, draftPolygon, issues } = getState()
  const b = s.bookingRule
  const zoneNeeded = needsZone(s.pattern)
  const stopsNeeded = needsStops(s.pattern)
  const st = steps(s, issues)
  const done = (k: string) => st.find((x) => x.key === k)!.done
  const isEmpty = !s.agency.name && !s.routeName && s.stops.length === 0 && !s.zone

  panelRoot.innerHTML = `
  <div class="panel-inner">
  <header class="panel-head">
    <div>
      <div class="title">
        <span class="logo" aria-hidden="true">${LOGO_SVG}</span>
        <h1>GTFS-Flex メーカー<span class="tag">試作</span></h1>
      </div>
      <p class="lead">デマンド交通の運行要領を、地図と数問の入力で GTFS-Flex にします。</p>
    </div>
    <div class="head-actions">
      <button type="button" data-act="load-example" class="link">サンプルを読み込む</button>
      <button type="button" data-act="show-intro" class="link">使い方</button>
    </div>
  </header>

  <nav class="steps" aria-label="手順">
    ${st
      .map(
        (x, i) =>
          `<button type="button" class="step ${x.done ? 'done' : ''} ${x.skip ? 'skip' : ''}" data-act="goto" data-target="sec-${x.key}">
             <span class="n">${x.done ? '✓' : i + 1}</span>${esc(x.label)}
           </button>`,
      )
      .join('')}
  </nav>

  ${
    isEmpty
      ? `<div class="welcome">
           <p><strong>はじめての方へ</strong><br>まず「サンプルを読み込む」で、どんな入力が要るかを確かめると早いです。</p>
         </div>`
      : ''
  }

  <section class="card" id="sec-basic">
    <div class="card-head"><span class="num ${done('basic') ? 'done' : ''}">${done('basic') ? '✓' : '1'}</span><h2>事業者と路線</h2></div>
    <div class="grid-2">
      <label class="field"><span>自治体・事業者名</span><input id="agency-name" name="agency.name" value="${esc(s.agency.name)}" placeholder="○○町" autocomplete="organization"></label>
      <label class="field"><span>事業者ID<span class="opt">半角英数</span></span><input id="agency-id" name="agency.id" value="${esc(s.agency.id)}" placeholder="example_town" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    </div>
    <div class="grid-2">
      <label class="field"><span>サービス名</span><input id="route-name" name="routeName" value="${esc(s.routeName)}" placeholder="○○号"></label>
      <label class="field"><span>路線ID<span class="opt">半角英数</span></span><input id="route-id" name="routeId" value="${esc(s.routeId)}" placeholder="example_demand" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    </div>
    <div class="grid-2">
      <label class="field"><span>Webサイト</span><input id="agency-url" name="agency.url" type="url" value="${esc(s.agency.url)}" placeholder="https://" inputmode="url"></label>
      <label class="field"><span>電話番号</span><input id="agency-phone" name="agency.phone" type="tel" value="${esc(s.agency.phone)}" placeholder="0000-00-0000"></label>
    </div>
  </section>

  <section class="card" id="sec-pattern">
    <div class="card-head"><span class="num done">✓</span><h2>運行形態</h2></div>
    <p class="hint top">どれか1つ。これで必要な入力と、便の組み立て方が決まります。</p>
    <div class="patterns" role="radiogroup" aria-label="運行形態">
    ${(Object.keys(PATTERN_LABEL) as OperationPattern[])
      .map(
        (p) => `<label class="pattern">
            <input type="radio" id="pattern-${p}" name="pattern" value="${p}" ${s.pattern === p ? 'checked' : ''}>
            ${PATTERN_ICON[p]}
            <span class="label">${esc(PATTERN_LABEL[p])}<br><span class="sub">${esc(PATTERN_SUB[p])}</span></span>
          </label>`,
      )
      .join('')}
    </div>
  </section>

  <section class="card ${zoneNeeded ? '' : 'skip'}" id="sec-zone">
    <div class="card-head">
      <span class="num ${done('zone') && zoneNeeded ? 'done' : ''}">${done('zone') && zoneNeeded ? '✓' : '3'}</span>
      <h2>区域</h2>
      ${zoneNeeded ? '' : '<span class="tag">この形態では使いません</span>'}
    </div>
    ${
      zoneNeeded
        ? `<label class="field"><span>区域の名前</span><input id="zone-name" name="zone.name" value="${esc(s.zone?.name)}" placeholder="○○町全域"></label>
           ${
             mapMode === 'zone'
               ? `<div class="map-status active-zone">
                    <span class="grow">上の地図をタップして頂点を置いてください。<span class="count">${draftPolygon.length}点</span></span>
                    <button type="button" data-act="zone-finish" class="primary" ${draftPolygon.length < 3 ? 'disabled' : ''}>閉じて確定</button>
                    <button type="button" data-act="zone-undo" class="secondary" ${draftPolygon.length === 0 ? 'disabled' : ''}>1点戻す</button>
                    <button type="button" data-act="zone-cancel" class="secondary">やめる</button>
                  </div>`
               : s.zone && s.zone.polygon.length >= 3
                 ? `<div class="map-status">
                      <span class="grow">地図に <span class="count">${s.zone.polygon.length}頂点</span> の区域があります</span>
                      <button type="button" data-act="zone-start" class="zone">描き直す</button>
                      <button type="button" data-act="zone-clear" class="secondary">消す</button>
                    </div>`
                 : `<div class="map-status">
                      <span class="grow">乗り降りできる範囲を地図に描きます</span>
                      <button type="button" data-act="zone-start" class="zone">地図で区域を描く</button>
                    </div>`
           }`
        : `<p class="skip-note">決まった乗降場所どうしを結ぶ形態なので、区域はいりません。</p>`
    }
  </section>

  <section class="card ${stopsNeeded ? '' : 'skip'}" id="sec-stops">
    <div class="card-head">
      <span class="num ${done('stops') && stopsNeeded ? 'done' : ''}">${done('stops') && stopsNeeded ? '✓' : '4'}</span>
      <h2>決まった乗降場所</h2>
      ${stopsNeeded ? '' : '<span class="tag">この形態では使いません</span>'}
    </div>
    ${
      stopsNeeded
        ? `${
            mapMode === 'stop'
              ? `<div class="map-status active-stop">
                   <span class="grow">上の地図をタップすると名前を聞かれます。病院・役場・駅など。</span>
                   <button type="button" data-act="stop-done" class="primary">置き終わり</button>
                 </div>`
              : `<div class="map-status">
                   <span class="grow">${s.stops.length ? `<span class="count">${s.stops.length}か所</span> あります` : '病院・役場・駅など、決まった場所を置きます'}</span>
                   <button type="button" data-act="stop-start" class="stop">${s.stops.length ? '場所を足す' : '地図で場所を置く'}</button>
                 </div>`
          }
          <ul class="stops">
            ${s.stops
              .map(
                (x, i) => `<li>
                  <span class="pin" aria-hidden="true"></span>
                  <span>${esc(x.name)}<small>${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}</small></span>
                  <button type="button" data-act="stop-remove" data-i="${i}" class="x" aria-label="${esc(x.name)} を削除">×</button>
                </li>`,
              )
              .join('')}
          </ul>`
        : `<p class="skip-note">区域の中ならどこでも乗り降りできる形態なので、決まった場所はいりません。</p>`
    }
  </section>

  <section class="card" id="sec-booking">
    <div class="card-head"><span class="num ${done('booking') ? 'done' : ''}">${done('booking') ? '✓' : '5'}</span><h2>予約のしかた</h2></div>
    <label class="choice"><input type="radio" id="booking-2" name="booking.type" value="2" ${b.type === 2 ? 'checked' : ''}>
      <span class="body">前日までに予約<small>「利用日の前日17時まで」のような決まり</small></span></label>
    ${
      b.type === 2
        ? `<div class="indent"><div class="grid-2">
            <label class="field"><span>何日前まで</span><input id="booking-lastday" name="booking.lastDay" type="number" min="1" inputmode="numeric" value="${esc(b.priorNoticeLastDay ?? 1)}"></label>
            <label class="field"><span>その日の何時まで</span><input id="booking-lasttime" name="booking.lastTime" type="time" value="${esc(b.priorNoticeLastTime ?? '17:00')}"></label>
           </div></div>`
        : ''
    }
    <label class="choice"><input type="radio" id="booking-1" name="booking.type" value="1" ${b.type === 1 ? 'checked' : ''}>
      <span class="body">当日でも可<small>「乗りたい時刻の60分前まで」のような決まり</small></span></label>
    ${
      b.type === 1
        ? `<div class="indent"><label class="field"><span>何分前まで</span><input id="booking-duration" name="booking.durationMin" type="number" min="0" inputmode="numeric" value="${esc(b.priorNoticeDurationMin ?? 60)}"></label></div>`
        : ''
    }
    <label class="choice"><input type="radio" id="booking-0" name="booking.type" value="0" ${b.type === 0 ? 'checked' : ''}>
      <span class="body">その場で<small>呼んだらすぐ来る、リアルタイム配車</small></span></label>
    <div class="grid-2">
      <label class="field"><span>予約の電話番号</span><input id="booking-phone" name="booking.phone" type="tel" value="${esc(b.phone)}" placeholder="0000-00-0000"></label>
      <label class="field"><span>予約サイト<span class="opt">あれば</span></span><input id="booking-url" name="booking.url" type="url" value="${esc(b.bookingUrl)}" placeholder="https://" inputmode="url"></label>
    </div>
    <label class="field"><span>利用者への一言</span><input id="booking-message" name="booking.message" value="${esc(b.message)}" placeholder="前日17時までにお電話ください"></label>
  </section>

  <section class="card" id="sec-calendar">
    <div class="card-head"><span class="num ${done('calendar') ? 'done' : ''}">${done('calendar') ? '✓' : '6'}</span><h2>運行日と時間帯</h2></div>
    <div class="days" role="group" aria-label="運行する曜日">
      ${DAY_LABEL.map(
        (d, i) =>
          `<label class="day ${i === 5 ? 'sat' : ''} ${i === 6 ? 'sun' : ''}"><input type="checkbox" id="day-${i}" name="day.${i}" ${s.calendar.days[i] ? 'checked' : ''}>${d}</label>`,
      ).join('')}
    </div>
    <div class="grid-2">
      <label class="field"><span>開始日<span class="opt">年月日8桁</span></span><input id="cal-start" name="calendar.startDate" value="${esc(s.calendar.startDate)}" placeholder="20260401" inputmode="numeric" maxlength="8"></label>
      <label class="field"><span>終了日<span class="opt">年月日8桁</span></span><input id="cal-end" name="calendar.endDate" value="${esc(s.calendar.endDate)}" placeholder="20270331" inputmode="numeric" maxlength="8"></label>
    </div>
    <p class="hint">時間帯ごとに1便になります。昼休みがあるなら午前と午後に分けてください。</p>
    <ul class="windows">
      ${s.windows
        .map(
          (w, i) => `<li>
            <span class="trip">${i + 1}便</span>
            <input id="win-${i}-start" name="window.${i}.start" type="time" value="${esc(w.start)}" aria-label="${i + 1}便の開始">
            <span class="tilde">〜</span>
            <input id="win-${i}-end" name="window.${i}.end" type="time" value="${esc(w.end)}" aria-label="${i + 1}便の終了">
            <button type="button" data-act="window-remove" data-i="${i}" class="x" aria-label="${i + 1}便を削除">×</button>
          </li>`,
        )
        .join('')}
    </ul>
    <button type="button" data-act="window-add" class="secondary">時間帯を足す</button>
  </section>

  <section class="card" id="sec-export">
    <div class="card-head"><span class="num ${done('export') ? 'done' : ''}">${done('export') ? '✓' : '7'}</span><h2>確かめて出す</h2></div>
    <div class="grid-2">
      <label class="field"><span>データ公開者名</span><input id="pub-name" name="feedPublisherName" value="${esc(s.feedPublisherName)}" placeholder="${esc(s.agency.name || '○○町')}"></label>
      <label class="field"><span>公開者URL</span><input id="pub-url" name="feedPublisherUrl" type="url" value="${esc(s.feedPublisherUrl)}" placeholder="https://" inputmode="url"></label>
    </div>
    ${renderIssues(issues)}
    <p class="note">ここでの検査は簡易なものです。本番のデータは
      <a href="https://gtfs-validator.mobilitydata.org/" target="_blank" rel="noopener">MobilityData の正規バリデータ</a>にもかけてください。</p>
  </section>
  </div>

  <div class="actionbar">
    <span class="status ${statusClass(issues)}">${statusText(issues)}</span>
    <button type="button" data-act="validate" class="secondary">検証する</button>
    <button type="button" data-act="download" class="primary">zip を出す</button>
  </div>
  `
}

function statusClass(issues: ValidationIssue[] | null): string {
  if (!issues) return ''
  return issues.some((i) => i.level === 'error') ? 'ng' : 'ok'
}

function statusText(issues: ValidationIssue[] | null): string {
  if (!issues) return '検証してから出力します'
  const e = issues.filter((i) => i.level === 'error').length
  const w = issues.filter((i) => i.level === 'warning').length
  if (e) return `エラー ${e} 件。直してから出せます`
  if (w) return `警告 ${w} 件。出力はできます`
  return '問題ありません。出力できます'
}

function renderIssues(issues: ValidationIssue[] | null): string {
  if (!issues) return ''
  if (issues.length === 0) {
    return `<div class="result"><p class="ok"><span aria-hidden="true">✓</span><span>ここで確認できる範囲では問題ありません。</span></p></div>`
  }
  const errors = issues.filter((i) => i.level === 'error')
  return `
    <div class="result">
      ${errors.length ? `<p class="ng-head">エラー ${errors.length} 件。このままでは仕様違反になるので、出力を止めています。</p>` : ''}
      <ul class="issues">${issues
        .map(
          (i) =>
            `<li class="${i.level}"><span class="lvl">${i.level === 'error' ? 'エラー' : '警告'}</span><span><code>${esc(i.file)}</code>${esc(i.message)}</span></li>`,
        )
        .join('')}</ul>
    </div>`
}

// ── 入力の反映 ────────────────────────────────────

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement
  if (!t.name) return
  const s = getState().service
  const v = t.value
  const [head, ...rest] = t.name.split('.')
  switch (head) {
    case 'agency':
      updateService({ agency: { ...s.agency, [rest[0]]: v } })
      break
    case 'routeName':
    case 'routeId':
    case 'feedPublisherName':
    case 'feedPublisherUrl':
      updateService({ [head]: v })
      break
    case 'pattern':
      updateService({ pattern: v as OperationPattern })
      break
    case 'zone':
      updateService({ zone: { id: s.zone?.id ?? 'zone_1', polygon: s.zone?.polygon ?? [], name: v } })
      break
    case 'booking': {
      const b = { ...s.bookingRule }
      if (rest[0] === 'type') {
        b.type = Number(v) as 0 | 1 | 2
        if (b.type === 2) {
          b.priorNoticeLastDay ??= 1
          b.priorNoticeLastTime ??= '17:00'
        }
        if (b.type === 1) b.priorNoticeDurationMin ??= 60
      } else if (rest[0] === 'lastDay') b.priorNoticeLastDay = Number(v)
      else if (rest[0] === 'lastTime') b.priorNoticeLastTime = v
      else if (rest[0] === 'durationMin') b.priorNoticeDurationMin = Number(v)
      else if (rest[0] === 'phone') b.phone = v
      else if (rest[0] === 'url') b.bookingUrl = v
      else if (rest[0] === 'message') b.message = v
      updateService({ bookingRule: b })
      break
    }
    case 'day': {
      const days = [...s.calendar.days] as typeof s.calendar.days
      days[Number(rest[0])] = t.checked
      updateService({ calendar: { ...s.calendar, days } })
      break
    }
    case 'calendar':
      updateService({ calendar: { ...s.calendar, [rest[0]]: v.replace(/\D/g, '') } })
      break
    case 'window': {
      const i = Number(rest[0])
      const windows = s.windows.map((w, j) => (j === i ? { ...w, [rest[1]]: v } : w))
      updateService({ windows })
      break
    }
  }
}

function onClick(e: Event): void {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (!btn) return
  const st = getState()
  const s = st.service
  switch (btn.dataset.act) {
    case 'goto': {
      const el = panelRoot.querySelector<HTMLElement>(`#${btn.dataset.target}`)
      el?.scrollIntoView({ block: 'start' })
      break
    }
    case 'load-example':
      setState({ service: exampleService(), draftPolygon: [], mapMode: 'none', issues: null })
      fitToService()
      break
    case 'show-intro':
      showIntro()
      break
    case 'zone-start':
      setState({ mapMode: 'zone', draftPolygon: [] })
      scrollToMapOnPhone()
      break
    case 'zone-undo':
      setState({ draftPolygon: st.draftPolygon.slice(0, -1) })
      break
    case 'zone-cancel':
      setState({ mapMode: 'none', draftPolygon: [] })
      break
    case 'zone-finish':
      updateService({ zone: { id: s.zone?.id ?? 'zone_1', name: s.zone?.name || '運行区域', polygon: st.draftPolygon } })
      setState({ mapMode: 'none', draftPolygon: [] })
      break
    case 'zone-clear':
      updateService({ zone: undefined })
      break
    case 'stop-start':
      setState({ mapMode: 'stop' })
      scrollToMapOnPhone()
      break
    case 'stop-done':
      setState({ mapMode: 'none' })
      break
    case 'stop-remove': {
      const i = Number(btn.dataset.i)
      updateService({ stops: s.stops.filter((_, j) => j !== i) })
      break
    }
    case 'window-add': {
      const last = s.windows[s.windows.length - 1]
      updateService({ windows: [...s.windows, last ? { start: last.end, end: '17:00' } : { start: '08:00', end: '17:00' }] })
      break
    }
    case 'window-remove': {
      const i = Number(btn.dataset.i)
      updateService({ windows: s.windows.filter((_, j) => j !== i) })
      break
    }
    case 'validate':
      setState({ issues: validateFlexFiles(buildFlexFiles(s)) })
      panelRoot.querySelector('#sec-export')?.scrollIntoView({ block: 'start' })
      break
    case 'download': {
      const files = buildFlexFiles(s)
      const issues = validateFlexFiles(files)
      setState({ issues })
      if (issues.some((i) => i.level === 'error')) {
        panelRoot.querySelector('#sec-export')?.scrollIntoView({ block: 'start' })
        return
      }
      downloadBytes(buildZip(files), `${s.routeId || 'gtfs-flex'}.zip`)
      break
    }
  }
}

// スマホでは地図が上に固定されているので、描き始めたらパネルの先頭に戻して地図を見せる。
function scrollToMapOnPhone(): void {
  if (window.matchMedia('(min-width: 900px)').matches) return
  panelRoot.scrollTo({ top: 0 })
}
