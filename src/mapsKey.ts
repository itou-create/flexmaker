// Google マップの API キーの置き場所。
//
// キーはリポジトリ（公開）には入れない。担当者がマイページで一度入力し、
// この端末の localStorage にだけ保存する。チラシ・サイネージは担当者の端末で
// 使うものなので、これで Google 地図が出せる。キーが無い端末では地理院タイルで表示する。
//
// キー側の設定（Google Cloud Console）：
//   - 有効化する API：Maps Static API（チラシ・サイネージ）、Maps JavaScript API（住民ページ）
//   - アプリケーションの制限：HTTP リファラー（公開サイトと localhost）
//   - 割り当て（クォータ）の上限設定（使いすぎ防止）

const KEY_STORAGE = 'flexmaker:gmapsKey'

/**
 * 運営側のキー。GitHub の Secrets（PUBLIC_GMAPS_KEY）に登録するとビルド時に
 * ここへ埋め込まれ、全利用者の地図が Google になる。ソースには値を書かない。
 */
const PUBLIC_KEY = (import.meta.env.VITE_PUBLIC_GMAPS_KEY as string | undefined) ?? ''

const KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/

/** 端末に保存した個人キーがあればそれを優先し、無ければ運営側のキー */
export function getGoogleMapsKey(): string | null {
  try {
    const k = localStorage.getItem(KEY_STORAGE)
    if (k && KEY_RE.test(k)) return k
  } catch {
    /* localStorage が読めない環境でも運営キーは使える */
  }
  return KEY_RE.test(PUBLIC_KEY) ? PUBLIC_KEY : null
}

/** 運営側のキーがビルドに入っているか（マイページの表示用） */
export function hasPublicKey(): boolean {
  return KEY_RE.test(PUBLIC_KEY)
}

/** この端末に個人キーが保存されているか（マイページの表示用） */
export function hasPersonalKey(): boolean {
  try {
    const k = localStorage.getItem(KEY_STORAGE)
    return !!k && KEY_RE.test(k)
  } catch {
    return false
  }
}

/** 形式が正しければ保存して true。空文字は削除 */
export function setGoogleMapsKey(key: string): boolean {
  try {
    const k = key.trim()
    if (k === '') {
      localStorage.removeItem(KEY_STORAGE)
      return true
    }
    if (!/^AIza[0-9A-Za-z_-]{35}$/.test(k)) return false
    localStorage.setItem(KEY_STORAGE, k)
    return true
  } catch {
    return false
  }
}
