// batch/ministry.js
// ④ 所管府省の第一次推定（ハイブリッド）
//   1) 発令省庁ルール: 府省令などは法令番号/タイトルに発令省庁名が入る → 高確度・無料
//   2) 事項別分類デフォルト: 50分類→府省の第一次マップ → 中確度・無料
//   3) AI推定（Haiku）: 上記で確定しない法律・政令等を、名称/番号/分類から推定 → --ai 時のみ
//
// 出力: data/ministry.json  { ministries:[...], items:{ law_id:{ministry,method,confidence} } }
// 認証(AI時のみ): 環境変数 ANTHROPIC_API_KEY（リポジトリにキーは保存しない）。
//
// 使い方:
//   node batch/ministry.js --rules-only        # キー不要・確定部分のみで全件マップ生成
//   node batch/ministry.js --ai --n 100         # 未確定のうち先頭100件をHaikuで推定して上書き
//   node batch/ministry.js --ai                 # 未確定を全件AI推定（数百〜のHaiku呼び出し）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data", "heatmap.json");
const OUT = path.join(__dirname, "..", "data", "ministry.json");
const MODEL = "claude-haiku-4-5";

// 現行の所管府省（軸の見やすさのため主要府省＋いくつかの庁に集約）
const MINISTRIES = [
  "内閣府", "デジタル庁", "復興庁", "総務省", "法務省", "外務省", "財務省", "金融庁",
  "文部科学省", "厚生労働省", "農林水産省", "経済産業省", "国土交通省", "環境省",
  "防衛省", "国家公安委員会", "人事院", "会計検査院", "その他",
];

// 発令省庁名（旧称含む）→ 現行府省。法令番号/タイトルに literal で現れるものを拾う。
const ISSUER_PATTERNS = [
  [/(厚生労働省令|厚生省令|労働省令)/, "厚生労働省"],
  [/(国土交通省令|運輸省令|建設省令|北海道開発庁令)/, "国土交通省"],
  [/(経済産業省令|通商産業省令|商工省令)/, "経済産業省"],
  [/(財務省令|大蔵省令)/, "財務省"],
  [/(総務省令|自治省令|郵政省令|総理府令|行政管理庁令)/, "総務省"],
  [/(文部科学省令|文部省令|科学技術庁令)/, "文部科学省"],
  [/(農林水産省令|農林省令)/, "農林水産省"],
  [/環境省令|環境庁令/, "環境省"],
  [/法務省令|司法省令/, "法務省"],
  [/外務省令/, "外務省"],
  [/防衛省令|防衛庁令/, "防衛省"],
  [/金融庁令/, "金融庁"],
  [/デジタル庁令/, "デジタル庁"],
  [/復興庁令/, "復興庁"],
  [/(国家公安委員会規則|警察庁)/, "国家公安委員会"],
  [/人事院規則/, "人事院"],
  [/会計検査院規則/, "会計検査院"],
  [/(内閣府令|内閣官房令)/, "内閣府"],
];

// 事項別分類 → 第一次の所管府省（best-effort）。番号に所管が出ない法律・政令の既定値。
const CATEGORY_MINISTRY = {
  行政組織: "総務省", 行政手続: "総務省", 地方自治: "総務省", 地方財政: "総務省", 統計: "総務省",
  消防: "総務省", 電気通信: "総務省", 郵務: "総務省", 国家公務員: "人事院",
  厚生: "厚生労働省", 社会福祉: "厚生労働省", 社会保険: "厚生労働省", 労働: "厚生労働省",
  工業: "経済産業省", 産業通則: "経済産業省", 商業: "経済産業省", 鉱業: "経済産業省", 事業: "経済産業省",
  農業: "農林水産省", 林業: "農林水産省", 水産業: "農林水産省",
  民事: "法務省", 刑事: "法務省", 司法: "法務省", 憲法: "その他", 国会: "その他",
  環境保全: "環境省", "金融・保険": "金融庁",
  財務通則: "財務省", 国税: "財務省", 国債: "財務省", 国有財産: "財務省", "外国為替・貿易": "財務省",
  教育: "文部科学省", 文化: "文部科学省",
  警察: "国家公安委員会", 防衛: "防衛省", 外事: "外務省",
  海運: "国土交通省", 陸運: "国土交通省", 航空: "国土交通省", 道路: "国土交通省", 河川: "国土交通省",
  都市計画: "国土交通省", "建築・住宅": "国土交通省", 国土開発: "国土交通省", 土地: "国土交通省",
  観光: "国土交通省", 貨物運送: "国土交通省", 災害対策: "内閣府",
};

function parseArgs(argv) {
  const a = { rulesOnly: false, ai: false, n: Infinity, dry: false, delay: 250, batch: 20 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--rules-only") a.rulesOnly = true;
    else if (argv[i] === "--ai") a.ai = true;
    else if (argv[i] === "--n") a.n = parseInt(argv[++i], 10);
    else if (argv[i] === "--dry") a.dry = true;
    else if (argv[i] === "--batch") a.batch = parseInt(argv[++i], 10);
  }
  return a;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ruleClassify(law) {
  const hay = `${law.num || ""} ${law.title || ""}`;
  for (const [re, m] of ISSUER_PATTERNS) if (re.test(hay)) return { ministry: m, method: "issuer", confidence: 0.95 };
  const cat = law.groups?.category;
  if (cat && CATEGORY_MINISTRY[cat]) return { ministry: CATEGORY_MINISTRY[cat], method: "category", confidence: 0.5 };
  return { ministry: "その他", method: "fallback", confidence: 0.2 };
}

const SYSTEM = `あなたは日本の法令の「所管府省」を推定する分類器です。次の候補から最も適切なものを1つだけ選びます。
候補: ${MINISTRIES.join(" / ")}
判断材料は法令名・法令番号・事項別分類です。確信が持てない場合は confidence を低くしてください。出力は指定のJSON配列のみ。`;

async function aiClassify(client, laws) {
  // laws: [{i, title, num, cat}] を1リクエストで分類
  const lines = laws.map((l) => `${l.i}. 名称「${l.title}」/ 番号「${l.num}」/ 分類「${l.cat || "－"}」`).join("\n");
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `次の各法令の所管府省を推定し、JSON配列で返してください。各要素は {"i": 番号, "ministry": 候補のいずれか, "confidence": 0〜1} の形式。配列のみ出力。\n\n${lines}`,
    }],
  });
  const text = (resp.content.find((b) => b.type === "text")?.text || "").trim();
  const json = text.replace(/^```json?\s*/i, "").replace(/```$/i, "").trim();
  const arr = JSON.parse(json);
  const out = {};
  for (const r of arr) {
    const m = MINISTRIES.includes(r.ministry) ? r.ministry : "その他";
    out[r.i] = { ministry: m, confidence: typeof r.confidence === "number" ? r.confidence : 0.5 };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const data = JSON.parse(fs.readFileSync(DATA, "utf-8"));

  // 既存マップがあれば引き継ぐ（AI実行を積み増しできる）
  let items = {};
  if (fs.existsSync(OUT)) { try { items = JSON.parse(fs.readFileSync(OUT, "utf-8")).items || {}; } catch {} }

  // 1) 全件にルール/分類デフォルトを付与（未設定のもののみ）
  for (const law of data.laws) {
    if (!items[law.id]) items[law.id] = ruleClassify(law);
  }

  if (args.ai && !args.dry) {
    // 2) 発令省庁で確定していない法令をAIで上書き（confidenceの低いものから）
    const pending = data.laws
      .filter((l) => items[l.id].method !== "issuer" && items[l.id].method !== "ai")
      .slice(0, args.n)
      .map((l) => ({ id: l.id, i: 0, title: l.title, num: l.num, cat: l.groups?.category }));
    console.log(`AI推定対象 ${pending.length} 件（${args.batch}件ずつ）／モデル ${MODEL}`);
    const client = new Anthropic();
    let done = 0;
    for (let b = 0; b < pending.length; b += args.batch) {
      const chunk = pending.slice(b, b + args.batch).map((x, k) => ({ ...x, i: k + 1 }));
      try {
        const res = await aiClassify(client, chunk);
        for (const x of chunk) {
          const r = res[x.i];
          if (r) items[x.id] = { ministry: r.ministry, method: "ai", confidence: r.confidence };
        }
      } catch (err) {
        console.error(`\n[batch @${b}] 失敗: ${err.message}`);
        if (/api key|authentication/i.test(err.message)) {
          console.error("→ 環境変数 ANTHROPIC_API_KEY を設定してください。");
          process.exit(1);
        }
      }
      done += chunk.length;
      process.stdout.write(`\r  AI推定 ${done}/${pending.length}  `);
      await sleep(args.delay);
    }
    process.stdout.write("\n");
  }

  // 集計（カバレッジ確認）
  const counts = {}; const byMethod = {};
  for (const law of data.laws) {
    const it = items[law.id];
    counts[it.ministry] = (counts[it.ministry] || 0) + 1;
    byMethod[it.method] = (byMethod[it.method] || 0) + 1;
  }

  const out = {
    generated_at: new Date().toISOString().slice(0, 10),
    model: MODEL,
    ministries: MINISTRIES,
    method_legend: { issuer: "発令省庁から確定", category: "事項別分類からの推定", ai: "AI(Haiku)推定", fallback: "未分類" },
    disclaimer: "所管府省は e-Gov API に含まれないため、発令省庁・分類・AIで推定した値です（参考）。",
    items,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`生成: ${path.relative(process.cwd(), OUT)}（${Object.keys(items).length} 件）`);
  console.log("方式内訳:", byMethod);
  console.log("府省別 上位:", Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join("  "));
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
