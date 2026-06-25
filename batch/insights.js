// batch/insights.js
// ① 時代相の自動キャプション（オフライン生成）
// data/heatmap.json の集計から「法令種別 × 5年区切り年代」の注目セルを選び、
// 各セルの実データ（改正回数・実在する法令名）を Claude Haiku に渡して
// 1文の参考解説を生成し、data/insights.json に保存する。
//
// 方針: 閲覧者ごとのAPI呼び出しはゼロ（事前焼き込み）。月次バッチで再生成。
// 認証: 環境変数 ANTHROPIC_API_KEY（このリポジトリにキーは保存しない）。
//
// 使い方:
//   $env:ANTHROPIC_API_KEY="sk-ant-..."   # PowerShell（その場限り）
//   node batch/insights.js --n 10          # 注目セル上位10件を生成
//   node batch/insights.js --n 6 --dry     # APIを呼ばず、対象とプロンプトだけ確認（キー不要）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data", "heatmap.json");
const OUT = path.join(__dirname, "..", "data", "insights.json");

const MODEL = "claude-haiku-4-5";
const PERIOD_SIZE = 5;
const AXIS = "law_type"; // 試作は法令種別軸のみ

function parseArgs(argv) {
  const a = { n: 10, dry: false, delay: 250 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--n") a.n = parseInt(argv[++i], 10);
    else if (argv[i] === "--dry") a.dry = true;
    else if (argv[i] === "--delay") a.delay = parseInt(argv[++i], 10);
  }
  return a;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eraOfYear = (y) => (y >= 2019 ? "令和" : y >= 1989 ? "平成" : y >= 1926 ? "昭和" : y >= 1912 ? "大正" : "明治");
const yearOf = (s) => (s ? parseInt(String(s).slice(0, 4), 10) : null);

function buildPeriods(years) {
  const periods = [];
  for (let i = 0; i < years.length; i += PERIOD_SIZE) {
    const chunk = years.slice(i, i + PERIOD_SIZE);
    periods.push({ start: chunk[0], end: chunk[chunk.length - 1], years: chunk, era: eraOfYear(chunk[0]) });
  }
  return periods;
}
const periodVal = (byYear, p) => p.years.reduce((s, y) => s + (byYear[y] || byYear[String(y)] || 0), 0);

const SYSTEM = `あなたは日本の現行法令データの解説者です。与えられた事実（実際の改正回数・実在する法令名）と、確実な一般的歴史知識のみに基づき、その「法令種別 × 年代」で改正がなぜ多い／少ないのかを、日本語で1文・全角70字以内で簡潔に解説してください。
制約:
- 与えられた数値・法令名と矛盾しない内容のみ。与えられていない統計や固有名を創作しない。
- 歴史的因果が不確かなときは「〜とみられる」「〜が背景にある可能性」等、推定と分かる書き方にする。
- 出力は解説本文のみ（前置き・記号・引用符・改行なし）。`;

function factsFor(cell, period, topLaws) {
  const laws = topLaws.length
    ? topLaws.map((l) => `${l.title}(${l.count}回)`).join("、")
    : "（該当なし）";
  return `法令種別: ${cell.label}
年代: ${period.start}〜${period.end}年（${period.era}）
この5年間の改正回数（公布ベース・現行法令対象）: ${period._total}
区分の現存法令数: ${cell.law_count}
この期間に多く改正された法令（回数）: ${laws}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const data = JSON.parse(fs.readFileSync(DATA, "utf-8"));
  const periods = buildPeriods(data.years);
  const groups = data.axes[AXIS].groups;

  // 注目セル = 期間改正回数の多い順（試作）。各セルの上位改正法令も付ける。
  const candidates = [];
  for (const g of groups) {
    for (const p of periods) {
      const total = periodVal(g.by_year, p);
      if (total > 0) candidates.push({ cell: g, period: { ...p, _total: total } });
    }
  }
  candidates.sort((a, b) => b.period._total - a.period._total);
  const targets = candidates.slice(0, args.n);

  const topLawsFor = (groupLabel, p) =>
    data.laws
      .filter((l) => l.groups[AXIS] === groupLabel)
      .map((l) => ({ title: l.title, count: periodVal(l.by_year, p) }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);

  console.log(`対象 ${targets.length} 件（${AXIS}軸・期間改正の多い順）／モデル ${MODEL}${args.dry ? "（dry-run）" : ""}`);

  const client = args.dry ? null : new Anthropic(); // ANTHROPIC_API_KEY を環境から
  const items = {};
  let done = 0;
  for (const { cell, period } of targets) {
    const top = topLawsFor(cell.group, period);
    const facts = factsFor(cell, period, top);
    const key = `${AXIS}|${cell.group}|${period.start}`;
    if (args.dry) {
      console.log(`\n--- ${key} (${cell.label} ${period.start}〜${period.end} / 改正${period._total}) ---\n${facts}`);
      continue;
    }
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: "user", content: facts }],
      });
      const caption = (resp.content.find((b) => b.type === "text")?.text || "").trim();
      items[key] = {
        caption,
        label: cell.label,
        period: [period.start, period.end],
        era: period.era,
        total: period._total,
      };
      done++;
      process.stdout.write(`\r  生成 ${done}/${targets.length}  `);
      await sleep(args.delay);
    } catch (err) {
      console.error(`\n[${key}] 失敗: ${err.message}`);
      if (/api key|authentication/i.test(err.message)) {
        console.error("→ 環境変数 ANTHROPIC_API_KEY を設定してください（このリポジトリにキーは保存しません）。");
        process.exit(1);
      }
    }
  }
  if (args.dry) {
    console.log(`\n(dry-run) ${targets.length} 件のプロンプトを表示しました。実生成は --dry を外して実行してください。`);
    return;
  }

  const out = {
    generated_at: new Date().toISOString().slice(0, 10),
    model: MODEL,
    axis: AXIS,
    disclaimer: "AI（Claude Haiku）が実データを基に生成した参考解説です。正確性は保証されません。",
    items,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n生成: ${path.relative(process.cwd(), OUT)}（${Object.keys(items).length} 件）`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
