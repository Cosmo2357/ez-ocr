// Turn the block list into .txt / .docx / .pdf files, all inside the browser.
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";

export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Paragraphs right after a heading, break or page break are not indented.
function withIndent(blocks) {
  let fresh = true;
  return blocks.map((b) => {
    const out = { ...b, indent: b.type === "para" && !fresh };
    fresh = b.type !== "para";
    return out;
  });
}

// ---------- plain text ----------

export function toTxt(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "pagebreak") out.push("", "");
    else if (b.type === "para" || b.type === "lines") out.push(b.text);
    else out.push("", b.text, "");
  }
  const text = out.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
  return new Blob([text], { type: "text/plain;charset=utf-8" });
}

// ---------- Word ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function wPara(text, { jc = "both", indent = false, size, bold, before = 0, after = 0, style, breakBefore } = {}) {
  const rPr = (bold ? "<w:b/>" : "") + (size ? `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>` : "");
  const runs = text
    .split("\n")
    .map((t, n) => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}${n ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`)
    .join("");
  const pPr =
    (style ? `<w:pStyle w:val="${style}"/>` : "") +
    (breakBefore ? "<w:pageBreakBefore/>" : "") +
    `<w:spacing w:before="${before * 20}" w:after="${after * 20}"/>` +
    (indent ? '<w:ind w:firstLine="425"/>' : "") +
    `<w:jc w:val="${jc}"/>`;
  return `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`;
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const FONT = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Yu Mincho"/>';

export function toDocx(blocks) {
  let body = "";
  let breakBefore = false;
  for (const b of withIndent(blocks)) {
    if (b.type === "pagebreak") {
      breakBefore = true;
      continue;
    }
    const o = { breakBefore };
    breakBefore = false;
    if (b.type === "title") body += wPara(b.text, { ...o, jc: "center", size: 26, bold: true, before: 140, after: 24 });
    else if (b.type === "heading") body += wPara(b.text, { ...o, jc: "center", style: "Heading1", before: 48, after: 36 });
    else if (b.type === "center") body += wPara(b.text, { ...o, jc: "center", after: 18 });
    else if (b.type === "break") body += wPara(b.text, { ...o, jc: "center", before: 12, after: 12 });
    else if (b.type === "lines") body += wPara(b.text, { ...o, jc: "left", after: 6 });
    else body += wPara(b.text, { ...o, indent: b.indent });
  }
  const files = {
    "[Content_Types].xml":
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
    "_rels/.rels":
      XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels":
      XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
    "word/styles.xml":
      XML +
      `<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="324" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style></w:styles>`,
    "word/footer1.xml":
      XML +
      `<w:ftr ${NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`,
    "word/document.xml":
      XML +
      `<w:document ${NS}><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return new Blob([zipped], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

// ---------- PDF ----------

const SWAP = { " ": " ", "‑": "-", "−": "-", "‐": "-", "　": " ", "\t": " " };

export async function toPdf(blocks, title = "") {
  const pdf = await PDFDocument.create();
  if (title) pdf.setTitle(title);
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const known = new Set(regular.getCharacterSet());
  let bad = 0;
  let total = 0;
  const safe = (s) =>
    [...s]
      .map((ch) => {
        if (ch === "\n") return ch;
        const c = SWAP[ch] ?? ch;
        total++;
        if (known.has(c.codePointAt(0))) return c;
        bad++;
        return "?";
      })
      .join("");
  const prepared = withIndent(blocks).map((b) => ({ ...b, text: safe(b.text) }));
  if (total && bad / total > 0.05) {
    throw new Error("PDF export supports Latin-script text only for now. Please save as Word or Text instead.");
  }

  const PW = 595.28;
  const PH = 841.89;
  const MX = 85;
  const MY = 72;
  const width = PW - 2 * MX;
  let page = null;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([PW, PH]);
    y = PH - MY;
  };
  const atTop = () => y === PH - MY;
  newPage();

  // Greedy line breaking; `justify` stretches every line except the last one.
  function draw(text, { font = regular, size = 12, align = "left", indent = 0, before = 0, after = 0, keep = 1 } = {}) {
    const lead = size * 1.35;
    const rows = [];
    for (const [n, hard] of text.split("\n").entries()) {
      let words = [];
      let w = 0;
      let first = n === 0;
      const space = font.widthOfTextAtSize(" ", size);
      for (const word of hard.split(/ +/).filter(Boolean)) {
        const ww = font.widthOfTextAtSize(word, size);
        const max = width - (first ? indent : 0);
        if (words.length && w + space + ww > max) {
          rows.push({ words, w, indent: first ? indent : 0, full: true });
          words = [];
          w = 0;
          first = false;
        }
        w += (words.length ? space : 0) + ww;
        words.push({ word, ww });
      }
      rows.push({ words, w, indent: first ? indent : 0, full: false });
    }
    if (!atTop()) y -= before;
    if (y - lead * Math.min(rows.length, keep) < MY) newPage();
    for (const row of rows) {
      if (y - lead < MY) newPage();
      y -= lead;
      const free = width - row.indent - row.w;
      const gaps = row.words.length - 1;
      const stretch = align === "justify" && row.full && gaps > 0 ? free / gaps : 0;
      let x = MX + row.indent + (align === "center" ? free / 2 : 0);
      const space = font.widthOfTextAtSize(" ", size);
      for (const { word, ww } of row.words) {
        page.drawText(word, { x, y, size, font });
        x += ww + space + stretch;
      }
    }
    y -= after;
  }

  for (const b of prepared) {
    if (b.type === "pagebreak") {
      if (!atTop()) newPage();
    } else if (b.type === "title") draw(b.text, { font: boldFont, size: 26, align: "center", before: 140, after: 24 });
    else if (b.type === "heading") {
      if (atTop()) y -= 48;
      draw(b.text, { font: boldFont, size: 18, align: "center", before: 30, after: 36, keep: 6 });
    } else if (b.type === "center") draw(b.text, { align: "center", after: 18 });
    else if (b.type === "break") draw(b.text, { align: "center", before: 12, after: 12, keep: 3 });
    else if (b.type === "lines") draw(b.text, { after: 6 });
    else draw(b.text, { align: "justify", indent: b.indent ? 21 : 0 });
  }

  pdf.getPages().forEach((p, n) => {
    const label = String(n + 1);
    p.drawText(label, { x: (PW - regular.widthOfTextAtSize(label, 10)) / 2, y: 36, size: 10, font: regular });
  });
  return new Blob([await pdf.save()], { type: "application/pdf" });
}
