# e-Gov 改正頻度ヒートマップ

e-Gov 法令検索の全法令（約9,500件）を対象に、「どの分野の法令がよく改正されるか」を
ヒートマップで可視化する静的 Web アプリ。色の濃さ＝改正頻度（公布ベース）。

**公開URL: https://finoject.github.io/finoject-egov-heatmap/**

仕様: `egov-heatmap-spec-v0.3.md` ／ 着手指示: `egov-heatmap-kickoff-prompt.md`（Desktop）

## 構成

```
egov-heatmap/
├─ batch/              # データ取得→集計→JSON生成（Node.js / 依存ゼロ）
│   ├─ fetch.js        # e-Gov v2 から法令リスト＆改正履歴を取得（キャッシュ・スロットリング・途中再開）
│   ├─ aggregate.js    # 法令種別×年で集計し data/heatmap.json を生成
│   └─ cache/          # APIレスポンスのローカルキャッシュ（.gitignore 済み・再実行で再利用）
├─ data/
│   └─ heatmap.json    # フロントが読む集計データ（仕様書 §5 + 右パネル用 laws[] を内包）
└─ web/
    └─ index.html      # 静的 HTML + D3.js 一枚（実行時は API を叩かず JSON のみ読む）
```

> **言語について**: 仕様書は Python（requests / pandas）指定ですが、この端末に Python が
> 未インストール（Microsoft Store のスタブのみ・pip なし）だったため、利用可能な
> **Node.js v24 で実装**しました（バッチは HTTP 取得→集計→JSON 書き出しのみで、依存パッケージ不要）。
> 出力 JSON の構造・フロント要件は仕様書どおりです。

## 使い方

### 1. データ取得＋集計（バッチ）

Node.js 18+（v24 で確認）。npm install 不要。

```bash
# 動作確認用：法令種別ごとに先頭20件だけ取得 → 集計（数分）
npm run build:sample

# 全件取得 → 集計（約9,500リクエスト・数十分。スロットリング＋キャッシュ＋途中再開あり）
npm run build:all

# 個別実行
node batch/fetch.js --per-type 20      # 少数取得（動作確認）
node batch/fetch.js --all --delay 400  # 全件取得（待機400ms）
node batch/aggregate.js                # キャッシュから集計のみ
```

- 取得済みレスポンスは `batch/cache/` に保存され、**再実行時は再取得しません**（途中で止めても再開可能）。
- 失敗した法令は `batch/cache/failures.json` に記録され、再実行で自動リトライされます。
- 月次更新は、現状はキャッシュを消さずに `npm run build:all` を再実行すれば差分のみ取得します
  （新規法令ぶんだけ取得・既存はキャッシュ流用）。本格的な「更新法令一覧での差分更新」は第3弾候補。

### 2. 表示（フロント）

```bash
npm run serve         # http://localhost:8080 で web/ を配信
# → ブラウザで http://localhost:8080/index.html を開く
```

### 3. デプロイ（GitHub Pages）

公開済み: https://finoject.github.io/finoject-egov-heatmap/ （リポジトリ `finoject/finoject-egov-heatmap`、Pages source = main / root）。
ルート `index.html` は `web/index.html` へリダイレクト。`.nojekyll` で素のまま配信。

データを更新して反映する手順:

```bash
npm run build:all     # 改正履歴を再取得（キャッシュ流用・差分のみ）→ data/heatmap.json 再生成
git add data/heatmap.json
git commit -m "data: 月次更新 YYYY-MM"
git push              # 数分で Pages に反映
```

> `batch/cache/`（APIキャッシュ）と `.claude/`（ローカル設定）は `.gitignore` 済みで公開されません。

**反映されないとき**（GitHub Pages のビルドが最新コミットを拾わない／一時障害のとき）は、最新HEADのビルドを手動トリガー:

```bash
gh api -X POST repos/finoject/finoject-egov-heatmap/pages/builds   # 最新HEADを再ビルド
# 確認
gh api repos/finoject/finoject-egov-heatmap/pages/builds/latest --jq '{status,commit:.commit[0:7]}'
```

ブラウザ側は `Ctrl+Shift+R`（強制リロード）、それでも旧版なら URL 末尾に `?v=2` などを付けて開く（CDN/ブラウザキャッシュ回避）。

## 機能（仕様書 §7）

- **3モード切替**:
  - 経年グリッド（行=区分×列=**5年区切り 1872〜2026**、セル色＝その5年間の改正回数）。最古の現行法令「改暦ノ布告(明治5年=1872)」を左端に、明治〜令和を元号バンド付きで通覧。明治維新直後・終戦直後・高度成長・バブル崩壊などの立法/改正の濃淡が時代相として読める。
  - 累計ツリーマップ（タイル面積＝法令数、色＝選択期間内の改正回数）
  - **公布年別度数分布**（現行法令を公布年5年区切りで度数分布）。X軸=年代（1872〜・左古→右新、グリッド/ツリーマップと同じ年代UI・元号バンド付き）、Y軸=公布数の積み上げ（下＝希少な種別=憲法・勅令／上＝多数=政令・府省令）。明治の細い裾＝今も生きる古い法令、平成期の公布爆発が読める。棒クリックでその期間・種別の現存法令一覧（公布順・e-Govリンク）。
- **色スケール**: 分位（quantile）6段階。多改正法に引っ張られず相対比較できる。**0回は無彩色**。凡例常時表示。
- **年レンジ選択**: グリッドの列・ツリーマップの色（累計）に即反映。既定は直近12年（全期間も選択可）。
- **可視化の詰め**: 5年区切りの強調ラベル＋ガイド線、ホバーで行/年をクロスハイライト、選択セル/タイルの枠を保持、ツリーマップに法令数＋改正回数を表示。
- **クリック→右パネル**: ①法令一覧 ②改正内訳（回数ランキング）。各法令に e-Gov 該当ページへのリンク。
- **ホバー**: ツールチップ（分野名／年／改正回数／法令数）。
- **検索**: 法令名で該当セル/タイルをハイライトし、一致法令を右パネルに直接表示。
- **状態表示**: ローディング／空／エラー。
- **モバイル対応**: 760px以下で操作列をリフロー、右パネルを下部ドロワー化（スライドアップ）。
- **PWA**: `web/manifest.webmanifest` ＋ `web/sw.js` でインストール可能・オフライン対応（ドキュメント/集計JSONは network-first、静的アセットは cache-first）。アイコンは `batch/make-icons.js` がヒートマップ柄PNGを生成（依存ゼロ・Node zlib）。データ更新時は `web/sw.js` の `CACHE` バージョンを上げると確実に入れ替わる。
- **出典明示**: フッターに e-Gov（デジタル庁）＋政府標準利用規約2.0 を明記。

## 改正回数の定義（仕様書 §10 の残論点に対する本実装の確定）

- **「改正」= `/law_revisions` の `revisions[]` のうち `amendment_law_id` が非null のもの**
  （別の改正法令によって更新されたリビジョン）。
- 最初の「制定」リビジョン（`amendment_law_id=null` / `mission=New`）は改正に数えません。
- **集計年 = `amendment_promulgate_date` の年（公布ベース）**。
- 附則のみの改正等の粒度は API のリビジョン単位に準拠（本文/附則の区別はリビジョンに分離情報がないため未分離）。

## 現状の注意点（サンプルデータ）

- `data/heatmap.json` は **動作確認モード（法令種別ごと20件）** で生成済みです。
  - **タイル面積（法令数）は全9,528件の実数**ですが、**色（改正回数）は取得済み122件ぶんのみ**を反映します。
  - 全件の正しい色を出すには `npm run build:all` を実行してください。
- `meta.laws_missing_revision_data` に改正履歴未取得の件数が入ります。

## AI参考解説（① 時代相キャプション）

セルをクリックすると、右パネル冒頭に「💡 AI参考解説」（Claude Haiku が**実データを根拠に**生成した1文解説）を表示。閲覧者ごとのAPI呼び出しはゼロ＝**事前生成（オフライン焼き込み）**方式で、コスト・安全性ともに最小。

```bash
# 認証は環境変数（リポジトリにキーは保存しない）
$env:ANTHROPIC_API_KEY = "sk-ant-..."          # PowerShell（その場限り）
node batch/insights.js --n 10                   # ← npm.ps1 が実行ポリシーで止まる環境では node 直実行
node batch/insights.js --n 10 --dry             # APIを呼ばず対象とプロンプトのみ確認（キー不要）
```
- 出力 `data/insights.json`（`{axis|group|periodStart: {caption,...}}`）をフロントが読む。`sample:true` の間は「（サンプル）」表示。
- 根拠（実改正回数・実在する法令名）をプロンプトに渡し、創作を禁止＋「AI生成の参考」ラベルで明示（ハルシネーション対策）。
- 第2弾候補: ③古い法令名の平易化／④所管府省の第一次推定／⑤見どころ自動抽出（同じオフライン方式で拡張可能）。

## 分野軸（仕様書 §2 / 第2弾）

上部バーの「分野軸」で切替:
- **法令種別**（9区分）… master 由来
- **事項別分類**（50区分: 行政組織・厚生・工業・国税…）… `/law_revisions` の `category` 由来。**API応答に含まれており外部データ不要**
- **所管府省**（未収録）… API に無く、外部マッピングの入手元確定が必要（仕様書 §10）。`data.laws[].groups` に `ministry` を足し、`aggregate.js` に軸を1つ加えれば対応可能な構造にしてある

JSON は `{ years, laws[], axes:{law_type,category} }` 構造。法令一覧は単一配列で持ち、各軸は集計のみ＋各法令に `groups:{法令種別,事項別分類}` を付与（サイズ最適化・検索の重複排除）。

## 段階リリース（仕様書 §9）

- 第1弾: 法令種別軸 × 経年/累計切替。データ取得〜JSON〜基本UI。✅
- 第2弾: 事項別分類軸を追加（軸切替ドリルダウン）。✅ ／ 所管府省軸は入手元確定後に追加。
- 第3弾: UI 磨き込み・更新法令一覧での差分更新。

---

出典: e-Gov 法令API v2（デジタル庁）を加工して作成。政府標準利用規約（第2.0版）に基づく。
