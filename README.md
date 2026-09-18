# flexmaker（仮称）

デマンド交通の運行要領を、地図と数問の入力で **GTFS-Flex** にする Web ツール。
公共交通オープンデータチャレンジ2026 応募検討用のプロトタイプです。

## 誰のためのものか

配車システムを持たず、電話予約と地元タクシー会社への委託で回している自治体のデマンド交通。
担当者の手元には「前日17時までに電話」「区域はこの範囲」「降りられるのは病院・役場・駅」という
運行要領があるのに、それをデータにして出す手段がありません。

このツールは、その運行要領を GTFS-Flex（GTFS の公式拡張・2024年3月採用）の zip にします。

## 動かす

```bash
npm install
npm run dev        # http://localhost:5173 （--host 付きなので同じ Wi-Fi のスマホからも開ける）
npm run build      # dist/ に静的ファイル
```

社内ネットワークでは地理院タイルがブロックされることがあります（地図が白いときはそれ）。

## 使い方

1. 「サンプルを読み込む」で形を見る
2. 事業者名・サービス名を入れる
3. 運行形態を1つ選ぶ（区域→決まった場所／決まった場所→区域／区域内自由／決まった場所どうし）
4. 地図をタップして区域を描く、場所を置く
5. 予約のしかた（前日まで／当日○分前まで／その場で）と電話番号
6. 運行日と時間帯（時間帯ごとに1便になる）
7. 「検証する」→「zip を出す」

## 出力されるファイル

`agency.txt` `routes.txt` `calendar.txt` `trips.txt` `stop_times.txt` `stops.txt` `feed_info.txt` に加えて、Flex の
`locations.geojson` `location_groups.txt` `location_group_stops.txt` `booking_rules.txt`。

出力前に Flex 固有の条件付き必須／禁止ルールを検査し、エラーがあれば出しません。
**ただしこれは簡易検査です。本番データは MobilityData の正規バリデータ（https://gtfs-validator.mobilitydata.org/）にもかけてください。**

## 実データを手元に置く

```bash
npm run fetch-samples   # ODPT の GTFS-Flex 15件（CC BY 4.0）を samples/ に落とす
```

## フォルダ

```
src/types.ts            入力モデル（担当者が触るもの）
src/gtfs/flexWriter.ts  入力モデル → GTFS-Flex ファイル群   ← 核心
src/gtfs/validate.ts    Flex 固有ルールの検査
src/gtfs/zip.ts         無圧縮 zip ライタ（依存なし）
src/gtfs/csv.ts         CSV 読み書き
src/ui/map.ts           地図（Leaflet + 地理院タイル）
src/ui/panel.ts         入力パネル
docs/gtfs-flex-reference.md   仕様の早見表・要確認事項・先行ツール・実データ一覧
scripts/fetch-samples.mjs     実データのダウンロード
CLAUDE.md               設計原則と次にやること
```

## 状態

まだ **GTFS-JP 第4.0版との突合と、実データとの比較が済んでいません**。
出力の構成は GTFS 本体仕様（gtfs.org）の条件から組んだもので、流通データと違う部分があれば直します。
