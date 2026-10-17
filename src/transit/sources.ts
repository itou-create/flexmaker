// 乗り継ぎ検索で使う「公表されている GTFS」の取り先。
//
// 国交省の GTFS データリポジトリ（gtfs-data.jp）は、一覧 API も zip のダウンロードも
// ブラウザから直接読める（CORS 許可。2026-10-17 に確認）。サーバを置かずに済む。
// Flex 側のデータ（同梱 JSON／作成中プレビュー）と、ここで取る路線バス等を同じ時刻表に載せる。
//
// ODPT（api-public.odpt.org）側は CORS が無いのでブラウザから直接は読めない。
// Flex データは scripts/convert-sample.mjs で変換した同梱 JSON を使う（従来どおり）。

import { readZip } from '../gtfs/zipReader.ts'

export interface RepoFeed {
  /** gtfs-data.jp の organization_id */
  org: string
  /** gtfs-data.jp の feed_id */
  feed: string
  /** 画面に出す名前（例：瑞穂町コミュニティバス） */
  label: string
  /** 提供者（出典表示用） */
  provider: string
  license?: string
  licenseUrl?: string
}

/** 同梱の Flex データセット ID → 乗り継ぎ相手として自動で読む固定路線 */
export const COMPANIONS: Record<string, RepoFeed[]> = {
  mizuho_town_mizuho_area: [
    {
      org: 'mizuhotown',
      feed: 'communitybus',
      label: '瑞穂町コミュニティバス',
      provider: '瑞穂町',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
    },
  ],
}

export const REPO_TOP_URL = 'https://www.gtfs-data.jp/'

export const repoZipUrl = (f: RepoFeed): string =>
  `https://api.gtfs-data.jp/v2/organizations/${encodeURIComponent(f.org)}/feeds/${encodeURIComponent(f.feed)}/files/feed.zip?rid=current`

/** リポジトリから zip を取って「ファイル名 → テキスト」にする */
export async function loadRepoFeed(f: RepoFeed): Promise<Record<string, string>> {
  const res = await fetch(repoZipUrl(f))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return readZip(await res.arrayBuffer())
}

/** 利用者が手元の GTFS zip を読ませたとき */
export async function loadLocalZip(file: File): Promise<Record<string, string>> {
  return readZip(await file.arrayBuffer())
}

export const PREF_NAMES = [
  '',
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
]

export interface RepoFeedInfo extends RepoFeed {
  prefId: number
  /** YYYY-MM-DD */
  end?: string
  discontinued: boolean
}

interface ApiFeed {
  organization_id: string
  organization_name: string
  feed_id: string
  feed_name: string
  feed_pref_id: number | string
  feed_license?: string
  feed_license_url?: string
  latest_feed_end_date?: string
  feed_is_discontinued?: boolean
}

let feedListCache: RepoFeedInfo[] | null = null

/** リポジトリに登録されている全フィード（提供終了を除く）。都道府県で絞って選ばせる用 */
export async function listRepoFeeds(): Promise<RepoFeedInfo[]> {
  if (feedListCache) return feedListCache
  const res = await fetch('https://api.gtfs-data.jp/v2/feeds')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { body?: ApiFeed[] } | ApiFeed[]
  const body = Array.isArray(json) ? json : (json.body ?? [])
  feedListCache = body
    .filter((f) => !f.feed_is_discontinued)
    .map((f) => ({
      org: f.organization_id,
      feed: f.feed_id,
      label: f.feed_name,
      provider: f.organization_name,
      license: f.feed_license,
      licenseUrl: f.feed_license_url,
      prefId: Number(f.feed_pref_id),
      end: f.latest_feed_end_date,
      discontinued: !!f.feed_is_discontinued,
    }))
    .sort((a, b) => a.prefId - b.prefId || a.provider.localeCompare(b.provider, 'ja') || a.label.localeCompare(b.label, 'ja'))
  return feedListCache
}
