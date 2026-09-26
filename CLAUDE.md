# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このプロジェクトは何か

デマンド交通の GTFS-Flex データを、**スマホや Web から数十分で作れるツール**（仮称 flexmaker）。
公共交通オープンデータチャレンジ2026 への応募を想定。企画の検討経緯は
`../10_GTFS-Flex作成ツール案.md`（リポジトリの1つ上、「GTFS-Flex作成ツール」フォルダ直下。
正本は Claude プロジェクト「公共交通オープンデータチャレンジ２０２６」）にある。**着手前に読むこと。**

**誰のため**：配車システムを持たず、電話予約＋地元タクシー会社委託で回している自治体の交通担当者。
手元にあるのは「予約は前日17時まで」「区域はこの図」「降りられる場所はこの一覧」という運行要領だけ。

**この段階のゴール**：運行形態を1つ選び、地図で区域と場所を置き、予約ルールを入れると、
仕様に違反しない GTFS-Flex の zip が出る。ここまでを壊さずに動かす。

**2026-09-26 方針追加：作る画面と、住民が見る画面を一体にする。**
担当者が作った Flex データを、そのまま住民向けの「うちから乗れる？」確認ページで見られるようにする。
住民は地図で自宅などの地点を置くと「区域内か」「どこへ行けるか」「予約はいつまで・電話番号」が分かる。
ODPT の既存 Flex データも同じ確認ページで見られるようにし、「作る」と「使う（オープンデータ活用）」を対にする。
サーバはアプリ完成後に検討する。**当面はサーバ無しで、デモで確認できるところまで仕上げる。**

公開先：https://itou-create.github.io/flexmaker/ （リポジトリ `itou-create/flexmaker`、公開）

---

## コマンド

```bash
npm install
npm run dev            # http://localhost:5173  --host 付き
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + vite build → dist/
npm run preview        # dist/ をローカルで確認
npm run fetch-samples  # ODPT の GTFS-Flex 15件（CC BY 4.0）を samples/ に落とす
```

テストは無い。動作確認は `npm run dev` で画面から「サンプルを読み込む」→「検証する」→「zip を出す」。

### この環境固有の落とし穴

- **OneDrive 配下では `vite build` が dist/ を空にする処理で Node がクラッシュする**（終了コード -1073740791、Node 24 で確認）。
  `vite.config.ts` で `emptyOutDir: false` にしてある。古い成果物が残るので、ビルド前に `rm -f dist/assets/*` する。
  クラッシュ後に `vite.config.ts.timestamp-*.mjs` が残ることがある（.gitignore 済み、消してよい）
- `node_modules` を別 OS から持ち込むと `.bin` に Windows 用シムが無く `vite` が見つからない。`npm install` し直す
- 社内ネットワークでは地理院タイルがブロックされることがある（地図が白ければそれ）
- スマホで手元の変更を確認したいとき：この PC は LAN 直アクセスがファイアウォールで通らない。
  `npx -y cloudflared tunnel --url http://localhost:5173` で一時 URL を作る（`server.allowedHosts` に `.trycloudflare.com` 設定済み）

### デプロイ

`main` に push すると `.github/workflows/deploy.yml` がビルドして GitHub Pages に出す（数分）。
`dist/` はコミットしない。`vite.config.ts` の `base` は `'./'`（相対パス）なのでサブディレクトリ配下でもそのまま動く。

---

## 絶対に守ってほしい設計原則

### 1. 担当者は GTFS を知らない

画面に `location_group_id` や `pickup_type` を出さない。担当者が答えるのは
「どこで乗れて、どこで降りられるか」「いつまでに予約するか」「いつ走るか」だけ。
GTFS への変換は `src/gtfs/flexWriter.ts` に閉じ込める。**画面側のコードに GTFS の項目名を書き始めたら設計が漏れている。**
（例外：検証結果の一覧にファイル名 `stop_times.txt` 等を出すのは可。直す手がかりになる）

### 2. 運行形態から入る

区域・場所・時刻を自由に組ませない。`OperationPattern`（4形態）を先に選ばせ、
その形態で必要な入力だけを求める。Flex は組み合わせが多く、自由に組ませると仕様違反のデータができる。
形態を増やしたくなったら、まず `docs/gtfs-flex-reference.md` の表に stop_times の組み方を書いてから実装する。
`needsZone(pattern)` / `needsStops(pattern)`（flexWriter）が「その形態で何が要るか」の唯一の判定。画面もこれを使う。

### 3. 仕様違反のデータを出さない

出力前に必ず `validateFlexFiles` を通し、エラーがあれば出さない。
バリデータは条件付き必須／禁止のルールを**仕様の原文どおり**に実装する。
「たぶん通る」で緩めない。ルールを足すときは `docs/gtfs-flex-reference.md` の該当行を示すこと。

ただし `src/gtfs/validate.ts` は MobilityData の正規バリデータの代わりではない。
README と画面の両方で「本番前に正規バリデータにかける」と明記し続ける。

### 4. 出力は GTFS-JP 第4.0版に寄せる

日本の公式仕様（2026年3月、Flex ローカライズ追加）に準拠した出力を目指す。
ただし **第2編 2.5〜2.8 の記入例との突合はまだ済んでいない**（docs の「要確認」）。
突合が済むまで、README や資料に「GTFS-JP 準拠」と**書かない**。「準拠を目指している」まで。

### 5. 依存を増やさない・サーバは必要なときだけ

Vite + TypeScript + 素の DOM。地図だけ Leaflet（地理院タイル）。zip は自前（`src/gtfs/zip.ts`）。
画面は静的ファイルで GitHub Pages に置ける形を基本にする。
描画ライブラリ（Leaflet-Geoman 等）は、タップ方式で足りなくなってから。
Web フォント（Zen Maru Gothic）だけは Google Fonts から読む。落ちても丸ゴシック系のフォールバックで崩れない。

**サーバを持たないことは絶対条件ではない**（2026-09-26 方針変更）。
静的ファイルだけでは実現できない、または利用者（担当者・住民）の手間が大きく増える機能は、
サーバを置く案を**理由・代わりの静的案・維持の手間（応募条件＝開催期間中の無償公開を2027-03-12まで保つこと）**とあわせて提案する。
勝手に導入はしない。提案して判断をもらう。

---

## 構造

### データの流れ

```
DemandService（src/types.ts、担当者が触る入力モデル）
   │ buildFlexFiles()          src/gtfs/flexWriter.ts   ← 核心。形態ごとの stop_times の組み方はここだけ
   ▼
GtfsFiles（ファイル名 → テキスト）
   │ validateFlexFiles()       src/gtfs/validate.ts     ← Flex 固有の条件付き必須／禁止
   ▼ エラーが無ければ
buildZip() → downloadBytes()  src/gtfs/zip.ts          ← 無圧縮 zip、依存ゼロ
```

- `GtfsFiles` は「ファイル名 → CSV 文字列」の素の辞書。バリデータは書き出したテキストを `parseCsv` で読み直して検査する
  （出力そのものを見るので、writer の内部構造に依存しない）
- 座標は `[経度, 緯度]`（GeoJSON / `Zone.polygon`）と `stop_lat, stop_lon`（stops.txt / `Stop`）で順序が逆。取り違えやすい

### 画面の仕組み

- `src/state.ts`：単一ストア。`setState` で全リスナーに通知、`updateService` は入力モデルの差し替え＋検証結果のクリア
- 画面は **状態が変わるたびに全部 `innerHTML` で描き直す**（フレームワーク無し）。
  だから入力は `change` で拾う（`input` だと再描画でフォーカスが飛ぶ）。ボタンは `data-act` 属性で束ねて1つのクリックハンドラで分岐
- `src/ui/panel.ts`：入力パネル本体と、地図の上に浮かぶ操作チップ（`#map-overlay`）の両方を描く。
  手順チップの「済み」判定は `steps()` にまとまっている
- `src/ui/map.ts`：Leaflet。区域はタップで頂点を置いて `draftPolygon` に溜め、「閉じて確定」で `service.zone` へ。
  乗降場所はタップ→`window.prompt` で名前
- `src/ui/intro.ts`：起動時のオープニング。ロゴ SVG（`LOGO_SVG`）もここに置いてパネルと共用
- `src/styles.css`：色・角丸・書体は `:root` のトークンで管理。地図上の意味色（区域＝`--zone`、場所＝`--stop`）は
  アクセント（`--green`）と分けてある。`map.ts` の Leaflet 描画色は CSS 変数が使えないので同じ hex を直書き

---

## いま実装済みのもの / これから作るもの

### 実装済み
- 4形態（zone_to_point / point_to_zone / zone_only / checkpoint）の stop_times 生成
- 区域（locations.geojson）、場所群（location_groups / location_group_stops）、予約ルール（booking_rules）の出力
- Flex 固有ルールの検証と、エラー時の出力停止
- 地図での区域描画・場所配置、サンプル読み込み、zip ダウンロード
- 画面デザイン（手順チップ、図つき運行形態、地図上の操作チップ、オープニング）と GitHub Pages 公開
- **実データとの突合（2026-09-26 完了）**：ODPT 15件と比較。全件が location_group 方式（区域＝geojson の実例ゼロ）で、
  checkpoint 形の出力は実データと行構造が一致。結果と flexWriter への反映は `docs/gtfs-flex-reference.md` §12
- **既存 Flex の読み込み（2026-09-26）**：`src/gtfs/flexReader.ts`（ファイル辞書 → 表示モデル FlexView）。
  時が1桁の時刻も読める。zone 系（locations.geojson）も読めるが実データに例が無いため未検証
- **住民向け確認ページの試作（2026-09-26）**：`check.html` + `src/check.ts`。瑞穂町「チョイソコみずほまち」1件分。
  地図タップ → 近くの乗り場3件と徒歩目安、運行日・時間帯、予約電話（tel: リンク）、出典表示。
  データは `scripts/convert-sample.mjs` で `public/data/*.json` に変換して同梱
- **プレビュー連携（2026-09-26）**：作成画面の「住民ページで見る」→ `check.html#preview`。
  受け渡しは `src/preview.ts`（localStorage 経由・サーバ不要）。中身は flexWriter → flexReader を
  通した FlexView なので、zip に入るものと同じ解釈で表示される。区域だけの形態（乗り場ゼロ）は
  「乗れる範囲の中／外」の判定だけを出す。ボタンは `<a target="_blank">`（window.open はブロックされる環境がある）

### まだ無いもの（優先順・2026-09-26 更新）

**ゴール：デモで確認できるアプリ。**「担当者が作る → 住民向け画面で確かめる」と「ODPT の既存データを住民向け画面で見る」が、GitHub Pages 上で一通り動くこと。

1. **住民向け確認ページの「形の確認」**：瑞穂町1件分の1画面（`check.html`）を 2026-09-26 に作った。
   担当者（伊藤さん）の確認をもらってから残りの14件・複数エリア表示に広げる
2. **ODPT の残り14件をデモ用に同梱**：`scripts/convert-sample.mjs` で軽い JSON に変換して `public/data/` に置く
   （zip そのものはコミットしない）。CC BY 4.0 なので画面に出典（提供事業者・ODPT）を必ず表示する。
   ODPT のアクセスキーを画面側に書かない。複数データの切り替え UI もここで
3. **zip のままの読み込み**：`flexReader` は「ファイル名 → テキスト」辞書までは読める。
   ブラウザで zip を展開する部分（zip.ts は書く専用）が未実装
4. **入力の保存**（localStorage で足りる。プレビューの `src/preview.ts` と同じ要領）
5. 正規バリデータでの確認：出力 zip を https://gtfs-validator.mobilitydata.org/ に投げ、Flex のルールがどこまで見られるか記録
6. GTFS-JP 第2編 2.5〜2.8 との突合（GTFS-JP 固有ファイルの要否。route_type は実データでは 3 が標準と確認済み）
7. 複数の区域・複数の予約ルール（今は各1つ）。実データはエリアごとに route / trip / location_group を 1:1:1 で作る（§12）
8. 運休日・曜日振替（calendar_dates.txt。実データは15件全てが同梱、flexWriter は未出力。flexReader は読める）

後回し（アプリ完成後に検討）：サーバ（固定URL・QR 発行、データ保存と引き継ぎ、ODPT 定期取り込み、住民の照会地点の集計）、LINE 窓口、印刷用チラシ

---

## 事実関係で気をつけること

- Flex データがある自治体は **14自治体・5事業者**（ODPT 2026-09-16 時点）。数字を資料に書くときは日付を添える
- **Google 乗換案内は Flex を受け付けない**（2025年12月末時点、GTFS-JP 第1編の注記）。「Google マップに載る」と書かない
- 国交省 **LINKS Mobilys** が今年度 Flex 対応予定。差別化の根拠を書くときは、Mobilys の実体を確認した日付を添える

## コミットについて

- `samples/` の zip はコミットしない（`.gitignore` 済み。CC BY 4.0 なので再配布自体は可だが、リポジトリを重くしない）
- `dist/` をコミットしない（GitHub Actions でビルド）
- 公開リポジトリなので、README・docs・このファイルも誰でも読める前提で書く
