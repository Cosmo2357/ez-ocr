import { createWorker } from "tesseract.js";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isDocx, pagesFromDocx, pagesFromImages, recognizePages, reconstruct, serialize, parse } from "./book.js";
import { toTxt, toDocx, toPdf, download } from "./exporters.js";

const BASE = import.meta.env.BASE_URL;
const $ = (id) => document.getElementById(id);
const drop = $("drop");
const fileInput = $("file");
const preview = $("preview");
const placeholder = $("placeholder");
const runBtn = $("run");
const clearBtn = $("clear");
const copyBtn = $("copy");
const copied = $("copied");
const result = $("result");
const langSel = $("lang");
const progressWrap = $("progress-wrap");
const progressBar = $("progress-bar");
const statusEl = $("status");

const pagesBadge = $("pages-badge");
const review = $("review");
const reviewList = $("review-list");
const legend = $("legend");
const saveBtns = ["save-pdf", "save-docx", "save-txt"].map($);
const isTauri = "__TAURI_INTERNALS__" in window;

let currentImage = null; // Blob (single-image mode)
let bookPages = null; // [{ name, blob }] (multi-page mode)
let baseName = "ocr";
let worker = null;
let workerLang = null;
let busy = false;

const STATUS_TEXT = {
  "loading tesseract core": "Loading OCR engine",
  "initializing tesseract": "Initializing OCR engine",
  "initialized tesseract": "Engine ready",
  "loading language traineddata": "Loading language data",
  "loading language traineddata (from cache)": "Loading language data",
  "loaded language traineddata": "Language data loaded",
  "initializing api": "Preparing",
  "initialized api": "Ready",
  "recognizing text": "Reading text",
};

function setStatus(status, progress) {
  progressWrap.hidden = false;
  statusEl.textContent = STATUS_TEXT[status] || status;
  progressBar.style.width = `${Math.round((progress || 0) * 100)}%`;
}

function showPreview(blob) {
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(blob);
  preview.hidden = false;
  placeholder.hidden = true;
}

function setOutputEnabled(on) {
  copyBtn.disabled = !on;
  saveBtns.forEach((b) => (b.disabled = !on));
}

function showReview(items) {
  reviewList.replaceChildren();
  review.hidden = !items.length;
  review.open = false;
  $("review-summary").textContent = `${items.length} spot${items.length === 1 ? "" : "s"} to double-check`;
  for (const it of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = `p.${it.page} · ${it.word}`;
    btn.title = it.find;
    btn.onclick = () => {
      let at = result.value.indexOf(it.find);
      let len = it.find.length;
      if (at < 0 && it.conf !== null) {
        at = result.value.indexOf(it.word);
        len = it.word.length;
      }
      btn.classList.toggle("gone", at < 0);
      if (at < 0) return;
      result.focus();
      result.setSelectionRange(at, at + len);
      result.scrollTop = (at / result.value.length) * result.scrollHeight - result.clientHeight / 2;
    };
    li.appendChild(btn);
    reviewList.appendChild(li);
  }
}

function setImage(blob) {
  if (!blob || !blob.type.startsWith("image/")) return;
  if (busy) return;
  currentImage = blob;
  bookPages = null;
  baseName = (blob.name || "ocr").replace(/\.[^.]+$/, "");
  pagesBadge.hidden = true;
  showReview([]);
  legend.hidden = true;
  showPreview(blob);
  runBtn.disabled = false;
  progressWrap.hidden = true;
  runOcr();
}

// A Word file or several images: treat every picture as one page of a document.
async function setFiles(files) {
  const list = [...(files || [])];
  if (!list.length || busy) return;
  const docx = list.find(isDocx);
  const images = list.filter((f) => f.type.startsWith("image/"));
  if (!docx && images.length <= 1) {
    if (images[0]) setImage(images[0]);
    else showError("Please choose an image or a Word (.docx) file");
    return;
  }
  try {
    bookPages = docx ? await pagesFromDocx(docx) : pagesFromImages(images);
  } catch (e) {
    console.error(e);
    showError(e?.message || e);
    return;
  }
  currentImage = null;
  baseName = (docx ? docx.name : images[0].name).replace(/\.[^.]+$/, "") + "_text";
  showPreview(bookPages[0].blob);
  pagesBadge.textContent = `${bookPages.length} page${bookPages.length === 1 ? "" : "s"}`;
  pagesBadge.hidden = false;
  runBook();
}

function showError(msg) {
  progressWrap.hidden = false;
  progressBar.style.width = "0%";
  statusEl.textContent = `Error: ${msg}`;
}

function clearAll() {
  if (busy) return;
  currentImage = null;
  bookPages = null;
  pagesBadge.hidden = true;
  showReview([]);
  legend.hidden = true;
  saveBtns.forEach((b) => (b.disabled = true));
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.removeAttribute("src");
  preview.hidden = true;
  placeholder.hidden = false;
  runBtn.disabled = true;
  result.value = "";
  copyBtn.disabled = true;
  progressWrap.hidden = true;
  fileInput.value = "";
}

const WORKER_OPTIONS = {
  workerPath: `${BASE}tesseract/worker.min.js`,
  corePath: `${BASE}tesseract/`,
  langPath: `${BASE}tessdata/`,
  gzip: true,
  cacheMethod: "none",
};

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  worker = await createWorker(lang, 1, { ...WORKER_OPTIONS, logger: (m) => setStatus(m.status, m.progress) });
  workerLang = lang;
  return worker;
}

// Tesseract inserts spaces between Japanese characters; strip them.
function cleanup(text, lang) {
  let t = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (lang.includes("jpn")) {
    const cjk = "[\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]";
    const re = new RegExp(`(${cjk}) +(?=${cjk})`, "g");
    let prev;
    do {
      prev = t;
      t = t.replace(re, "$1");
    } while (t !== prev);
  }
  return t;
}

async function runBook() {
  if (!bookPages || busy) return;
  busy = true;
  runBtn.disabled = true;
  langSel.disabled = true;
  setOutputEnabled(false);
  result.value = "";
  showReview([]);
  const lang = langSel.value;
  try {
    if (worker) {
      await worker.terminate(); // free memory for the page workers
      worker = null;
    }
    const pages = await recognizePages(bookPages, lang, WORKER_OPTIONS, ({ phase, done, total }) => {
      progressWrap.hidden = false;
      statusEl.textContent = phase === "init" ? "Loading OCR engine" : `Reading page ${done} of ${total}`;
      progressBar.style.width = `${Math.round((done / total) * 100)}%`;
    });
    const { blocks, review: spots } = reconstruct(pages, lang);
    result.value = cleanup(serialize(blocks), lang);
    setOutputEnabled(!!result.value);
    legend.hidden = !result.value;
    showReview(spots);
    statusEl.textContent = result.value ? `Done: ${pages.length} pages. Check the text, then save it as PDF, Word or Text` : "No text found";
    progressBar.style.width = "100%";
  } catch (e) {
    console.error(e);
    showError(e?.message || e);
  } finally {
    busy = false;
    runBtn.disabled = false;
    langSel.disabled = false;
  }
}

async function save(kind) {
  const blocks = parse(result.value);
  if (!blocks.length) return;
  try {
    const blob = kind === "pdf" ? await toPdf(blocks, baseName) : kind === "docx" ? toDocx(blocks) : toTxt(blocks);
    download(blob, `${baseName}.${kind}`);
  } catch (e) {
    console.error(e);
    showError(e?.message || e);
  }
}

async function runOcr() {
  if (!currentImage || busy) return;
  busy = true;
  runBtn.disabled = true;
  langSel.disabled = true;
  setOutputEnabled(false);
  result.value = "";
  const lang = langSel.value;
  try {
    const w = await getWorker(lang);
    setStatus("recognizing text", 0);
    const { data } = await w.recognize(currentImage);
    result.value = cleanup(data.text, lang);
    setOutputEnabled(!!result.value);
    statusEl.textContent = result.value ? "Done" : "No text found";
    progressBar.style.width = "100%";
  } catch (e) {
    console.error(e);
    statusEl.textContent = `Error: ${e?.message || e}`;
    progressWrap.hidden = false;
  } finally {
    busy = false;
    runBtn.disabled = !currentImage;
    langSel.disabled = false;
  }
}

async function copyText() {
  const text = result.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    result.select();
    document.execCommand("copy");
  }
  copied.hidden = false;
  setTimeout(() => (copied.hidden = true), 1500);
}

// --- input handlers ---
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  setFiles(fileInput.files);
});

["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  })
);
drop.addEventListener("drop", (e) => {
  setFiles(e.dataTransfer?.files);
});
// Prevent the webview from navigating when a file is dropped outside the zone.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

window.addEventListener("paste", (e) => {
  if (e.target === result) return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) {
        e.preventDefault();
        setImage(f);
        return;
      }
    }
  }
});

runBtn.addEventListener("click", () => (bookPages ? runBook() : runOcr()));
$("save-pdf").addEventListener("click", () => save("pdf"));
$("save-docx").addEventListener("click", () => save("docx"));
$("save-txt").addEventListener("click", () => save("txt"));
clearBtn.addEventListener("click", clearAll);
copyBtn.addEventListener("click", copyText);
result.addEventListener("input", () => setOutputEnabled(!!result.value));

// --- light / dark theme: follows the system until the user picks one ---
{
  const root = document.documentElement;
  const saved = () => {
    try {
      return localStorage.getItem("theme");
    } catch {
      return null;
    }
  };
  document.querySelectorAll(".theme-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch {}
    })
  );
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!saved()) root.dataset.theme = e.matches ? "dark" : "light";
  });
}

// --- landing page vs app, install as an app (PWA), offline support ---
// In a plain browser tab we show a landing page that leads to installing;
// the tool itself is shown once it runs as an installed app (or in the desktop build).
const landing = $("landing");
const appEl = $("app");
const standalone = () =>
  isTauri ||
  matchMedia("(display-mode: standalone)").matches ||
  matchMedia("(display-mode: window-controls-overlay)").matches ||
  navigator.standalone === true ||
  new URLSearchParams(location.search).get("source") === "pwa";

function showApp(on) {
  appEl.hidden = !on;
  landing.hidden = on;
}
showApp(standalone());

if (!isTauri) {
  const installBtn = $("install-btn");
  const headerInstall = $("header-install");
  const help = $("install-help");
  let installEvent = null;
  let installed = false;

  const helpText = () => {
    const ua = navigator.userAgent;
    if ("onbeforeinstallprompt" in window) {
      return "<strong>Already installed?</strong>Open OCR Magic from your Start menu, Launchpad or desktop. Otherwise use the install icon at the right end of the address bar, or the browser menu and then “Install OCR Magic”.";
    }
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua) && /Macintosh/.test(ua)) {
      return "<strong>Installing from Safari</strong>Choose File, then “Add to Dock”. Or open this page in Chrome or Edge and press Install.";
    }
    return "<strong>Open this page in Chrome or Edge</strong>This browser cannot install web apps. Chrome and Edge can, on both Windows and Mac.";
  };

  async function install() {
    if (!installEvent) {
      $("install-help-text").innerHTML = helpText();
      help.hidden = false;
      return;
    }
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    installEvent = null;
    if (outcome === "accepted") onInstalled();
  }

  function onInstalled() {
    installed = true;
    headerInstall.hidden = true;
    help.hidden = true;
    $("install-done").hidden = false;
    $("install-label").textContent = "Installed";
    installBtn.disabled = true;
    $("install-note").hidden = true;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    if (installed) return;
    installEvent = e;
    help.hidden = true;
    headerInstall.hidden = false;
  });
  window.addEventListener("appinstalled", onInstalled);
  installBtn.addEventListener("click", install);
  headerInstall.addEventListener("click", install);
  $("use-in-browser").addEventListener("click", () => showApp(true));
  matchMedia("(display-mode: standalone)").addEventListener("change", (e) => e.matches && showApp(true));

  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker
      .register(`${BASE}sw.js`)
      .then(() => navigator.serviceWorker.ready)
      // warm the cache so the installed app can read English text offline right away
      .then((reg) => reg.active?.postMessage({ type: "warm" }))
      .catch((e) => console.warn("offline support unavailable", e));
  }
}

// --- version & auto update ---
getVersion().then((v) => ($("app-version").textContent = `v${v}`)).catch(() => {});

async function checkForUpdate() {
  try {
    const update = await check();
    if (!update) return;
    const banner = $("update-banner");
    $("update-text").textContent = `Version v${update.version} is available`;
    banner.hidden = false;
    $("update-dismiss").onclick = () => (banner.hidden = true);
    $("update-btn").onclick = async () => {
      const btn = $("update-btn");
      btn.disabled = true;
      $("update-dismiss").hidden = true;
      let total = 0;
      let got = 0;
      try {
        await update.downloadAndInstall((ev) => {
          if (ev.event === "Started") total = ev.data.contentLength || 0;
          else if (ev.event === "Progress") {
            got += ev.data.chunkLength;
            $("update-text").textContent = total
              ? `Downloading ${Math.round((got / total) * 100)}%`
              : "Downloading...";
          } else if (ev.event === "Finished") {
            $("update-text").textContent = "Installing... restarting";
          }
        });
        await relaunch();
      } catch (e) {
        console.error(e);
        $("update-text").textContent = `Update failed: ${e?.message || e}`;
        btn.disabled = false;
      }
    };
  } catch (e) {
    console.warn("update check failed", e);
  }
}
checkForUpdate();
