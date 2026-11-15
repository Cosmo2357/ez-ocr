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

// Which kind of device is this? Used to show only the instructions that apply to it.
// (iPadOS reports itself as a Mac, but has a touch screen.)
const UA = navigator.userAgent;
const OS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1)
  ? "ios"
  : /Android/.test(UA)
    ? "android"
    : /Windows/.test(UA)
      ? "windows"
      : /Macintosh|Mac OS X/.test(UA)
        ? "mac"
        : "other";
const isPhone = OS === "ios" || OS === "android";
document.documentElement.dataset.os = OS;

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

// --- drop zone wording for this device ---
if (isPhone) {
  $("drop-title").textContent = "Choose a photo or file";
  $("drop-hint").textContent = "Tap here to take a photo or pick from your files";
} else {
  const key = OS === "mac" ? "⌘V" : "Ctrl+V";
  $("drop-hint").innerHTML = `or <span class="linkish">browse</span>, or paste an image with ${key}`;
}

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
  const setTheme = (t) => {
    root.dataset.theme = t;
    // keep the phone status bar / window title bar the same colour as the header
    document.querySelector('meta[name="theme-color"]').content = t === "dark" ? "#211816" : "#ffffff";
  };
  document.querySelectorAll(".theme-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      setTheme(next);
      try {
        localStorage.setItem("theme", next);
      } catch {}
    })
  );
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!saved()) setTheme(e.matches ? "dark" : "light");
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

  const isIOS = OS === "ios";
  // where an installed app shows up on this device
  const HOME = { windows: "your Start menu", mac: "Launchpad or the Dock", android: "your home screen", ios: "your Home Screen", other: "your apps menu" }[OS];
  const SHARE_ICON =
    '<svg class="icon inline" viewBox="0 0 24 24"><path d="M12 15V3"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';

  const helpText = () => {
    const ua = navigator.userAgent;
    if (isIOS) {
      return `<strong>On iPhone and iPad, install from the Share menu</strong><ol><li>Tap the Share button ${SHARE_ICON} in the browser toolbar.</li><li>Scroll down and tap “Add to Home Screen”.</li><li>Tap “Add”. OCR Magic appears on your Home Screen.</li></ol>Apple does not let a web page do this for you, so the button above cannot install it directly.`;
    }
    if ("onbeforeinstallprompt" in window) {
      return `<strong>Already installed?</strong>Open OCR Magic from ${HOME}. Otherwise use the install icon at the right end of the address bar, or the browser menu and then “Install OCR Magic”.`;
    }
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua) && /Macintosh/.test(ua)) {
      return "<strong>Installing from Safari</strong>Choose File, then “Add to Dock”. Or open this page in Chrome or Edge and press Install.";
    }
    return "<strong>Open this page in Chrome or Edge</strong>This browser cannot install web apps. Chrome and Edge can, on both Windows and Mac.";
  };

  function showHelp(draw) {
    $("install-help-text").innerHTML = helpText();
    help.hidden = false;
    if (!draw) return;
    // make it obvious that the press did something
    help.scrollIntoView({ block: "center", behavior: "smooth" });
    help.classList.remove("flash");
    void help.offsetWidth;
    help.classList.add("flash");
  }

  async function install() {
    if (!installEvent) {
      showHelp(true);
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
  // --- wording for this device only ---
  $("install-note").textContent = {
    windows: "Installs in seconds from Chrome or Edge on Windows",
    mac: "Installs in seconds from Chrome or Edge on Mac",
    android: "Installs in seconds from Chrome on Android",
    other: "Installs in seconds from Chrome or Edge",
  }[OS] || "";
  $("install-done-text").textContent = isPhone
    ? `It has been added to ${HOME}. You can close this tab.`
    : `It has opened in its own window, and from now on you will find it in ${HOME}. You can close this tab.`;
  if (isPhone) {
    $("lead-where").textContent = "device";
    $("feat-offline").textContent = "Once installed it opens from your home screen like any other app, with or without an internet connection.";
    $("step-install").textContent = isIOS
      ? "Tap the Share button, then “Add to Home Screen”."
      : "Press the button above. The app is added to your home screen.";
  }
  if (isIOS) {
    // there is no one-tap install on iOS: show the steps straight away
    $("install-label").textContent = "How to install";
    $("install-note").textContent = "On iPhone and iPad you add the app from the Share menu";
    showHelp(false);
  }
  installBtn.addEventListener("click", install);
  headerInstall.addEventListener("click", install);
  $("use-in-browser").addEventListener("click", () => showApp(true));
  matchMedia("(display-mode: standalone)").addEventListener("change", (e) => e.matches && showApp(true));

  // --- automatic updates ---
  // A new deploy ships a new service worker. We look for one on launch, whenever the
  // window comes back into view and every 30 minutes. When it has taken over we
  // switch to the new version straight away, unless there is work on screen: then
  // we ask first, so nothing is lost.
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    const sw = navigator.serviceWorker;
    let controlled = !!sw.controller;
    let reloading = false;
    const applyUpdate = () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    };
    const working = () => busy || !!currentImage || !!bookPages || !!result.value;
    sw.addEventListener("controllerchange", () => {
      if (!controlled) {
        controlled = true; // first install on this device, nothing to update
        return;
      }
      if (!working()) return applyUpdate();
      $("update-text").textContent = "A new version of OCR Magic is ready";
      $("update-btn").onclick = applyUpdate;
      $("update-dismiss").onclick = () => ($("update-banner").hidden = true);
      $("update-banner").hidden = false;
    });

    sw.register(`${BASE}sw.js`)
      .then((reg) => {
        let last = Date.now();
        const look = () => {
          if (Date.now() - last < 60_000) return;
          last = Date.now();
          reg.update().catch(() => {});
        };
        setInterval(look, 30 * 60_000);
        window.addEventListener("focus", look);
        document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && look());
        return sw.ready;
      })
      // warm the cache so the installed app can read English text offline right away
      .then((reg) => reg.active?.postMessage({ type: "warm" }))
      .catch((e) => console.warn("offline support unavailable", e));
  }
}

// --- version & auto update ---
getVersion()
  .then((v) => ($("app-version").textContent = `v${v}`))
  .catch(() => ($("app-version").textContent = __BUILD__.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2}).*/, "$1.$2.$3 $4:$5")));

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
