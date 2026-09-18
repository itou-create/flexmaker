// 画面の「サンプルを読み込む」用。架空の町のデマンド交通。
// 座標は宮城県七ヶ浜町の周辺を借りているだけで、実在の運行とは無関係。

import type { DemandService } from '../types'

export function exampleService(): DemandService {
  const y = new Date().getFullYear()
  return {
    agency: {
      id: 'sample_town',
      name: 'サンプル町',
      url: 'https://example.com/',
      phone: '022-000-0000',
    },
    routeId: 'sample_demand',
    routeName: 'サンプル町デマンド交通（サンプル号）',
    pattern: 'zone_to_point',
    zone: {
      id: 'zone_sample',
      name: 'サンプル町全域',
      polygon: [
        [141.03, 38.32],
        [141.09, 38.32],
        [141.10, 38.28],
        [141.05, 38.27],
        [141.02, 38.29],
      ],
    },
    stops: [
      { id: 'stop_hospital', name: '町立病院', lat: 38.303, lon: 141.06 },
      { id: 'stop_office', name: '役場', lat: 38.305, lon: 141.05 },
      { id: 'stop_station', name: '最寄り駅（バス乗継）', lat: 38.31, lon: 141.04 },
    ],
    bookingRule: {
      id: 'book_prev_day',
      type: 2,
      priorNoticeLastDay: 1,
      priorNoticeLastTime: '17:00',
      message: '利用日の前日17時までに電話で予約してください',
      phone: '022-000-0000',
    },
    calendar: {
      id: 'weekday',
      days: [true, true, true, true, true, false, false],
      startDate: `${y}0401`,
      endDate: `${y + 1}0331`,
    },
    windows: [
      { start: '08:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ],
    feedPublisherName: 'サンプル町',
    feedPublisherUrl: 'https://example.com/',
  }
}
