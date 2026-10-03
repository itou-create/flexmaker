// 画面の「サンプルを読み込む」用。架空の町のデマンド交通（2エリア）。
// 座標は宮城県七ヶ浜町の周辺を借りているだけで、実在の運行とは無関係。
// エリア2は「複数エリア」「運休日」「朝の便だけ前日締切」の使い方を見せるために入れてある。

import type { DemandService } from '../types.ts'

export function exampleService(): DemandService {
  const y = new Date().getFullYear()
  const calendarBase = {
    days: [true, true, true, true, true, false, false] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
    startDate: `${y}0401`,
    endDate: `${y + 1}0331`,
  }
  return {
    agency: {
      id: 'sample_town',
      name: 'サンプル町',
      url: 'https://example.com/',
      phone: '022-000-0000',
    },
    areas: [
      {
        routeId: 'sample_east',
        routeName: 'サンプル号（東地区）',
        pattern: 'zone_to_point',
        zone: {
          id: 'zone_east',
          name: '東地区全域',
          polygon: [
            [141.03, 38.32],
            [141.09, 38.32],
            [141.1, 38.28],
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
        calendar: { id: 'east_cal', ...calendarBase, closedDates: [`${y}1229`, `${y}1230`, `${y}1231`] },
        windows: [
          { start: '08:00', end: '12:00' },
          { start: '13:00', end: '17:00' },
        ],
      },
      {
        routeId: 'sample_west',
        routeName: 'サンプル号（西地区）',
        pattern: 'zone_only',
        zone: {
          id: 'zone_west',
          name: '西地区全域',
          polygon: [
            [140.96, 38.33],
            [141.01, 38.33],
            [141.02, 38.3],
            [140.98, 38.28],
            [140.95, 38.3],
          ],
        },
        stops: [],
        bookingRule: {
          id: 'book_same_day',
          type: 1,
          priorNoticeDurationMin: 60,
          message: '乗りたい時刻の60分前までに電話で予約してください',
          phone: '022-000-0000',
        },
        calendar: { id: 'west_cal', ...calendarBase, closedDates: [`${y}1229`, `${y}1230`, `${y}1231`] },
        windows: [
          {
            start: '06:30',
            end: '08:00',
            // 朝の便だけ前日締切（便ごとの予約ルール上書きの例）
            booking: {
              id: 'book_west_morning',
              type: 2,
              priorNoticeLastDay: 1,
              priorNoticeLastTime: '16:30',
              message: '朝の便は前日16:30までに予約してください',
              phone: '022-000-0000',
            },
          },
          { start: '08:00', end: '17:00' },
        ],
      },
    ],
    feedPublisherName: 'サンプル町',
    feedPublisherUrl: 'https://example.com/',
  }
}
