// 公共交通オープンデータセンター（ODPT）のアクセストークンの置き場所。
//
// 「公共交通オープンデータ基本ライセンス」のデータ（西武バス・西東京バス・京王バスなど）は、
// 開発者サイト（developer.odpt.org）で登録して得たトークンが無いと zip を取れない。
// トークンはリポジトリにもサイト（ビルド）にも入れない（CLAUDE.md の方針）。
// 担当者がマイページで入力し、この端末の localStorage にだけ保存する。
// 無い端末では「認証なし」で公開されているデータ（都営バスなど CC BY / CC0）だけで乗りつぎを調べる。

const KEY_STORAGE = 'flexmaker:odptToken'
const TOKEN_RE = /^[0-9a-z]{20,}$/i

export function getOdptToken(): string | null {
  try {
    const t = localStorage.getItem(KEY_STORAGE)
    return t && TOKEN_RE.test(t) ? t : null
  } catch {
    return null
  }
}

export function hasOdptToken(): boolean {
  return getOdptToken() !== null
}

/** 形式が正しければ保存して true。空文字は削除 */
export function setOdptToken(token: string): boolean {
  try {
    const t = token.trim()
    if (t === '') {
      localStorage.removeItem(KEY_STORAGE)
      return true
    }
    if (!TOKEN_RE.test(t)) return false
    localStorage.setItem(KEY_STORAGE, t)
    return true
  } catch {
    return false
  }
}
