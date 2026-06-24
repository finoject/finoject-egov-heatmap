// batch/fetch.js
// e-Gov 法令API v2 から「全法令リスト」と「各法令の改正履歴」を取得する。
//
// マナー (仕様書 §3 / kickoff):
//   - リクエスト間に待機 (--delay ms, 既定 300ms)、同時実行は1 (直列)
//   - レスポンスは batch/cache/ に保存し、再実行時はキャッシュを使う (= 再取得しない)
//   - 失敗時はリトライ + 途中再開 (キャッシュ済みファイルはスキップ)
//
// 使い方:
//   node batch/fetch.js --per-type 20     # 動作確認用: 法令種別ごとに先頭20件だけ取得
//   node batch/fetch.js --all             # 全件取得 (約9,500件・数十分)
//   node batch/fetch.js --all --delay 500 # 待機を長めに
//
// 出力 (キャッシュ):
//   batch/cache/laws_master.json          # /laws の全ページを結合した法令マスタ
//   batch/cache/revisions/<law_id>.json   # /law_revisions/<id> の生レスポンス

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = "https://laws.e-gov.go.jp/api/2";
const CACHE_DIR = path.join(__dirname, "cache");
const REV_DIR = path.join(CACHE_DIR, "revisions");
const MASTER_PATH = path.join(CACHE_DIR, "laws_master.json");

// ---- 引数 ----
function parseArgs(argv) {
  const a = { all: false, perType: 20, delay: 300, refreshList: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--all") a.all = true;
    else if (t === "--per-type") a.perType = parseInt(argv[++i], 10);
    else if (t === "--delay") a.delay = parseInt(argv[++i], 10);
    else if (t === "--refresh-list") a.refreshList = true;
    else if (t === "--help" || t === "-h") a.help = true;
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 失敗時リトライ付き fetch (指数バックオフ)。429/5xx と通信エラーを再試行。
async function fetchJson(url, { retries = 4, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "egov-heatmap-batch/0.1 (research; polite-throttled)",
          Accept: "application/json",
        },
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        // 404 等は再試行しても無駄なので、その旨を返す
        return { ok: false, status: res.status };
      }
      return { ok: true, status: res.status, json: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const backoff = Math.min(8000, 500 * 2 ** attempt);
      if (attempt < retries) {
        process.stderr.write(
          `  retry ${attempt + 1}/${retries} after ${backoff}ms (${err.message}) ${url}\n`,
        );
        await sleep(backoff);
      }
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

// ---- [1] 全法令リスト取得 (ページング) ----
async function fetchLawMaster(delay) {
  if (fs.existsSync(MASTER_PATH)) {
    const cached = JSON.parse(fs.readFileSync(MASTER_PATH, "utf-8"));
    console.log(`法令マスタ: キャッシュ使用 (${cached.laws.length} 件)`);
    return cached;
  }
  console.log("法令マスタ取得開始 (/laws をページング)...");
  const limit = 500;
  let offset = 0;
  let total = null;
  const laws = [];
  while (true) {
    const url = `${API_BASE}/laws?limit=${limit}&offset=${offset}`;
    const r = await fetchJson(url);
    if (!r.ok) throw new Error(`/laws 取得失敗 status=${r.status}`);
    total = r.json.total_count;
    for (const item of r.json.laws) {
      const info = item.law_info ?? {};
      const rev = item.revision_info ?? item.current_revision_info ?? {};
      laws.push({
        law_id: info.law_id,
        law_type: info.law_type,
        law_num: info.law_num,
        promulgation_date: info.promulgation_date,
        // current title for display (改正履歴側の生データとは別に、一覧表示用に保持)
        law_title: rev.law_title ?? null,
      });
    }
    process.stdout.write(`\r  ${laws.length}/${total}`);
    const next = r.json.next_offset;
    if (next == null || next <= offset || laws.length >= total) break;
    offset = next;
    await sleep(delay);
  }
  process.stdout.write("\n");
  const master = { fetched_count: laws.length, total_count: total, laws };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(MASTER_PATH, JSON.stringify(master));
  console.log(`法令マスタ保存: ${laws.length} 件 -> ${path.relative(process.cwd(), MASTER_PATH)}`);
  return master;
}

// 取得対象の law_id を選ぶ
function selectTargets(master, args) {
  if (args.all) return master.laws.slice();
  // 法令種別ごとに先頭 perType 件
  const byType = new Map();
  const picked = [];
  for (const law of master.laws) {
    const n = byType.get(law.law_type) ?? 0;
    if (n < args.perType) {
      byType.set(law.law_type, n + 1);
      picked.push(law);
    }
  }
  return picked;
}

// ---- [2] 改正履歴取得 ----
async function fetchRevisions(targets, delay) {
  fs.mkdirSync(REV_DIR, { recursive: true });
  let done = 0,
    fetched = 0,
    skipped = 0,
    failed = 0;
  const failures = [];
  const t0 = Date.now();
  for (const law of targets) {
    done++;
    const out = path.join(REV_DIR, `${law.law_id}.json`);
    if (fs.existsSync(out)) {
      skipped++;
      continue; // 途中再開: 取得済みは飛ばす
    }
    const url = `${API_BASE}/law_revisions/${law.law_id}`;
    try {
      const r = await fetchJson(url);
      if (!r.ok) {
        failed++;
        failures.push({ law_id: law.law_id, status: r.status });
      } else {
        fs.writeFileSync(out, JSON.stringify(r.json));
        fetched++;
      }
    } catch (err) {
      failed++;
      failures.push({ law_id: law.law_id, error: err.message });
    }
    if (done % 25 === 0 || done === targets.length) {
      const rate = done / ((Date.now() - t0) / 1000 || 1);
      const eta = Math.round((targets.length - done) / (rate || 1));
      process.stdout.write(
        `\r  ${done}/${targets.length} (新規${fetched} / キャッシュ${skipped} / 失敗${failed}) ETA~${eta}s   `,
      );
    }
    await sleep(delay); // スロットリング
  }
  process.stdout.write("\n");
  if (failures.length) {
    const fp = path.join(CACHE_DIR, "failures.json");
    fs.writeFileSync(fp, JSON.stringify(failures, null, 2));
    console.log(`失敗 ${failures.length} 件を ${path.relative(process.cwd(), fp)} に記録 (再実行で再試行されます)`);
  }
  return { fetched, skipped, failed };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("使い方: node batch/fetch.js [--per-type N | --all] [--delay ms] [--refresh-list]");
    return;
  }
  if (args.refreshList && fs.existsSync(MASTER_PATH)) fs.rmSync(MASTER_PATH);

  const master = await fetchLawMaster(args.delay);
  const targets = selectTargets(master, args);
  console.log(
    args.all
      ? `改正履歴取得: 全 ${targets.length} 件`
      : `改正履歴取得: 法令種別ごと先頭 ${args.perType} 件 = 計 ${targets.length} 件 (動作確認モード)`,
  );
  const stats = await fetchRevisions(targets, args.delay);
  console.log(
    `完了: 新規取得 ${stats.fetched} / キャッシュ流用 ${stats.skipped} / 失敗 ${stats.failed}`,
  );
  console.log("次は: node batch/aggregate.js で集計JSONを生成してください。");
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
