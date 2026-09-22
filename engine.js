const MAX_ALTERNATIVES = 32;
const SINGLE_CHUNK_LIMIT = 80;
const MULTI_CHUNK_LIMIT = 40;
const MIN_MULTI_CHUNKS = 2;
const MAX_MULTI_CHUNKS = 8;
const TWO_WORD_PART_LIMIT = 12;
const TWO_WORD_COMMON_FREQUENCY = 80000000;
const EXTRA_DICTIONARY_WORDS = {
  asshole: 500000,
  dumbass: 400000,
  eatingdisorder: 100000,
  fentanyl: 400000,
  ketamine: 400000,
  selfharm: 400000,
  selfinjury: 100000,
  transphobic: 200000,
  xanax: 400000,
};
const MAX_CHARS = 4000;
const EXTERIOR = "\"'“”‘’()[]{}<>.,;:";
const ZERO_WIDTH = new Set(["\u200b", "\u200c", "\u200d", "\ufeff"]);
const SYMBOLS = {
  "0": "o", "1": "i", "2": "z", "3": "e", "4": "a",
  "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "+": "t",
};
const REMOVABLE = new Set((" \t\n\r\f\v" + `!"#$%&()*+,-./:;<=>?@[\\]^_{|}~\``).split(""));
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const CHUNK_RE = /\S+/g;
const RULE_LABELS = {
  mixed_alphanumeric: "letters mixed with numbers",
  mask_or_symbol: "symbols or punctuation standing in for letters",
  internal_punctuation: "punctuation breaking up a word",
  repeated_run: "stretched or repeated letters",
  separated_letters: "letters spaced apart",
  edit_distance: "close to an ordinary English word, but not an exact match",
  compacted_separated_letters: "spaced-out letters that form a word when joined",
  compatibility_form: "unusual character shapes",
  mixed_script: "letters from more than one alphabet",
  zero_width: "hidden characters",
  combining_mark: "stacked or accented characters",
};
const DETECTOR_LABELS = {
  B: "the spelling looks structurally unusual",
  C: "it is close to an ordinary English word",
};
const NUISANCE_LABELS = {
  url: "this span may be part of a web address",
  email: "this span may be part of an email address",
  technical: "this span may be technical text rather than ordinary language",
};

function casefold(text) {
  return text.normalize("NFKC").toLocaleLowerCase("en");
}

function pythonCasefold(text) {
  return text.toLocaleLowerCase("en");
}

function isAlpha(ch) {
  return /\p{L}/u.test(ch);
}

function isDigit(ch) {
  return /\p{Nd}/u.test(ch);
}

function isCombining(ch) {
  return /\p{M}/u.test(ch);
}

function scriptOf(ch) {
  const code = ch.codePointAt(0);
  if ((code >= 0x0041 && code <= 0x007a) || (code >= 0x00c0 && code <= 0x024f) || (code >= 0x1e00 && code <= 0x1eff)) return "LATIN";
  if (code >= 0x0370 && code <= 0x03ff) return "GREEK";
  if (code >= 0x0400 && code <= 0x04ff) return "CYRILLIC";
  try {
    const name = ch.normalize("NFC");
    if (/[A-Za-z]/.test(name) && name.length === 1) return "LATIN";
  } catch {}
  return null;
}

function unicodeNameScript(ch) {
  if (/^\p{Script=Latin}$/u.test(ch)) return "LATIN";
  if (/^\p{Script=Cyrillic}$/u.test(ch)) return "CYRILLIC";
  if (/^\p{Script=Greek}$/u.test(ch)) return "GREEK";
  return null;
}

function damerauOsa(a, b, maxDistance) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDistance) return -1;
  const INF = maxDistance + 1;
  const da = new Map();
  const maxI = la + 1;
  const maxJ = lb + 1;
  const d = Array.from({ length: maxI + 1 }, () => Array(maxJ + 1).fill(0));
  d[0][0] = INF;
  for (let i = 0; i <= la; i++) {
    d[i + 1][1] = i;
    d[i + 1][0] = INF;
  }
  for (let j = 0; j <= lb; j++) {
    d[1][j + 1] = j;
    d[0][j + 1] = INF;
  }
  for (let i = 1; i <= la; i++) {
    let db = 0;
    for (let j = 1; j <= lb; j++) {
      const i1 = da.get(b[j - 1]) || 0;
      const j1 = db;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        db = j;
      }
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost,
        d[i + 1][j] + 1,
        d[i][j + 1] + 1,
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1)
      );
    }
    da.set(a[i - 1], i);
    let rowMin = INF;
    for (let j = 1; j <= lb + 1; j++) rowMin = Math.min(rowMin, d[i + 1][j]);
    if (rowMin > maxDistance) return -1;
  }
  const distance = d[la + 1][lb + 1];
  return distance > maxDistance ? -1 : distance;
}

class SymSpell {
  constructor(maxDictionaryEditDistance = 2, prefixLength = 7) {
    this.maxDictionaryEditDistance = maxDictionaryEditDistance;
    this.prefixLength = prefixLength;
    this.words = new Map();
    this.deletes = new Map();
    this.maxLength = 0;
  }

  createDictionaryEntry(key, count) {
    if (this.words.has(key)) {
      this.words.set(key, this.words.get(key) + count);
      return false;
    }
    this.words.set(key, count);
    if (key.length > this.maxLength) this.maxLength = key.length;
    for (const del of this.editsPrefix(key)) {
      const list = this.deletes.get(del);
      if (list) list.push(key);
      else this.deletes.set(del, [key]);
    }
    return true;
  }

  edits(word, editDistance, deleteWords, currentDistance = 0) {
    editDistance += 1;
    if (!word) return deleteWords;
    for (let i = currentDistance; i < word.length; i++) {
      const del = word.slice(0, i) + word.slice(i + 1);
      if (!deleteWords.has(del)) deleteWords.add(del);
      if (editDistance < this.maxDictionaryEditDistance) {
        this.edits(del, editDistance, deleteWords, i);
      }
    }
    return deleteWords;
  }

  editsPrefix(key) {
    const hashSet = new Set();
    if (key.length <= this.maxDictionaryEditDistance) hashSet.add("");
    if (key.length > this.prefixLength) key = key.slice(0, this.prefixLength);
    hashSet.add(key);
    return this.edits(key, 0, hashSet);
  }

  lookup(phrase, maxEditDistance = this.maxDictionaryEditDistance) {
    const suggestions = [];
    const phraseLen = phrase.length;
    if (phraseLen - maxEditDistance > this.maxLength) return suggestions;
    if (this.words.has(phrase)) {
      suggestions.push({ term: phrase, distance: 0, count: this.words.get(phrase) });
      return suggestions;
    }
    if (maxEditDistance === 0) return suggestions;
    const consideredDeletes = new Set();
    const consideredSuggestions = new Set([phrase]);
    let maxEditDistance2 = maxEditDistance;
    const candidates = [];
    let phrasePrefixLen = Math.min(phraseLen, this.prefixLength);
    candidates.push(phraseLen > this.prefixLength ? phrase.slice(0, phrasePrefixLen) : phrase);
    let candidatePointer = 0;
    while (candidatePointer < candidates.length) {
      const candidate = candidates[candidatePointer++];
      const candidateLen = candidate.length;
      const lenDiff = phrasePrefixLen - candidateLen;
      if (lenDiff > maxEditDistance2) break;
      const dictSuggestions = this.deletes.get(candidate);
      if (dictSuggestions) {
        for (const suggestion of dictSuggestions) {
          if (suggestion === phrase) continue;
          const suggestionLen = suggestion.length;
          if (
            Math.abs(suggestionLen - phraseLen) > maxEditDistance2 ||
            suggestionLen < candidateLen ||
            (suggestionLen === candidateLen && suggestion !== candidate)
          ) continue;
          const suggestionPrefixLen = Math.min(suggestionLen, this.prefixLength);
          if (suggestionPrefixLen > phrasePrefixLen && suggestionPrefixLen - candidateLen > maxEditDistance2) continue;
          let distance = 0;
          let minDistance = 0;
          if (candidateLen === 0) {
            distance = Math.max(phraseLen, suggestionLen);
            if (distance > maxEditDistance2 || consideredSuggestions.has(suggestion)) continue;
          } else if (suggestionLen === 1) {
            distance = phrase.indexOf(suggestion[0]) < 0 ? phraseLen : phraseLen - 1;
            if (distance > maxEditDistance2 || consideredSuggestions.has(suggestion)) continue;
          } else {
            if (this.prefixLength - maxEditDistance === candidateLen) {
              minDistance = Math.min(phraseLen, suggestionLen) - this.prefixLength;
            } else {
              minDistance = 0;
            }
            if (
              this.prefixLength - maxEditDistance === candidateLen &&
              (
                (minDistance > 1 && phrase.slice(phraseLen + 1 - minDistance) !== suggestion.slice(suggestionLen + 1 - minDistance)) ||
                (
                  minDistance > 0 &&
                  phrase[phraseLen - minDistance] !== suggestion[suggestionLen - minDistance] &&
                  (
                    phrase[phraseLen - minDistance - 1] !== suggestion[suggestionLen - minDistance] ||
                    phrase[phraseLen - minDistance] !== suggestion[suggestionLen - minDistance - 1]
                  )
                )
              )
            ) continue;
            if (consideredSuggestions.has(suggestion)) continue;
            consideredSuggestions.add(suggestion);
            distance = damerauOsa(phrase, suggestion, maxEditDistance2);
            if (distance < 0) continue;
          }
          if (distance <= maxEditDistance2) {
            const suggestionCount = this.words.get(suggestion);
            const item = { term: suggestion, distance, count: suggestionCount };
            if (suggestions.length && distance < maxEditDistance2) suggestions.length = 0;
            maxEditDistance2 = distance;
            suggestions.push(item);
          }
        }
      }
      if (lenDiff < maxEditDistance && candidateLen <= this.prefixLength) {
        if (lenDiff >= maxEditDistance2) continue;
        for (let i = 0; i < candidateLen; i++) {
          const del = candidate.slice(0, i) + candidate.slice(i + 1);
          if (!consideredDeletes.has(del)) {
            consideredDeletes.add(del);
            candidates.push(del);
          }
        }
      }
    }
    suggestions.sort((a, b) => a.distance === b.distance ? b.count - a.count : a.distance - b.distance);
    return suggestions;
  }
}

class Lexicon {
  constructor(dictionaryText, confusableMap) {
    this.symspell = new SymSpell(2, 7);
    for (const line of dictionaryText.split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split(" ");
      if (parts.length < 2) continue;
      const count = Number(parts[1]);
      if (!Number.isFinite(count)) continue;
      this.symspell.createDictionaryEntry(parts[0], count);
    }
    this.confusableMap = confusableMap;
  }

  lookup(text) {
    return this.symspell.lookup(pythonCasefold(text), 2).map((item) => ({
      term: item.term,
      distance: item.distance,
      count: item.count,
    }));
  }

  frequency(term) {
    const key = pythonCasefold(term);
    return EXTRA_DICTIONARY_WORDS[key] || this.symspell.words.get(key) || 0;
  }
}

function trimWindow(text, start, end) {
  while (start < end && EXTERIOR.includes(text[start])) start += 1;
  while (end > start && EXTERIOR.includes(text[end - 1])) end -= 1;
  while (start < end && "!?".includes(text[start]) && [...text.slice(start + 1, end)].filter(isAlpha).length < 2) start += 1;
  while (end > start && "!?:".includes(text[end - 1])) {
    const core = text.slice(start, end - 1);
    const hasSupporting = /[*#$@_]/.test(core) ||
      ([...core].some(isAlpha) && [...core].some(isDigit)) ||
      /(?<=\w)[^\w\s](?=\w)/u.test(core);
    if ("!?".includes(text[end - 1]) && hasSupporting) break;
    end -= 1;
  }
  return [start, end];
}

function enumerateWindows(text, lexicon) {
  const matches = [...text.matchAll(CHUNK_RE)];
  const stats = { over_limit_chunks: 0, over_limit_windows: 0 };
  const output = [];
  const seen = new Set();
  const add = (start, end, compact, paths = []) => {
    const key = `${start}|${end}|${compact}|${paths.join(",")}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ start, end, surface: text.slice(start, end), compact, paths });
    }
  };
  const trimmed = [];
  for (const match of matches) {
    const [start, end] = trimWindow(text, match.index, match.index + match[0].length);
    if (start === end) continue;
    if (end - start > SINGLE_CHUNK_LIMIT) {
      stats.over_limit_chunks += 1;
      continue;
    }
    const compact = text.slice(start, end);
    add(start, end, compact);
    trimmed.push([start, end, compact]);
  }
  for (let left = 0; left < trimmed.length; left++) {
    let run = 0;
    for (const item of trimmed.slice(left)) {
      const part = item[2];
      if (!( /^[A-Za-z]+$/.test(part) && part.length <= 4)) break;
      run += 1;
    }
    if (run > MAX_MULTI_CHUNKS) stats.over_limit_windows += 1;
    for (let count = MIN_MULTI_CHUNKS; count <= Math.min(MAX_MULTI_CHUNKS, trimmed.length - left); count++) {
      const group = trimmed.slice(left, left + count);
      const start = group[0][0];
      const end = group[group.length - 1][1];
      if (end - start > MULTI_CHUNK_LIMIT) {
        stats.over_limit_windows += 1;
        continue;
      }
      const parts = group.map((item) => item[2]);
      if (parts.every((part) => /^[A-Za-z]+$/.test(part) && part.length <= 4) &&
          (parts.some((part) => part.length === 1) || parts.length >= 3)) {
        add(start, end, parts.join(""), ["separated_letters"]);
      }
    }
  }
  if (lexicon) {
    for (let i = 0; i < trimmed.length - 1; i++) {
      const left = trimmed[i];
      const right = trimmed[i + 1];
      const leftPart = left[2];
      const rightPart = right[2];
      if (!/^[A-Za-z]+$/.test(leftPart) || !/^[A-Za-z]+$/.test(rightPart)) continue;
      if (leftPart.length > TWO_WORD_PART_LIMIT || rightPart.length > TWO_WORD_PART_LIMIT) continue;
      const start = left[0];
      const end = right[1];
      if (end - start > MULTI_CHUNK_LIMIT) {
        stats.over_limit_windows += 1;
        continue;
      }
      const compact = (leftPart + rightPart).toLocaleLowerCase("en");
      if (!lexicon.frequency(compact)) continue;
      add(start, end, leftPart + rightPart, ["separated_letters"]);
    }
  }
  return [output, stats];
}

function nuisance(text, start, end) {
  const flags = [];
  for (const match of text.matchAll(URL_RE)) {
    if (match.index < end && match.index + match[0].length > start) flags.push("url");
  }
  for (const match of text.matchAll(EMAIL_RE)) {
    if (match.index < end && match.index + match[0].length > start) flags.push("email");
  }
  const surface = text.slice(start, end);
  if (/(?:[/\\]|::|\.[A-Za-z0-9]{1,5}$)/.test(surface)) flags.push("technical");
  return flags;
}

function detectStructural(text, lexicon) {
  const [windows] = enumerateWindows(text, lexicon);
  const spans = [];
  for (const window of windows) {
    const surface = window.surface;
    const rules = [...window.paths];
    const scripts = new Set();
    for (const ch of surface) {
      const script = unicodeNameScript(ch);
      if (script) scripts.add(script);
    }
    if ([...surface].some((ch) => ZERO_WIDTH.has(ch))) rules.push("zero_width");
    if ([...surface].some(isCombining)) rules.push("combining_mark");
    if (surface.normalize("NFKC") !== surface) rules.push("compatibility_form");
    if (scripts.size > 1) rules.push("mixed_script");
    if ([...surface].some(isAlpha) && [...surface].some(isDigit)) rules.push("mixed_alphanumeric");
    if (/\w[*#$@_?!]+\w|\w[*#$@_?!]+$|^[*#$@_?!]+\w/u.test(surface)) rules.push("mask_or_symbol");
    if (/(?<=\w)[^\w\s](?=\w)/u.test(surface)) rules.push("internal_punctuation");
    if (/(.)\1{2,}/u.test(pythonCasefold(surface))) rules.push("repeated_run");
    if (rules.length) {
      spans.push({
        start: window.start,
        end: window.end,
        source: "B",
        rules: [...new Set(rules)],
        nuisance_flags: nuisance(text, window.start, window.end),
      });
    }
  }
  return spans;
}

function uniquePaths(path) {
  return path;
}

function confusableOptions(ch, confusableMap) {
  const raw = confusableMap[ch] || [];
  const options = [];
  for (const value of raw) {
    const folded = pythonCasefold(value);
    if (folded !== pythonCasefold(ch) && !options.includes(folded)) options.push(folded);
  }
  return [options.slice(0, 4), options.length > 4];
}

function views(surface, confusableMap) {
  const viewsOut = [[pythonCasefold(surface), ["identity"]]];
  const nfkc = surface.normalize("NFKC");
  const nfkcFolded = pythonCasefold(nfkc);
  viewsOut.push([nfkcFolded, ["nfkc"]]);
  const compact = [...nfkcFolded].filter((ch) => !REMOVABLE.has(ch)).join("");
  viewsOut.push([compact, ["nfkc", "remove_spacing_punctuation"]]);
  let branches = [["", []]];
  let discarded = false;
  const nfkcChars = [...pythonCasefold(nfkc)];
  for (const ch of nfkcChars) {
    const choices = [[ch, []]];
    if (REMOVABLE.has(ch)) choices.push(["", ["remove_spacing_punctuation"]]);
    if (SYMBOLS[ch]) choices.push([SYMBOLS[ch], ["symbol_substitution"]]);
    const [opts, optionsDiscarded] = confusableOptions(ch, confusableMap);
    discarded = discarded || optionsDiscarded;
    for (const value of opts) choices.push([value, ["confusable"]]);
    const nextBranches = [];
    for (const [prefix, path] of branches) {
      for (const [replacement, step] of choices) {
        nextBranches.push([prefix + replacement, path.concat(step)]);
      }
    }
    const weights = { symbol_substitution: 1, remove_spacing_punctuation: 1, confusable: 3 };
    const unique = [];
    const seen = new Set();
    for (const item of nextBranches) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }
    unique.sort((a, b) => {
      const wa = a[1].reduce((s, step) => s + (weights[step] || 0), 0);
      const wb = b[1].reduce((s, step) => s + (weights[step] || 0), 0);
      if (wa !== wb) return wa - wb;
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      return JSON.stringify(a[1]) < JSON.stringify(b[1]) ? -1 : 1;
    });
    if (unique.length > MAX_ALTERNATIVES) discarded = true;
    branches = unique.slice(0, MAX_ALTERNATIVES);
  }
  for (const [text, path] of branches) viewsOut.push([text, ["nfkc", ...path]]);
  return [viewsOut, discarded];
}

function editCost(surface, term) {
  const source = pythonCasefold(surface);
  const target = pythonCasefold(term);
  let previous = [...Array(target.length + 1).keys()];
  for (let i = 0; i < source.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < target.length; j++) {
      current.push(Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + (source[i] !== target[j])));
    }
    previous = current;
  }
  return previous[previous.length - 1];
}

function reconstruct(surface, lexicon) {
  const alternatives = new Map();
  let truncated = false;
  const add = (term, frequency, path) => {
    const cost = editCost(surface, term);
    if (!alternatives.has(term)) {
      alternatives.set(term, { term, edit_cost: cost, frequency, paths: [] });
    }
    const row = alternatives.get(term);
    row.edit_cost = Math.min(row.edit_cost, cost);
    row.frequency = Math.max(row.frequency, frequency);
    const pathList = [...path];
    if (!row.paths.some((existing) => JSON.stringify(existing) === JSON.stringify(pathList))) {
      row.paths.push(pathList);
    }
  };
  const identity = surface;
  add(identity, lexicon.frequency(identity), ["identity"]);
  const [generated, branchesDiscarded] = views(surface, lexicon.confusableMap);
  truncated = branchesDiscarded;
  for (const [view, path] of generated) {
    if (view !== identity) add(view, lexicon.frequency(view), path);
  }
  for (const [view, path] of generated) {
    for (const suggestion of lexicon.lookup(view)) {
      const term = suggestion.term;
      if (term !== pythonCasefold(identity)) {
        add(term, suggestion.count, path.concat(["dictionary"]));
      }
    }
  }
  const rank = (row) => [row.edit_cost, -row.frequency, row.term];
  const ranked = [...alternatives.values()].sort((a, b) => {
    const ra = rank(a); const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  });
  const retained = [alternatives.get(identity)];
  for (const family of ["nfkc", "remove_spacing_punctuation", "symbol_substitution", "confusable", "dictionary"]) {
    const representatives = ranked.filter((r) => r.paths.some((p) => p.includes(family) && (family === "dictionary" || !p.includes("dictionary")))).slice(0, 4);
    for (const representative of representatives) {
      if (!retained.includes(representative)) retained.push(representative);
    }
  }
  const usable = [...ranked].sort((a, b) => {
    const af = a.frequency <= 0; const bf = b.frequency <= 0;
    if (af !== bf) return af - bf;
    const ra = rank(a); const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  });
  for (const row of usable) {
    if (!retained.includes(row) && retained.length < MAX_ALTERNATIVES) retained.push(row);
  }
  truncated = truncated || retained.length < alternatives.size;
  for (const row of retained) row.paths.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  retained.sort((a, b) => {
    const ai = a.term !== identity; const bi = b.term !== identity;
    if (ai !== bi) return ai - bi;
    if (a.edit_cost !== b.edit_cost) return a.edit_cost - b.edit_cost;
    if (a.frequency !== b.frequency) return b.frequency - a.frequency;
    return a.term < b.term ? -1 : 1;
  });
  const changed = retained.filter((row) => pythonCasefold(row.term) !== pythonCasefold(identity) && row.frequency > 0);
  changed.sort((a, b) => {
    if (a.edit_cost !== b.edit_cost) return a.edit_cost - b.edit_cost;
    if (a.frequency !== b.frequency) return b.frequency - a.frequency;
    return a.term < b.term ? -1 : 1;
  });
  return { identity, alternatives: retained, top3: changed.slice(0, 3).map((row) => row.term), alternatives_truncated: truncated };
}

function whyUnusual(detectorIds, ruleIds) {
  const parts = detectorIds.map((name) => DETECTOR_LABELS[name]).filter(Boolean);
  const details = [];
  for (const rule of ruleIds) {
    if (RULE_LABELS[rule] && !details.includes(RULE_LABELS[rule])) details.push(RULE_LABELS[rule]);
  }
  let sentence = parts.length ? parts.join(" and ") : "the spelling looks unusual";
  if (details.length) sentence += ": " + details.join("; ");
  return sentence + ".";
}

function guessedWords(top3) {
  const words = (top3 || []).filter(Boolean);
  if (!words.length) return "no clear ordinary word";
  if (words.length === 1) return words[0];
  return words[0] + " (also " + words.slice(1, 3).join(", ") + ")";
}

function cautionText(flags) {
  const notes = [];
  for (const flag of flags || []) {
    if (NUISANCE_LABELS[flag] && !notes.includes(NUISANCE_LABELS[flag])) notes.push(NUISANCE_LABELS[flag]);
  }
  return notes.join("; ");
}

function reviewCandidates(candidates, lexicon) {
  return candidates.filter((candidate) => {
    if (candidate.rule_ids.includes("separated_letters")) {
      const parts = candidate.surface.split(/\s+/).filter(Boolean);
      const compact = parts.join("").toLocaleLowerCase("en");
      const top3 = (candidate.top3 || []).map((term) => String(term).toLocaleLowerCase("en"));
      if (!top3.length || top3[0] !== compact) return false;
      if (parts.length === 2 && lexicon) {
        const freqs = parts.map((part) => lexicon.frequency(part));
        const bothWords = freqs.every((freq) => freq > 0);
        const oneCommon = Math.max(...freqs) >= TWO_WORD_COMMON_FREQUENCY;
        if (bothWords && oneCommon && !EXTRA_DICTIONARY_WORDS[compact]) return false;
      }
    }
    return true;
  });
}

export function scanText(text, lexicon) {
  let cleaned = (text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const truncated = [...cleaned].length > MAX_CHARS;
  if (truncated) cleaned = [...cleaned].slice(0, MAX_CHARS).join("");
  const spans = detectStructural(cleaned, lexicon);
  const union = new Map();
  for (const span of spans) {
    const key = `${span.start}|${span.end}`;
    if (!union.has(key)) union.set(key, []);
    union.get(key).push(span);
  }
  const keys = [...union.keys()].sort((a, b) => {
    const [as, ae] = a.split("|").map(Number);
    const [bs, be] = b.split("|").map(Number);
    return as - bs || ae - be;
  });
  const candidates = keys.map((key) => {
    const [start, end] = key.split("|").map(Number);
    const itemSpans = union.get(key);
    const surface = cleaned.slice(start, end);
    const rec = reconstruct(surface, lexicon);
    const ruleIds = [...new Set(itemSpans.flatMap((s) => s.rules))].sort();
    return {
      surface,
      start,
      end,
      top3: rec.top3,
      detector_ids: [...new Set(itemSpans.map((s) => s.source))].sort(),
      rule_ids: ruleIds,
      nuisance_flags: [...new Set(itemSpans.flatMap((s) => s.nuisance_flags))].sort(),
    };
  });
  const rows = reviewCandidates(candidates, lexicon).map((candidate) => ({
    surface: candidate.surface,
    start: candidate.start,
    end: candidate.end,
    guess: guessedWords(candidate.top3),
    why: whyUnusual(candidate.detector_ids, candidate.rule_ids),
    caution: cautionText(candidate.nuisance_flags),
    motive: "Unknown. A person still has to read the post and decide.",
    detectors: candidate.detector_ids,
  }));
  return { text: cleaned, truncated, max_chars: MAX_CHARS, candidate_count: rows.length, rows };
}

export async function loadLexicon() {
  const [dictRes, confRes] = await Promise.all([
    fetch("data/frequency_dictionary_en_82_765.txt"),
    fetch("data/confusable_mapping.json"),
  ]);
  if (!dictRes.ok || !confRes.ok) throw new Error("Could not load the local dictionary.");
  const dictionaryText = await dictRes.text();
  const confusableMap = await confRes.json();
  return new Lexicon(dictionaryText, confusableMap);
}

export { Lexicon, MAX_CHARS };
