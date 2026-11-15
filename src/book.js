// Multi-page ("book") OCR: pull page images out of a .docx or a set of image
// files, OCR every page, then rebuild paragraphs, headings and scene breaks
// from the line geometry. Everything is rule based and runs locally.
import { createWorker, PSM } from "tesseract.js";
import { unzipSync, strFromU8 } from "fflate";

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };

export function isDocx(file) {
  return /\.docx$/i.test(file.name || "");
}

// Returns the embedded pictures of a Word file in reading order.
export async function pagesFromDocx(file) {
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (f) => f.name === "word/document.xml" || f.name === "word/_rels/document.xml.rels" || f.name.startsWith("word/media/"),
  });
  const doc = zip["word/document.xml"];
  const rels = zip["word/_rels/document.xml.rels"];
  if (!doc || !rels) throw new Error("This does not look like a Word (.docx) file");
  const target = {};
  for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target[id] = t.startsWith("/") ? t.slice(1) : `word/${t}`;
  }
  const pages = [];
  for (const m of strFromU8(doc).matchAll(/\br:(?:embed|id)="([^"]+)"/g)) {
    const path = target[m[1]];
    if (!path || !IMAGE_EXT.test(path) || !zip[path]) continue;
    const ext = path.split(".").pop().toLowerCase();
    pages.push({ name: path.split("/").pop(), blob: new Blob([zip[path]], { type: MIME[ext] }) });
  }
  if (!pages.length) throw new Error("No pictures were found in this Word file");
  return pages;
}

export function pagesFromImages(files) {
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
  return [...files]
    .filter((f) => f.type.startsWith("image/"))
    .sort((a, b) => cmp(a.name, b.name))
    .map((f) => ({ name: f.name, blob: f }));
}

// Flatten transparency onto white and enlarge small scans; both help Tesseract.
async function prepare(blob) {
  const bmp = await createImageBitmap(blob);
  const longest = Math.max(bmp.width, bmp.height);
  const scale = longest >= 2400 ? 1 : Math.min(2, 4000 / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const out = await new Promise((res) => canvas.toBlob(res, "image/png"));
  return { blob: out, width: canvas.width, height: canvas.height };
}

function linesFromData(data) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        const words = (line.words || []).filter((w) => w.text && w.text.trim());
        if (!words.length) continue;
        words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
        lines.push({
          left: Math.min(...words.map((w) => w.bbox.x0)),
          right: Math.max(...words.map((w) => w.bbox.x1)),
          top: Math.min(...words.map((w) => w.bbox.y0)),
          bot: Math.max(...words.map((w) => w.bbox.y1)),
          text: words.map((w) => w.text.trim()).join(" "),
          conf: Math.min(...words.map((w) => w.confidence)),
          words: words.map((w) => ({ text: w.text.trim(), conf: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1 })),
        });
      }
    }
  }
  return lines.sort((a, b) => a.top - b.top);
}

// OCR all pages with a small pool of workers. Returns one entry per page.
export async function recognizePages(pages, lang, workerOptions, onProgress) {
  const cores = navigator.hardwareConcurrency || 2;
  const n = Math.max(1, Math.min(4, cores - 1, pages.length));
  onProgress?.({ phase: "init", done: 0, total: pages.length });
  const workers = await Promise.all(
    Array.from({ length: n }, async () => {
      const w = await createWorker(lang, 1, workerOptions);
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      return w;
    })
  );
  const results = new Array(pages.length);
  let next = 0;
  let done = 0;
  try {
    await Promise.all(
      workers.map(async (w) => {
        while (next < pages.length) {
          const i = next++;
          const img = await prepare(pages[i].blob);
          const { data } = await w.recognize(img.blob, {}, { blocks: true, text: false });
          results[i] = { width: img.width, height: img.height, lines: linesFromData(data) };
          onProgress?.({ phase: "ocr", done: ++done, total: pages.length });
        }
      })
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }
  return results;
}

// ---------- text clean-up ----------

function ordinal(n) {
  const v = Number(n) % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[v % 10] || "th"}`;
}

const I_VERBS =
  "look|remember|was|have|had|am|think|thought|know|knew|can|could|would|will|just|never|did|got|went|said|saw|felt|feel|love|need|want|guess|mean|do|don’t|didn’t";

export function cleanLine(t, lang = "eng") {
  if (!lang.includes("eng")) return t;
  return t
    // superscript ordinals (4th, 3rd …) come out of OCR as digits plus junk
    .replace(/\b(\d{1,3})(?:\*+®?|t®|t['’]|"¢|™)/g, (_, n) => ordinal(n))
    .replace(/\b(\d{1,2})["”]?(?=[ -]grade\b)/g, (_, n) => ordinal(n))
    // a lone bar or bracket is a misread capital I
    .replace(/(^|\s)[|\[](?=\s)/g, "$1I")
    .replace(/\b(\d{1,3})‘(?=\s|$)/g, (_, n) => ordinal(n))
    .replace(/—-|--/g, "–")
    .replace(/(^| )- /g, "$1– ")
    .replace(/(?<=\p{L})'(?=\p{L})/gu, "’")
    .replace(new RegExp(`\\bI(${I_VERBS})\\b`, "g"), "I $1");
}

// ---------- layout analysis ----------

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// Share of lines that start at the most common left edge.
function leftModeShare(L, tol) {
  let best = 0;
  for (const a of L) best = Math.max(best, L.filter((b) => Math.abs(b.left - a.left) <= tol).length);
  return best / L.length;
}

// A page is "centred" (title page, copyright notice, dedication …) when its
// shorter lines sit on the same axis as its longest ones. In running text the
// short lines hug the left margin instead.
function isCenteredPage(L, H, W) {
  if (L.length < 3) {
    const mid = (L[0].left + L[0].right) / 2;
    return L.every((l) => l.left > 0.15 * W && l.right < 0.85 * W && Math.abs((l.left + l.right) / 2 - mid) <= 0.4 * H);
  }
  const widest = Math.max(...L.map((l) => l.right - l.left));
  const full = L.filter((l) => l.right - l.left >= widest - H);
  const rest = L.filter((l) => l.right - l.left < widest - H);
  if (rest.length < 0.4 * L.length) return false;
  const mid = median(full.map((l) => (l.left + l.right) / 2));
  return rest.filter((l) => Math.abs((l.left + l.right) / 2 - mid) <= 0.4 * H).length >= 0.8 * rest.length;
}

// Tesseract sometimes drops a lone "I" at the start of a sentence, leaving a
// wide hole in the line. Put it back when the hole follows a sentence end.
function restoreDroppedI(l, lang) {
  if (!lang.includes("eng") || l.words.length < 4) return false;
  const gaps = [];
  for (let n = 1; n < l.words.length; n++) gaps.push(l.words[n].x0 - l.words[n - 1].x1);
  const usual = median(gaps);
  let fixed = false;
  for (let n = l.words.length - 1; n >= 1; n--) {
    const prev = l.words[n - 1];
    const next = l.words[n];
    if (gaps[n - 1] > 1.8 * usual && /[.!?]["”’]?$/.test(prev.text) && /^\p{Ll}/u.test(next.text)) {
      l.words.splice(n, 0, { text: "I", conf: 0, x0: prev.x1, x1: next.x0 });
      fixed = true;
    }
  }
  if (fixed) l.text = l.words.map((w) => w.text).join(" ");
  return fixed;
}

// Two neighbouring lines sharing both edges means justified running text.
function hasJustifiedPair(L, H) {
  for (let i = 0; i + 1 < L.length; i++) {
    const a = L[i];
    const b = L[i + 1];
    if (Math.abs(a.left - b.left) <= 0.3 * H && Math.abs(a.right - b.right) <= 0.3 * H && a.right - a.left > 10 * H) return true;
  }
  return false;
}

const isOrnament = (l, H) => l.bot - l.top < 0.6 * H || (l.conf < 60 && l.text.length < 5);

/**
 * Turn per-page OCR lines into a list of blocks:
 *   title | heading | center | lines | para | break | pagebreak
 * plus a list of spots worth a human look.
 */
export function reconstruct(pages, lang = "eng") {
  const blocks = [];
  const review = [];
  let cur = null; // paragraph being built
  let afterHead = true;
  let prevShort = false;
  let prevKind = null; // kind of the previous page

  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  const last = () => blocks[blocks.length - 1];
  const pageBreak = () => {
    flush();
    if (blocks.length && last().type !== "pagebreak") blocks.push({ type: "pagebreak", text: "" });
  };
  const addLine = (t) => {
    if (!cur) cur = { type: "para", text: t };
    else cur.text += (cur.text.endsWith("-") ? "" : " ") + t;
  };
  const note = (page, l) => {
    l.words.forEach((w, n) => {
      const odd = /\d["'‘°%]$/.test(cleanLine(w.text, lang)) && w.conf < 90;
      // ordinary contractions score low only because of the apostrophe
      const contraction = /^\p{L}+['’](t|s|ll|re|ve|d|m)[.,;:!?”"]*$/iu.test(w.text);
      if ((w.conf >= 60 || contraction) && !odd) return;
      if (!/[\p{L}\p{N}]/u.test(w.text)) return;
      const ctx = l.words.slice(Math.max(0, n - 2), n + 3).map((x) => x.text).join(" ");
      review.push({ page: page + 1, word: cleanLine(w.text, lang), find: cleanLine(ctx, lang), conf: Math.round(w.conf) });
    });
    if (l.text.endsWith("-")) {
      const tail = l.words.slice(-3).map((x) => x.text).join(" ");
      review.push({ page: page + 1, word: "line-end hyphen", find: cleanLine(tail, lang), conf: null });
    }
  };

  pages.forEach((page, i) => {
    let L = page.lines.map((l) => ({ ...l, words: l.words.map((w) => ({ ...w })) }));
    if (!L.length) return;
    L.forEach((l) => restoreDroppedI(l, lang));
    const H = median(L.map((l) => l.bot - l.top));

    if (isCenteredPage(L, H, page.width)) {
      // title page, copyright page, dedication …: keep the line breaks
      L = L.filter((l) => !(l.conf < 60 && l.text.length < 12 && (l.bot - l.top > 1.5 * H || !/[\p{L}\p{N}]{2}/u.test(l.text))));
      if (!L.length) return;
      const groups = [];
      L.forEach((l, n) => {
        if (n && l.top - L[n - 1].bot <= 1.2 * H) groups[groups.length - 1].push(l);
        else groups.push([l]);
      });
      const continues = prevKind === "center" && /^\p{Ll}/u.test(L[0].text) && last()?.type === "center";
      if (!continues) pageBreak();
      groups.forEach((g, n) => {
        g.forEach((l) => note(i, l));
        const text = g.map((l) => cleanLine(l.text, lang)).join("\n");
        if (continues && n === 0) last().text += "\n" + text;
        else blocks.push({ type: !blocks.length ? "title" : "center", text });
      });
      prevKind = "center";
      afterHead = true;
      prevShort = false;
      return;
    }

    const startsFresh = /^[\p{Lu}\p{N}]/u.test(L[0].text);
    if (L.length >= 3 && startsFresh && leftModeShare(L, 0.3 * H) >= 0.8 && !hasJustifiedPair(L, H)) {
      // table of contents or another plain list: one entry per line
      if (prevKind !== "list") pageBreak();
      L.forEach((l) => note(i, l));
      const centredHead = L[0].left - median(L.map((l) => l.left)) > 2.4 * H;
      let body = L;
      if (centredHead) {
        blocks.push({ type: "center", text: cleanLine(L[0].text, lang) });
        body = L.slice(1);
      }
      const text = body.map((l) => cleanLine(l.text, lang)).join("\n");
      if (prevKind === "list" && last()?.type === "lines") last().text += "\n" + text;
      else blocks.push({ type: "lines", text });
      prevKind = "list";
      afterHead = true;
      prevShort = false;
      return;
    }

    // ---- running text ----
    if (prevKind === "center" || prevKind === "list") pageBreak();
    prevKind = "body";
    const lefts = L.map((l) => l.left).sort((a, b) => a - b);
    const rights = L.map((l) => l.right).sort((a, b) => a - b);
    const k = Math.floor(L.length / 5);
    const Lm = lefts[k];
    const Rm = rights[L.length - 1 - k];

    // drop cap: a tall single capital that belongs in front of the line above it
    for (let n = 0; n + 1 < L.length; n++) {
      const m = /^(\p{Lu}|[|\[1l]) (.*)$/u.exec(L[n + 1].text);
      if (m && L[n + 1].bot - L[n + 1].top > 2 * H) {
        if (!/\p{Lu}/u.test(m[1])) m[1] = "I";
        // "I" and "A" may be whole words; join only when a known word fragment follows
        const first = L[n].text.split(" ")[0].toLowerCase();
        const frag = { I: /^(n|t|f|s|ts|nto|nside|nstead)$/, A: /^(s|t|n|ll|nd|re|fter|lthough|nother|ny|bout|round|gain|lways|lmost|cross|mong|lso)$/ }[m[1]];
        L[n].text = m[1] + (frag && !frag.test(first) ? " " : "") + L[n].text;
        review.push({ page: i + 1, word: "drop cap", find: cleanLine(L[n].text.split(" ").slice(0, 3).join(" "), lang), conf: null });
        L[n].left = Lm;
        L[n + 1].text = m[2];
        L[n + 1].words = L[n + 1].words.slice(1);
      }
    }

    for (const l of L) {
      const dl = l.left - Lm;
      const dr = Rm - l.right;
      const t = cleanLine(l.text, lang);
      if (dl > 2.4 * H && dr > 2.4 * H) {
        flush();
        if (isOrnament(l, H)) blocks.push({ type: "break", text: "* * *" });
        else if (last()?.type === "heading" && afterHead) last().text += "\n" + t;
        else {
          pageBreak();
          blocks.push({ type: "heading", text: t });
        }
        afterHead = true;
        prevShort = true;
        continue;
      }
      note(i, l);
      if (afterHead || dl > 0.5 * H || (prevShort && cur)) flush();
      addLine(t);
      afterHead = false;
      prevShort = dr > 3 * H;
    }
  });
  flush();
  while (blocks.length && last().type === "pagebreak") blocks.pop();
  return { blocks, review };
}

// ---------- editable text form ----------
//   ## title     # heading     > centred     * * * scene break     === page break

const PREFIX = { title: "## ", heading: "# ", center: "> " };

export function serialize(blocks) {
  return blocks
    .map((b) => {
      if (b.type === "pagebreak") return "===";
      if (b.type === "break") return "* * *";
      const p = PREFIX[b.type];
      return p ? b.text.split("\n").map((l) => p + l).join("\n") : b.text;
    })
    .join("\n\n");
}

export function parse(text) {
  const blocks = [];
  for (const chunk of text.replace(/\r\n/g, "\n").split(/\n[ \t]*\n+/)) {
    const lines = chunk.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    const one = lines.length === 1 ? lines[0].trim() : "";
    if (/^={3,}$/.test(one)) blocks.push({ type: "pagebreak", text: "" });
    else if (/^\*(\s*\*){2}$/.test(one)) blocks.push({ type: "break", text: "* * *" });
    else {
      const strip = (p) => lines.map((l) => l.slice(p.length)).join("\n");
      if (lines.every((l) => l.startsWith("## "))) blocks.push({ type: "title", text: strip("## ") });
      else if (lines.every((l) => l.startsWith("# "))) blocks.push({ type: "heading", text: strip("# ") });
      else if (lines.every((l) => l.startsWith("> "))) blocks.push({ type: "center", text: strip("> ") });
      else blocks.push({ type: lines.length > 1 ? "lines" : "para", text: lines.join("\n") });
    }
  }
  return blocks;
}
