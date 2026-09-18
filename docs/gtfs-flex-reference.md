# GTFS-Flex 早見表（このツールが守るべき仕様）

作成：2026-09-18
出典：GTFS Schedule Reference（google/transit `gtfs/spec/en/reference.md`、2026-09 時点）。
Flex は 2024年3月に GTFS 本体へ正式採用済み。MobilityData の旧 `gtfs-flex` リポジトリは deprecated。

「要確認」と書いた箇所は、まだ一次資料で裏が取れていない。実装前に確かめること。

---

## 1. ファイル構成

Flex で増えるのは4ファイル。他は通常の GTFS と同じ。

| ファイル | 役割 | 必須 |
|---|---|---|
| `locations.geojson` | 乗降できる**区域**（ポリゴン） | 任意 |
| `location_groups.txt` | **決まった乗降場所の集まり**に ID を付ける | 任意 |
| `location_group_stops.txt` | どの `stop_id` がどのグループに属するか | 任意 |
| `booking_rules.txt` | **予約ルール** | 任意 |
| `stop_times.txt` | 上記を参照し、時刻の代わりに**時間帯（窓）**を書く | 必須（既存） |

`stops.txt` は通常 GTFS で条件付き必須。区域のみの運行で stop が無い場合にヘッダのみで通るかは**要確認**（正規バリデータで試す）。

---

## 2. ID の一意性（いちばん踏みやすい）

**`stops.stop_id`・`locations.geojson` の `id`・`location_groups.location_group_id` は、3つをまたいで全体で一意。**
例：区域 `zone_1` と停留所 `zone_1` は共存できない。

---

## 3. stop_times.txt の Flex 項目

| 項目 | 条件 |
|---|---|
| `stop_id` | `location_group_id` / `location_id` のどちらかがあれば**禁止**。両方無ければ必須 |
| `location_group_id` | `stop_id` / `location_id` があれば禁止 |
| `location_id` | `stop_id` / `location_group_id` があれば禁止 |
| `start_pickup_drop_off_window` | `location_group_id` か `location_id` を使うなら**必須**。`arrival_time` / `departure_time` があれば禁止。end があれば必須 |
| `end_pickup_drop_off_window` | 同上（start があれば必須） |
| `arrival_time` / `departure_time` | 窓があれば**禁止** |
| `pickup_type` | 窓があるとき **0 と 3 は禁止**（→ 1=乗車不可 か 2=要予約） |
| `drop_off_type` | 窓があるとき **0 は禁止**（→ 1・2・3） |
| `continuous_pickup` / `continuous_drop_off` | 窓があるとき 1 か空以外は禁止 |
| `pickup_booking_rule_id` | 任意。`pickup_type=2` のとき推奨 |
| `drop_off_booking_rule_id` | 任意。`drop_off_type=2` のとき推奨 |

### 組み立ての決まり

- **同じ区域内・同じグループ内での移動**は、同じ `location_id`（または `location_group_id`）を持つレコードを**2行**書く
- 便の中で「乗車できる場所」→「降車できる場所」の順に `stop_sequence` を振る。消費側は「前の行から後ろの行へ移動できる」と解釈する
- 同一 `trip_id` 内で、窓のある**中間**レコードは経路計算では無視される（gtfs.org の Flex 例参照）
- 同一 `trip_id` 内で、同じ区域・同じ時間帯・同じ pickup/drop_off の重なりは禁止

### このツールでの4形態 → stop_times

| 形態 | 1行目（乗車側） | 2行目（降車側） |
|---|---|---|
| zone_to_point | `location_id`=区域, pickup=2, drop_off=1 | `location_group_id`=場所群, pickup=1, drop_off=2 |
| point_to_zone | `location_group_id`=場所群, pickup=2, drop_off=1 | `location_id`=区域, pickup=1, drop_off=2 |
| zone_only | `location_id`=区域, pickup=2, drop_off=1 | `location_id`=**同じ区域**, pickup=1, drop_off=2 |
| checkpoint | `location_group_id`=場所群, pickup=2, drop_off=1 | `location_group_id`=**同じ場所群**, pickup=1, drop_off=2 |

前3つは国交省 COMmmmONS 技術実証（札幌・2025年度）の checkpoint / zone-to-point / point-to-zone に対応。

---

## 4. booking_rules.txt

| 項目 | 条件 |
|---|---|
| `booking_rule_id` | 必須 |
| `booking_type` | 必須。**0**=リアルタイム、**1**=当日でも可（事前連絡あり）、**2**=前日まで |
| `prior_notice_duration_min` | type=1 で**必須**、それ以外は禁止。「何分前まで」 |
| `prior_notice_duration_max` | type=1 のみ任意。他は禁止 |
| `prior_notice_last_day` | type=2 で**必須**、他は禁止。「前日17時まで」→ `1` |
| `prior_notice_last_time` | `prior_notice_last_day` があれば必須、無ければ禁止。→ `17:00:00` |
| `prior_notice_start_day` | type=0 で禁止。type=1 で `duration_max` があれば禁止。他は任意。「1週間前から」→ `7` |
| `prior_notice_start_time` | `start_day` があれば必須、無ければ禁止 |
| `prior_notice_service_id` | type=2 のみ任意（営業日で数えるときに `calendar.service_id` を指す） |
| `message` / `pickup_message` / `drop_off_message` | 任意。利用者への短い案内 |
| `phone_number` / `info_url` / `booking_url` | 任意。**電話予約型なら `phone_number` は実質必須** |

---

## 5. locations.geojson

- `FeatureCollection` 1つ。各 `Feature` に **`id`（必須・全体一意）**、`properties`（必須。`stop_name` / `stop_desc` 任意）、`geometry`（`Polygon` か `MultiPolygon`）
- RFC 7946 の部分集合。座標は `[経度, 緯度]` の順。環は閉じる（最初と最後の点が同じ）
- ポリゴンは OpenGIS Simple Features の意味で valid であること（自己交差しない）

---

## 6. location_groups.txt / location_group_stops.txt

- `location_groups.txt`：`location_group_id`（必須・全体一意）、`location_group_name`（任意）
- `location_group_stops.txt`：`location_group_id`、`stop_id`（両方必須）。同じ `stop_id` が複数グループに属してよい

---

## 7. 日本向け：GTFS-JP 第4.0版（2026年3月・国交省）

- 第4.0版で **Flex 拡張のローカライズ仕様が正式追加**。追加ファイルは上記4つ
- 第1編（仕様編）の記述は簡潔で、詳しい解説は **第2編 第3部「2. Flex拡張」（pp.35–51）**：2.5 乗降場グループ・乗降エリアの設定／2.6 予約ルールの設定／2.7 便と運行時刻の設定／2.8 運賃の設定
  - 第1編：https://www.mlit.go.jp/commmmons/document/007/commmmons_doc_007-01_ver01.pdf
  - 第2編：https://www.mlit.go.jp/commmmons/document/007/commmmons_doc_007-02_ver01.pdf
  - 差分資料：https://www.mlit.go.jp/commmmons/document/007/commmmons_doc_007-03_ver01.pdf
- **2025年12月末現在、Google 乗換案内は Flex 拡張を含むデータセットを受け付けない**（第1編の注記）。「Google マップに載る」とは言えない。消費側は OTP 等
- **要確認**：`route_type` の推奨値（乗合タクシーを 3=バス にしてよいか）、GTFS-JP 固有ファイル（`agency_jp.txt`、`translations.txt` 等）の要否、第2編 2.5–2.8 の記入例との突合

---

## 8. 検証（バリデータ）

- MobilityData **gtfs-validator**（Java）：https://github.com/MobilityData/gtfs-validator — Flex のルールをどこまで実装しているかは**要確認**。Web 版 https://gtfs-validator.mobilitydata.org/ にzipを投げれば手軽
- このツールの `src/gtfs/validate.ts` は、上の条件付き必須／禁止のうち Flex 固有のものだけを実装した簡易版。**正規バリデータの代わりにはならない**

## 9. 消費側（作ったデータを確かめる）

- **OpenTripPlanner** は Flex 対応（gtfs.org 記載）。ローカルで立てて経路が出るか確認できる
- gtfs.org の Flex サンプル：https://gtfs.org/schedule/examples/flex/

## 10. 先行ツール

| ツール | 種類 | メモ |
|---|---|---|
| Spare GTFS-Flex Builder | 無料・Web | 英語。事業者向け。https://spare.com/spare-gtfs-flex-builder |
| derhuerst/generate-gtfs-flex | CLI（Node） | 既存 GTFS に Flex v2 を足す。https://github.com/derhuerst/generate-gtfs-flex |
| LINKS Mobilys（国交省） | OSS・計画支援 | 今年度 Flex 対応予定（ODPT 2026-09-16）。**最大の競合。10/1 ウェビナーで確認** |

## 11. 実データ（ODPT、CC BY 4.0、15件・2026-09-18 時点）

`npm run fetch-samples` で `samples/` に落とす（ネットワークが通る環境で実行）。

| データセット ID | 自治体 | 提供 |
|---|---|---|
| swat_hakuba_demand_taxi | 白馬村（長野） | SWAT Mobility |
| ai-hakuba-village-on-demand-taxi-fure-ai | 白馬村（長野） | MONET |
| miraishare_fukuchi_fukurubus | 福智町（福岡） | 未来シェア |
| miraishare_maebashi_demand | 前橋市（群馬） | 未来シェア |
| nextmobility_umi_knowroute | 宇美町（福岡） | ネクスト・モビリティ |
| munakata-city-on-demand-bus-knowroute | 宗像市（福岡） | ネクスト・モビリティ |
| junpuzi_kawagoe_kawamaru | 川越市（埼玉） | 順風路 |
| kinokawa-city-demand-shared-transportation-norinori-transportation | 紀の川市（和歌山） | MONET |
| monet_annaka_ai_shinkotsu | 安中市（群馬） | MONET |
| monet_tomioka_ai_taku | 富岡市（群馬） | MONET |
| ai-showa-village-ai-on-demand-bus-veggie-bus | 昭和村（群馬） | MONET |
| go-tamamura-town-on-demand-taxi-tama-go | 玉村町（群馬） | MONET |
| sakai-city-on-demand-transportation-etaku | 坂井市（福井） | MONET |
| monet_hirakawa_norassa | 平川市（青森） | MONET |
| mizuho_town_mizuho_area | 瑞穂町（東京） | 瑞穂町 |

一覧：https://ckan.odpt.org/dataset/?tags=GTFS-Flex
