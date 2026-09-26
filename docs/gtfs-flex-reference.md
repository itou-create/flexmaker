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
- `route_type`：ODPT の実データでは **3（バス）が事実上の標準**（14/15件。§12）。GTFS-JP 文書上の推奨値の確認は残っている
- GTFS-JP 固有ファイル（`agency_jp.txt`、`translations.txt` 等）：ODPT の Flex 実データ15件は**どれも含んでいない**（§12）。文書上の要否確認は残っている
- **要確認**：第2編 2.5–2.8 の記入例との突合

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
**2026-09-26：ckan.odpt.org の CKAN API（/api/3/action/…）が JSON を返さなくなった**（どのパスでもカタログの HTML が返る）。
fetch-samples はデータセットページ → リソースページとたどって `api-public.odpt.org` の直リンクを拾う方式に変更済み。
各データセットには zip が2つある：1つ目が GTFS-Flex フィード本体、2つ目は**乗降実績データ**（`route_id,pickup_stop_id,drop_off_stop_id,pickup_date,…` の CSV。フィードではない）。

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

---

## 12. 実データとの突合結果（2026-09-26、15フィード全件）

flexWriter の出力（`buildFlexFiles`）と、上の15件の中身を突き合わせた。

### 15件すべてに共通していたこと

- **ファイル構成は全件同一**：`agency / booking_rules / calendar / calendar_dates / feed_info / location_groups / location_group_stops / routes / stops / stop_times / trips` の11ファイル。
  **`locations.geojson`（区域）を使うフィードは1件も無い。** 全件が「決まった乗降場所の集まり＝location_group」方式
- **stop_times は全件このツールの checkpoint 形と同じ組み方**：1便2行、
  1行目 `pickup_type=2, drop_off_type=1`、2行目 `pickup_type=1, drop_off_type=2`、
  両行とも同じ `location_group_id` と同じ窓（start/end_pickup_drop_off_window）。
  → flexWriter の checkpoint 出力は実データと行構造が一致。zone 系3形態は実例が無い（仕様上は正しいが、消費側での実績は未知）
- **booking_type は全件 1**（当日でも可・n分前まで）。type=2（前日まで）の実例は無し。
  `prior_notice_duration_min` は 0〜60分、`prior_notice_start_day` は 0〜7日（受付開始）が相場
- **feed_info は全件 `feed_start_date` / `feed_end_date` を記入** → flexWriter も calendar の期間を書くように直した（2026-09-26）
- **calendar_dates.txt は全件が同梱**（中身は 0〜36行。運休日・曜日振替に使用）→ flexWriter は未出力。運休日入力を付けるときに対応（ロードマップに追記済み）

### 多数派だが全件ではないこと

- `route_type` は **14件が 3（バス）**、瑞穂町のみ 715（拡張 route_type：Demand and Response Bus）。
  §7 の「要確認」への答え：**3 が ODPT の事実上の標準。このツールも 3 のままでよい**
- 予約の連絡先：**電話番号・案内文・URL を booking_rules に書いているのは瑞穂町だけ**
  （`message` に受付時間、`phone_number`、`info_url`。他14件は予約手段の情報が一切無い）。
  → 電話番号を必ず書かせるこのツールの方針は、既存データの弱点を埋める差別化点
- `pickup_booking_rule_id` / `drop_off_booking_rule_id`：14件は**両方の行に両方**書く（乗車不可の行にも pickup 側を書く）。
  瑞穂町だけが flexWriter と同じ「乗車行に pickup 側・降車行に drop_off 側」。仕様上はどちらも通る。flexWriter は現状のまま
- 複数エリアの表現：**エリアごとに route / trip / location_group を1つずつ**（1:1:1）作る（川越3・紀の川3・前橋3・坂井3・安中2）。
  同じ stop が複数グループに属する例あり（紀の川・坂井）。ロードマップ「複数の区域」はこの形に合わせる
- `trip_headsign` は瑞穂町以外ほぼ空。`stops.txt` は `stop_code` を書く事業者が多く、`location_type` は瑞穂町以外空

### 実データ側の癖（読み込み機能を作るときの注意）

- 時刻の桁：未来シェア2件は `8:30:00` のように**時が1桁**。読む側は `H:mm:ss` も受ける
- 福智町の `prior_notice_start_day=10080` は分の値を日の欄に書いたと思われる（10080分=7日）。実データにも誤りはある
- 規模感：stops は 35〜872件、trip は 1〜3件。1フィード＝1サービス（zip 全体が小さい）

### flexWriter に入れた変更（2026-09-26）

1. `feed_info.txt` に `feed_start_date` / `feed_end_date` を追加（calendar と同じ期間）

変更しないと判断したこと：stop_times の空列（`stop_id` / `location_id` を空で出す）はそのまま
（実データは使う列しか書かないが、固定ヘッダの方がコードが単純で仕様上も問題ない）。
booking_rule の参照の書き方も現状のまま（上記のとおり瑞穂町方式）。
