// 入力モデル（担当者が画面で触るもの）と、出力の GTFS-Flex の間を分けるための型。
// 画面は DemandService だけを扱い、GTFS のファイル構成は src/gtfs/flexWriter.ts が決める。

/**
 * 運行形態。担当者はこの4つから選ぶだけで、stop_times の組み立て方が決まる。
 *
 * - zone_to_point : 区域内のどこでも乗車 → 決まった降車場所（病院・駅・役場など）で降車
 * - point_to_zone : 決まった乗車場所で乗車 → 区域内のどこでも降車
 * - zone_only     : 区域内のどこでも乗車・どこでも降車（道路運送法でいう区域運行に近い）
 * - checkpoint    : 決まった乗降場所群のどこでも乗車・降車。時刻表も経路も固定しない
 *
 * 前の3つは国交省 COMmmmONS の技術実証（札幌・2025年度）で使われた3型と同じ。
 */
export type OperationPattern = 'zone_to_point' | 'point_to_zone' | 'zone_only' | 'checkpoint'

export const PATTERN_LABEL: Record<OperationPattern, string> = {
  zone_to_point: '区域内どこでも乗車 → 決まった場所で降車',
  point_to_zone: '決まった場所で乗車 → 区域内どこでも降車',
  zone_only: '区域内どこでも乗車・降車',
  checkpoint: '決まった乗降場所どうしを自由に移動',
}

export interface Agency {
  id: string
  name: string
  url: string
  phone?: string
}

/** 乗降できる区域。polygon は [lng, lat] の列。閉じていなくてよい（出力時に閉じる） */
export interface Zone {
  id: string
  name: string
  polygon: [number, number][]
}

/** 決まった乗降場所（ミーティングポイント・停留所・施設前など） */
export interface Stop {
  id: string
  name: string
  lat: number
  lon: number
}

/**
 * 予約ルール。booking_rules.txt にそのまま対応する。
 * type の意味：0 = その場で（リアルタイム）、1 = 当日でも可（◯分前まで）、2 = 前日まで
 */
export interface BookingRule {
  id: string
  type: 0 | 1 | 2
  /** type=1 のとき必須：何分前までに予約するか */
  priorNoticeDurationMin?: number
  /** type=1 のとき任意：最大何分前から予約できるか */
  priorNoticeDurationMax?: number
  /** type=2 のとき必須：何日前まで（1 = 前日） */
  priorNoticeLastDay?: number
  /** type=2 のとき必須："17:00" 形式。その日の何時まで */
  priorNoticeLastTime?: string
  /** 任意：何日前から予約できるか */
  priorNoticeStartDay?: number
  /** priorNoticeStartDay があれば必須 */
  priorNoticeStartTime?: string
  message?: string
  phone?: string
  infoUrl?: string
  bookingUrl?: string
}

/** 運行時間帯。"08:00"〜"17:00" のような1日の中の帯。帯ごとに1便（trip）になる */
export interface ServiceWindow {
  start: string
  end: string
}

/** 運行日。days は 月〜日 の順。日付は YYYYMMDD */
export interface Calendar {
  id: string
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean]
  startDate: string
  endDate: string
}

/** 画面で扱う1サービス分の入力。これが揃えば zip が出せる */
export interface DemandService {
  agency: Agency
  routeId: string
  routeName: string
  pattern: OperationPattern
  /** zone_to_point / point_to_zone / zone_only で必須 */
  zone?: Zone
  /** zone_to_point / point_to_zone / checkpoint で必須（1件以上） */
  stops: Stop[]
  bookingRule: BookingRule
  calendar: Calendar
  windows: ServiceWindow[]
  feedPublisherName: string
  feedPublisherUrl: string
}

/** 出力：ファイル名 → 中身（テキスト）。zip 化は src/gtfs/zip.ts */
export type GtfsFiles = Record<string, string>

export interface ValidationIssue {
  level: 'error' | 'warning'
  file: string
  message: string
}
