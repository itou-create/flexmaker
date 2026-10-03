// 実例サンプル：田村市デマンドタクシー「田村らくらくタクシー」（福島県田村市）。
// 画面の「実例を読み込む」と、scripts/make-tamura.mjs（zip 生成）の両方がこれを使う。
//
// 出典（2026-10-03 閲覧）：田村市「田村らくらくタクシー」利用ガイド（令和6年4月1日発行）
// https://www.city.tamura.lg.jp/soshiki/1/rakuraku.html
//   - 予約：利用30分前まで電話/LINE。受付 7:00〜17:30。6:30〜7:30発の便は前日16:30まで
//   - 運休：日曜・祝日・年末年始（12/29〜1/3）
//   - 乗降：自宅付近の公道まで迎えに来る（＝区域方式）
//   - エリア内の移動 300円、エリア間 400〜800円。エリアごとの時刻表制（時刻は目安）
//
// モデル化の判断（公式データではない。このツールの試作）：
//   - エリア＝ 滝根 / 大越 / 都路・常葉 / 船引町内 の4つ（zone_only）。
//     船引の北部線・まちなか線・南部線は「船引町内」1区域に近似
//   - エリア間の便（滝根→船引まちなか等）は「区域→別の区域」で、今の4形態に無いため未収録
//   - 祝日・年末年始は closedDates で運休に。祝日は2026年度のもの（公開前に内閣府の一覧と要突合）
//   - 都路・常葉の朝6:30〜7:30便だけ前日16:30締切（便ごとの予約ルール上書き）
//   - 区域ポリゴンはどれもおおよその範囲。正確な行政界ではない

import type { BookingRule, Calendar, DemandService } from '../types.ts'

// 2026年度（2026-04-01〜2027-03-31）の運休日：祝日（日曜と重なる日は除く）＋年末年始
const CLOSED_DATES = [
  '20260429', // 昭和の日
  '20260504', // みどりの日
  '20260505', // こどもの日
  '20260506', // 振替休日（5/3 憲法記念日が日曜）
  '20260720', // 海の日
  '20260811', // 山の日
  '20260921', // 敬老の日
  '20260922', // 国民の休日
  '20260923', // 秋分の日
  '20261012', // スポーツの日
  '20261103', // 文化の日
  '20261123', // 勤労感謝の日
  '20261229', '20261230', '20261231', '20270101', '20270102', // 年末年始（1/3 は日曜）
  '20270111', // 成人の日
  '20270211', // 建国記念の日
  '20270223', // 天皇誕生日
  '20270322', // 振替休日（3/21 春分の日が日曜）
]

const PHONE = '0247-82-3000'
const INFO_URL = 'https://www.city.tamura.lg.jp/soshiki/1/rakuraku.html'
const MSG =
  '予約は乗る30分前まで（電話受付 7:00〜17:30、LINEは24時間）。エリア内の移動は300円、エリアをまたぐ移動は400〜800円'

function booking(): BookingRule {
  return { id: 'b', type: 1, priorNoticeDurationMin: 30, message: MSG, phone: PHONE, infoUrl: INFO_URL }
}

const earlyMorning: BookingRule = {
  id: 'b_early',
  type: 2,
  priorNoticeLastDay: 1,
  priorNoticeLastTime: '16:30',
  message: '朝6:30〜7:30発の便は、前の日の16:30までに予約してください',
  phone: PHONE,
  infoUrl: INFO_URL,
}

function calendar(id: string): Calendar {
  return {
    id,
    days: [true, true, true, true, true, true, false],
    startDate: '20260401',
    endDate: '20270331',
    closedDates: CLOSED_DATES,
  }
}

export function tamuraService(): DemandService {
  return {
    agency: {
      id: 'tamura_city',
      name: '田村市（田村市公共交通活性化協議会）',
      url: INFO_URL,
      phone: PHONE,
    },
    areas: [
      {
        routeId: 'tamura_rakuraku_takine',
        routeName: '田村らくらくタクシー（滝根エリア）',
        pattern: 'zone_only',
        zone: {
          id: 'zone',
          name: '滝根町内（おおよその範囲）',
          polygon: [
            [140.625, 37.33], [140.635, 37.365], [140.675, 37.375], [140.715, 37.355],
            [140.735, 37.32], [140.715, 37.285], [140.675, 37.27], [140.64, 37.29],
          ],
        },
        stops: [],
        bookingRule: booking(),
        calendar: calendar('takine_cal'),
        windows: [{ start: '07:30', end: '17:30' }],
      },
      {
        routeId: 'tamura_rakuraku_ogoe',
        routeName: '田村らくらくタクシー（大越エリア）',
        pattern: 'zone_only',
        zone: {
          id: 'zone',
          name: '大越町内（おおよその範囲）',
          polygon: [
            [140.555, 37.37], [140.6, 37.405], [140.645, 37.395], [140.655, 37.355],
            [140.625, 37.325], [140.575, 37.33],
          ],
        },
        stops: [],
        bookingRule: booking(),
        calendar: calendar('ogoe_cal'),
        windows: [{ start: '07:30', end: '18:00' }],
      },
      {
        routeId: 'tamura_rakuraku_miyakoji_tokiwa',
        routeName: '田村らくらくタクシー（都路・常葉エリア）',
        pattern: 'zone_only',
        zone: {
          id: 'zone',
          name: '都路町・常葉町内（おおよその範囲）',
          polygon: [
            [140.6, 37.44], [140.65, 37.49], [140.72, 37.48], [140.8, 37.44],
            [140.79, 37.38], [140.72, 37.36], [140.65, 37.4], [140.61, 37.4],
          ],
        },
        stops: [],
        bookingRule: booking(),
        calendar: calendar('miyakoji_cal'),
        // 朝6:30〜7:30発だけ前日16:30締切（利用ガイドの例外規定）
        windows: [
          { start: '06:30', end: '07:30', booking: earlyMorning },
          { start: '07:30', end: '18:30' },
        ],
      },
      {
        routeId: 'tamura_rakuraku_funehiki',
        routeName: '田村らくらくタクシー（船引エリア）',
        pattern: 'zone_only',
        zone: {
          id: 'zone',
          name: '船引町内（おおよその範囲。北部線・まちなか線・南部線をまとめて近似）',
          polygon: [
            [140.48, 37.44], [140.52, 37.5], [140.59, 37.49], [140.615, 37.44],
            [140.6, 37.4], [140.54, 37.38], [140.49, 37.4],
          ],
        },
        stops: [],
        bookingRule: booking(),
        calendar: calendar('funehiki_cal'),
        windows: [{ start: '07:00', end: '18:30' }],
      },
    ],
    feedPublisherName: '田村市',
    feedPublisherUrl: 'https://www.city.tamura.lg.jp/',
  }
}
