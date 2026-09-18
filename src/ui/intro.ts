// オープニング画面。起動時に全面に出し、「はじめる」か「サンプルで試す」で閉じる。
// パネルの「使い方」からいつでも開き直せる。入力データには触らない（サンプル読み込みを除く）。

import { exampleService } from '../gtfs/example'
import { setState } from '../state'
import { fitToService } from './map'

let root: HTMLElement

export const LOGO_SVG = `<svg viewBox="0 0 26 26" fill="none" aria-hidden="true">
  <rect x="4" y="4" width="18" height="15" rx="4" fill="#fff"/>
  <rect x="6.5" y="7" width="13" height="5.5" rx="1.5" fill="#cfeedb"/>
  <rect x="7" y="14.5" width="3" height="2" rx="1" fill="#f3a4c0"/>
  <rect x="16" y="14.5" width="3" height="2" rx="1" fill="#f3a4c0"/>
  <circle cx="8.5" cy="20" r="2.2" fill="#fff" stroke="#227a4d" stroke-width="1.5"/>
  <circle cx="17.5" cy="20" r="2.2" fill="#fff" stroke="#227a4d" stroke-width="1.5"/>
</svg>`

const STEPS = [
  {
    title: '運行形態を選ぶ',
    text: '「区域内どこでも乗って病院で降りる」など4つから1つ',
    icon: `<svg viewBox="0 0 40 40" aria-hidden="true">
      <path class="z" d="M6 16 C9 8 20 8 23 13 C26 18 24 27 17 30 C10 33 4 26 6 16 Z"/>
      <path class="a" d="M25 20 H31"/><path class="ah" d="M30 16 L36 20 L30 24 Z"/>
    </svg>`,
  },
  {
    title: '地図で区域と場所を置く',
    text: '指でタップするだけ。線を引く道具はいりません',
    icon: `<svg viewBox="0 0 40 40" aria-hidden="true">
      <path class="z" d="M7 14 C10 6 24 6 29 11 C34 16 32 28 24 32 C15 36 4 28 7 14 Z"/>
      <circle class="p" cx="26" cy="15" r="4.5"/>
      <circle class="p" cx="14" cy="24" r="4.5"/>
    </svg>`,
  },
  {
    title: '予約のしかたと運行日を入れる',
    text: '「前日17時まで」「平日8時〜17時」のように答える',
    icon: `<svg viewBox="0 0 40 40" aria-hidden="true">
      <rect x="8" y="7" width="24" height="26" rx="5" fill="#fff" stroke="#34a06a" stroke-width="2.5"/>
      <path d="M8 14 H32" stroke="#34a06a" stroke-width="2.5"/>
      <circle cx="15" cy="21" r="2" fill="#f3a4c0"/><circle cx="20" cy="21" r="2" fill="#cfeedb"/><circle cx="25" cy="21" r="2" fill="#cfeedb"/>
      <circle cx="15" cy="27" r="2" fill="#cfeedb"/><circle cx="20" cy="27" r="2" fill="#34a06a"/><circle cx="25" cy="27" r="2" fill="#cfeedb"/>
    </svg>`,
  },
]

export function mountIntro(el: HTMLElement): void {
  root = el
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-intro]')
    if (!btn) return
    if (btn.dataset.intro === 'example') {
      setState({ service: exampleService(), draftPolygon: [], mapMode: 'none', issues: null })
      fitToService()
    }
    hideIntro()
  })
  root.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') hideIntro()
  })
  render()
  showIntro()
}

export function showIntro(): void {
  root.hidden = false
  document.body.classList.add('intro-open')
  root.querySelector<HTMLElement>('[data-intro="start"]')?.focus({ preventScroll: true })
}

export function hideIntro(): void {
  root.hidden = true
  document.body.classList.remove('intro-open')
}

function render(): void {
  root.innerHTML = `
  <div class="intro-card" role="dialog" aria-modal="true" aria-labelledby="intro-title">
    <div class="intro-logo">${LOGO_SVG}</div>
    <p class="intro-eyebrow">デマンド交通のデータづくり</p>
    <h1 id="intro-title">GTFS-Flex メーカー<span class="tag">試作</span></h1>
    <p class="intro-lead">
      「前日までに電話で予約」「区域はこの範囲」「降りられるのは病院と役場」。<br>
      手元の運行要領を、地図と数問の入力で <strong>GTFS-Flex</strong> のデータにします。
    </p>

    <ol class="intro-steps">
      ${STEPS.map(
        (s, i) => `<li>
          <span class="ico">${s.icon}</span>
          <span class="txt"><span class="n">${i + 1}</span><strong>${s.title}</strong><small>${s.text}</small></span>
        </li>`,
      ).join('')}
    </ol>

    <div class="intro-actions">
      <button type="button" class="primary big" data-intro="start">はじめる</button>
      <button type="button" class="big" data-intro="example">サンプルで試す</button>
    </div>
    <p class="intro-note">入力したデータはこの端末の中だけで処理され、どこにも送られません。</p>
  </div>`
}
