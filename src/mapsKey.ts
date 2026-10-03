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

export function getGoogleMapsKey(): string | null {
  try {
    const k = localStorage.getItem(KEY_STORAGE)
    return k && /^AIza[0-9A-Za-z_-]{35}$/.test(k) ? k : null
  } catch {
    return null
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
