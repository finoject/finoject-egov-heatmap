// batch/aggregate.js
// キャッシュ (laws_master.json + revisions/*.json) を読み、分野軸ごとに
// 法令種別 (law_type) / 事項別分類 (category) × 年で改正回数を集計し、
// フロントが読む data/heatmap.json を生成する。
//
// 改正回数の定義 (仕様書 §10 の残論点に対する本実装の確定):
//   - 「改正」= /law_revisions の revisions[] のうち amendment_law_id が非null のもの。
//   - 最初の「制定」リビジョン (amendment_law_id=null, mission=New) は改正に数えない。
//   - 集計年 = amendment_promulgate_date の年 (公布ベース)。
//
// 分野軸 (仕様書 §2 / 第2弾):
//   - law_type : 法令種別 (master 由来)
//   - category : 事項別分類 (revisions[].category 由来。API応答に含まれる・50分類)
//   - ministry : 所管府省 は API に無く、外部マッピングが必要なため未実装 (要・入手元確定)
//
// 出力 JSON 構造 (サイズ最適化のため法令一覧は単一配列で持ち、軸は集計のみ):
//   { generated_at, years, meta, laws:[{id,title,num,date,type,cat,total,by_year}], axes:{<axis>:{label,groups:[...]}} }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "cache");
const REV_DIR = path.join(CACHE_DIR, "revisions");
const MASTER_PATH = path.join(CACHE_DIR, "laws_master.json");
const OUT_PATH = path.join(__dirname, "..", "data", "heatmap.json");

// 日本最古の現行法令「明治五年太政官布告第三百三十七号(改暦ノ布告)」=1872年公布を起点に。
const START_YEAR = 1872;
const END_YEAR = new Date().getFullYear();

const LAW_TYPE_LABELS = {
  Constitution: "憲法",
  Act: "法律",
  CabinetOrder: "政令",
  ImperialOrder: "勅令",
  MinisterialOrdinance: "府省令",
  Rule: "規則",
  Misc: "その他",
  // 法律としての効力を持つ命令（ポツダム命令・物価統制令等）。e-Gov は複合 law_type で区別。
  "Act,CabinetOrder": "政令（法律の効力）",
  "Act,ImperialOrder": "勅令（法律の効力）",
  "Act,MinisterialOrdinance": "府省令（法律の効力）",
};
const labelOf = (t) => LAW_TYPE_LABELS[t] ?? t ?? "不明";

const yearOf = (s) => {
  if (!s || typeof s !== "string") return null;
  const y = parseInt(s.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
};

function readMaster() {
  if (!fs.existsSync(MASTER_PATH)) {
    console.error("laws_master.json がありません。先に node batch/fetch.js を実行してください。");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MASTER_PATH, "utf-8"));
}

// 改正履歴 → {byYear, total, category}
function readRevisions(law_id) {
  const p = path.join(REV_DIR, `${law_id}.json`);
  if (!fs.existsSync(p)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
  const revs = j?.revisions ?? [];
  const byYear = {};
  let total = 0;
  let category = null;
  for (const r of revs) {
    if (category == null && r.category) category = r.category; // 事項別分類 (法令で一定)
    if (!r.amendment_law_id) continue; // 制定は改正に数えない
    const y = yearOf(r.amendment_promulgate_date);
    if (y == null) continue;
    byYear[y] = (byYear[y] ?? 0) + 1;
    total++;
  }
  return { byYear, total, category };
}

// 軸ごとの集計器
function makeAxis(label, keyFn) {
  return { label, keyFn, groups: new Map() };
}
function addToAxis(axis, axisName, law) {
  const g = axis.keyFn(law);
  if (g == null || g === "") return;
  law.groups[axisName] = g; // 各法令にどの軸でどの区分かを記録 (フロントの絞り込み用)
  if (!axis.groups.has(g)) {
    axis.groups.set(g, { group: g, label: g, law_count: 0, by_year: {}, total: 0 });
  }
  const cell = axis.groups.get(g);
  cell.law_count++;
  cell.total += law.total;
  for (const [y, n] of Object.entries(law.by_year)) cell.by_year[y] = (cell.by_year[y] ?? 0) + n;
}
function finalizeAxis(axis) {
  const groups = [...axis.groups.values()].sort((a, b) => b.law_count - a.law_count);
  return { label: axis.label, groups };
}

function main() {
  const master = readMaster();
  const years = [];
  for (let y = START_YEAR; y <= END_YEAR; y++) years.push(y);

  const laws = [];
  let withRev = 0, missingRev = 0, missingCat = 0;

  const axisType = makeAxis("法令種別", (l) => labelOf(l.type));
  const axisCat = makeAxis("事項別分類", (l) => l.cat);

  for (const m of master.laws) {
    const rev = readRevisions(m.law_id);
    if (rev) withRev++; else missingRev++;
    const cat = rev?.category ?? null;
    if (!cat) missingCat++;
    const law = {
      id: m.law_id,
      title: m.law_title || m.law_num || m.law_id,
      num: m.law_num,
      date: m.promulgation_date,
      type: m.law_type ?? "Unknown",
      cat: cat ?? "未分類",
      total: rev?.total ?? 0,
      by_year: rev?.byYear ?? {},
      groups: {},
    };
    laws.push(law);
    addToAxis(axisType, "law_type", law);
    addToAxis(axisCat, "category", law);
  }

  // 法令一覧は改正回数の多い順 (右パネルの内訳ランキングの既定順)
  laws.sort((a, b) => b.total - a.total);

  const out = {
    generated_at: new Date().toISOString().slice(0, 10),
    source: "e-Gov 法令API v2 (https://laws.e-gov.go.jp/api/2)",
    license: "政府標準利用規約(第2.0版)",
    amendment_rule: "改正=amendment_law_id非null / 集計年=公布日(amendment_promulgate_date)",
    years,
    default_axis: "law_type",
    axes: {
      law_type: finalizeAxis(axisType),
      category: finalizeAxis(axisCat),
    },
    laws,
    meta: {
      total_laws: master.laws.length,
      laws_with_revision_data: withRev,
      laws_missing_revision_data: missingRev,
      laws_missing_category: missingCat,
      law_type_labels: LAW_TYPE_LABELS,
      note_ministry: "所管府省(ministry)軸は外部マッピング未整備のため未収録",
    },
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  const kb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  console.log(`生成: ${path.relative(process.cwd(), OUT_PATH)} (${kb} KB)`);
  console.log(`  法令 ${master.laws.length} 件 / 改正履歴あり ${withRev} / 分類欠損 ${missingCat}`);
  console.log(`  軸[法令種別] ${out.axes.law_type.groups.length} 区分 / 軸[事項別分類] ${out.axes.category.groups.length} 区分`);
  console.log("  事項別分類トップ5:");
  for (const g of out.axes.category.groups.slice(0, 5)) {
    console.log(`    - ${g.label}　法令${g.law_count} / 改正計${g.total}`);
  }
}

main();
