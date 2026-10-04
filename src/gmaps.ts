// Google Maps JavaScript API の読み込み（住民ページ・作成画面で共用）。
// キーが無い／API未有効／リファラ不許可／ネットワーク遮断のどれでも null を返し、
// 呼び出し側は Leaflet＋地理院タイルに切り替える。
//
// 型パッケージ（@types/google.maps）は増やさず any で扱う。

export const gapi = (): any => (window as unknown as { google?: unknown }).google

let scriptPromise: Promise<boolean> | null = null
let authFailed = false

function loadScript(key: string): Promise<boolean> {
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve) => {
    const w = window as unknown as Record<string, unknown>
    // 認証エラー（ApiNotActivatedMapError / RefererNotAllowedMapError 等）はここに届く
    w.gm_authFailure = () => {
      authFailed = true
    }
    const t = setTimeout(() => resolve(false), 7000)
    w.__gmapsReady = () => {
      clearTimeout(t)
      resolve(true)
    }
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=ja&region=JP&loading=async&callback=__gmapsReady`
    s.onerror = () => {
      clearTimeout(t)
      resolve(false)
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

/**
 * el に Google の地図を作る。使えなければ null（el は空に戻す）。
 * 認証エラーは読み込みの少し後に届くので、生成後に短く待ってから判定する。
 */
export async function createGoogleMap(el: HTMLElement, key: string, opts: Record<string, unknown> = {}): Promise<any | null> {
  if (!(await loadScript(key))) return null
  const g = gapi()
  if (!g?.maps || authFailed) return null
  const map = new g.maps.Map(el, {
    center: { lat: 36.2, lng: 138.3 },
    zoom: 5,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: 'greedy',
    ...opts,
  })
  await new Promise((r) => setTimeout(r, 1500))
  if (authFailed) {
    el.innerHTML = ''
    return null
  }
  return map
}
