import { createWorker } from "tesseract.js";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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

let currentImage = null; // Blob
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

function setImage(blob) {
  if (!blob || !blob.type.startsWith("image/")) return;
  currentImage = blob;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(blob);
  preview.hidden = false;
  placeholder.hidden = true;
  runBtn.disabled = false;
  progressWrap.hidden = true;
  runOcr();
}

function clearAll() {
  currentImage = null;
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

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  worker = await createWorker(lang, 1, {
    workerPath: `${BASE}tesseract/worker.min.js`,
    corePath: `${BASE}tesseract/`,
    langPath: `${BASE}tessdata/`,
    gzip: true,
    cacheMethod: "none",
    logger: (m) => setStatus(m.status, m.progress),
  });
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

async function runOcr() {
  if (!currentImage || busy) return;
  busy = true;
  runBtn.disabled = true;
  langSel.disabled = true;
  copyBtn.disabled = true;
  result.value = "";
  const lang = langSel.value;
  try {
    const w = await getWorker(lang);
    setStatus("recognizing text", 0);
    const { data } = await w.recognize(currentImage);
    result.value = cleanup(data.text, lang);
    copyBtn.disabled = !result.value;
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
  if (fileInput.files?.[0]) setImage(fileInput.files[0]);
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
  const f = e.dataTransfer?.files?.[0];
  if (f) setImage(f);
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

runBtn.addEventListener("click", runOcr);
clearBtn.addEventListener("click", clearAll);
copyBtn.addEventListener("click", copyText);
result.addEventListener("input", () => (copyBtn.disabled = !result.value));

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
