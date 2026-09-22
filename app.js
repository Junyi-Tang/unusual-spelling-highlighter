import { loadLexicon, scanText, MAX_CHARS } from "./engine.js";

const input = document.getElementById("input");
const output = document.getElementById("output");
const status = document.getElementById("status");
const scanButton = document.getElementById("scan");
const tableBody = document.querySelector("#table tbody");

let lexicon = null;

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function render(result) {
  const marks = [...result.rows].sort((a, b) => a.start - b.start || b.end - a.end);
  const events = [];
  for (const row of marks) {
    events.push({ pos: row.start, type: "start" });
    events.push({ pos: row.end, type: "end" });
  }
  events.sort((a, b) => a.pos - b.pos || (a.type === "end" ? -1 : 1));
  let html = "";
  let last = 0;
  let depth = 0;
  const text = result.text;
  for (const event of events) {
    if (event.pos > last) {
      const chunk = escapeHtml(text.slice(last, event.pos));
      html += depth > 0 ? `<mark>${chunk}</mark>` : chunk;
    }
    depth += event.type === "start" ? 1 : -1;
    last = event.pos;
  }
  html += escapeHtml(text.slice(last));
  output.innerHTML = html || "&nbsp;";
  tableBody.replaceChildren();
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    for (const value of [row.surface, row.guess, row.why]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    tableBody.appendChild(tr);
  }
}

function scan() {
  if (!lexicon) return;
  const result = scanText(input.value, lexicon);
  render(result);
  const extra = result.truncated ? ` First ${MAX_CHARS} characters only.` : "";
  if (result.candidate_count === 0) status.textContent = "No unusual spellings were marked." + extra;
  else status.textContent = `${result.candidate_count} ${result.candidate_count === 1 ? "candidate" : "candidates"} marked.` + extra;
}

scanButton.addEventListener("click", scan);

async function boot() {
  try {
    const [loaded] = await Promise.all([
      loadLexicon(),
      loadBenchmark().catch((error) => {
        if (benchCount) benchCount.textContent = "Could not load the curated benchmark list.";
        console.error(error);
      }),
    ]);
    lexicon = loaded;
    scanButton.disabled = false;
    status.textContent = "Ready.";
    render({ text: "", rows: [] });
  } catch (error) {
    status.textContent = "Could not load the local dictionary.";
    console.error(error);
  }
}

const CATEGORY_LABELS = {
  hate_extremism: "hate / extremism",
  profanity_insult: "profanity / insult",
  regulated_substance: "regulated substance",
  self_harm_health: "self-harm / health",
  sexual_content: "sexual content",
  violence_weapon: "violence / weapon",
};

const MECHANISM_LABELS = {
  digit_symbol_substitution_or_masking: "digit / symbol / mask",
  internal_punctuation_or_spacing: "punctuation / spacing",
  none: "ordinary control",
};

const OUTCOME_LABELS = {
  hit: "detected",
  miss: "missed",
  clear: "not flagged",
};

const benchBody = document.querySelector("#bench tbody");
const benchCount = document.getElementById("bench-count");
const benchQuery = document.getElementById("bench-query");
let benchCases = [];
let benchFilter = "all";

function renderBenchmark() {
  if (!benchBody) return;
  const query = (benchQuery?.value || "").trim().toLowerCase();
  const rows = benchCases.filter((item) => {
    if (benchFilter !== "all" && item.b !== benchFilter) return false;
    if (!query) return true;
    const hay = [item.id, item.surface, item.target, item.category, item.mechanism, OUTCOME_LABELS[item.b]].join(" ").toLowerCase();
    return hay.includes(query);
  });
  benchBody.replaceChildren();
  for (const item of rows) {
    const tr = document.createElement("tr");
    tr.className = item.b;
    const cells = [
      item.id,
      item.surface,
      item.target,
      CATEGORY_LABELS[item.category] || item.category,
      MECHANISM_LABELS[item.mechanism] || item.mechanism,
      OUTCOME_LABELS[item.b] || item.b,
    ];
    cells.forEach((value, index) => {
      const td = document.createElement("td");
      if (index === 1) td.className = "surface";
      if (index === 5) {
        const pill = document.createElement("span");
        pill.className = "pill " + item.b;
        pill.textContent = value;
        td.appendChild(pill);
      } else {
        td.textContent = value;
      }
      tr.appendChild(td);
    });
    benchBody.appendChild(tr);
  }
  if (benchCount) {
    benchCount.textContent = rows.length === benchCases.length
      ? "Showing all 300 cases."
      : "Showing " + rows.length + " of 300 cases.";
  }
}

for (const button of document.querySelectorAll("[data-bench-filter]")) {
  button.addEventListener("click", () => {
    benchFilter = button.dataset.benchFilter;
    for (const other of document.querySelectorAll("[data-bench-filter]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    renderBenchmark();
  });
}
benchQuery?.addEventListener("input", renderBenchmark);

async function loadBenchmark() {
  const response = await fetch("data/curated-v1.json");
  if (!response.ok) throw new Error("benchmark missing");
  const payload = await response.json();
  benchCases = payload.cases || [];
  renderBenchmark();
}

boot();
