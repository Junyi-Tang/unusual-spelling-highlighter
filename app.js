import { loadLexicon, scanText, MAX_CHARS } from "./engine.js";

const input = document.getElementById("input");
const output = document.getElementById("output");
const status = document.getElementById("status");
const scanButton = document.getElementById("scan");
const tableBody = document.querySelector("#table tbody");

const DEFAULT_TEXT = "Please notice how h3llo and w0rld can hide inside l33t $peak, how an @ltered $pelling or un.us.ual m!xed t#xt can still be read, how s p a c e d letters and 4lphanumeric 5ubstitutions keep the original word in view, and how intern.al punc.tuation, a lookalike pаssw0rd, a d0llar, a c@t, a b00k, some t7ext, and n.o.t.e.s all count as altered words in this paragraph.";

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
    lexicon = await loadLexicon();
    scanButton.disabled = false;
    if (!input.value.trim()) input.value = DEFAULT_TEXT;
    status.textContent = "Ready.";
    scan();
  } catch (error) {
    status.textContent = "Could not load the local dictionary.";
    console.error(error);
  }
}

boot();
