/* ==========================================================================
   Fidelior – app.js  (FINAL • 2025-10-21 r20)
   Fixes & polish:
   • Status-Pills (tri-state): Betreff aus defaults.invoice.Fidelior.subjectByStatus,
     Empfänger aus defaults.invoice.Fidelior.toByStatus; perObject-Empfänger bleiben,
     keine Duplikate, Abwahl erlaubt → manueller Betreff.
   • Dateiname live & korrekt; ARNDT & CIE exakt so im Dateinamen; keine „·“-DisplayNames
     in Pfadberechnung (Scopevisio nutzt scopevisioName, pCloud nutzt pcloudName).
   • Subfolder-Dropdown wieder da (auch für Nicht-Rechnung); B75-Spezialordner sichtbar.
   • PDF.js workerSrc gesetzt (keine Deprecation-Warnung).
   • Inbox→Bearbeitet: stabil, löscht Ursprungsdatei aus Inbox (wenn möglich).
   • Vollständiges Reset auch für Dateiname & Zielvorschau.
   • Dialoge (E-Mails / Objekte / Typen / Zuordnung) reaktiviert; aus Dialogen wird
     auf Wunsch die Config-Verbindung hergestellt (falls nicht verbunden).
   • Keine stillen Ordner-Neuanlagen – immer Confirm.
   ========================================================================== */

(() => {
/* ------------------------------- Helpers -------------------------------- */
const $  = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));
// ---- Config-Handle vereinheitlichen ----
function syncConfigHandle(from){
  // Nimm das erste, was gesetzt ist
  const cfg = from
    || configDirHandle
    || window.configDirHandle
    || window.pcloudConfigDir
    || null;

  if (!cfg) return null;

  configDirHandle        = cfg;
  window.configDirHandle = cfg;
  window.pcloudConfigDir = cfg;

  return cfg;
}


/* NEU (Schritt 1): Checkbox-Flag-Helfer – liest NEUE oder ALTE IDs */
function flag(newId, oldId){
  const a = document.getElementById(newId);
  const b = document.getElementById(oldId);
  return !!(a?.checked || b?.checked);
}

const pad2 = n => (n<10?"0":"")+n;
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

// pCloud Sammelordner (unterhalb des verbundenen pCloud-Roots)
const PCL_COLLECT_FOLDER = "DMS BACKUP PCLOUD";

// ganz oben bei den Helpers
const isPcloudBucketChecked = () =>
  ($("#chkPcloudBucket")?.checked || $("#chkPcloudCollect")?.checked) === true;

// Entfernt evtl. Chrome-Swap-Dateien wie "Datei.pdf.crswap"
async function tryRemoveCrSwap(dirHandle, baseName){
  if (!dirHandle || !baseName) return;
  try { await dirHandle.removeEntry(baseName + ".crswap"); } catch {}
  try {
    // zur Sicherheit: alle *.crswap im Ordner mit gleichem Stem löschen
    const stem = String(baseName).replace(/\.[^.]+$/, "");
    for await (const e of dirHandle.values()){
      if (e.kind !== "file") continue;
      if (!/\.crswap$/i.test(e.name)) continue;
      if (e.name.toLowerCase().startsWith(stem.toLowerCase()))
        await dirHandle.removeEntry(e.name).catch(()=>{});
    }
  } catch {}
}


  // Erkennt: stammt die geladene Datei faktisch aus dem Inbox-ROOT?
async function tryBindInboxContextForFileByName(file) {
  const inboxRoot = window.inboxRootHandle || inboxRootHandle;
  if (!inboxRoot || !file?.name) return false;
  try {
    const h  = await inboxRoot.getFileHandle(file.name, { create: false });
    const f2 = await h.getFile();
    // Simple, robuste Heuristik: gleicher Name + gleiche Größe -> wir sind im Inbox-Root
    if (f2 && f2.size && f2.size === file.size) {
      currentInboxFileHandle = h;
      currentInboxFileName   = file.name;
      currentInboxRelPath    = [file.name]; // Root-Fall
      return true;
    }
  } catch {}
  return false;
}

  function toast(html, ms=4500){
    let host=$("#toastHost");
    if(!host){ host=document.createElement("div"); host.id="toastHost"; host.className="toast-host"; document.body.appendChild(host); }
    const box=document.createElement("div"); box.className="toast"; box.innerHTML=html;
    host.appendChild(box);
    setTimeout(()=>{ try{box.remove();}catch{} }, ms);
  }
  function setStatus(t){ const el=$("#uploadStatus"); if(el) el.textContent=t||""; }

  const today = ()=>{ const d=new Date(); return `${pad2(d.getDate())}.${pad2(d.getMonth()+1)}.${d.getFullYear()}`; };
  const dispToIso = (s)=>{ const m=String(s||"").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); return m?`${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`:""; };
  const isoToDisp = (s)=>{ const m=String(s||"").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?`${m[3]}.${m[2]}.${m[1]}`:""; };

// Erzwingt die Schreibberechtigungs-Abfrage (aus einem User-Gesture aufrufen)
async function ensureWritePermissionWithPrompt(dirHandle, label = "Ordner") {
  if (!dirHandle?.requestPermission) return true; // Browser ohne FS-API o.ä.

  try {
    let st = await dirHandle.queryPermission({ mode: "readwrite" });
    if (st === "granted") return true;

    // Nur innerhalb eines Klicks/Tastendrucks zeigt der Browser zuverlässig den Prompt
    st = await dirHandle.requestPermission({ mode: "readwrite" });

    if (st !== "granted") {
      toast(`${label}: Schreibberechtigung abgelehnt.`, 3500);
      return false;
    }
    toast(`${label}: Schreibberechtigung erteilt.`, 1500);
    return true;
  } catch (e) {
    toast(`${label}: Permission-Check fehlgeschlagen: ${e?.message || e}`, 4000);
    return false;
  }
}
// --- UI-Refresh-Helfer: Inbox-Eintrag sofort entfernen + Liste/Zähler neu zeichnen ---
function __fdlCssEsc(s = "") {
  return String(s).replace(/(["'\\])/g, "\\$1");
}

/** Entfernt den sichtbaren Inbox-Listeneintrag anhand des Dateinamens. */
function __fdlRemoveInboxListItemByName(name) {
  if (!name) return;
  // Dein Markup: <button class="linklike" data-file="NAME.pdf">…</button>
  const btn = document.querySelector(`button.linklike[data-file="${__fdlCssEsc(name)}"]`);
  const li  = btn?.closest("li");
  if (li) li.remove();
}



// ===== Persistenz für Directory-Handles (IndexedDB) =====
const FDL_IDB_DB = "fdl-handles-v1";
const FDL_IDB_STORE = "handles";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FDL_IDB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FDL_IDB_STORE)) {
        db.createObjectStore(FDL_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  await new Promise((res, rej) => {
    const tx = db.transaction(FDL_IDB_STORE, "readwrite");
    tx.objectStore(FDL_IDB_STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}
async function idbGet(key) {
  const db = await idbOpen();
  const val = await new Promise((res, rej) => {
    const tx = db.transaction(FDL_IDB_STORE, "readonly");
    const req = tx.objectStore(FDL_IDB_STORE).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return val;

async function idbDel(key) {
  const db = await idbOpen();
  await new Promise((res, rej) => {
    const tx = db.transaction(FDL_IDB_STORE, "readwrite");
    tx.objectStore(FDL_IDB_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}
}


// ===== Ziel-Overrides (Fixe Ziele können optional auf einen frei gewählten Ordner umgebogen werden) =====
// Technisch nutzen wir denselben Handle-Speicher wie bei Custom-Zielen: IndexedDB-Key "customTarget:<checkboxId>".
// Für fixe Ziele interpretieren wir diesen Handle als OVERRIDE des Standardpfads.
const FDL_FIXED_TARGET_IDS = ["chkScopevisio","chkScope","chkScopeBk","chkPcloudExtra","chkPcloudExtras","chkPcloudBackup","chkLocalSave","chkLocal"];

window.__fdlOverrideHandles = window.__fdlOverrideHandles || {};

// lädt Override-Handles einmal (und kann später erneut aufgerufen werden)
async function refreshOverrideCache(){
  const out = {};
  for (const id of FDL_FIXED_TARGET_IDS){
    try { out[id] = await idbGet("customTarget:" + id); }
    catch { out[id] = null; }
  }
  window.__fdlOverrideHandles = out;
  return out;
}

function getOverrideHandleSync(id){
  try { return (window.__fdlOverrideHandles && window.__fdlOverrideHandles[id]) || null; }
  catch { return null; }
}

// initial (non-blocking)
try { setTimeout(() => { refreshOverrideCache().catch(()=>{}); }, 0); } catch {}

// Speichern der verbundenen Handles
async function saveBoundHandles() {
  try {
    await idbSet("scopeRootHandle",     scopeRootHandle     || null);
    await idbSet("inboxRootHandle",     inboxRootHandle     || null);
    await idbSet("processedRootHandle", processedRootHandle || null);
    // optional mitpersistieren:
    await idbSet("pcloudRootHandle",    pcloudRootHandle    || null);
    await idbSet("configDirHandle",     configDirHandle     || null);
  } catch (e) {
    console.warn("saveBoundHandles failed:", e);
  }
}

// Wiederherstellen (beim Boot)
async function restoreBoundHandles() {
  try {
    const s = await idbGet("scopeRootHandle");
    const i = await idbGet("inboxRootHandle");
    const b = await idbGet("processedRootHandle");
    const p = await idbGet("pcloudRootHandle");
    const c = await idbGet("configDirHandle");

    // WICHTIG: immer beide setzen – lokal und window.*
    if (s) { scopeRootHandle     = s; window.scopeRootHandle     = s; }
    if (i) { inboxRootHandle     = i; window.inboxRootHandle     = i; }
    if (b) { processedRootHandle = b; window.processedRootHandle = b; }
    if (p) { pcloudRootHandle    = p; window.pcloudRootHandle    = p; }
    if (c) { syncConfigHandle(c); }

    // Permissions prüfen (ohne Popup)
    const check = async (h) => {
      if (!h?.queryPermission) return !!h;
      try {
        const st = await h.queryPermission({ mode: "readwrite" });
        return st === "granted" || st === "prompt";
      } catch { return false; }
    };

    const okScope = await check(scopeRootHandle);
    const okInbox = await check(inboxRootHandle);
    const okBearb = await check(processedRootHandle);

    // Guard: Bearbeitet darf nicht innerhalb der Inbox liegen
    if (okInbox && okBearb && inboxRootHandle && processedRootHandle) {
      try { await assertProcessedNotInsideInbox(inboxRootHandle, processedRootHandle); }
      catch { processedRootHandle = null; window.processedRootHandle = null; }
    }

    paintChips();
    if (okInbox) await refreshInbox();

  } catch (e) {
    console.warn("restoreBoundHandles failed:", e);
  }
      // sicherheitshalber Config aus allen Quellen zusammenziehen
    syncConfigHandle();

}
// --- Root-Verbindungen direkt herstellen (mit echtem System-Picker) ---
// --- PICKER & BINDING: pCloud ---
// ---------- Hilfsfunktion: Picker sicher mit User-Geste starten ----------
async function pickDirectoryWithUserGesture() {
  // Wenn noch eine User-Aktivierung da ist, direkt versuchen
  if (navigator.userActivation?.isActive) {
    return await window.showDirectoryPicker({ mode: "readwrite" });
  }

  // Sonst: Einmaliger, unsichtbarer Trampolin-Button
  return new Promise((resolve, reject) => {
    const cover = document.createElement("button");
    Object.assign(cover.style, {
      position: "fixed", inset: "0", opacity: "0", zIndex: "2147483647",
      border: "0", padding: "0", margin: "0", background: "transparent", cursor: "default"
    });
    cover.setAttribute("aria-hidden", "true");
    cover.addEventListener("pointerdown", async (e) => {
      e.preventDefault();
      try {
        const dir = await window.showDirectoryPicker({ mode: "readwrite" });
        resolve(dir);
      } catch (err) {
        reject(err);
      } finally {
        try { cover.remove(); } catch {}
      }
    }, { once: true });

    document.body.appendChild(cover);
    // Optionaler Hinweis für den Nutzer:
    toast("Bitte einmal klicken, um den Ordner auszuwählen…", 2000);
  });
}

// ---------- pCloud verbinden (robust) ----------
async function bindPcloudInteractive(){
  // schon verbunden?
  if (window.pcloudRootHandle || pcloudRootHandle) return true;

  try {
    if (!("showDirectoryPicker" in window)) {
      alert("Dieser Browser unterstützt keinen Ordner-Picker.");
      return false;
    }

    // Ordner auswählen – muss in echter User-Geste aufgerufen sein
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });

    // Schreibrecht erzwingen
    if (dir.requestPermission) {
      const st = await dir.requestPermission({ mode: "readwrite" });
      if (st !== "granted") {
        alert("Zugriff auf pCloud-Ordner wurde nicht gewährt.");
        return false;
      }
    }

    // WICHTIG: beide Variablen setzen!
    window.pcloudRootHandle = pcloudRootHandle = dir;

    // persistieren
    try { await idbSet("pcloudRootHandle", dir); } catch {}

    // UI refresh (best effort)
    try { paintConnectionsCompact(); } catch {}
    try { renderTargetSummary(); } catch {}
    try { refreshPreview(); } catch {}

    toast("<strong>pCloud verbunden</strong>", 1500);
    return true;
  } catch (e) {
    console.warn("bindPcloudInteractive failed:", e?.name, e?.message, e);
    alert("pCloud konnte nicht verbunden werden.");
    return false;
  }
}
// global verfügbar machen
window.bindPcloudInteractive = bindPcloudInteractive;


// ---------- Scopevisio verbinden (robust) ----------
async function bindScopeInteractive(){
  // schon verbunden?
  if (window.scopeRootHandle || scopeRootHandle) return true;

  try {
    if (!("showDirectoryPicker" in window)) {
      alert("Dieser Browser unterstützt keinen Ordner-Picker.");
      return false;
    }

    // Ordner auswählen – muss in echter User-Geste aufgerufen sein
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });

    // Schreibrecht erzwingen
    if (dir.requestPermission) {
      const st = await dir.requestPermission({ mode: "readwrite" });
      if (st !== "granted") {
        alert("Zugriff auf Scopevisio-Ordner wurde nicht gewährt.");
        return false;
      }
    }

    // WICHTIG: beide Variablen setzen!
    window.scopeRootHandle = scopeRootHandle = dir;

    // persistieren
    try { await idbSet("scopeRootHandle", dir); } catch {}

    // UI refresh (best effort)
    try { paintConnectionsCompact(); } catch {}
    try { renderTargetSummary(); } catch {}
    try { refreshPreview(); } catch {}

    toast("<strong>Scopevisio verbunden</strong>", 1500);
    return true;
  } catch (e) {
    console.warn("bindScopeInteractive failed:", e?.name, e?.message, e);
    alert("Scopevisio konnte nicht verbunden werden.");
    return false;
  }
}
// global verfügbar machen
window.bindScopeInteractive = bindScopeInteractive;


  /* ------------------------------ Globals --------------------------------- */
  let zoomToken = 0, zoomDebounce = null;
  let pdfDoc=null, zoom=1.10, renderTasks=[], lastFile=null, lastBlobUrl=null;
  let saveArrayBuffer=null, previewArrayBuffer=null;

  // Directory handles (user-chosen roots)
  let scopeRootHandle=null, pcloudRootHandle=null, configDirHandle=null, inboxRootHandle=null, processedRootHandle=null;

  // Inbox context
let currentInboxFileHandle=null, currentInboxFileName="";
let currentInboxRelPath=null; // NEU: Pfadsegmente relativ zur Inbox (für korrektes Löschen)


// Configs
let objectsCfg=null, docTypesCfg=null, emailsCfg=null, assignmentsCfg=null, stampCfg=null;


  // UI Refs
  const amountEl=$("#amountInput"), senderEl=$("#senderInput");
  const recvDateEl=$("#receivedDate"), invDateEl=$("#invoiceDate"), invNoEl=$("#invoiceNo");
  const typeSel=$("#docTypeSelect"), objSel=$("#objectSelect");
  const subRow=$("#subfolderRow"), subSel=$("#genericSubfolder");
  const fileNamePrev=$("#fileNamePreview"), targetPrev=$("#targetPreview");
  const amountLabel = document.querySelector("label[for='amountInput']");
  const amountStar  = document.getElementById("amountRequiredStar");

  function updateAmountRequiredUI() {
    const isInv = (typeof isInvoice === "function") ? isInvoice() : false;

    if (amountEl) {
      // Pflichtflag
      amountEl.required = isInv;

      // aktueller Inhalt (raw bevorzugen, falls vorhanden)
      const current = (amountEl.dataset.raw !== undefined
        ? amountEl.dataset.raw
        : amountEl.value || ""
      ).trim();

      const isEmpty = current === "";

      // Rot nur: Rechnung + leer
      amountEl.classList.toggle("input--error", isInv && isEmpty);
    }

    if (amountStar) {
      // Sternchen nur bei Rechnung
      amountStar.style.display = isInv ? "inline" : "none";
    }
  }


// Manuelle Eingaben merken (überschreibt Auto-Erkennung) + Preview sofort aktualisieren
invNoEl?.addEventListener("input", ()=>{
  invNoEl.dataset.userTyped = "1";
  invNoEl.classList.remove("auto");
  refreshPreview();                 // <<< sofort Dateiname/Ziel neu berechnen
});
invNoEl?.addEventListener("change", ()=>{ refreshPreview(); }); // Fallback für Autofill/Paste

senderEl?.addEventListener("input", ()=>{
  senderEl.dataset.userTyped = "1";
  refreshPreview();                 // <<< sofort aktualisieren
});


// --- Helper: Button klicken, auf Handle warten, UI refreshen ---
function __on(id){ return document.getElementById(id)?.checked === true; }

// ALT-Logik deaktiviert – neue Logik läuft über preflightTargets()
async function ensureTargetsReady(){
  return true;
}
/* ===================== Ctrl+Enter: Markieren → Übernehmen + OCR ===================== */

/*
  Verhalten:
  - Wenn Text markiert ist: Ctrl+Enter übernimmt wie bisher (Normalizer pro Feld)
  - Wenn NICHTS markiert ist: Ctrl+Enter startet OCR-Auswahl (Rechteck ziehen)
*/

let __fdlActiveField = "invoiceNo";

/* --- OCR State --- */
let __fdlOcrMode = false;
let __fdlOcrStart = null;
let __fdlOcrOverlay = null;
let __fdlOcrBoxEl = null;

/* Fokus merkt sich das Ziel-Feld */
[
  ["invoiceNo",    invNoEl],
  ["amountInput",  amountEl],
  ["invoiceDate",  invDateEl],
  ["receivedDate", recvDateEl],
  ["senderInput",  senderEl],      // <- WICHTIG: Absender unterstützen
].forEach(([id, el]) => {
  el?.addEventListener("focus", () => { __fdlActiveField = id; });
});

/* Normalizer je Feld */
function __fdlNormalizeForField(fieldId, raw){
  let t = String(raw || "").trim();
  if (!t) return "";

  if (fieldId === "amountInput"){
    const m = t.match(/-?\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|-?\d+(?:,\d{2})/);
    const hit = (m ? m[0] : t);
    return formatAmountDisplay(hit);
  }

  if (fieldId === "invoiceDate" || fieldId === "receivedDate"){
    const dmy = t.match(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})\b/);
    if (dmy){
      const dd = String(+dmy[1]).padStart(2,"0");
      const mm = String(+dmy[2]).padStart(2,"0");
      const yy = dmy[3].length === 2 ? ("20" + dmy[3]) : dmy[3];
      return `${dd}.${mm}.${yy}`;
    }
    const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
    return t;
  }

  if (fieldId === "invoiceNo"){
    t = t.replace(/\b(Rechnungs?(nummer|nr|no)\.?|Invoice\s*(No|Nr|Number)?|RG-?Nr\.?|RN\.?)\b\s*[:#-]?\s*/i, "");
    if (t.length > 40) t = t.slice(0, 40).trim();
    return t;
  }

  if (fieldId === "senderInput"){
    // Absender: harte Zeilenumbrüche glätten, nicht zu lang
    t = t.replace(/\s+/g, " ").trim();
    if (t.length > 60) t = t.slice(0, 60).trim();
    return t;
  }

  return t;
}

function __fdlApplyToField(fieldId, value){
  if (!value) return false;

  if (fieldId === "invoiceNo" && invNoEl){
    invNoEl.value = value;
    invNoEl.dataset.userTyped = "1";
    invNoEl.classList.remove("auto");
    refreshPreview();
    return true;
  }

  if (fieldId === "amountInput" && amountEl){
    amountEl.value = value;
    amountEl.dataset.raw = value;
    amountEl.dataset.userTyped = "1";
    amountEl.classList.remove("auto");
    if (typeof updateAmountRequiredUI === "function") updateAmountRequiredUI();
    refreshPreview();
    return true;
  }

  if (fieldId === "invoiceDate" && invDateEl){
    invDateEl.value = value;
    invDateEl.dataset.userTyped = "1";
    invDateEl.classList.remove("auto");
    refreshPreview();
    return true;
  }

  if (fieldId === "receivedDate" && recvDateEl){
    recvDateEl.value = value;
    recvDateEl.dataset.userTyped = "1";
    recvDateEl.classList.remove("auto");
    refreshPreview();
    return true;
  }

  if (fieldId === "senderInput" && senderEl){
    senderEl.value = value;
    senderEl.dataset.userTyped = "1";
    senderEl.classList.remove("auto");
    refreshPreview();
    return true;
  }

  return false;
}

function __fdlTakeSelectionIntoActiveField(){
  const sel = window.getSelection?.();
  const raw = sel ? sel.toString() : "";
  const cleaned = __fdlNormalizeForField(__fdlActiveField, raw);

  if (!cleaned){
    toast("Kein Text markiert.", 2000);
    return false;
  }

  const ok = __fdlApplyToField(__fdlActiveField, cleaned);
  if (ok) toast("Übernommen ✓", 1200);
  else toast("Konnte nicht übernehmen (kein Feld aktiv).", 2200);
  return ok;
}

/* ===== OCR Auswahl ===== */

function __fdlGetFirstPageCanvas(){
  // Wir nehmen bewusst die erste Seite (dein RenderAll hängt pro Seite ein Canvas in .pdf-page)
  return document.querySelector("#pdfViewer .pdf-page canvas");
}

function __fdlCleanupOcrOverlay(){
  try { __fdlOcrOverlay?.remove(); } catch {}
  __fdlOcrOverlay = null;
  __fdlOcrBoxEl = null;
  __fdlOcrStart = null;
  __fdlOcrMode = false;
}

function startOcrSelection(){
  if (__fdlOcrMode) return;

  // Tesseract vorhanden?
  if (!window.Tesseract){
    toast("OCR nicht geladen (Tesseract fehlt).", 3000);
    return;
  }

  const viewer = document.getElementById("pdfViewer");
  const sc = document.getElementById("previewScroll") || viewer;
  if (!viewer || !sc){
    toast("Kein Preview gefunden.", 2500);
    return;
  }

  __fdlOcrMode = true;
  toast("OCR: Bereich ziehen…", 2000);

  // Overlay relativ zum Scroll-Container
  const host = sc;
  const hostRect = host.getBoundingClientRect();

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.left = hostRect.left + "px";
  overlay.style.top  = hostRect.top  + "px";
  overlay.style.width  = hostRect.width + "px";
  overlay.style.height = hostRect.height + "px";
  overlay.style.zIndex = "9999";
  overlay.style.cursor = "crosshair";
  overlay.style.background = "rgba(0,0,0,0.03)";

  const box = document.createElement("div");
  box.style.position = "absolute";
  box.style.border = "2px dashed #5B1B70";
  box.style.background = "rgba(91,27,112,0.06)";
  overlay.appendChild(box);

  document.body.appendChild(overlay);
  __fdlOcrOverlay = overlay;
  __fdlOcrBoxEl = box;

  overlay.addEventListener("mousedown", (e) => {
    __fdlOcrStart = { x: e.offsetX, y: e.offsetY };
    box.style.left = __fdlOcrStart.x + "px";
    box.style.top  = __fdlOcrStart.y + "px";
    box.style.width = "0px";
    box.style.height = "0px";
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!__fdlOcrStart) return;
    const x1 = __fdlOcrStart.x, y1 = __fdlOcrStart.y;
    const x2 = e.offsetX,        y2 = e.offsetY;

    const left = Math.min(x1, x2);
    const top  = Math.min(y1, y2);
    const w    = Math.abs(x2 - x1);
    const h    = Math.abs(y2 - y1);

    box.style.left = left + "px";
    box.style.top  = top  + "px";
    box.style.width  = w + "px";
    box.style.height = h + "px";
  });

  overlay.addEventListener("mouseup", async () => {
    const rect = box.getBoundingClientRect();
    __fdlCleanupOcrOverlay();
    await runOcrOnRect(rect);
  });

  // ESC bricht OCR ab
  const onEsc = (ev) => {
    if (ev.key === "Escape"){
      document.removeEventListener("keydown", onEsc, true);
      __fdlCleanupOcrOverlay();
      toast("OCR abgebrochen.", 1500);
    }
  };
  document.addEventListener("keydown", onEsc, true);
}

async function runOcrOnRect(rect){
  try {
    const canvas = __fdlGetFirstPageCanvas();
    if (!canvas) { toast("OCR: Kein Canvas gefunden.", 2500); return; }

    const cRect = canvas.getBoundingClientRect();

    // OCR-Rect (Screen) -> Canvas-Coords
    const scaleX = canvas.width  / cRect.width;
    const scaleY = canvas.height / cRect.height;

    const sx = Math.max(0, (rect.left - cRect.left) * scaleX);
    const sy = Math.max(0, (rect.top  - cRect.top)  * scaleY);
    const sw = Math.max(1, rect.width  * scaleX);
    const sh = Math.max(1, rect.height * scaleY);

    const crop = document.createElement("canvas");
    crop.width  = Math.floor(sw);
    crop.height = Math.floor(sh);

    const ctx = crop.getContext("2d");
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);

    toast("OCR läuft…", 2500);

    const res = await Tesseract.recognize(crop, "deu+eng");
    const text = String(res?.data?.text || "").trim();

    if (!text){
      toast("OCR: kein Text erkannt.", 2500);
      return;
    }

    const cleaned = __fdlNormalizeForField(__fdlActiveField, text);
    __fdlApplyToField(__fdlActiveField, cleaned);
    toast("OCR übernommen ✓", 1500);

  } catch (e) {
    console.error(e);
    toast("OCR fehlgeschlagen.", 2500);
  }
}

/* Shortcut: Ctrl+Enter / Cmd+Enter
   - wenn Text markiert: übernehmen
   - sonst: OCR-Bereich starten
*/
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key !== "Enter") return;

  // In Inputs/Textareas nicht kaputt machen
  const t = (document.activeElement?.tagName || "").toLowerCase();
  if (["textarea"].includes(t)) return;

  e.preventDefault();

  const sel = window.getSelection?.();
  const raw = sel ? sel.toString().trim() : "";

  if (raw){
    __fdlTakeSelectionIntoActiveField();
  } else {
    startOcrSelection();
  }
});


/* ----------------------------- Mail State (clean) ------------------------- */
const Mail = {
  to: new Set(), cc: new Set(), bcc: new Set(),
  status: null,
  perObjectSubject: "", perObjectReply: "",
  baseTo: new Set(),
  recipientsTouched: false,
  subjectTouched:   false,
  replyTouched:     false,
  uiShowCc: false, uiShowBcc: false
};

/* ---------- helpers ---------- */
function normEmailToken(x){
  const t = String(x||"").trim();
  const m = t.match(/<([^>]+)>$/);
  if (m && EMAIL_RE.test(m[1])) return m[1];
  const hit = (emailsCfg?.addressBook||emailsCfg?.emails||[]).find(e=>e.id===t||e.label===t||e.name===t);
  return hit?.email || t;
}
function populateMailSelect(){ // nur Datalist
  const dl = $("#mailBook"); if(!dl) return;
  dl.innerHTML = "";
  (emailsCfg?.addressBook||emailsCfg?.emails||[]).forEach(e=>{
    const opt = document.createElement("option");
    opt.value = e.email;
    opt.label = e.label || e.name || e.id || "";
    dl.appendChild(opt);
  });
}
const isInvoice = ()=> {
  const opt=typeSel?.selectedOptions?.[0];
  return !!(opt && (opt.dataset.isInvoice==="true" || opt.getAttribute("data-isinvoice")==="true"));
};
const isFideliorInvoice = ()=> {
  const code=(objSel?.value||"").trim();
  return isInvoice() && (code==="FIDELIOR");
};
function updateStatusPillsVisibility(){
  const row=$("#mailStatusRow");
  if (row) row.style.display = isFideliorInvoice() ? "grid" : "none";

  // Rechnungsbetrag: Pflichtfeld nur bei Dokumentart "Rechnung"
  if (amountEl) {
    const isInv = (typeof isInvoice === "function") ? isInvoice() : false;
    amountEl.required = !!isInv;
    // visuelle Kennzeichnung (falls im CSS hinterlegt)
    amountEl.classList.toggle("required", !!isInv);
  }
}

function numToEuro(n){
  // 75.16 -> "75,16"
  return (isFinite(n) ? Number(n) : 0).toFixed(2).replace(".", ",");
}

/* ---------- subject/reply computation without hidden spans ---------- */
function computeSubjectAndReply(){
  const subj = $("#mailSubjectInput")?.value?.trim() || "";
  const rtIn = $("#mailReplyToInput")?.value?.trim() || "";
  let subject = subj, replyTo = rtIn;

  // Falls Nutzer nichts eingegeben hat, aus Vorlagen vorbelegen:
  if (!Mail.subjectTouched){
    if (Mail.status && isFideliorInvoice()){
      const map = emailsCfg?.defaults?.invoice?.Fidelior?.subjectByStatus || {};
      subject = map[Mail.status] || Mail.perObjectSubject || subj || "";
    } else {
      subject = Mail.perObjectSubject || subj || "";
    }
  }
  if (!Mail.replyTouched){
    if (!replyTo){
      if (Mail.status && isFideliorInvoice()){
        replyTo = (emailsCfg?.defaults?.invoice?.Fidelior?.replyToByStatus?.[Mail.status]) || Mail.perObjectReply || emailsCfg?.defaults?.replyTo || "documents@fidelior.de";
      } else {
        replyTo = Mail.perObjectReply || emailsCfg?.defaults?.replyTo || "documents@fidelior.de";
      }
    }
  }
  return { subject, replyTo };
}

function computeMailBody(){
  const code = (objSel?.value || "").trim();
  if (isInvoice()){
    const perInv = emailsCfg?.perObject?.[code]?.invoice;
    if (perInv?.body || perInv?.text) return perInv.body || perInv.text;
  }
  if (isFideliorInvoice()){
    return emailsCfg?.defaults?.invoice?.Fidelior?.body || "Automatischer Versand aus FIDELIOR DMS.";
  }
  return "Automatischer Versand aus FIDELIOR DMS.";
}

function applyPerObjectMailRules(){
  Mail.perObjectSubject=""; Mail.perObjectReply=""; Mail.baseTo = new Set();
  const code=(objSel?.value||"").trim(); if(!code || !isInvoice()) return;
  const per = emailsCfg?.perObject?.[code]?.invoice; if(!per) return;
  [].concat(per.emails||[]).concat(per.to||[]).map(normEmailToken).filter(a=>EMAIL_RE.test(a))
    .forEach(a=>{ Mail.to.add(a); Mail.baseTo.add(a); });
  if (per.subject) Mail.perObjectSubject = per.subject;
  if (per.replyTo) Mail.perObjectReply   = per.replyTo;
}

function renderMailChips(){
  const clear = sel => { const n=$(sel); if(n) n.innerHTML=""; };
  clear("#chipsTo"); clear("#chipsCc"); clear("#chipsBcc");

  const mk = (addr, rem) => {
    const s=document.createElement("span"); s.className="chip chip--mail"; s.textContent=addr;
    const x=document.createElement("button"); x.className="chip-x"; x.textContent="×"; x.title="Entfernen";
    x.onclick=()=>{ rem(addr); Mail.recipientsTouched=true; renderMailChips(); };
    s.appendChild(x); return s;
  };
  const wTo=$("#chipsTo"), wCc=$("#chipsCc"), wBcc=$("#chipsBcc");
  Mail.to.forEach(a=>wTo?.appendChild(mk(a,v=>Mail.to.delete(v))));
  Mail.cc.forEach(a=>wCc?.appendChild(mk(a,v=>Mail.cc.delete(v))));
  Mail.bcc.forEach(a=>wBcc?.appendChild(mk(a,v=>Mail.bcc.delete(v))));
}

function repaintMailMeta(){
  const { subject, replyTo } = computeSubjectAndReply();
  if (!Mail.subjectTouched) $("#mailSubjectInput") && ($("#mailSubjectInput").value = subject || "");
  if (!Mail.replyTouched)   $("#mailReplyToInput") && ($("#mailReplyToInput").value = replyTo || "");
  renderMailChips();
  updateStatusPillsVisibility();
}

function prefillMail(){
  repaintMailMeta();
  if (isFideliorInvoice() && !Mail.perObjectSubject){
    const def = emailsCfg?.defaults?.invoice?.Fidelior || {};
    const base=[].concat(def.to||[]).concat(def.emails||[]);
    base.map(normEmailToken).filter(a=>EMAIL_RE.test(a)).forEach(a=>{ Mail.to.add(a); Mail.baseTo.add(a); });
  }
  renderMailChips();
}

function applyStatusChange(){
  if (isFideliorInvoice()){
    const toMap = emailsCfg?.defaults?.invoice?.Fidelior?.toByStatus || {};
    const addrs = (Mail.status && toMap[Mail.status] ? toMap[Mail.status] : [])
      .map(normEmailToken).filter(a=>EMAIL_RE.test(a));
    if (!Mail.recipientsTouched){
      const next = new Set(Mail.baseTo); addrs.forEach(a=>next.add(a)); Mail.to = next;
    }
  }
  repaintMailMeta();
}

function updateCcBccVisibility(){
  const showCc  = (Mail.uiShowCc  || Mail.cc.size  > 0);
  const showBcc = (Mail.uiShowBcc || Mail.bcc.size > 0);
  const set = (id, on)=>{ const n=$(id); if(n) n.style.display = on ? "flex" : "none"; };
  set("#rowCc", showCc); set("#rowCcChips", showCc);
  set("#rowBcc", showBcc); set("#rowBccChips", showBcc);
  const lCc=$("#linkShowCc"), lBcc=$("#linkShowBcc");
  if(lCc) lCc.textContent = showCc ? "− CC" : "+ CC";
  if(lBcc) lBcc.textContent = showBcc ? "− BCC" : "+ BCC";
}

function attachMailUI(){
  populateMailSelect();

  // Eingaben → Chips
  const commitChip = (raw, set) => {
    const parts = String(raw||"").split(/[;, ]+/).map(normEmailToken).filter(s=>EMAIL_RE.test(s));
    parts.forEach(a=>set.add(a));
    if (parts.length){ Mail.recipientsTouched=true; renderMailChips(); }
  };

  $("#mailFree")?.addEventListener("keydown",(e)=>{
    if (e.key==="Enter" || e.key==="," || e.key===" "){
      e.preventDefault(); commitChip(e.target.value, Mail.to); e.target.value="";
    }
  });
  $("#mailFree")?.addEventListener("change",(e)=>{
    const v=(e.target.value||"").trim(); if(EMAIL_RE.test(v)){ Mail.to.add(v); Mail.recipientsTouched=true; renderMailChips(); e.target.value=""; }
  });
  $("#mailCc")?.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); commitChip(e.target.value, Mail.cc); e.target.value=""; }});
  $("#mailBcc")?.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); commitChip(e.target.value, Mail.bcc); e.target.value=""; }});

  $("#linkShowCc") ?.addEventListener("click",(e)=>{ e.preventDefault(); Mail.uiShowCc=!Mail.uiShowCc; updateCcBccVisibility(); if(Mail.uiShowCc) $("#mailCc")?.focus(); });
  $("#linkShowBcc")?.addEventListener("click",(e)=>{ e.preventDefault(); Mail.uiShowBcc=!Mail.uiShowBcc; updateCcBccVisibility(); if(Mail.uiShowBcc) $("#mailBcc")?.focus(); });

  // Subject / Reply-To „touched“
  $("#mailSubjectInput") ?.addEventListener("input", ()=>{ Mail.subjectTouched = true; });
  $("#mailReplyToInput") ?.addEventListener("input", ()=>{ Mail.replyTouched   = true; });

  // Status-Pills
  const o=$("#stOpen"), r=$("#stReview");
  const paint=()=>{ o?.closest(".pill")?.classList.toggle("is-checked", Mail.status==="open");
                    r?.closest(".pill")?.classList.toggle("is-checked", Mail.status==="review");
                    if(o) o.checked = (Mail.status==="open"); if(r) r.checked = (Mail.status==="review"); };
  const sync=()=>{ Mail.status = o?.checked ? "open" : (r?.checked ? "review" : null); paint(); applyStatusChange(); };
  o?.addEventListener("change", sync); r?.addEventListener("change", sync);
  o?.addEventListener("click",(e)=>{ if(Mail.status==="open" && o.checked){ e.preventDefault(); o.checked=false; Mail.status=null; paint(); repaintMailMeta(); }});
  r?.addEventListener("click",(e)=>{ if(Mail.status==="review" && r.checked){ e.preventDefault(); r.checked=false; Mail.status=null; paint(); repaintMailMeta(); }});

  paint(); updateCcBccVisibility(); repaintMailMeta();
}

  /* ----------------------------- Betrag/Inputs live ----------------------- */
  function formatAmountDisplay(raw){
  let r = String(raw ?? "").trim().replace(/−/g,"-");
  // Wenn nur Punkt vorhanden -> als Dezimalpunkt behandeln
  if (r.includes(".") && !r.includes(",")) r = r.replace(".", ",");
  // Wenn beides vorhanden -> Punkte als Tausender entfernen
  if (r.includes(",") && r.includes(".")) r = r.replace(/\./g, "");
  // Nur Ziffern, Komma, Minus behalten
  r = r.replace(/[^\d,-]/g,"");
  const parts = r.split(",");
  const euros = (parts[0]||"0").replace(/^0+(?=\d)/,"").replace(/\B(?=(\d{3})+(?!\d))/g,".");
  const cents = ((parts[1]||"")+"00").slice(0,2);
  return `${euros||"0"},${cents}`;
}

  if (amountEl) {
    const onAmountInput = (e) => {
      // rohen Text merken (auch wenn leer)
      amountEl.dataset.raw = e.target.value;
      updateAmountRequiredUI();   // Pflicht/Fehler direkt nachziehen
      refreshPreview();
    };

    amountEl.addEventListener("input", onAmountInput);
    amountEl.addEventListener("change", onAmountInput);

    amountEl.addEventListener("blur", () => {
      // beim Verlassen schön formatieren
      amountEl.value = formatAmountDisplay(
        amountEl.dataset.raw || amountEl.value || ""
      );
      updateAmountRequiredUI();   // nach dem Formatieren nochmal prüfen
      refreshPreview();
    });
  }


  
  recvDateEl?.addEventListener("input", ()=>{ refreshPreview(); });
  invDateEl?.addEventListener("input",  ()=>{ refreshPreview(); });

  /* ----------------------------- PDF Preview ------------------------------- */
  function cancelRenders(){ try{ renderTasks.forEach(t=>t.cancel?.()); }catch{} renderTasks=[]; }
  function fitCanvas(canvas, viewport){
    const dpr = window.devicePixelRatio || 1; const ratio = Math.min(3, dpr * 1.25);
    const pxW = Math.floor(viewport.width*ratio); const pxH = Math.floor(viewport.height*ratio);
    if (canvas.width!==pxW || canvas.height!==pxH){ canvas.width=pxW; canvas.height=pxH; canvas.style.width = Math.floor(viewport.width)+"px"; canvas.style.height= Math.floor(viewport.height)+"px"; }
    const ctx = canvas.getContext("2d", { alpha:false }); ctx.setTransform(ratio,0,0,ratio,0,0); ctx.imageSmoothingEnabled=false; return ctx;
  }
  function wmPreview(pageWrap, viewport, pageIndex){
    if (pageIndex !== 1) return;
    pageWrap.querySelectorAll(".wm-overlay").forEach(n=>n.remove());
    const code = (objSel?.value||"").trim() || "—";
    const txt = `${code} – EINGEGANGEN: ${recvDateEl?.value || today()}`;
    const el = document.createElement("div"); el.className="wm-overlay";
    Object.assign(el.style, { position:"absolute", top:"8px", left:"16px", transformOrigin:"left top", transform:"rotate(-90deg)", fontWeight:"800", color:"#E2001A", pointerEvents:"none" });
    el.style.fontSize = Math.max(10, Math.round((viewport?.width||600)*0.022)) + "px";
    el.textContent=txt; pageWrap.appendChild(el);
  }
async function renderAll(){
  const pdfViewer = $("#pdfViewer");
  if (!pdfViewer || !pdfDoc) return;

  const myToken = ++zoomToken;
  cancelRenders();

  const frag = document.createDocumentFragment();

  for (let i = 1; i <= pdfDoc.numPages; i++){
    if (myToken !== zoomToken) return;

    const page = await pdfDoc.getPage(i);
    if (myToken !== zoomToken) return;

    const viewport = page.getViewport({ scale: zoom });

    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.style.width = viewport.width + "px";
    wrap.style.position = "relative";

    // 1) Canvas (wie bisher)
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);

    const ctx  = fitCanvas(canvas, viewport);
    const task = page.render({ canvasContext: ctx, viewport });
    renderTasks.push(task);
    await task.promise;

    // 2) Text-Layer (NEU: damit Markieren möglich ist)
    try{
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      textLayer.style.width  = viewport.width + "px";
      textLayer.style.height = viewport.height + "px";
      wrap.appendChild(textLayer);

      const textContent = await page.getTextContent({ normalizeWhitespace:true, disableCombineTextItems:false });

      // pdf.js Render-Helper
      if (window.pdfjsLib?.renderTextLayer) {
        const tlTask = pdfjsLib.renderTextLayer({
          textContent,
          container: textLayer,
          viewport,
          textDivs: []
        });
        // je nach pdf.js-Version: promise oder dannable
        if (tlTask?.promise) await tlTask.promise;
        else if (tlTask?.then) await tlTask;
      }
    } catch (e){
      console.debug("textLayer failed (ok):", e);
    }

    // 3) Wasserzeichen wie bisher (bleibt sichtbar über allem)
    await new Promise(r => setTimeout(r, 0));
    wmPreview(wrap, viewport, i);

    frag.appendChild(wrap);
  }

  pdfViewer.replaceChildren(frag);
  $("#previewPlaceholder")?.setAttribute("style","display:none");
}


  /* ---------------------------- Upload & Zoom ------------------------------ */


// ==================================================================
// attachUpload (angepasst: <input> & Drag&Drop erkennen Inbox-Quelle)
// ==================================================================
function attachUpload(){
  const input  = $("#fileInput"),    // Fallback
        btnPick= $("#btnPick"),
        dz     = $("#dropZone");
  if (!input && !btnPick) return;

  // fromInbox=true: Handle NICHT löschen
  async function takeFile(f, { fromInbox = false } = {}){
    if (!f) return;

    const okType = (f.type === "application/pdf") || /\.pdf$/i.test(f.name);
    if (!okType){ setStatus("Nur PDF erlaubt."); return; }

    const mb = f.size/1024/1024;
    if (mb > 50){ setStatus(`Zu groß (${mb.toFixed(1)} MB)`); return; }

    if (!fromInbox){
      // nur löschen, wenn nicht aus Inbox gekommen
      currentInboxFileHandle = null;
      currentInboxFileName   = "";
      currentInboxRelPath    = null;
    }

    if (lastBlobUrl){ URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }
    lastFile = f;
    lastBlobUrl = URL.createObjectURL(f);

    setStatus(`Datei: ${f.name} (${mb.toFixed(2)} MB)`);
    saveArrayBuffer    = await f.arrayBuffer();
    previewArrayBuffer = saveArrayBuffer.slice(0);

    if (window.pdfjsLib?.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    pdfDoc = await pdfjsLib.getDocument({ data: previewArrayBuffer }).promise;

    $("#zoomLabel") && ($("#zoomLabel").textContent = `${Math.round(zoom*100)}%`);
    document.body.classList.add("has-preview");
    $("#previewPlaceholder")?.setAttribute("style","display:none");

    await renderAll();


    autoRecognize();
    $("#saveBtn")?.removeAttribute("disabled");
    toast("<strong>Datei geladen</strong>", 1500);
    refreshPreview();
  }

  // für refreshInbox() erreichbar machen
  window.__fdl_takeFile = takeFile;

  // Neuer, minimaler Picker-Handler (nur Inbox-ROOT prüfen + Debug-Ausgaben)
btnPick?.addEventListener("click", async () => {
  try {
    if (!window.showOpenFilePicker) {
      // Fallback auf <input type="file">
      input?.click();
      return;
    }

    // Inbox-Root: bevorzugt window.*, sonst alte Variable
    const inboxRoot = window.inboxRootHandle || inboxRootHandle || null;

    const picks = await window.showOpenFilePicker({
      startIn: inboxRoot || "documents",
      multiple: false,
      types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }]
    });
    if (!picks?.length) return;

    const pickedFileHandle = picks[0];
    const pickedFile = await pickedFileHandle.getFile();

    console.debug("[PICK] picked:", pickedFileHandle.name, pickedFile.size, "bytes");
    console.debug("[PICK] have inboxRoot:", !!inboxRoot, "name:", inboxRoot?.name || "(?)");

    // --- Nur Inbox-ROOT prüfen (kein Unterordner-Resolve) ---
    let isInInbox = false;
    let relPath = null;
    let inboxFileHandle = null;

    try {
      if (inboxRoot) {
        // Einmalig Schreibrecht anstoßen (innerhalb User-Gesture)
        await ensureWritePermissionWithPrompt(inboxRoot, "Inbox");

        // Gibt es im Inbox-ROOT eine Datei gleichen Namens?
        const h = await inboxRoot.getFileHandle(pickedFileHandle.name, { create: false });
        // Wenn ja → als Inbox-Datei behandeln
        isInInbox = true;
        relPath = [pickedFileHandle.name];
        inboxFileHandle = h;
      }
    } catch (e) {
      // nicht im Inbox-ROOT -> extern
      console.debug("[PICK] not in inbox root or no permission", e);
    }

    if (isInInbox) {
      // → sicher Inbox-Quelle
      currentInboxFileHandle = inboxFileHandle;
      currentInboxFileName   = pickedFileHandle.name;
      currentInboxRelPath    = relPath; // ["Datei.pdf"]

      await takeFile(pickedFile, { fromInbox: true });
      setStatus(`Datei: ${pickedFile.name} – Quelle: Inbox ✓`);
    } else {
      // → extern; kein Verschieben/Löschen später
      currentInboxFileHandle = null;
      currentInboxFileName   = "";
      currentInboxRelPath    = null;

      await takeFile(pickedFile, { fromInbox: false });
      setStatus(`Datei: ${pickedFile.name} – Quelle: extern (kein Verschieben)`);
      toast("Datei liegt nicht im verbundenen <strong>Inbox</strong>-Ordner – es wird nicht verschoben.", 2800);
    }
  } catch {
    /* abgebrochen */
  }
});


  // Fallback: klassischer <input type=file>  ⇐⇐⇐ ANGEPASST
  input?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fromInbox = await tryBindInboxContextForFileByName(f);
    await takeFile(f, { fromInbox });
    if (fromInbox) {
      setStatus(`Datei: ${f.name} – Quelle: Inbox ✓`);
    } else {
      setStatus(`Datei: ${f.name} – Quelle: extern (kein Verschieben)`);
    }
  });

  // Drag & Drop  ⇐⇐⇐ ANGEPASST
  if (dz){
    const over  = e => { e.preventDefault(); dz.classList.add("drag"); };
    const leave = e => { e.preventDefault(); dz.classList.remove("drag"); };
    ["dragenter","dragover"].forEach(ev => dz.addEventListener(ev, over));
    ["dragleave","drop"].forEach(ev => dz.addEventListener(ev, leave));

    dz.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = [...e.dataTransfer.files].find(x => x.type==="application/pdf" || /\.pdf$/i.test(x.name));
      if (!f) return;
      const fromInbox = await tryBindInboxContextForFileByName(f);
      await takeFile(f, { fromInbox });
      if (fromInbox) {
        setStatus(`Datei: ${f.name} – Quelle: Inbox ✓`);
      } else {
        setStatus(`Datei: ${f.name} – Quelle: extern (kein Verschieben)`);
      }
    });

    dz.addEventListener("keydown",(e)=>{ if (e.key==="Enter"||e.key===" "){ e.preventDefault(); btnPick?.click(); } });
  }
}

  function attachZoom(){
    const range=$("#zoomRange"), label=$("#zoomLabel");
    const setZ=(z)=>{ zoom = clamp(z, 0.5, 2.5); if(range) range.value = String(Math.round(zoom*100)); if(label) label.textContent = `${Math.round(zoom*100)}%`; const myToken = ++zoomToken; if (zoomDebounce) clearTimeout(zoomDebounce); zoomDebounce = setTimeout(() => { if (myToken === zoomToken) renderAll(); }, 120); };
    if(range) range.value = String(Math.round(zoom*100)); if(label) label.textContent = `${Math.round(zoom*100)}%`;
    range?.addEventListener("input", ()=> setZ(Number(range.value)/100));
    $("#zoomIn") ?.addEventListener("click", ()=> setZ(+(zoom+0.1).toFixed(2)));
    $("#zoomOut")?.addEventListener("click", ()=> setZ(+(zoom-0.1).toFixed(2)));
    document.addEventListener("keydown",(e)=>{ const t=(document.activeElement?.tagName||"").toLowerCase(); if(["input","select","textarea"].includes(t)) return; if(e.key==="+"||e.key==="="){ e.preventDefault(); setZ(+(zoom+0.1).toFixed(2)); } if(e.key==="-"){ e.preventDefault(); setZ(+(zoom-0.1).toFixed(2)); } if(e.key==="0"){ e.preventDefault(); setZ(1.10); } });
  }
  // Fallback: Event-Handler sicher binden
document.getElementById("openTabBtn")?.addEventListener("click", () => {
  // nutzt bestehende Funktionalität, wenn vorhanden
  if (typeof openPdfInNewTab === "function") return openPdfInNewTab();
  // generischer Fallback:
  if (lastBlobUrl) window.open(lastBlobUrl, "_blank", "noopener");
});

document.getElementById("printBtn")?.addEventListener("click", () => {
  try { window.print?.(); } catch {}
});

document.getElementById("downloadBtn")?.addEventListener("click", () => {
  if (!lastBlobUrl) return;
  const a = document.createElement("a");
  a.href = lastBlobUrl;
  a.download = (typeof effectiveFileName === "function" ? effectiveFileName() : "dokument.pdf");
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// === Helper: STRIKTE Rechnungsnummer-Erkennung (robust & konservativ) ===
function findInvoiceNumberStrict(rawText){
  if (!rawText) return "";

  // 1) Normalisieren (PDF-Artefakte entfernen)
  const text = String(rawText)
    .replace(/\u00A0/g, " ")                    // NBSP -> Space
    .replace(/[\u2010-\u2015\u2212]/g, "-")     // typogr. Bindestriche -> "-"
    .replace(/\s+/g, " ")
    .trim();

  // 2) Label-basierte Kandidaten (de/en)
  const labelRxs = [
    /\b(rechnungs?(nummer|nr|no)\.?|rechnung\s*#|rg-?nr\.?|rn\.?|beleg(nr|nummer))\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/gi,
    /\b(invoice\s*(no|nr|number)?|inv\.?\s*no\.?|bill\s*no\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,})/gi,
    // Muster: "Rechnungs-Nr. 5080235099" / "Rechnungsnummer 5080..."
  ];

  const candidates = [];

  for (const rx of labelRxs){
    let m;
    while ((m = rx.exec(text))){
      const token = m[m.length - 1]; // letzter capture
      candidates.push({ c: token, score: 5, why: "label" });
    }
  }

  // 3) Fallback: freie Tokens, die invoice-ähnlich aussehen
  //    (mind. 4 Zeichen, max 24, enthält mind. 1 Ziffer; erlaubt . _ / -)
  for (const m of text.matchAll(/\b(?!DE\d{9}\b)[A-Z0-9][A-Z0-9._/-]{3,23}\b/gi)){
    candidates.push({ c: m[0], score: 1, why: "generic" });
  }

  // 4) harte Negativ-Filter (weg damit)
  const BAD = {

    
maskedIbanLike: /^DE[\dxX*]{6,}$/i,
    

    // Daten
    date1: /^(\d{1,2}[.\-/]){2}\d{2,4}$/i,
    date2: /^(20\d{2}[.\-/]?\d{2}[.\-/]?\d{2})$/,     // 20251031 / 2025-10-31
    // USt-Id
    ustid: /^DE[\s-]?\d{9}$/i,
    // IBAN sehr grob
    iban: /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i,
    // Telefonnr. grob
    phone: /^\+?\d{2,3}[\s/-]?(?:\d{2,4}[\s/-]?){2,4}\d{2,}$/i,
    // PLZ
    zip: /^\d{5}$/,

    // Offenkundige Nicht-Rechnungs-IDs
    uuid: /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i,
    money: /(?:€|\bEUR\b)\s*\d/i,

    // Prefixe, die wir nicht wollen
    badPrefix: /^(KDNR|KUNDENNR|KUNDENNUMMER|KUNDE|CUSTOMER|ACCOUNT|AUFTRAG|BESTELL|ORDER|VERTRAG|CONTRACT|CLIENT|ACC)\b/i,
  };

  const clean = s => String(s||"")
    .trim()
    .replace(/^[#:.,\-\s]+/, "")
    .replace(/[,:.;]+$/, "");

  const invalid = s => {
    if (!s) return true;
    const x = s.toUpperCase();
    // invalid(x):
if (BAD.maskedIbanLike.test(x)) return true;
// NEU: mindestens 6 aufeinanderfolgende Ziffern erzwingen
if (!/\d{6,}/.test(x)) return true;

    // Länge & Zusammensetzung
    if (x.length < 4 || x.length > 24) return true;
    if (!/\d/.test(x)) return true;                 // muss mind. eine Ziffer haben

    // harte Muster
    if (BAD.date1.test(x) || BAD.date2.test(x)) return true;
    if (BAD.ustid.test(x)) return true;
    if (BAD.iban.test(x)) return true;
    if (BAD.phone.test(x)) return true;
    if (BAD.zip.test(x)) return true;
    if (BAD.uuid.test(x)) return true;
    if (BAD.money.test(x)) return true;
    if (BAD.badPrefix.test(x)) return true;

    // reine große Zahl mit 10–15 Stellen → eher Kunden-/Vertrags-/Telefonnummer
    if (/^\d{10,15}$/.test(x)) return true;

    return false;
  };

  // 5) Scoring & Auswahl
  const pool = [];
for (const k of candidates){
  const x = clean(k.c);
  if (invalid(x)) continue;

  let score = k.score;
  if (/[A-Z]/.test(x) && /\d/.test(x)) score += 2;
  if (x.length >= 6 && x.length <= 18) score += 1;
  if (/^(RE|RG|RN|INV|INVOICE)[\s._/-]?/i.test(x)) score += 2;

  pool.push({ c: x, score });
}


  if (!pool.length) return "";
  pool.sort((a,b) => b.score - a.score);
  return pool[0].c;
}

// — Text + Zeilen (mit x/y) extrahieren —
async function extractTextAndLinesFirstPages(pdf, maxPages = 3){
  const N = Math.min(maxPages, pdf.numPages);
  let allItems = [];
  for (let i = 1; i <= N; i++){
    const p = await pdf.getPage(i);
    const c = await p.getTextContent({ normalizeWhitespace:true, disableCombineTextItems:false });
    allItems = allItems.concat(c.items || []);
  }
  const rows = new Map();
  for (const it of allItems){
    const y = Math.round((it.transform?.[5] || 0));
    const x = (it.transform?.[4] || 0);
    const arr = rows.get(y) || [];
    arr.push({ x, str: it.str });
    rows.set(y, arr);
  }
  const lines = [...rows.entries()]
    .sort((a,b)=>b[0]-a[0])
    .map(([_, arr]) => {
      const sorted = arr.sort((a,b)=>a.x-b.x);
      return { text: sorted.map(t=>t.str).join(" "), parts: sorted };
    });
  const text = lines.map(l => l.text).join("\n");
  return { text, lines };
}

// — Betrag erkennen (Fälliger Betrag > Gesamt brutto) —
function detectTotalAmountFromLines(lines){
  if (!Array.isArray(lines) || !lines.length) return NaN;

 const PRI = [
  /Zu\s+zahlender\s+Betrag|Zahlungsbetrag|Fälliger Betrag|Zahlbetrag|Amount due|Total due/i,
  /Gesamtsumme\s+brutto|Grand total|Gesamtbetrag|Brutto\s+gesamt/i,
  /Gesamtsumme(?!.*netto)/i
];

  const IGN = /Zwischensumme|Subtotal|Netto\b|Rabatt|Discount|USt|MwSt|Steuer|Versand/i;

  const parseNum = (s) => {
    let x = (s||"").replace(/[ €\u00A0]/g,"").replace(/−/g,"-");
    if (/,/.test(x) && /\./.test(x)) x = x.replace(/\./g,"").replace(",",".");
    else if (/,/.test(x)) x = x.replace(",",".");
    const v = Number((x.match(/-?\d+(?:\.\d+)?/)||[""])[0]);
    return isFinite(v) ? v : NaN;
  };

  const rightMostAmount = (L) => {
    const nums = L.text.match(/-?\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\d+(?:\.\d{2})/g);
    if (!nums || !nums.length) return NaN;
    return parseNum(nums[nums.length-1]);
  };

  for (const rx of PRI){
    let best = null;
    for (let i=0;i<lines.length;i++){
      const L = lines[i];
      if (!rx.test(L.text)) continue;
      if (IGN.test(L.text)) continue;

      let v = rightMostAmount(L);
      if (!isFinite(v) || isNaN(v)){
        const N = lines[i+1];
        if (N && !IGN.test(N.text)) v = rightMostAmount(N);
      }
      if (isFinite(v) && !isNaN(v)){
        if (!best || v >= best.val) best = { val: v };
      }
    }
    if (best) return best.val;
  }
  return NaN;
}


function rightMostNumberToken(s){
  const nums = String(s||"").match(/\b\d{6,}\b/g); // mind. 6-stellig
  return nums ? nums[nums.length-1] : "";
}


function isMaskedIbanLike(tok){
  // fängt DE + Ziffern/X/* (auch maskiert) ab
  return /^DE[\dxX*]{6,}$/i.test(tok);
}

/** Holt die Rechnungsnummer aus den Zeilen:
 *  – sucht nach 'Rechnungsnummer' / 'Invoice number'
 *  – nimmt die rechteste 6+stellige Zahl derselben oder nächsten Zeile
 *  – ignoriert Kundennummer/Vertragsnummer/Maske 'DE…'
 */
function findInvoiceNumberFromLines(lines){
  if (!Array.isArray(lines)) return "";

  const LABEL = /(Rechnungs\s*nummer|Rechnungs-?Nr\.?|Invoice\s*(number|no\.?)?)/i;
  const BAN   = /(Kunden\s*nummer|Vertrags\s*nummer|Customer|Contract)/i;

  for (let i=0;i<lines.length;i++){
    const L = lines[i];
    if (!LABEL.test(L.text) || BAN.test(L.text)) continue;

    // gleiche Zeile: rechteste 6+stellige Zahl
    let tok = rightMostNumberToken(L.text);
    if (tok && tok.length >= 6) return tok;

    // sonst nächste Zeile (typisch bei tabellarischem Layout)
    const N = lines[i+1];
    if (N && !BAN.test(N.text)){
      tok = rightMostNumberToken(N.text);
      if (tok && tok.length >= 6) return tok;
    }
  }
  return "";
}

// Robust: bewertet Regeln gegen 3 Text-Varianten, mit Fallback auf .includes()
function evaluateAssignmentRules(rawText, cfg){
  if (!cfg || !Array.isArray(cfg.patterns)) return null;

  const T1 = String(rawText || "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const T2 = T1;
  const T3 = T2.replace(/[^\wäöüÄÖÜß\-/.#]+/g, " ");

  const variants = [T1, T2, T3];

  const normalizeList = (rule) => {
    if (Array.isArray(rule.patterns)) return rule.patterns;
    if (Array.isArray(rule.pattern))  return rule.pattern;
    if (typeof rule.pattern === "string" && rule.pattern.trim()) return [rule.pattern];
    return [];
  };

  let best = null;
  for (const rule of (cfg.patterns || [])){
    const pats = normalizeList(rule);
    if (!pats.length) continue;

    let matched = false, score = 0;

    for (const pat of pats){
      let rx = null, isRegex = false;
      try { rx = new RegExp(pat, "i"); isRegex = true; } catch {}

      for (const V of variants){
        if (isRegex ? rx.test(V) : V.toLowerCase().includes(String(pat||"").toLowerCase())){
          matched = true;
          score += isRegex ? 3 : 2;
          break;
        }
      }
    }
    if (!matched) continue;

    if (rule.object){
      try {
        const esc = rule.object.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
        if (new RegExp(`\\b${esc}\\b`, "i").test(T2)) score += 1;
      } catch {}
    }

    if (!best || score > best.score) best = { rule, score };
  }
  return best ? best.rule : null;
}


/* --------------------------- Auto-Erkennung ------------------------------ */
async function extractTextFirstPages(pdf, maxPages=3){
  const N=Math.min(maxPages, pdf.numPages);
  let out=[];
  for(let i=1;i<=N;i++){
    const p=await pdf.getPage(i);
    const c=await p.getTextContent({ normalizeWhitespace:true, disableCombineTextItems:false });
    out.push((c.items||[]).map(it=>it.str).join(" "));
  }
  return out.join("\n");
}
function euroToNum(s){
  let x=(s||"").replace(/[€\s]/g,"").replace(/−/g,"-");
  if(x.includes(",")&&x.includes(".")) x=x.replace(/\./g,"").replace(",",".");
  else if(x.includes(",")) x=x.replace(",",".");
  const v=Number(x); return isFinite(v)?v:NaN;
}


// ====== ERSATZ: autoRecognize (Block 2) ======
async function autoRecognize() {
  try {
    const { text: txt, lines } = await extractTextAndLinesFirstPages(pdfDoc, 3);


      /* Betrag – Priorität statt „größter Wert“ */
    const total = detectTotalAmountFromLines(lines);
    if (amountEl && !amountEl.dataset.userTyped) {
      if (isFinite(total) && !isNaN(total)) {
        const euro = numToEuro(total);
        amountEl.dataset.raw = euro;
        amountEl.value = euro;
        amountEl.classList.add("auto");
      } else {
        amountEl.dataset.raw = "";
        amountEl.value = "";
        amountEl.classList.remove("auto");
      }

      // Pflicht/Fehler-Style nachziehen
      if (typeof updateAmountRequiredUI === "function") {
        updateAmountRequiredUI();
      }
    }

 
   /* Datum (konservativ; nur plausibles jüngstes Datum ≤ heute, sonst leer) */
const MONTHS = { januar:1,februar:2,maerz:3,märz:3,april:4,mai:5,juni:6,juli:7,august:8,september:9,oktober:10,november:11,dezember:12 };
const isoFromDMY = (d,m,y)=>{ const yy=String(y).length===2?(+y<50?2000+ +y:1900+ +y):+y; return `${yy}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; };

const dateHits=[];
for (const m of txt.matchAll(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})\b/g)) {
  dateHits.push(isoFromDMY(+m[1],+m[2],m[3]));
}
for (const m of txt.matchAll(/\b(\d{1,2})\.\s*(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})\b/gi)){
  const mon = MONTHS[m[2].toLowerCase()]; if (mon) dateHits.push(isoFromDMY(+m[1],mon,m[3]));
}
const todayIso = new Date().toISOString().slice(0,10);
const uniq = Array.from(new Set(dateHits)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
const nonFuture = uniq.filter(d => d <= todayIso).sort();
if (invDateEl && !invDateEl.value.trim()) {
  if (nonFuture.length) {
    const picked = nonFuture[nonFuture.length - 1];
    invDateEl.value = isoToDisp(picked);
    invDateEl.classList.add('auto');
  } else {
    invDateEl.value = '';                      // nichts Plausibles → leer
    invDateEl.classList.remove('auto');
  }
}


 /* Rechnungsnummer (nur setzen, wenn plausibel; sonst leer lassen) */
/* Rechnungsnummer zuerst aus Zeilen lesen; Fallback: strikter Parser */
let autoInv = "";
if (lines && lines.length) autoInv = findInvoiceNumberFromLines(lines);
if (!autoInv) autoInv = findInvoiceNumberStrict(txt);

if (invNoEl && !invNoEl.dataset.userTyped) {
  if (autoInv && !isMaskedIbanLike(autoInv)) {
    invNoEl.value = autoInv;
    invNoEl.classList.add('auto');
  } else {
    invNoEl.value = "";
    invNoEl.classList.remove('auto');
  }
}


    /* 1) Dokumenttyp früh setzen → Unterordner können korrekt geladen werden */
    if (typeSel && typeSel.value !== "rechnung") {
      typeSel.value = "rechnung";
      toast('Dokumentenart gesetzt: <strong>Rechnung</strong>', 2000);
          updateAmountRequiredUI();   // <<< neu
    }

   /* 2) AUTO-ASSIGN: Objekt & (optional) Unterordner (robuste Scoring-Engine) */
let appliedMsg = null;
if (assignmentsCfg && Array.isArray(assignmentsCfg.patterns) && assignmentsCfg.patterns.length) {
  const hit = evaluateAssignmentRules(txt, assignmentsCfg);

  if (hit) {
    if (hit.object) {
      const before = objSel.value;
      objSel.value = String(hit.object);
      if (objSel.value !== before) {
        appliedMsg = `Zuordnung: <strong>${hit.object}</strong>`;
      }
    }

    if (typeof updateSubfolderOptions === "function") {
      await updateSubfolderOptions({ silent: !hit.subfolder });
    }

    if (hit.subfolder && subSel) {
      const wanted = String(hit.subfolder).trim();
      const has = Array.from(subSel.options).some(o => o.value === wanted);
      if (has) {
        subSel.value = wanted;
        if (subRow) subRow.style.display = "grid";
        appliedMsg = appliedMsg
          ? `${appliedMsg} · Unterordner: <strong>${wanted}</strong>`
          : `Unterordner: <strong>${wanted}</strong>`;
      } else {
        toast(`Hinweis: Unterordner „<code>${wanted}</code>“ ist für <strong>${hit.object}</strong> nicht bekannt.`, 3500);
      }
    }
  }
}


    /* Mail-Vorbelegung & Meta */
    applyPerObjectMailRules();
    prefillMail();
    updateStatusPillsVisibility();

    const found = [];
    if (amountEl.value)  found.push("Betrag");
    if (invDateEl.value) found.push("Rechnungsdatum");
    if (invNoEl?.value)  found.push("Rechnungsnr.");
    if (found.length)    toast(`<strong>Automatisch erkannt</strong><br>${found.join(" · ")}`, 2800);
    if (appliedMsg)      toast(appliedMsg, 2200);

    // am Ende UI aktualisieren
    refreshPreview();
  } catch (e) {
    console.warn("Auto-Erkennung fehlgeschlagen", e);
    toast("Auto-Erkennung fehlgeschlagen.", 2500);
  }
}


  /* ----------------------------- Name + Ziel ------------------------------- */
  function currentYear(){ const s = invDateEl?.value || recvDateEl?.value || today(); const iso = dispToIso(s); return iso ? +iso.slice(0,4) : (new Date()).getFullYear(); }

  // Editable file name inline
  let fileNameInput = null;
  function ensureEditableFileName(){
    if (!fileNameInput && fileNamePrev) {
      const inp = document.createElement("input"); inp.type = "text"; inp.className = "input slim"; inp.id = "fileNameInputInline"; inp.placeholder = "Dateiname.pdf"; fileNamePrev.replaceWith(inp); fileNameInput = inp; fileNameInput.dataset.mode = "auto"; // "auto" | "manual"
      inp.addEventListener("input", ()=>{ fileNameInput.dataset.mode = "manual"; refreshPreview(); });
      inp.addEventListener("blur", ()=>{ if (!inp.value.trim()){ fileNameInput.dataset.mode = "auto"; refreshPreview(); } });
    }
  }
  ensureEditableFileName();

function computeFileNameAuto() {
  // Eingaben einsammeln
  const betragRaw = (amountEl?.value || "").trim();           // z. B. "45,22"
  const absender  = (senderEl?.value || "").trim();
  const reNummer  = (invNoEl?.value || "").trim();            // RE-/Rechnungsnummer (roh)
  const objCode   = (objSel?.value  || "").trim();            // z. B. "EGYO" / "B75" ...
  const sub       = (subSel?.value  || "").trim();            // Unterordner (für B75-Sonderfall)

  // Objekt-/Liegenschafts-Part wie bisher (ARNDT & CIE fix, B75-D1/D4)
  let liegenschaft = (() => {
    const c = String(objCode).toUpperCase();
    if (c === "ARNDTCIE" || c === "ARNDT&CIE" || c === "ARNDT & CIE") return "ARNDT & CIE";
    return objCode;
  })();
  if (/^B75$/i.test(objCode) && /^(D1|D4)$/i.test(sub)) {
    liegenschaft = `B75-${sub.toUpperCase()}`;
  }

  // Datum in "JJJJ.MM.TT"
  const datum =
    (dispToIso(invDateEl?.value) || dispToIso(recvDateEl?.value) || "")
      .replace(/-/g, ".") || today().split(".").reverse().join(".");

  // Betrag nur bei Rechnung verwenden und nur wenn sinnvoll
  const includeAmount = isInvoice() && betragRaw && !/^0+(?:[.,]00)?$/.test(betragRaw);

  // RE-Teil: Nur numerische IDs bekommen "RE" davor; alphanumerische bleiben unverändert.
  let rePart = "";
  if (reNummer) {
    const id = reNummer.trim().toUpperCase();
    if (/^\d+$/.test(id)) {
      rePart = "RE " + id;          // z.B. "1244" -> "RE 1244"
    } else {
      rePart = id;                  // z.B. "RE1244", "RG-2025-0317", "W7-55321"
    }
  }

  // =======================
  // Rechnung:
  //   [Betrag]_[Liegenschaft]_[Absender]_[RE-Teil]_[JJJJ.MM.TT].pdf
  //
  // Nicht-Rechnung:
  //   [Liegenschaft]_[Absender]_[JJJJ.MM.TT].pdf
  // =======================
  const parts = [];

  if (isInvoice()) {
    if (includeAmount) parts.push(betragRaw);     // 1) Betrag
    if (liegenschaft)  parts.push(liegenschaft);  // 2) Liegenschaft
    if (absender)      parts.push(absender);      // 3) Absender
    if (rePart)        parts.push(rePart);        // 4) RE-Teil
    parts.push(datum);                            // 5) Datum (immer)
  } else {
    if (liegenschaft)  parts.push(liegenschaft);  // 1) Liegenschaft
    if (absender)      parts.push(absender);      // 2) Absender
    parts.push(datum);                            // 3) Datum (immer)
  }

  // Fallback falls alles leer
  const base = parts.filter(Boolean).join("_") || "dokument";
  return base + ".pdf";
}


  function effectiveFileName(){
    if (fileNameInput && fileNameInput.dataset.mode === "manual") {
      const v = fileNameInput.value.trim();
      return v ? (/\.(pdf)$/i.test(v) ? v : (v + ".pdf")) : computeFileNameAuto();
    }
    return computeFileNameAuto();
  }

  // Mapping helpers (use code→record; use scopevisioName/pcloudName, not displayName)
  function getObjectRecord(code){ const all = objectsCfg?.objects || []; return all.find(o => (o.code === code)) || {}; }
  function getFolderNames(code){ const rec = getObjectRecord(code); const scopeName  = rec.scopevisioName || rec.code || ""; const pcloudName = rec.pcloudName    || rec.code || ""; return { scopeName, pcloudName }; }
  function isArndtCie(code){ const c = String(code || "").toUpperCase(); return c === "ARNDTCIE" || c === "ARNDT&CIE" || c === "ARNDT & CIE"; }
  function getKnownSubfolders(code){ const rec = getObjectRecord(code); const set = new Set(); (rec.pcloudSubfolders||[]).forEach(s=>set.add(s)); (rec.specialSubfoldersScopevisio||[]).forEach(s=>set.add(s)); return Array.from(set); }

  async function listChildFolders(rootHandle, segments){ try{ if(!rootHandle || !segments?.length) return []; let dir = rootHandle; for (const s of segments){ if(!s) continue; dir = await dir.getDirectoryHandle(s, { create:false }); } const out = []; for await (const e of dir.values()){ if(e.kind === "directory") out.push(e.name); } return out; }catch{ return []; } }

async function updateSubfolderOptions({ silent = false } = {}) {
  if (!subRow || !subSel) return;

  const code    = (objSel?.value || "").trim();
  const invoice = isInvoice();
  const subLabel = subRow.querySelector("label");
  const subHint  = document.getElementById("subfolderHint");

  // Standard: ausblenden & leeren
  subRow.style.display = "none";
  subSel.innerHTML = "";
  if (subHint) subHint.style.display = "none";

  // PRAGMATIK: Für PRV/ohne Code nichts anzeigen
  if (!code || code === "PRIVAT") return;

  // ---- Sonderfall B75 (nur bei Rechnung, nur für Dateinamen) ----
  if (code === "B75" && invoice) {
    const prev = (subSel.value || "").trim();
    const opts = [
      { value: "",   label: "(kein Unterordner)" },
      { value: "D1", label: "D1" },
      { value: "D4", label: "D4" }
    ];

    subSel.innerHTML = opts
      .map(o => `<option value="${o.value}">${o.label}</option>`)
      .join("");

    if (opts.some(o => o.value === prev)) {
      subSel.value = prev;
    } else {
      subSel.value = "";
    }

    // Label + Erklärung für B75
    if (subLabel) subLabel.textContent = "Zusatz im Dateinamen";
    if (subHint) {
      subHint.innerHTML =
        'Diese Auswahl steuert nur den Dateinamen, z.&nbsp;B. <code>B75-D1-…</code>.' +
        ' Die Ablage erfolgt immer im Ordner „Rechnungsbelege“ der Liegenschaft B75.';
      subHint.style.display = "block";
    }

    if (!silent) subRow.style.display = "grid";
    return;
  }

  // ---- alle anderen Objekte: echter Unterordner ----
  if (subLabel) subLabel.textContent = "Unterordner";
  if (subHint) {
    subHint.textContent =
      "Hier kannst du einen Unterordner innerhalb der Liegenschaft auswählen. " +
      "Er beeinflusst Ablagepfad und Dateinamen.";
    subHint.style.display = "block";
  }

  // Sichtbarkeits-Flag statt mehrfacher DOM-Schalter
  let show = false;

  // ---- Spezialfall FIDELIOR (nur bei Nicht-Rechnung, pCloud-Verwaltung) ----
  if (code === "FIDELIOR") {
    const root = window.pcloudRootHandle || pcloudRootHandle;
    if (!invoice && root) {
      const base = ["FIDELIOR", "VERWALTUNG"];
      const raw  = await listChildFolders(root, base);

      const options = [...new Set(raw)]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "de", { sensitivity: "base", numeric: true }));

      if (options.length) {
        const prev = subSel.value; // Auswahl behalten, falls möglich
        subSel.innerHTML = options.map(v => `<option value="${v}">${v}</option>`).join("");
        subSel.value = options.includes(prev) ? prev : (options[0] || "");
        show = true;
      }
    }
    subRow.style.display = (!silent && show) ? "grid" : "none";
    return;
  }

  // ---- Allgemeiner Zweig (alle anderen Objekte) ----
  const { scopeName, pcloudName } = getFolderNames(code);
  const scopeBase = ["OBJEKTE", scopeName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];

  let pclBase = null;
  if (!isArndtCie(code)) {
    if (code === "A15" && invoice) {
      pclBase = ["FIDELIOR","OBJEKTE","A15 Ahrweiler Straße 15","Buchhaltung","Rechnungsbelege"];
    } else {
      pclBase = ["FIDELIOR","OBJEKTE", pcloudName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];
    }
  }

  const known = new Set(getKnownSubfolders(code));
  known.add(invoice ? "Rechnungsbelege" : "Objektdokumente");

  const lists = [];
  const scopeRoot  = window.scopeRootHandle  || scopeRootHandle;
  const pcloudRoot = window.pcloudRootHandle || pcloudRootHandle;
  // Overrides (fixe Ziele können optional auf freien Ordner zeigen)
  const ovScope   = getOverrideHandleSync("chkScopevisio");
  const ovScopeBk = getOverrideHandleSync("chkScopeBk");
  const ovPclEx   = getOverrideHandleSync("chkPcloudExtra");
  const ovPclBk   = getOverrideHandleSync("chkPcloudBackup");

  if (scopeRoot)             lists.push(listChildFolders(scopeRoot,  scopeBase));
  if (pcloudRoot && pclBase) lists.push(listChildFolders(pcloudRoot, pclBase));

  const foundLists = (await Promise.all(lists).catch(() => [[]])).flat();
  for (const n of foundLists) if (n) known.add(n);

  const options = [...known].filter(Boolean);

  if (!options.length) {
    if (!invoice) {
      subSel.innerHTML = `<option value="Objektdokumente">Objektdokumente</option>`;
      show = true;
    }
    subRow.style.display = (!silent && show) ? "grid" : "none";
    return;
  }

  subSel.innerHTML = options.map(v => `<option value="${v}">${v}</option>`).join("");
  subSel.value = invoice
    ? (options.includes("Rechnungsbelege") ? "Rechnungsbelege" : options[0])
    : (options.includes("Objektdokumente") ? "Objektdokumente" : options[0]);

  show = true;
  subRow.style.display = (!silent && show) ? "grid" : "none";
}

// ---- Zielordner-Übersicht (global) ----
// Zeigt nur, was wirklich aktiv & auflösbar ist. Nutzt resolveTargets() als einzige Wahrheit.
function renderTargetSummary(){
  const el = (typeof targetPrev !== "undefined" && targetPrev) ? targetPrev : document.querySelector("#targetPreview");
  if (!el) return;

  // aktuelle Ziele auflösen (nutzt deine Objekt-/Pfadregeln)
  const t = (typeof resolveTargets === "function") ? resolveTargets() : {};

  const lines = [];

  // Scopevisio → nur wenn Root existiert UND Segmente vorhanden
  if (t?.scope?.root && Array.isArray(t.scope.seg) && t.scope.seg.length){
    lines.push(`<strong>Scopevisio:</strong> ${t.scope.seg.join(" \\ ")}`);
  }

  // Scopevisio – Abrechnungsbelege (separate Zeile)
  if (t?.scopeBk?.root && Array.isArray(t.scopeBk.seg) && t.scopeBk.seg.length){
    lines.push(`<strong>Scopevisio – Abrechnungsbelege:</strong> ${t.scopeBk.seg.join(" \\ ")}`);
  }

  // pCloud Zusatzablage (strukturierter Objektpfad)
  if (t?.pcloud?.root && Array.isArray(t.pcloud.seg) && t.pcloud.seg.length){
    lines.push(`<strong>pCloud (Zusatzablage):</strong> ${t.pcloud.seg.join(" \\ ")}`);
  }

  // pCloud Sammelordner / Backup
  if (t?.pcloudBucket?.root && Array.isArray(t.pcloudBucket.seg) && t.pcloudBucket.seg.length){
    lines.push(`<strong>pCloud (Sammelordner):</strong> ${t.pcloudBucket.seg.join(" \\ ")}`);
  }

  // Lokal
  if (t?.local === true){
    lines.push(`<strong>Lokal:</strong> (wird beim Speichern abgefragt)`);
  }




// ===== Custom-Ziele (Zusatzordner) =====
try{
  // lokale Escape-Funktion (keine Abhängigkeit von escapeHtml)
  const esc = (s) => String(s ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");

  // fixe System-Checkboxen ausschließen (ID-Varianten)
  const fixedIds = new Set([
    "chkScopevisio","chkScope",
    "chkPcloudBackup",
    "chkScopeBk",
    "chkPcloudExtra","chkPcloudExtras",
    "chkLocalSave","chkLocal"
  ]);

  const customNames = Array.from(
    document.querySelectorAll('#saveTargets input[type="checkbox"]:checked')
  )
    .filter(cb => cb && cb.id && !fixedIds.has(cb.id))
    .map(cb => {
      const label = cb.closest("label")?.querySelector("span")?.textContent?.trim();
      return label || cb.dataset.label || cb.id;
    })
    .filter(Boolean);

  if (customNames.length){
    lines.push('<strong>Zusatzordner:</strong> ' + customNames.map(esc).join(", "));
  }
} catch(e){
  console.warn("Custom target summary failed:", e);
}



  // Wenn nichts anzeigbar ist → präzise Gründe (neue ODER alte Checkbox-IDs)
  if (!lines.length){
    const hints = [];
    if (flag("chkScopevisio","chkScope") && !window.scopeRootHandle){
      hints.push("Scopevisio (nicht verbunden)");
    }
    if (flag("chkPcloudExtra","chkPcloudExtras") && !window.pcloudRootHandle){
      hints.push("pCloud Zusatzablage (nicht verbunden)");
    }
    if (!!document.getElementById("chkPcloudBackup")?.checked && !window.pcloudRootHandle){
      hints.push("pCloud Sammelordner/Backup (nicht verbunden)");
    }
    if (flag("chkLocalSave","chkLocal")){
      hints.push("Lokal: (wird beim Speichern abgefragt)");
    }

    el.innerHTML = hints.length
      ? `Zielordner: <span class="muted">${hints.join(" · ")}</span>`
      : `Zielordner: <span class="muted">Keine Ablageziele aktiviert</span>`;
    return;
  }

  el.innerHTML = `Zielordner: ${lines.join("<br>")}`;
}


// ---- Vorschau der Zielordner & Dateiname aktualisieren ----
function refreshPreview(){
  const hasDoc = !!pdfDoc;

  // Dateiname-Preview
  if (fileNameInput){
    if (!hasDoc){
      if (fileNameInput.dataset.mode !== "manual") fileNameInput.value = "";
    } else if (fileNameInput.dataset.mode !== "manual"){
      fileNameInput.value = computeFileNameAuto();
    }
  } else if (fileNamePrev){
    fileNamePrev.textContent = hasDoc ? computeFileNameAuto() : "-";
  }

  const el = (typeof targetPrev !== "undefined" && targetPrev) ? targetPrev : document.querySelector("#targetPreview");

  if (!el) return;

  if (!hasDoc){
    el.innerHTML = "Zielordner: —";   // eindeutig: kein Dokument → keine Zielauflösung
    return;
  }

  renderTargetSummary();               // nur bei vorhandenem Dokument
}


// Zielordner-Preview bei Ziel-/Objektwechsel live aktualisieren
(function wireTargetPreviewLive(){
  function schedule(){
    try { refreshPreview(); }
    catch(e){ console.warn("refreshPreview failed", e); }
  }

   const ids = [
    "#chkScope", "#chkScopevisio",
    "#chkScopeBk",
    "#chkPcloudExtras", "#chkPcloudExtra", "#chkPcloudBackup",
    "#chkLocal", "#chkLocalSave",
    "#objectSelect", "#genericSubfolder", "#docTypeSelect"
  ];


  function attach(){
    ids.forEach(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.addEventListener("change", schedule);
      el.addEventListener("input",  schedule);
    });


    // Delegation: auch dynamische Checkboxen (Custom) sollen sofort die Preview aktualisieren
    const st = document.getElementById("saveTargets");
    if (st && !st.__fdlPreviewBound){
      st.__fdlPreviewBound = "1";
      st.addEventListener("change", (ev) => {
        const t = ev.target;
        if (t && t.matches && t.matches('input[type="checkbox"]')) schedule();
      });
    }
  }


  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", attach, { once:true });
  } else {
    attach();
  }
})();

// === TARGETS: Pfade für das Speichern bestimmen (neu, kompakt) ===
function resolveTargets(){
  const code    = (objSel?.value || "").trim();
  const invoice = (typeof isInvoice === "function") ? isInvoice() : true;
  const year    = (typeof currentYear === "function") ? String(currentYear()) : String(new Date().getFullYear());
  const sub     = (subSel?.value || "").trim();

  // NEUE Schalter
  const useScope    = flag("chkScopevisio", "chkScope");
  const useExtras   = flag("chkPcloudExtra", "chkPcloudExtras");
  const wantLocal   = flag("chkLocalSave",  "chkLocal");
  const wantBackup  = !!document.getElementById("chkPcloudBackup")?.checked;
  const wantScopeBk = !!document.getElementById("chkScopeBk")?.checked;   // NEU

  // Root-Handles: bevorzugt window.*, Fallback alte lokalen Variablen
  const scopeRoot  = window.scopeRootHandle  || scopeRootHandle  || null;
  const pcloudRoot = window.pcloudRootHandle || pcloudRootHandle || null;

  const out = {
    scope:        { root:null, seg:[] },
    scopeBk:      { root:null, seg:[] },     // NEU: Betriebskosten-Kopie
    pcloud:       { root:null, seg:[] },     // strukturierte pCloud (Extras)
    pcloudBucket: { root:null, seg:[] },     // Sammelordner (Backup)
    local:        wantLocal === true
  };

  // ---------- Scopevisio (Hauptablage) ----------
  if (useScope && scopeRoot && code){
    let seg;
    if (code === "FIDELIOR"){
      seg = ["FIDELIOR", (invoice ? "Eingangsrechnungen" : "Dokumente"), year];
    } else if (code === "PRIVAT"){
      seg = ["PRIVAT", (invoice ? "Rechnungsbelege" : "Dokumente"), year];
    } else if (typeof isArndtCie === "function" && isArndtCie(code)) {
      seg = ["ARNDT & CIE", (invoice ? "Eingangsrechnungen" : "Dokumente"), year];
    } else {
      const scopeName = (typeof getFolderNames === "function" ? getFolderNames(code).scopeName : code);
      const base = ["OBJEKTE", scopeName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];
      const leaf = (code === "B75" && invoice)
        ? [year]
        : (sub && !["Rechnungsbelege","Objektdokumente"].includes(sub) ? [sub, year] : [year]);
      seg = base.concat(leaf);
    }
    out.scope.root = scopeRoot;
    out.scope.seg  = seg;
  }

  // ---------- Scopevisio – Abrechnungsbelege (nur Objekte, nur Rechnungen) ----------
  if (
    useScope &&
    scopeRoot &&
    code &&
    invoice &&
    wantScopeBk &&
    code !== "FIDELIOR" &&
    code !== "PRIVAT" &&
    !(typeof isArndtCie === "function" && isArndtCie(code))
   ){
    const scopeNameBk = (typeof getFolderNames === "function"
      ? getFolderNames(code).scopeName
      : code
    );

    // NEU: OBJEKTE / Objektname / Abrechnungsbelege / Jahr
    out.scopeBk.root = scopeRoot;
    out.scopeBk.seg  = ["OBJEKTE", scopeNameBk, "Abrechnungsbelege", year];
  }


  // ---------- pCloud: strukturierte Ablage (Extras) ----------
  if (useExtras && pcloudRoot && code){
    let seg = null;
    if (code === "FIDELIOR"){
      seg = invoice
        ? ["FIDELIOR","VERWALTUNG","Finanzen - Buchhaltung","Eingangsrechnungen", year]
        : (sub ? ["FIDELIOR","VERWALTUNG", sub, year] : null);
    } else if (code === "PRIVAT"){
      seg = ["FIDELIOR","PRIVAT", (invoice ? "Rechnungsbelege" : "Dokumente"), year];
    } else if (!(typeof isArndtCie === "function" && isArndtCie(code))){
      // Spezieller Sonderfall A15: zusätzlicher "Buchhaltung"-Layer
      if (code === "A15" && invoice){
        const leaf = (sub && sub !== "Rechnungsbelege") ? [sub, year] : [year];
        seg = ["FIDELIOR","OBJEKTE","A15 Ahrweiler Straße 15","Buchhaltung","Rechnungsbelege"].concat(leaf);
      } else {
        const pcloudName = (typeof getFolderNames === "function" ? getFolderNames(code).pcloudName : code);
        if (invoice || sub){
          const base = ["FIDELIOR","OBJEKTE", pcloudName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];
          const leaf = (code === "B75" && invoice)
            ? [year]
            : (sub && !["Rechnungsbelege","Objektdokumente"].includes(sub) ? [sub, year] : [year]);
          seg = base.concat(leaf);
        }
      }
    }
    if (seg){
      out.pcloud.root = pcloudRoot;
      out.pcloud.seg  = seg;
    }
  }

     // ---------- pCloud: Sammelordner (Backup nur, wenn Checkbox aktiv) ----------
  if (wantBackup && pcloudRoot){
    const seg = ["FIDELIOR", (typeof PCL_COLLECT_FOLDER === "string" ? PCL_COLLECT_FOLDER : "DMS BACKUP PCLOUD")];
    out.pcloudBucket.root = pcloudRoot;
    out.pcloudBucket.seg  = seg;
  }
  return out;
}      

// --- Vorprüfung der Ziele und Rechte ---
// Prüft nur die aktivierten Ziele, schreibt aber noch nichts.
async function preflightTargets(){
  // Override-Handles sicher einlesen (Fix-Ziele können umgebogen sein)
  try { await refreshOverrideCache(); } catch {}
  const t = resolveTargets();

  // Flags: neue ODER alte Checkbox-IDs
  const wantScope  = flag("chkScopevisio", "chkScope");
  const wantExtras = flag("chkPcloudExtra", "chkPcloudExtras");
  const wantLocal  = flag("chkLocalSave", "chkLocal");
  const wantBackup = !!document.getElementById("chkPcloudBackup")?.checked;

  // Mindestens ein Ziel aktiv?
  let anyOn = wantScope || wantExtras || wantLocal || wantBackup;

  // Custom-Ziele (Checkboxen mit gebundenem Ordner) zählen auch als Speichziel
  if (!anyOn) {
    try {
      const cfg = (window.__fdlCheckboxesCfg && typeof window.__fdlCheckboxesCfg === "object")
        ? window.__fdlCheckboxesCfg
        : (JSON.parse(localStorage.getItem("fdlCheckboxesCfg") || "null") || null);

      const defs = Array.isArray(cfg?.saveTargets) ? cfg.saveTargets : [];
      for (const def of defs) {
        const id = String(def?.id || "").trim();
        if (!id) continue;
        const el = document.getElementById(id);
        if (!el || !el.checked) continue;
        const h = await idbGet("customTarget:" + id);
        if (h) { anyOn = true; break; }
      }
    } catch (e) {
      console.warn("custom target check failed:", e);
    }
  }

  if (!anyOn) {
    return { ok:false, reason: "Kein Speicherziel aktiv." };
  }

  // ===== pCloud: nur prüfen, wenn Backup oder Zusatzablage aktiv sind =====
  if (wantBackup || wantExtras) {
    // irgendein pCloud-Root (aus resolveTargets bevorzugt)
    const pRoot =
      t?.pcloudBucket?.root ||
      t?.pcloud?.root ||
      window.pcloudRootHandle ||
      (typeof pcloudRootHandle !== "undefined" ? pcloudRootHandle : null);

    // noch gar kein Root verbunden
    if (!pRoot) {
      return {
        ok:false,
        reason: "pCloud ist nicht verbunden. Bitte in der Verbindungs-Zentrale einen pCloud-Ordner auswählen und dann erneut speichern."
      };
    }

    // STUMMER Check: ist FIDELIOR wirklich erreichbar?
    let okPcloudRoot = true;
    try {
      await pRoot.getDirectoryHandle("FIDELIOR", { create:false });
    } catch (e) {
      okPcloudRoot = false;
    }
    if (!okPcloudRoot) {
      return {
        ok:false,
        reason: "pCloud ist nicht erreichbar. Bitte pCloud öffnen (Laufwerk P: prüfen), sich anmelden und ggf. in der Verbindungs-Zentrale neu verbinden. Danach erneut auf „Speichern“ klicken."
      };
    }

    // Backup-Sammelordner Rechte
    if (wantBackup && t?.pcloudBucket?.root) {
      const okB = await ensureWritePermissionWithPrompt(
        t.pcloudBucket.root,
        "pCloud (Sammelordner)"
      );
      if (!okB) {
        return {
          ok:false,
          reason: "pCloud (Sammelordner): kein Zugriff. Bitte Verbindung prüfen."
        };
      }
    }

    // Zusatzablage Rechte
    if (wantExtras && t?.pcloud?.root) {
      const okE = await ensureWritePermissionWithPrompt(
        t.pcloud.root,
        "pCloud (Zusatzablage)"
      );
      if (!okE) {
        return {
          ok:false,
          reason: "pCloud (Zusatzablage): kein Zugriff. Bitte Verbindung prüfen."
        };
      }
    }
  }

  // ===== Scopevisio: nur prüfen, wenn aktiv =====
  if (wantScope) {
    if (!t?.scope?.root) {
      return {
        ok:false,
        reason: "Scopevisio-Ordner ist nicht verbunden. Bitte in der Verbindungs-Zentrale verbinden und dann erneut speichern."
      };
    }

    const scopeRoot = t.scope.root;

    // STUMMER Check: ist Scopevisio-Drive wirklich erreichbar?
    // Annahme: scopeRoot zeigt auf „Arndt“, darunter liegt z.B. „Inbox“.
    let okScopeRoot = true;
    try {
      await scopeRoot.getDirectoryHandle("Inbox", { create:false });
    } catch (e) {
      okScopeRoot = false;
    }
    if (!okScopeRoot) {
      return {
        ok:false,
        reason: "Scopevisio ist nicht erreichbar. Bitte Scopevisio / „Scopevisio Documents“ öffnen, sich anmelden und ggf. in der Verbindungs-Zentrale neu verbinden. Danach erneut auf „Speichern“ klicken."
      };
    }

    // Schreibrecht auf dem eigentlichen Ziel
    const okS = await ensureWritePermissionWithPrompt(scopeRoot, "Scopevisio");
    if (!okS) {
      return {
        ok:false,
        reason: "Scopevisio: kein Zugriff. Bitte Verbindung prüfen."
      };
    }
  }

  // Lokal benötigt keine Extra-Prüfung
  return { ok:true, t };
}



  /* --------------------------- Date-Picker (native) ------------------------ */
 function attachNativeDatePicker(textInput){
  if (!textInput || textInput._hasPicker) return;
  textInput._hasPicker = true;

  const hidden = document.createElement("input");
  hidden.type = "date";
  hidden.style.position = "fixed";
  hidden.style.opacity = "0";
  hidden.style.pointerEvents = "none";
  hidden.style.width = "1px";
  hidden.style.height = "1px";
  hidden.style.zIndex = "9999"; // sicherheitshalber oben
  textInput.insertAdjacentElement("afterend", hidden);

  const openPicker = () => {
    // Feld möglichst sichtbar machen
    textInput.scrollIntoView({ block: "nearest", inline: "nearest" });

    const rect = textInput.getBoundingClientRect();
    const margin = 8;        // kleiner Abstand
    const calH   = 320;      // grobe Kalender-Höhe
    const calW   = 320;      // grobe Kalender-Breite

    // Links klemmen
    const left = Math.max(
      margin,
      Math.min(rect.left + margin, window.innerWidth - calW - margin)
    );

    // Unten genug Platz? Sonst oberhalb anzeigen
    const needsUp = (rect.top + rect.height + calH + margin > window.innerHeight);
    const top = needsUp
      ? Math.max(margin, rect.top - calH - margin)          // oberhalb
      : Math.max(margin, rect.top + rect.height + margin);  // unterhalb

    hidden.style.left = Math.floor(left) + "px";
    hidden.style.top  = Math.floor(top)  + "px";

  
    // aktuellen Wert übernehmen – wenn keiner gesetzt: heute
const iso = dispToIso(textInput.value);
hidden.value = iso || new Date().toISOString().slice(0,10);

hidden.showPicker?.();
hidden.click();

  };

  textInput.addEventListener("focus", openPicker);
  textInput.addEventListener("click", openPicker);

  hidden.addEventListener("change", () => {
    if (hidden.value) {
      const m = hidden.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) textInput.value = `${m[3]}.${m[2]}.${m[1]}`;
      textInput.dispatchEvent(new Event("input",  { bubbles:true }));
      textInput.dispatchEvent(new Event("change", { bubbles:true }));
    }
  });
}

  attachNativeDatePicker(recvDateEl); attachNativeDatePicker(invDateEl);
/* ----------------------- Verbindungen & Zähler --------------------------- */
// ==== BACKCOMPAT: alte Aufrufe von paintChips() weiterleiten ====
function paintChips(){
  try{
    if (typeof paintConnectionsCompact === "function") {
      paintConnectionsCompact();
    }
  }catch(e){
    console.warn("paintChips shim failed:", e);
  }
}

/* ---------- Verbindungsanzeige (kompakt) ---------- */
function paintConnectionsCompact(){
  const sBtn  = document.getElementById("btnBindScopevisio");
  const pBtn  = document.getElementById("btnBindPcloud");
  const sLine = document.getElementById("connScopeLine");
  const pLine = document.getElementById("connPcloudLine");

  // WICHTIG: Status nur noch aus window.*, genau wie Verbindungs-Zentrale + Banner
  const scopeOK   = !!window.scopeRootHandle;
  const pcloudOK  = !!window.pcloudRootHandle;
  const useScope  = document.getElementById("chkScope")?.checked ?? false;
  const useExtras = document.getElementById("chkPcloudExtras")?.checked ?? false;

  // —— Scopevisio (links Button/Pill, rechts Status) ——
  if (sBtn){
    sBtn.classList.add("conn-pill");
    sBtn.classList.remove("btn-outline");
    sBtn.classList.toggle("conn-pill--ok",  scopeOK);
    sBtn.classList.toggle("conn-pill--off", !scopeOK);
    sBtn.textContent = scopeOK ? "Scopevisio: Verbunden ✓" : "Scopevisio verbinden…";
  }
  if (sLine){
    if (!scopeOK){
      sLine.classList.remove("conn-right--ok");
      sLine.textContent = "Nicht verbunden";
    } else if (useScope){
      sLine.classList.add("conn-right--ok");
      sLine.textContent = "Root ✓ · Inbox ✓ · Bearbeitet ✓";
    } else {
      sLine.classList.remove("conn-right--ok");
      sLine.textContent = "Ablageziele —";            // Ziele sind verbunden, aber deaktiviert
    }
  }

  // —— pCloud ——
  if (pBtn){
    pBtn.classList.add("conn-pill");
    pBtn.classList.remove("btn-outline");
    pBtn.classList.toggle("conn-pill--ok",  pcloudOK);
    pBtn.classList.toggle("conn-pill--off", !pcloudOK);
    pBtn.textContent = pcloudOK ? "pCloud: Verbunden ✓" : "pCloud verbinden…";
  }
  if (pLine){
    if (!pcloudOK){
      pLine.classList.remove("conn-right--ok");
      pLine.textContent = "Nicht verbunden";
    } else {
      // Backup/Config sind dauerhaft aktiv, Zusatzablage per Checkbox
      pLine.classList.add("conn-right--ok");
      pLine.textContent = `Backup ✓ · Config ✓ · Zusatzablage ${useExtras ? "✓" : "—"}`;
    }
  }
}



async function requestDirWrite(dirHandle){ try{ if(!dirHandle?.requestPermission) return true; let p = await dirHandle.queryPermission?.({ mode: "readwrite" }); if (p !== "granted") p = await dirHandle.requestPermission({ mode: "readwrite" }); return p === "granted"; }catch{ return true; } }
function detectRootKind(rootHandle) {
  const pcRoot1 = window.pcloudRootHandle || null;
  const pcRoot2 = (typeof pcloudRootHandle !== "undefined") ? pcloudRootHandle : null;
  const scRoot1 = window.scopeRootHandle || null;
  const scRoot2 = (typeof scopeRootHandle !== "undefined") ? scopeRootHandle : null;

  if (rootHandle && (rootHandle === pcRoot1 || rootHandle === pcRoot2)) return "pcloud";
  if (rootHandle && (rootHandle === scRoot1 || rootHandle === scRoot2)) return "scope";
  return "other";
}

let lastRootWarnKey = null;  // Root-Warnungen pro Speichern nur einmal anzeigen

// Erst prüfen, ob der Basis-Ordner erreichbar ist.
// Unterscheidet zwischen pCloud-Root und Scopevisio-Root.
// Pro Speichern wird je Root nur EIN Hinweis gezeigt.
async function ensureDirWithPrompt(rootHandle, segments) {
  if (!rootHandle) {
    throw new Error("Kein Root-Handle");
  }

  const kind = detectRootKind(rootHandle);  // "pcloud" | "scope" | "other"

  let dir  = rootHandle;
  const segs = Array.isArray(segments) ? segments : [];

  for (let i = 0; i < segs.length; i++) {
    const raw = segs[i];
    const s   = (raw || "").trim();
    if (!s) continue;

    try {
      // vorhandenen Ordner öffnen
      dir = await dir.getDirectoryHandle(s, { create: false });
    } catch (e) {
      // 1. Segment unterhalb des Roots fehlt → Grundpfad nicht erreichbar
      if (i === 0) {
        console.warn("[ensureDirWithPrompt] Basis-Ordner nicht erreichbar:", s, "kind:", kind, e);

        const warnKey = `${kind}:${s}`;   // z.B. "pcloud:FIDELIOR"
        const showToast = (lastRootWarnKey !== warnKey);
        lastRootWarnKey = warnKey;

        if (kind === "pcloud") {
          if (showToast) {
            toast(
              `pCloud-Ordner „${s}“ ist nicht erreichbar.<br>` +
              "<small>Bitte pCloud öffnen (Laufwerk P: prüfen) und ggf. in der Verbindungs-Zentrale erneut verbinden.</small>",
              9000
            );
          }
          const err = new Error(`Basis-Ordner nicht erreichbar: ${s}`);
          err.fdlRootMissing = true;        // Spezial-Flag für pCloud
          throw err;
        }

        if (kind === "scope") {
          if (showToast) {
            toast(
              `Scopevisio-Ordner „${s}“ ist nicht erreichbar.<br>` +
              "<small>Bitte Scopevisio / „Scopevisio Documents“ öffnen und ggf. in der Verbindungs-Zentrale erneut verbinden.</small>",
              9000
            );
          }
          const err = new Error(`Scopevisio-Basisordner nicht erreichbar: ${s}`);
          err.fdlScopeRootMissing = true;   // Spezial-Flag für Scopevisio
          throw err;
        }

        // generischer Fallback für andere Roots
        if (showToast) {
          toast(
            `Ordner „${s}“ ist nicht erreichbar.<br>` +
            "<small>Bitte Verbindung oder Berechtigungen prüfen und ggf. in der Verbindungs-Zentrale neu verbinden.</small>",
            8000
          );
        }
        throw e || new Error(`Basis-Ordner nicht erreichbar: ${s}`);
      }

      // Nur für Unterordner (i > 0) Ordner-anlegen-Dialog anbieten
      const yes = window.confirm(`Ordner fehlt: "${s}". Jetzt anlegen?`);
      if (!yes) {
        throw new Error(`Abgebrochen – fehlender Ordner: ${s}`);
      }

      try {
        dir = await dir.getDirectoryHandle(s, { create: true });
      } catch (e2) {
        console.warn("[ensureDirWithPrompt] Anlegen fehlgeschlagen:", s, e2);
        throw e2;
      }
    }
  }

  return dir;
}


// Bildet einen kollisionssicheren Dateinamen:  name.pdf → name (2).pdf → name (3).pdf …
async function uniqueName(dirHandle, fileName) {
  if (!dirHandle) return fileName;

  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext  = dot > 0 ? fileName.slice(dot)    : "";

  // Prüfer: existiert eine Datei mit diesem Namen schon?
  async function exists(name) {
    try {
      await dirHandle.getFileHandle(name, { create: false });
      return true;
    } catch {
      return false;
    }
  }

  let n = 1;
  let candidate = fileName;

  while (await exists(candidate)) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
    if (n > 2000) break; // Schutz, sollte nie erreicht werden
  }
  return candidate;
}
// optional global machen:
try { window.uniqueName = uniqueName; } catch {}

// Schreiben ins Ziel (mit Prompt für Berechtigungen + Ordner-Anlage + Slash-Fallback)
async function writeFileTo(rootHandle, segments, bytes, fileName, opts = {}) {
  if (!rootHandle) throw new Error("Root-Handle fehlt");
  if (!fileName)   throw new Error("Dateiname fehlt");

  // Schreibrecht
  const ok = await requestDirWrite(rootHandle);
  if (!ok) throw new Error("Schreibberechtigung verweigert");

  // Zielordnerkette (mit optionaler Anlage)
  const dir = await ensureDirWithPrompt(rootHandle, segments || []);

  // Kollisionssicheren Namen bilden, wenn gewünscht
  const finalName = opts.unique ? await uniqueName(dir, fileName) : fileName;

  // Robustes Schreiben + sauberes Abbrechen bei Fehler
  async function doWrite(targetName){
    const h  = await dir.getFileHandle(targetName, { create: true });
    const ws = await h.createWritable({ keepExistingData: false });
    try {
      await ws.write(new Blob([bytes], { type: "application/pdf" }));
      await ws.close();
    } catch (e) {
      try { await ws.abort?.(); } catch {}
      // hier KEIN safeName benutzen – nur targetName oder e.message
      try { toast?.(`Speichern fehlgeschlagen<br>${targetName}<br><small>${e?.message || e}</small>`, 8000); } catch {}
      throw e;
    }
  }

  // 1) Erst mit dem ursprünglichen Namen versuchen
  let attemptedName = finalName;
  try {
    await doWrite(attemptedName);
  } catch (e1) {
    // 2) Fallback: optische Slashes (U+2215/FF0F) durch "-" ersetzen
    let fallbackName = attemptedName.replace(/\u2215/g, "-").replace(/\uFF0F/g, "-");
    if (fallbackName !== attemptedName) {
      if (opts.unique) fallbackName = await uniqueName(dir, fallbackName);
      await doWrite(fallbackName);
      attemptedName = fallbackName;
      toast?.("Hinweis: „/“ im Dateinamen wurde für das Ziel ersetzt.", 5200);
    } else {
      throw e1;
    }
  }

  // Chrome .crswap-Reste säubern (best effort)
  try { await tryRemoveCrSwap(dir, attemptedName); } catch {}

  return attemptedName;
}

// Kurzer Check, ob pCloud-Root + FIDELIOR erreichbar sind
async function verifyPcloudRootOrWarn(){
  const root =
    window.pcloudRootHandle ||
    (typeof pcloudRootHandle !== "undefined" ? pcloudRootHandle : null);

  if (!root) {
    toast(
      "pCloud ist nicht verbunden.<br>" +
      "<small>Bitte pCloud Drive öffnen und in der Verbindungs-Zentrale den pCloud-Root wählen.</small>",
      9000
    );
    return false;
  }

  // Reachability-Test: einmal einen typischen Ordner/Eintrag abfragen
  // (wenn pCloud nicht eingeloggt/offline ist, werfen getDirectoryHandle/values oft Fehler)
  const candidates = ["FIDELIOR", "OBJEKTE", "PRIVAT", "DMS BACKUP PCLOUD", "SOFTWARE", "config"];

  for (const name of candidates) {
    try {
      await root.getDirectoryHandle(name, { create: false });
      return true; // erreichbar
    } catch (e) {
      // weiterprobieren
    }
  }

  // fallback: einmal root iterieren (manche Setups erlauben das eher)
  try {
    for await (const _ of root.values()) { break; }
    return true;
  } catch (e) {
    toast(
      "pCloud-Root ist nicht erreichbar.<br>" +
      "<small>Bitte pCloud Drive öffnen, einloggen und danach erneut versuchen. Falls nötig: in der Verbindungs-Zentrale neu verbinden.</small>",
      10000
    );
    return false;
  }
}


// Sorgt dafür, dass die pCloud-Checkboxen nur aktiv bleiben,
// wenn der Root erreichbar ist
function setupPcloudTargetGuards() {
    // nur einmal pro Seite initialisieren (verhindert doppelte Listener)
  if (window.__fdl_pcloudGuardsDone) return;
  window.__fdl_pcloudGuardsDone = true;

  const ids = ["chkPcloudBackup", "chkPcloudExtra", "chkPcloudExtras"];

  ids.forEach(id => {
    const cb = document.getElementById(id);
    if (!cb) return;

    cb.addEventListener("change", async (ev) => {
      // Wir reagieren nur, wenn der Nutzer die Checkbox AUF "aktiv" setzt
      if (!ev.target.checked) return;

      const ok = await verifyPcloudRootOrWarn();
      if (!ok) {
        // Root nicht erreichbar → Auswahl sofort wieder zurücknehmen
        ev.target.checked = false;
      }
    });
  });
}



async function verifyScopeRootOrWarn() {
  const root =
    window.scopeRootHandle ||
    (typeof scopeRootHandle !== "undefined" ? scopeRootHandle : null);

  // Noch gar kein Scope-Root verbunden
  if (!root) {
    toast(
      "Scopevisio ist nicht verbunden.<br>" +
      "<small>Bitte Scopevisio / „Scopevisio Documents“ öffnen und in der Verbindungs-Zentrale einen Ordner auswählen.</small>",
      8000
    );
    return false;
  }

  // Ordner, die es unter „Arndt“ sicher gibt (siehe Screenshot)
  const candidates = [
    "Arndt",
    "OBJEKTE",
    "Inbox",
    "PRIVAT",
    "Bearbeitet",
    "FIDELIOR",
    "ARNDT & CIE"
  ];

  for (const name of candidates) {
    try {
      await root.getDirectoryHandle(name, { create: false });
      // Wenn ein typischer Unterordner erreichbar ist, gilt Scopevisio als "online"
      return true;
    } catch (e) {
      // ignorieren, wir probieren die anderen Kandidaten
    }
  }

  // Kein typischer Ordner erreichbar → Scopevisio-Drive vermutlich offline / nicht eingeloggt
  toast(
    "Scopevisio-Basisordner ist nicht erreichbar.<br>" +
    "<small>Bitte Scopevisio / „Scopevisio Documents“ öffnen, sich anmelden und ggf. in der Verbindungs-Zentrale erneut verbinden. Danach erneut auf „Speichern“ klicken.</small>",
    9000
  );
  return false;
}


// Bearbeitet darf nicht innerhalb der Inbox liegen (Crashschutz, heuristisch ok)
async function assertProcessedNotInsideInbox(inboxDir, processedDir){
  if (!inboxDir || !processedDir) return true;
  if (inboxDir === processedDir) throw new Error("Inbox und Bearbeitet sind identisch");
  // Mehr geht mit FS-API nicht sicher – Heuristiken würden hier wenig helfen.
  return true;
}

// Kopiert die aktuelle Inbox-Datei nach "Bearbeitet" und löscht das Original.
// Nutzt currentInboxRelPath (['sub','sub','Datei.pdf']) oder fällt zurück auf currentInboxFileName.
async function moveInboxToProcessed(){
  // Root-Handles: bevorzugt window.*, Fallback alte lokalen Variablen
  const inboxRoot     = window.inboxRootHandle      || inboxRootHandle;
  const processedRoot = window.bearbeitetRootHandle || processedRootHandle;

  // Guards
  if (!inboxRoot)           throw new Error("Inbox-Root fehlt");
  if (!processedRoot)       throw new Error("Bearbeitet-Root fehlt");
  if (!currentInboxFileHandle && !currentInboxFileName) {
    throw new Error("Keine Inbox-Datei im Kontext");
  }

  // Sicherheit: Bearbeitet darf nicht innerhalb der Inbox liegen
  try {
    await assertProcessedNotInsideInbox?.(inboxRoot, processedRoot);
  } catch (e) {
    throw new Error("Konfiguration ungültig (Inbox/Bearbeitet): " + (e?.message || e));
  }

  // Schreibrecht für Bearbeitet einholen
  const okOut = await ensureWritePermissionWithPrompt(processedRoot, "Bearbeitet");
  if (!okOut) throw new Error("Bearbeitet: Schreibrecht verweigert");

  // Pfad der Inbox-Datei bestimmen
  const rel = Array.isArray(currentInboxRelPath) && currentInboxRelPath.length
    ? currentInboxRelPath.slice()
    : [currentInboxFileName];

  const name = rel[rel.length - 1];
  const sub  = rel.slice(0, -1); // Unterordner relativ zur Inbox (meist leer)

  // Quelle laden (Dateiobjekt)
  let fileObj;
  try {
    if (currentInboxFileHandle?.getFile) {
      // Wenn wir ein Handle haben, das direkt benutzen (stabiler)
      fileObj = await currentInboxFileHandle.getFile();
    } else {
      // Sonst via Pfad aus Inbox-Root ermitteln
      let dir = inboxRoot;
      for (const s of sub) {
        dir = await dir.getDirectoryHandle(s, { create:false });
      }
      const fh = await dir.getFileHandle(name, { create:false });
      fileObj = await fh.getFile();
    }
  } catch (e) {
    throw new Error("Quelle nicht lesbar: " + (e?.message || e));
  }

  if (!fileObj || !fileObj.size) {
    throw new Error("Inbox-Datei ist leer oder nicht lesbar");
  }

  // Zielordner (Bearbeitet) aufbauen: gleiche Substruktur wie in Inbox
  let outDir = processedRoot;
  for (const s of sub) {
    outDir = await outDir.getDirectoryHandle(s, { create:true });
  }

  // Schreiben (überschreibt existierende Datei gleichen Namens NICHT)
  const finalName = await uniqueName(outDir, name);
  const outHandle = await outDir.getFileHandle(finalName, { create:true });

  let ws;
  try {
    ws = await outHandle.createWritable({ keepExistingData:false });
    await ws.write(fileObj);
    await ws.close();
  } catch (e) {
    try { await ws?.abort?.(); } catch {}
    throw new Error("Schreiben nach Bearbeitet fehlgeschlagen: " + (e?.message || e));
  }

  // Chrome .crswap-Reste säubern (best effort, wie bei writeFileTo)
  try { await tryRemoveCrSwap(outDir, finalName); } catch {}

  // Quelle in der Inbox löschen (best effort)
  try {
    let srcDir = inboxRoot;
    for (const s of sub) {
      srcDir = await srcDir.getDirectoryHandle(s, { create:false });
    }
    await srcDir.removeEntry(name);
  } catch (e) {
    console.warn("Inbox-Quelle konnte nicht gelöscht werden:", e);
  }

  // Kontext zurücksetzen
  currentInboxFileHandle = null;
  currentInboxFileName   = "";
  currentInboxRelPath    = null;

  // Inbox-Liste aktualisieren (Zähler & Liste unten)
  try {
    if (typeof refreshInbox === "function") {
      await refreshInbox();
    }
  } catch (e) {
    console.warn("refreshInbox nach moveInboxToProcessed fehlgeschlagen:", e);
  }

  return true;
}



/* ---------------------- Verbindungen: Root-Ordner binden ---------------------- */

document.getElementById("btnBindScopevisio")
  ?.addEventListener("click", async () => { await bindScopeInteractive(); });

document.getElementById("btnBindPcloud")
  ?.addEventListener("click", async () => { await bindPcloudInteractive(); });


/* ----------------------------- Inbox-Aktualisierung ----------------------------

   Fix: 0-Byte-Stubs (Cloud-Platzhalter) werden herausgefiltert.
   – Wir holen file.size, bevor wir den Eintrag anzeigen.
   – Beim Klick prüfen wir _nochmals_ die Größe (Race-Condition-Sicherheit).
--------------------------------------------------------------------------------*/

async function refreshInbox(){
  const list     = $("#inboxList");
  const counters = $("#counters");

  if (list) list.innerHTML = "";

  // Einfacher Debug: was sieht die Funktion?
  const inboxRoot = window.inboxRootHandle || inboxRootHandle || null;
  console.debug("[refreshInbox] inboxRoot:", !!inboxRoot, inboxRoot?.name || "(none)");

  let offen = 0;

  if (inboxRoot){
    try {
      for await (const entry of inboxRoot.values()){
        if (entry.kind !== "file") continue;
        if (!entry.name.toLowerCase().endsWith(".pdf")) continue;

        offen++;

        if (list){
          const li = document.createElement("li");
          li.innerHTML = `<button class="linklike" data-file="${entry.name}">${entry.name}</button><span class="badge">Inbox</span>`;
          list.appendChild(li);

          li.querySelector("button")?.addEventListener("click", async () => {
            try {
              const h = await inboxRoot.getFileHandle(entry.name, { create:false });
              const f = await h.getFile();

              currentInboxFileHandle = h;
              currentInboxFileName   = entry.name;
              currentInboxRelPath    = [entry.name];

              if (typeof window.__fdl_takeFile === "function"){
                await window.__fdl_takeFile(f, { fromInbox:true });
              }
              toast(`Inbox-Datei ausgewählt: <code>${entry.name}</code>`, 1400);
            } catch (err) {
              console.warn("[refreshInbox] Klick-Fehler:", err);
              toast("Konnte Datei nicht öffnen.", 2500);
            }
          });
        }
      }
    } catch (err) {
      console.warn("[refreshInbox] Fehler beim Lesen der Inbox:", err);
    }
  }

  // Anzeige: nur echte Zahl für „Offen“ zeigen, Rest vorerst weglassen
  if (counters) {
    counters.textContent = `Offen: ${offen}`;
  }
}


  /* --------------------------- Config: load/save --------------------------- */
// NUR diese Funktion ersetzen
async function loadJson(rel){
  const baseName = rel.split("/").pop();            // z.B. "assignments.json"
  const stem     = baseName.replace(/\.json$/i, ""); // "assignments"
  const withExt  = stem + ".json";

  // 1) Im verbundenen Config-Ordner suchen (beide Varianten) und die JÜNGSTE nehmen
  try {
    if (configDirHandle) {
      const candidates = [];
      for await (const e of configDirHandle.values()) {
        if (e.kind !== "file") continue;
        const n = e.name.toLowerCase();
        if (n === baseName.toLowerCase() || n === withExt.toLowerCase() || n === stem.toLowerCase()) {
          const h = await configDirHandle.getFileHandle(e.name, { create:false });
          const f = await h.getFile();
          candidates.push({ file: f, name: e.name, mtime: f.lastModified || 0 });
        }
      }
      if (candidates.length) {
        // jüngste Datei gewinnen lassen (endet .json oder endungslos – egal)
        candidates.sort((a,b)=>b.mtime - a.mtime);
        return JSON.parse(await candidates[0].file.text());
      }
    }
  } catch { /* ignore, wir versuchen Fetch */ }

  // 2) Fallback: vom Projekt laden (beide Varianten probieren)
  const tries = [
    rel, "./"+rel,
    "config/"+withExt, "./config/"+withExt,
    "config/"+stem,    "./config/"+stem
  ];
  for (const p of tries) {
    try {
      const r = await fetch(p, { cache:"no-store" });
      if (r.ok) return await r.json();
    } catch {}
  }

  throw new Error("Konfiguration nicht gefunden: " + rel);
}

// JSON im verbundenen Config-Ordner speichern
async function saveJson(rel, data){
  // rel kann "config/assignments.json", "assignments.json" oder "assignments" sein
  const raw0 = String(rel || "").replace(/^\.\//, "");
  let segs = raw0.split("/").filter(Boolean);

  // Schutz: wenn der gebundene Ordner bereits "config" heißt, führendes "config/" ignorieren
  const rootIsConfig = (configDirHandle?.name || "").toLowerCase() === "config";
  if (rootIsConfig && segs[0]?.toLowerCase() === "config") segs = segs.slice(1);

  // Dateiname + optionaler Unterordner
  let fileName = (segs.pop() || "config.json");
  fileName = fileName.replace(/\.json$/i, "") + ".json";
  const subdirs = segs; // z.B. ["config"] oder []

  // Ordner verbunden?
  if (!configDirHandle) {
    try {
      configDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      paintChips?.();
      await saveBoundHandles?.();
      toast?.("<strong>Config verbunden</strong>", 1500);
    } catch {
      throw new Error("Kein Config-Ordner verbunden.");
    }
  }

  // Schreibrecht (innerhalb User-Gesture aufgerufen → Prompt sichtbar)
  const ok = await (typeof ensureWritePermissionWithPrompt === "function"
    ? ensureWritePermissionWithPrompt(configDirHandle, "Config")
    : true);
  if (ok === false) throw new Error("Schreibberechtigung für Config verweigert.");

  // ggf. Unterordner anlegen (falls rel "config/…" war)
  let dir = configDirHandle;
  for (const s of subdirs) {
    dir = await dir.getDirectoryHandle(s, { create: true });
  }

  // schreiben
  const fh = await dir.getFileHandle(fileName, { create: true });
  const ws = await fh.createWritable({ keepExistingData: false });
  await ws.write(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
  await ws.close();

  return true;
}


try {
  window.FDLDBG = window.FDLDBG || {};
  FDLDBG.saveJson    = saveJson;     // <— hinzufügen
  FDLDBG.loadJson    = loadJson;
  FDLDBG.loadObjects = loadObjects;
  FDLDBG.loadDocTypes= loadDocTypes;
} catch {}




  /* --------------------------- Dialoge (vollständig) ----------------------- */
  function wireDialogClose(dlg){ if(!dlg) return; dlg.addEventListener("keydown", (e)=>{ if(e.key==="Escape"){ e.preventDefault(); dlg.close?.(); }}); dlg.querySelectorAll("[data-close], .btn-cancel, .dlg-close, .dialog-close").forEach(btn=>{ btn.addEventListener("click",(e)=>{ e.preventDefault(); dlg.close?.(); }); }); dlg.addEventListener("click",(e)=>{ const r=dlg.getBoundingClientRect(); const inside = e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom; if(!inside && e.target===dlg) dlg.close?.(); }); }

async function ensureConfigConnectedOrAsk(){
  // Erst versuchen, aus vorhandenen Quellen zu synchronisieren
  if (syncConfigHandle()) {
    // Schon verbunden → nichts tun
    return;
  }

  // Noch nichts da → Picker öffnen
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    if (!dir) throw new Error("abgebrochen");

    syncConfigHandle(dir);

    paintChips?.();
    try { await saveBoundHandles?.(); } catch {}
    try { await saveAllHandles?.(); } catch {}

    toast("<strong>Config verbunden</strong>", 1500);
    window.fdlRefreshConnectionsUI?.();
  } catch {
    toast("Config nicht verbunden.", 2000);
  }
}


  async function openEmailsDialog(){
  await ensureConfigConnectedOrAsk();
  const dlg = $("#manageEmailsDialog");
  if (!dlg.__draggable) { makeDialogDraggable(dlg); dlg.__draggable = true; }

  if (!dlg) { toast("E-Mail-Dialog fehlt im HTML.", 2500); return; }

  // ---- Laden / Defaults (ohne Markdown-Link!) ----
  let json;
  try {
    json = await loadJson("emails.json");
  } catch {
    json = {
      addressBook: [],
      perObject: {},
      defaults: {
        replyTo: "documents@fidelior.de",
        invoice: {
          Fidelior: {
            subjectByStatus: {
              open:   "NEUE RECHNUNG – ZAHLUNG OFFEN",
              review: "RECHNUNGSPRÜFUNG ERFORDERLICH"
            }
          }
        }
      }
    };
  }

  // ===== Adressbuch mit Stift/Löschen (inline edit) =====
  const tbody = $("#emailsTbody");
  tbody.innerHTML = "";
// Ersetze deinen gesamten addRow-Block durch DIESEN:
const addRow = (rec = { label:"", email:"", id:"", tags:[] }) => {
  const tr = document.createElement("tr");

  // Anzeigezellen
  const tdLabel = document.createElement("td");
  tdLabel.className = "ab-label";
  tdLabel.textContent = rec.label || rec.name || "";

  const tdEmail = document.createElement("td");
  tdEmail.className = "ab-email";
  tdEmail.textContent = rec.email || "";

  const tdId = document.createElement("td");
  tdId.className = "ab-id";
  tdId.textContent = rec.id || "";

  const tdTags = document.createElement("td");
  tdTags.className = "ab-tags";
  tdTags.textContent = Array.isArray(rec.tags) ? rec.tags.join(", ") : (rec.tags || "");

  const tdActions = document.createElement("td");
  tdActions.className = "right";
  tdActions.style.whiteSpace = "nowrap"; // verhindert Umbrechen/Abschneiden
  tdActions.style.minWidth = "120px";

  const btnEdit = document.createElement("button");
  btnEdit.type = "button";
  btnEdit.className = "icon-btn ab-edit";
  btnEdit.title = "Bearbeiten";
  btnEdit.textContent = "🖉";
btnEdit.setAttribute("aria-label", "Bearbeiten");

  const btnDel = document.createElement("button");
  btnDel.type = "button";
  btnDel.className = "icon-btn ab-del";
  btnDel.title = "Löschen";
  btnDel.style.marginLeft = ".4rem";
  btnDel.textContent = "🗑️";
btnDel.setAttribute("aria-label", "Löschen");

  tdActions.appendChild(btnEdit);
  tdActions.appendChild(btnDel);

  tr.appendChild(tdLabel);
  tr.appendChild(tdEmail);
  tr.appendChild(tdId);
  tr.appendChild(tdTags);
  tr.appendChild(tdActions);

  // Edit-Modus
  const toInputs = () => {
    tr.innerHTML = "";

    const mkInputCell = (cls, val, ph) => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.className = "input slim " + cls;
      inp.value = val || "";
      inp.placeholder = ph || "";
      td.appendChild(inp);
      return { td, inp };
    };

    const iLabel = mkInputCell("em-label", rec.label || rec.name || "", "Name/Label");
    const iEmail = mkInputCell("em-email", rec.email || "", "name@firma.de");
    const iId    = mkInputCell("em-id",    rec.id || "",    "id (optional)");
    const iTags  = mkInputCell("em-tags",  Array.isArray(rec.tags) ? rec.tags.join(", ") : (rec.tags || ""), "Tags");

    const tdAct = document.createElement("td");
    tdAct.className = "right";
    tdAct.style.whiteSpace = "nowrap";
    tdAct.style.minWidth = "120px";

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn-outline btn-small em-ok";
    ok.textContent = "OK";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-outline btn-small em-cancel";
    cancel.style.marginLeft = ".4rem";
    cancel.textContent = "Abbrechen";

    tdAct.appendChild(ok);
    tdAct.appendChild(cancel);

    tr.appendChild(iLabel.td);
    tr.appendChild(iEmail.td);
    tr.appendChild(iId.td);
    tr.appendChild(iTags.td);
    tr.appendChild(tdAct);

    ok.onclick = () => {
      const next = {
        label: (iLabel.inp.value || "").trim(),
        name:  (iLabel.inp.value || "").trim(),
        email: (iEmail.inp.value || "").trim(),
        id:    (iId.inp.value || "").trim() || undefined,
        tags:  (iTags.inp.value || "").split(",").map(s => s.trim()).filter(Boolean)
      };
      if (!EMAIL_RE.test(next.email)) { toast("Ungültige E-Mail.", 1800); return; }
      const fresh = addRow(next);
      tr.replaceWith(fresh);
    };

    cancel.onclick = () => {
      const fresh = addRow(rec);
      tr.replaceWith(fresh);
    };
  };

  btnEdit.onclick = toInputs;
  btnDel.onclick  = () => tr.remove();

  return tr;
};


  (json.addressBook || json.emails || []).forEach(r => tbody.appendChild(addRow(r)));
  $("#emailsAdd")?.addEventListener("click", () => {
  // Neue Zeile anhängen …
  const tr = addRow({});
  tbody.appendChild(tr);
  // … und direkt in den Bearbeiten-Modus springen
  tr.querySelector(".ab-edit")?.click();
});


// ===== Pro Liegenschaft: Vorlagen (edit/löschen) =====
const poObjSel = $("#poObject"),
      poRec    = $("#poRecipients"),
      poSubj   = $("#poSubject"),
      poReply  = $("#poReplyTo"),
      poList   = $("#poList");

let poEditState = null;  // merkt, ob wir eine bestehende Vorlage bearbeiten


  try {
    const o = await loadJson("objects.json");
    poObjSel.innerHTML =
      '<option value="">(Liegenschaft wählen)</option>' +
      (o.objects || []).map(x => '<option value="'+ (x.code||"") +'">' + (x.displayName||x.code||"") + '</option>').join("");
  } catch {
    poObjSel.innerHTML = '<option value="">(Liegenschaft wählen)</option>';
  }

  let poRules = structuredClone(json.perObject || {});

  const renderPoList = () => {
    poList.innerHTML = "";
    const codes = Object.keys(poRules);
    if (!codes.length) { poList.innerHTML = "<li class='muted'>Keine Vorlagen</li>"; return; }

    codes.forEach(code => {
      const inv = (poRules[code] && poRules[code].invoice) ? poRules[code].invoice : {};

      // Hauptvorlage "bei Rechnung"
      if ((inv.to && inv.to.length) || (inv.emails && inv.emails.length) || inv.subject || inv.replyTo) {
        const mails = (inv.to || inv.emails || []).join(", ");
        const li = document.createElement("li");
        li.innerHTML =
          '<div><strong>'+code+
          '</strong> · '+(mails || "—")+
          (inv.subject ? ' — <em>'+escapeHtml(inv.subject)+'</em>' : '')+
          (inv.replyTo ? ' — <code>'+escapeHtml(inv.replyTo)+'</code>' : '')+
          ' <span class="badge">bei Rechnung</span></div>' +
          '<div>' +
            '<button class="icon-btn po-edit" title="Bearbeiten">🖉</button>' +
            '<button class="icon-btn po-del"  title="Löschen">🗑️</button>' +
          '</div>';

     li.querySelector(".po-edit").onclick = () => {
  poObjSel.value = code;
  poRec.value    = (inv.to || inv.emails || []).join(" ");
  poSubj.value   = inv.subject || "";
  poReply.value  = inv.replyTo || "";
  poEditState    = { code, kind: "invoice" };
};

        li.querySelector(".po-del").onclick  = () => {
          delete poRules[code].invoice;
          renderPoList();
        };
        poList.appendChild(li);
      }

      // Zusätzliche Templates (optional)
      (poRules[code].templates || []).forEach(t => {
        const mails = (t.recipients || t.to || []).join(", ");
        const li = document.createElement("li");
        const labelTxt = t.label || t.subject || t.id || "Vorlage";
        li.innerHTML =
          '<div><strong>'+code+'</strong> · <span class="muted">'+escapeHtml(labelTxt)+'</span> — '+
          (mails || "—") +
          (t.subject ? ' — <em>'+escapeHtml(t.subject)+'</em>' : '')+
          (t.replyTo ? ' — <code>'+escapeHtml(t.replyTo)+'</code>' : '')+
          (t.invoiceOnly ? ' <span class="badge">bei Rechnung</span>' : '')+
          '</div>' +
          '<div>' +
            '<button class="icon-btn pt-edit" title="Bearbeiten">🖉</button>' +
            '<button class="icon-btn pt-del"  title="Löschen">🗑️</button>' +
          '</div>';

       li.querySelector(".pt-edit").onclick = () => {
  poObjSel.value = code;
  poRec.value    = (t.recipients || t.to || []).join(" ");
  poSubj.value   = t.subject || "";
  poReply.value  = t.replyTo || "";
  poEditState    = { code, kind: "template", id: (t.id || t.label || t.subject || "") };
};

        li.querySelector(".pt-del").onclick = () => {
          poRules[code].templates = (poRules[code].templates || []).filter(x => (x.id||x.label) !== (t.id||t.label));
          renderPoList();
        };
        poList.appendChild(li);
      });
    });
  };

  // Simple HTML escaping for safety in template strings
  function escapeHtml(s){
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  renderPoList();

$("#poAdd")?.addEventListener("click", (e) => {
  e.preventDefault();
  const code = (poObjSel?.value || "").trim();
  if (!code) { toast("Bitte Liegenschaft wählen.", 1800); return; }
  const recs    = (poRec?.value || "").split(/[;, ]+/).map(s => s.trim()).filter(Boolean);
  const subject = (poSubj?.value || "").trim();
  const replyTo = (poReply?.value || "").trim();

  poRules[code] = poRules[code] || {};

  // Wenn wir aus "Bearbeiten" kommen → bestehende Vorlage aktualisieren
  if (poEditState && poEditState.code === code) {
    if (poEditState.kind === "invoice") {
      // Hauptvorlage überschreiben
      poRules[code].invoice = { to: recs, subject, replyTo };
    } else if (poEditState.kind === "template") {
      const list = poRules[code].templates || [];
      const id   = poEditState.id || ("tmpl-" + Date.now().toString(36));
      let hit    = list.find(x => (x.id || x.label || x.subject) === poEditState.id);
      if (!hit) {
        hit = { id };
        list.push(hit);
      }
      hit.id          = id;
      hit.label       = subject || hit.label || id;   // neuer Betreff überschreibt tmpl-ID
      hit.to          = recs;
      hit.recipients  = recs;
      hit.subject     = subject;
      hit.replyTo     = replyTo;
      hit.invoiceOnly = true;
      poRules[code].templates = list;
    }

  } else {
    // Neuer Eintrag:
    // 1. falls noch keine Hauptvorlage existiert → diese füllen
    // 2. sonst zusätzliche Template-Vorlage anlegen
    const hasMain = !!(poRules[code].invoice && (poRules[code].invoice.subject ||
                     (poRules[code].invoice.to && poRules[code].invoice.to.length)));
    if (!hasMain) {
      poRules[code].invoice = { to: recs, subject, replyTo };
    } else {
      const list = poRules[code].templates || [];
      const id   = "tmpl-" + Date.now().toString(36);
      list.push({
        id,
        label: subject || id,
        to: recs,
        recipients: recs,
        subject,
        replyTo,
        invoiceOnly: true
      });
      poRules[code].templates = list;
    }
  }

  poEditState = null;

  poRec.value = ""; poSubj.value = ""; poReply.value = "";
  renderPoList();
});


  // ===== Speichern =====
  $("#emailsSave")?.addEventListener("click", async () => {
    const addressBook = Array.from($("#emailsTbody")?.querySelectorAll("tr") || []).map(tr => {
      const label = (tr.querySelector(".ab-label")?.textContent || tr.querySelector(".em-label")?.value || "").trim();
      const email = (tr.querySelector(".ab-email")?.textContent || tr.querySelector(".em-email")?.value || "").trim();
      const id    = (tr.querySelector(".ab-id")?.textContent    || tr.querySelector(".em-id")?.value    || "").trim();
      const tagsS = (tr.querySelector(".ab-tags")?.textContent  || tr.querySelector(".em-tags")?.value  || "");
      const tags  = tagsS.split(",").map(s => s.trim()).filter(Boolean);
      if (!EMAIL_RE.test(email)) { throw new Error("Ungültige E-Mail im Adressbuch: " + email); }
      return { label, name: label, email, id, tags };
    });

    const result = {
      addressBook,
      perObject: poRules,
      defaults: json.defaults || { replyTo: "documents@fidelior.de" }
    };

  try {
  await saveJson("emails.json", result);
  emailsCfg = result;               // direkt im laufenden State aktualisieren
  // Globale Aliase für Versanddialog aktualisieren
  window.emailsCfg      = result;
  window.__fdlEmailsCfg = result;
  populateMailSelect();             // Datalist/Select neu füllen

    // NEU: alten E-Mail-Prompt verwerfen, damit Betreff-Datalist neu aufgebaut wird
      const oldPrompt = document.getElementById("fdlEmailPrompt");
      if (oldPrompt) oldPrompt.remove();
  toast("E-Mail-Vorlagen gespeichert.", 2500);


      if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open");
    } catch (e) {
      console.error("Fehler beim Speichern von emails.json", e);
      toast("Fehler beim Speichern.", 2500);
    }
  });

  if (typeof dlg.showModal === "function") dlg.showModal();
  wireDialogClose?.(dlg);
}
async function openCheckboxesDialog(){
  await ensureConfigConnectedOrAsk();
  const dlg = $("#manageCheckboxesDialog");
  if (!dlg.__draggable) { makeDialogDraggable(dlg); dlg.__draggable = true; }

  if (!dlg) { toast("Checkboxen-Dialog fehlt im HTML.", 2500); return; }

  let cfg;
  try { cfg = await loadJson("checkboxes.json"); }
  catch { cfg = { saveTargets: [], emailTargets: [] }; }

  const saveList  = Array.isArray(cfg.saveTargets)  ? cfg.saveTargets  : [];
  const emailList = Array.isArray(cfg.emailTargets) ? cfg.emailTargets : [];

  const tbSave  = $("#cbSaveTbody");
  const tbEmail = $("#cbEmailTbody");
  tbSave.innerHTML = "";
  tbEmail.innerHTML = "";

  const rowSave = (def = { id:"", key:"", label:"", defaultChecked:false }) => {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td><input class="input slim cb-label" value="${(def.label||"").replaceAll('"','&quot;')}"></td>
      <td><input class="input slim cb-key"   value="${(def.key||"").replaceAll('"','&quot;')}"></td>

      <td class="cb-folder">
        <div class="row tight" style="flex-wrap:nowrap">
          <button type="button" class="btn-outline btn-small cb-pick">Ordner…</button>
          <button type="button" class="btn-outline btn-small cb-clear" title="Ordner-Bindung entfernen" disabled>✕</button>
          <span class="muted cb-bindstate" style="white-space:nowrap">kein Ordner</span>
        </div>
      </td>

      <td class="center"><input type="checkbox" class="cb-default" ${def.defaultChecked ? "checked":""}></td>
      <td class="right"><button type="button" class="btn-outline btn-small cb-del">Löschen</button></td>
    `;

    // id ist absichtlich NICHT editierbar, aber muss vorhanden sein:
    tr.dataset.id = def.id || "";

    // Systemziele (fix) vs. Eigene Ablagen (custom)
    const fixedKeys = new Set(["scope","backup","scopeBk","extras","local"]);
    const fixedIds  = new Set(["chkScopevisio","chkScope","chkScopeBk","chkPcloudBackup","chkPcloudExtra","chkPcloudExtras","chkLocalSave","chkLocal"]);
    const isFixed = fixedIds.has(tr.dataset.id) || fixedKeys.has(String(def.key||"").trim());
    if (isFixed) tr.classList.add("is-fixed");

    // Ordner-Bindung (optional): pro Checkbox-ID ein DirectoryHandle in IndexedDB speichern
    const bindKey = "customTarget:" + (tr.dataset.id || "");
    const bindStateEl = tr.querySelector(".cb-bindstate");
    const btnPick  = tr.querySelector(".cb-pick");
    const btnClear = tr.querySelector(".cb-clear");

    // Button-Text passend zum Typ (Systemziel vs. eigene Ablage)
    if (btnPick) btnPick.textContent = isFixed ? "Override…" : "Ordner…";
const btnDel   = tr.querySelector(".cb-del");
const inpLabel = tr.querySelector(".cb-label");
const inpKey   = tr.querySelector(".cb-key");

// UI je Typ
btnPick.textContent = isFixed ? "Override…" : "Ordner…";
btnPick.title = isFixed
  ? "Standardpfad dieses Systemziels optional auf einen anderen Ordner umleiten"
  : "Ordner für diese eigene Ablage auswählen";

// Systemziele dürfen nicht gelöscht/umbenannt werden
if (isFixed){
  if (btnDel){ btnDel.disabled = true; btnDel.style.visibility = "hidden"; }
  if (inpKey){ inpKey.readOnly = true; inpKey.setAttribute("aria-readonly","true"); inpKey.classList.add("is-readonly"); }
  if (inpLabel){ inpLabel.readOnly = true; inpLabel.setAttribute("aria-readonly","true"); inpLabel.classList.add("is-readonly"); }
}

    async function refreshBindState(){
  try{
    const h = await idbGet(bindKey);
    if (h) {
      bindStateEl.textContent = isFixed ? "Override aktiv" : "Ordner gesetzt";
      btnClear.disabled = false;
    } else {
      bindStateEl.textContent = isFixed ? "Standardpfad" : "kein Ordner";
      btnClear.disabled = true;
    }
  } catch {
    bindStateEl.textContent = isFixed ? "Standardpfad" : "kein Ordner";
    btnClear.disabled = true;
  }
}

    btnPick?.addEventListener("click", async () => {
      try{
        const h = await window.showDirectoryPicker({ mode:"readwrite" });
        await idbSet(bindKey, h);
        await refreshBindState();
        try { await refreshOverrideCache(); } catch {}
        toast(isFixed ? "Override gespeichert." : "Ordner gespeichert.", 1600);
      } catch (e) {
        // Abbruch ist ok
        if (e?.name !== "AbortError") {
          console.error(e);
          toast("Ordner konnte nicht gespeichert werden.", 2200);
        }
      }
    });

    btnClear?.addEventListener("click", async () => {
      try{
        await idbDel(bindKey);
        await refreshBindState();
        try { await refreshOverrideCache(); } catch {}
        toast(isFixed ? "Override entfernt." : "Ordner-Bindung entfernt.", 1600);
      } catch (e) {
        console.error(e);
        toast("Konnte Ordner-Bindung nicht entfernen.", 2200);
      }
    });

    // initial
    refreshBindState();
    try { refreshOverrideCache().catch(()=>{}); } catch {}

    tr.querySelector(".cb-del").addEventListener("click", async () => {
      try { await idbDel(bindKey); } catch {}
      tr.remove();
    });

    return tr;
  };

  const rowEmail = (def = { id:"", label:"", addressBookIds:[], status:null }) => {
    const tr = document.createElement("tr");
    const ids = Array.isArray(def.addressBookIds) ? def.addressBookIds.join(", ") : "";

    tr.innerHTML = `
      <td><input class="input slim cb-label" value="${(def.label||"").replaceAll('"','&quot;')}"></td>
      <td><input class="input slim cb-ids"   value="${ids.replaceAll('"','&quot;')}"></td>
      <td>
        <select class="input slim cb-status">
          <option value="" ${!def.status ? "selected":""}>–</option>
          <option value="open"   ${def.status==="open"?"selected":""}>open</option>
          <option value="review" ${def.status==="review"?"selected":""}>review</option>
        </select>
      </td>
      <td class="right"><button type="button" class="btn-outline btn-small cb-del">Löschen</button></td>
    `;

    tr.dataset.id = def.id || "";
    // Ordner-Bindung (optional): pro Checkbox-ID ein DirectoryHandle in IndexedDB speichern
    const bindKey = "customTarget:" + (tr.dataset.id || "");
    const bindStateEl = tr.querySelector(".cb-bindstate");
    const btnPick  = tr.querySelector(".cb-pick");
    const btnClear = tr.querySelector(".cb-clear");

    // Button-Text passend zum Typ (Systemziel vs. eigene Ablage)
    if (btnPick) btnPick.textContent = isFixed ? "Override…" : "Ordner…";

    async function refreshBindState(){
      try{
        const h = await idbGet(bindKey);
        if (h) {
          bindStateEl.textContent = "Ordner gesetzt";
          btnClear.disabled = false;
        } else {
          bindStateEl.textContent = "kein Ordner";
          btnClear.disabled = true;
        }
      } catch {
        bindStateEl.textContent = "kein Ordner";
        btnClear.disabled = true;
      }
    }

    btnPick?.addEventListener("click", async () => {
      try{
        const h = await window.showDirectoryPicker({ mode:"readwrite" });
        await idbSet(bindKey, h);
        await refreshBindState();
        try { await refreshOverrideCache(); } catch {}
        toast(isFixed ? "Override gespeichert." : "Ordner gespeichert.", 1600);
      } catch (e) {
        // Abbruch ist ok
        if (e?.name !== "AbortError") {
          console.error(e);
          toast("Ordner konnte nicht gespeichert werden.", 2200);
        }
      }
    });

    btnClear?.addEventListener("click", async () => {
      try{
        await idbDel(bindKey);
        await refreshBindState();
        try { await refreshOverrideCache(); } catch {}
        toast(isFixed ? "Override entfernt." : "Ordner-Bindung entfernt.", 1600);
      } catch (e) {
        console.error(e);
        toast("Konnte Ordner-Bindung nicht entfernen.", 2200);
      }
    });

    // initial
    refreshBindState();

    tr.querySelector(".cb-del").addEventListener("click", async () => {
      try { await idbDel(bindKey); } catch {}
      tr.remove();
    });

    return tr;
  };

  // render
  saveList.forEach(def => tbSave.appendChild(rowSave(def)));
  emailList.forEach(def => tbEmail.appendChild(rowEmail(def)));

  // Add buttons
  $("#cbSaveAdd")?.addEventListener("click", () => {
    // neue ID automatisch (stabil, nicht editierbar)
    const id = "chkCustom_" + Date.now().toString(36);
    tbSave.appendChild(rowSave({ id, key:"custom_"+Date.now().toString(36), label:"Neue Ablage", defaultChecked:false }));
  }, { once:false });

  $("#cbEmailAdd")?.addEventListener("click", () => {
    const id = "mail-custom-" + Date.now().toString(36);
    tbEmail.appendChild(rowEmail({ id, label:"Neue E-Mail", addressBookIds:[], status:null }));
  }, { once:false });

  // Save
  $("#checkboxesSave")?.addEventListener("click", async () => {
    // SaveTargets einsammeln
    const outSave = Array.from(tbSave.querySelectorAll("tr")).map(tr => {
      const id = tr.dataset.id || "";
      const label = (tr.querySelector(".cb-label")?.value || "").trim();
      const key   = (tr.querySelector(".cb-key")?.value   || "").trim();
      const defOn = !!tr.querySelector(".cb-default")?.checked;

      if (!id || !key) throw new Error("Ablage-Checkbox: id/key fehlt.");
      return { id, key, label, defaultChecked: defOn };
    });

    // EmailTargets einsammeln
    const outEmail = Array.from(tbEmail.querySelectorAll("tr")).map(tr => {
      const id = tr.dataset.id || "";
      const label = (tr.querySelector(".cb-label")?.value || "").trim();
      const idsS  = (tr.querySelector(".cb-ids")?.value   || "");
      const status = (tr.querySelector(".cb-status")?.value || "").trim() || null;

      if (!id) throw new Error("E-Mail-Checkbox: id fehlt.");

      const addressBookIds = idsS.split(",").map(s => s.trim()).filter(Boolean);
      return { id, label, addressBookIds, status };
    });

    const out = { saveTargets: outSave, emailTargets: outEmail };

    try {
      await saveJson("checkboxes.json", out);
      window.__fdlCheckboxesCfg = out;
      try { localStorage.setItem("fdlCheckboxesCfg", JSON.stringify(out)); } catch {}

// Voreinstellungen sofort auf die Hauptansicht anwenden
try{
  const defaults = {};
  for (const def of outSave){
    defaults[String(def.id)] = !!def.defaultChecked;
  }
  localStorage.setItem("fdlTargets", JSON.stringify(defaults));
} catch {}



      // UI sofort aktualisieren
      try { await ensureSaveCheckboxes(); } catch {}
      try { window.__fdlRefreshEmailCheckboxes?.(); } catch {}

      toast("Checkboxen gespeichert.", 2000);
      dlg.close?.();
    } catch (e) {
      console.error(e);
      toast("Fehler beim Speichern der Checkboxen.", 2500);
    }
  });

  if (typeof dlg.showModal === "function") dlg.showModal();
  wireDialogClose?.(dlg);
}

async function openStampDialog(){
  await ensureConfigConnectedOrAsk();
  const dlg = $("#manageStampDialog");
  if (!dlg.__draggable) { makeDialogDraggable(dlg); dlg.__draggable = true; }

  if (!dlg) { toast("Stempel-Dialog fehlt im HTML.", 2500); return; }

 const txt     = dlg.querySelector("#stampText");
const cbEn    = dlg.querySelector("#stampEnabled");
const cbDat   = dlg.querySelector("#stampInclDate");
const cbObj   = dlg.querySelector("#stampInclObj");

const cbPaid  = dlg.querySelector("#stampPaidEnabled");
const txtPaid = dlg.querySelector("#stampPaidText");

const btn     = dlg.querySelector("#stampSaveBtn");

  let cfg;
  try {
    cfg = await loadJson("stamp.json");
  } catch {
    cfg = {
      enabled: true,
      coreText: "EINGEGANGEN",
      includeDate: true,
      includeObject: true
    };
  }

  cbEn.checked  = cfg.enabled !== false;
  txt.value     = cfg.coreText || "EINGEGANGEN";
  cbDat.checked = cfg.includeDate !== false;
  cbObj.checked = cfg.includeObject !== false;
  cbPaid.checked = cfg.paidEnabled === true;
txtPaid.value  = cfg.paidText || "BEZAHLT";


  btn.onclick = async () => {
const out = {
  enabled:       !!cbEn.checked,
  coreText:      (txt.value || "EINGEGANGEN").trim() || "EINGEGANGEN",
  includeDate:   !!cbDat.checked,
  includeObject: !!cbObj.checked,

  paidEnabled:   !!cbPaid.checked,
  paidText:      (txtPaid.value || "BEZAHLT").trim() || "BEZAHLT"
};

    try {
      await saveJson("stamp.json", out);
      stampCfg = out; // Cache aktualisieren
      toast("Stempel-Einstellungen gespeichert.", 2000);
      dlg.close?.();
    } catch (e) {
      console.error(e);
      toast("Stempel-Konfiguration konnte nicht gespeichert werden.", 3000);
    }
  };

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "open");

  if (!dlg.__wired && typeof wireDialogClose === "function") {
    wireDialogClose(dlg);
    dlg.__wired = true;
  }
}


async function openObjectsDialog(){
  // 1) Sicherstellen, dass config/ verbunden ist
  await ensureConfigConnectedOrAsk();

  const dlg = $("#manageObjectsDialog");
  if (!dlg.__draggable) { makeDialogDraggable(dlg); dlg.__draggable = true; }

  if (!dlg){
    toast("Objekte-Dialog fehlt.", 2000, "err");
    return;
  }

  // 2) config/objects.json laden
  let cfg;
  try {
    cfg = await loadJson("objects.json");
  } catch {
    cfg = { objects: [] };
  }
  const list = Array.isArray(cfg.objects) ? cfg.objects : [];

  const ul = $("#objectsList");
  ul.innerHTML = "";

  // --- Neue Zeile erzeugen ---
  const addRow = (o = { displayName:"", code:"", scopevisioName:"", pcloudName:"" }) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="row tight">
        <input class="input slim ob-name"  placeholder="Anzeigename"  value="${o.displayName || ""}">
        <input class="input slim ob-code"  placeholder="Code (optional)" value="${o.code || ""}">
        <input class="input slim ob-scope" placeholder="Scopevisio (optional)" value="${o.scopevisioName || ""}">
        <input class="input slim ob-pcl"   placeholder="pCloud (optional)" value="${o.pcloudName || ""}">
        <button class="icon-btn ob-del" title="Löschen">🗑️</button>
      </div>`;
    
    li.querySelector(".ob-del").addEventListener("click", () => li.remove());
    ul.appendChild(li);
  };

  // Bestehende Objekte einfügen
  list.forEach(addRow);

  // +Neu-Button → neue Zeile
  $("#objectsAddRow")?.addEventListener("click", () => addRow({}));

  // --- Automatisches Füllen der technischen Felder ---
  function autoFill(obj){
    const name = obj.displayName.trim();
    if (!name) return;

    // Code automatisch erzeugen, wenn leer
    if (!obj.code){
      obj.code = name
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "_");
    }

    // ScopevisioName automatisch setzen
    if (!obj.scopevisioName){
      obj.scopevisioName = obj.code;
    }

    // pCloudName automatisch setzen
    if (!obj.pcloudName){
      obj.pcloudName = obj.code;
    }
  }

  // --- Speichern ---
  $("#objectsSaveShared")?.addEventListener("click", async () => {
    try{
      const rows = [...ul.querySelectorAll("li")].map(li => {
        const displayName = li.querySelector(".ob-name")?.value.trim();
        const code        = li.querySelector(".ob-code")?.value.trim();
        const scope       = li.querySelector(".ob-scope")?.value.trim();
        const pcl         = li.querySelector(".ob-pcl")?.value.trim();

        if (!displayName) return null; // komplett leere Zeilen raus

        const obj = { displayName, code, scopevisioName:scope, pcloudName:pcl };

        autoFill(obj);   // 🔥 Automatische Befüllung anwenden
        return obj;
      }).filter(Boolean);

      const next = { objects: rows };
      await saveJson("objects.json", next);
      objectsCfg = next;
      await loadObjects();

      toast("<strong>Liegenschaften gespeichert.</strong>", 1800);
      dlg.close?.();
    } catch (e){
      console.error(e);
      toast("Fehler beim Speichern der Liegenschaften.", 2500, "err");
    }
  });

  // --- Dialog öffnen ---
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "open");

  wireDialogClose(dlg);
}

  async function openTypesDialog(){ await ensureConfigConnectedOrAsk(); const dlg=$("#manageTypesDialog");
    if (!dlg.__draggable) { makeDialogDraggable(dlg); dlg.__draggable = true; }

    if(!dlg){ toast("Dokumentarten-Dialog fehlt.",2000); return; } let j; try{ j = await loadJson("document_types.json"); }catch{ j={types:[], defaultTypeKey:""}; } const list=j.types||[]; const ul=$("#typesList"); ul.innerHTML=""; const defaultKey=j.defaultTypeKey||"";
    const addRow=(t={label:"", key:"", isInvoice:false})=>{ const li=document.createElement("li"); li.innerHTML = `
        <div class="row tight">
          <input class="input slim ty-label" placeholder="Label" value="${t.label||""}">
          <input class="input slim ty-key"   placeholder="Key"   value="${t.key||""}">
          <label class="chk" style="margin-left:.5rem"><input type="checkbox" class="ty-inv" ${t.isInvoice?"checked":""}> Rechnung</label>
          <label class="chk" style="margin-left:1rem"><input type="radio" name="ty-default" class="ty-def" ${t.key===defaultKey?"checked":""}> Default</label>
          <button class="icon-btn ty-del" title="Löschen">🗑️</button>
        </div>`; li.querySelector(".ty-del").addEventListener("click",()=>li.remove()); ul.appendChild(li); };
    list.forEach(addRow); $("#typesAddRow")?.addEventListener("click",()=>addRow({}));
    $("#typesSaveShared")?.addEventListener("click", async()=>{ try{ const rows=[...ul.querySelectorAll("li")].map(li=>{ const label=li.querySelector(".ty-label")?.value.trim(); let key=li.querySelector(".ty-key")?.value.trim(); const isInv=li.querySelector(".ty-inv")?.checked||false; const isDef=li.querySelector(".ty-def")?.checked||false; if(!label) return null; if(!key) key=label.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9\-]/g,""); return {label, key, isInvoice:isInv, isDefault:isDef}; }).filter(Boolean); const def = rows.find(r=>r.isDefault)?.key || ""; const types = rows.map(({isDefault, ...t})=>t); const next={types, defaultTypeKey:def}; await saveJson("document_types.json", next); docTypesCfg=next; await loadDocTypes(); toast("<strong>Dokumentarten gespeichert</strong>",1800); dlg.close?.(); }catch(e){ toast("Fehler beim Speichern der Dokumentarten.",2500); } });
    if (typeof dlg.showModal==="function") dlg.showModal(); else dlg.setAttribute("open","open"); wireDialogClose(dlg);
  }

// ====== ERSATZ (komplett): openAssignmentsDialog ======
async function openAssignmentsDialog() {
  await ensureConfigConnectedOrAsk();

  const dlg = $("#manageAssignmentsDialog");
  if (!dlg.__draggable) { makeDialogDraggable(dlg); dlg.__draggable = true; }

  if (!dlg) { toast("Zuordnungs-Dialog fehlt.", 2000); return; }

  // Bestehende Regeln laden
  let j;
  try { j = await loadJson("assignments.json"); }
  catch { j = { patterns: [] }; }

  const tbody = $("#assignTbody");
  tbody.innerHTML = "";

  // Tabellenzeile (leichtgewichtig)
  const addRow = (row = { pattern: "", object: "", subfolder: "", note: "" }) => {
    const esc = s => String(s || "").replace(/"/g, "&quot;");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="input slim as-pat" placeholder="RegEx oder mehrere per |" value="${esc(row.pattern)}"></td>
      <td><input class="input slim as-obj" placeholder="Objektcode (z. B. B75)"  value="${esc(row.object)}"></td>
      <td><input class="input slim as-sub" placeholder="Unterordner (optional)"  value="${esc(row.subfolder)}"></td>
      <td><input class="input slim as-note" placeholder="Hinweis (optional)"     value="${esc(row.note)}"></td>
      <td class="right"><button class="icon-btn as-del" title="Löschen">🗑️</button></td>
    `;
    tr.querySelector(".as-del").onclick = () => tr.remove();
    tbody.appendChild(tr);
    return tr;
  };

  // Vorhandene Regeln in die Tabelle
  (j.patterns || []).forEach(addRow);

  // --- NEU: Objektliste für die Einfach-Eingabe (#saObject) füllen ---
  try {
    const o = await loadJson("objects.json");
    const sel = $("#saObject");
    if (sel) {
      const opts = (o.objects || []).map(x => {
        const val = x.code || x.scopevisioName || x.displayName || "";
        const txt = x.displayName || x.code || x.scopevisioName || "";
        return `<option value="${val}">${txt}</option>`;
      }).join("");
      sel.innerHTML = `<option value="">(Objekt wählen)</option>${opts}`;
      sel.value = "";
    }
  } catch {
    const sel = $("#saObject");
    if (sel) {
      sel.innerHTML = `
        <option value="">(Objekt wählen)</option>
        <option value="PRIVAT">PRIVAT</option>
        <option value="FIDELIOR">FIDELIOR</option>
        <option value="ARNDTCIE">ARNDT & CIE</option>`;
      sel.value = "";
    }
  }


// --- Unterordner-Vorschläge für #saSub (robust & ohne Duplikate) ---
(function setupSaSubDatalist(){
  try {
    // nur einmal pro Seite initialisieren
    if (window.__fdl_saSubSetupDone) return;
    window.__fdl_saSubSetupDone = true;

    const input = document.querySelector("#saSub");
    if (!input) return;

    // evtl. doppelte Datalists mit gleicher ID entfernen
    document.querySelectorAll('[id="saSubList"]').forEach((n,i)=>{ if(i>0) n.remove(); });

    // datalist erzeugen/holen
    let dl = document.getElementById("saSubList");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "saSubList";
      input.setAttribute("list", "saSubList");
      (input.parentElement || document.body).appendChild(dl);
    }

    async function gatherSubfolders(code){
      const uniq = new Set();

      (getKnownSubfolders(code) || []).forEach(s => { if (s) uniq.add(String(s).trim()); });

      const { scopeName, pcloudName } = getFolderNames(code);

      const jobs = [];
      if (scopeRootHandle) {
        jobs.push(listChildFolders(scopeRootHandle, ["OBJEKTE", scopeName, "Rechnungsbelege"]));
        jobs.push(listChildFolders(scopeRootHandle, ["OBJEKTE", scopeName, "Objektdokumente"]));
      }
      if (pcloudRootHandle && !isArndtCie(code)) {
        jobs.push(listChildFolders(pcloudRootHandle, ["FIDELIOR","OBJEKTE", pcloudName, "Rechnungsbelege"]));
        jobs.push(listChildFolders(pcloudRootHandle, ["FIDELIOR","OBJEKTE", pcloudName, "Objektdokumente"]));
      }

      const lists = (await Promise.all(jobs).catch(()=>[[]])).flat();
      lists.forEach(n => { if (n) uniq.add(String(n).trim()); });

      const priority = ["Allgemein","D1","D4"];
      return Array.from(uniq)
        .filter(Boolean)
        .sort((a,b)=>{
          const ia = priority.indexOf(a), ib = priority.indexOf(b);
          if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
          const ya = /^\d{4}$/.test(a) ? -parseInt(a,10) : 0;
          const yb = /^\d{4}$/.test(b) ? -parseInt(b,10) : 0;
          if (ya !== yb) return ya - yb; // Jahre absteigend
          return a.localeCompare(b, "de");
        });
    }

    async function refill(){
      // Sicherheit: nur erste Datalist behalten
      document.querySelectorAll('[id="saSubList"]').forEach((n,i)=>{ if(i>0) n.remove(); });
      dl.textContent = "";

      const code = (document.querySelector("#saObject")?.value || "").trim();
      if (!code) return;

      const items = await gatherSubfolders(code);
      const seen = new Set();
      for (const v of items) {
        const val = String(v||"").trim();
        const key = val.toLowerCase();
        if (!val || seen.has(key)) continue;
        seen.add(key);
        const opt = document.createElement("option");
        opt.value = val;
        dl.appendChild(opt);
      }
    }

    document.querySelector("#saObject")?.addEventListener("change", refill);
    refill(); // initial füllen

    // Datalist beim Fokus/Klick zeigen
    input.setAttribute("autocomplete", "off");
    const showAll = () => {
      const prev = input.value;
      input.value = " ";
      input.dispatchEvent(new Event("input", { bubbles:true }));
      setTimeout(() => { input.value = prev; }, 0);
    };
    input.addEventListener("focus", showAll);
    input.addEventListener("click", showAll);
    input.addEventListener("keydown", (e)=>{ if (e.key === "ArrowDown") showAll(); });
  } catch(e) {
    console.warn("setupSaSubDatalist failed:", e);
  }
})();



  // --- Pattern-Builder (wie gehabt) ---
  const escRx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loosenId = (id) => {
    const raw = String(id || "").trim();
    if (!raw) return "";
    const chunks = raw.replace(/\s+/g, "").match(/[A-Za-z]+|\d+/g) || [raw];
    const expandDigits = (d) => (d.length >= 7 ? [d.slice(0, 3), d.slice(3)] : (d.match(/\d{1,2}/g) || [d]));
    const parts = chunks.flatMap(ch => /\d/.test(ch) ? expandDigits(ch) : [ch]);
   return parts.map(p => escRx(p)).join("[\\s./\\-–—−]*");

  };
  const buildPattern = (vendor, ident) => {
    const la = [];
    if (vendor) la.push(`(?=.*${escRx(String(vendor).trim())})`);
    if (ident)  la.push(`(?=.*${loosenId(ident)})`);
    return la.join("");
  };


  // → Regel erstellen (Einfach-Modus)
  $("#saAddBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    const vendor = ($("#saVendor")?.value || "").trim();
    const ident  = ($("#saId")?.value     || "").trim();
    const obj    = ($("#saObject")?.value || "").trim();
    const sub    = ($("#saSub")?.value    || "").trim();
    const note   = ($("#saNote")?.value   || "").trim();

    if (!vendor && !ident) { toast("Bitte Lieferant/Stichwort oder Kundennr. eingeben.", 2200); return; }
    if (!obj) { toast("Bitte ein Objekt wählen.", 2000); return; }

    if (sub) {
      const inList = !!([...($("#saSubList")?.children || [])].find(o => o.value === sub));
      if (!inList) toast(`Hinweis: Unterordner „<code>${sub}</code>“ ist für <strong>${obj}</strong> nicht bekannt.`, 3200);
    }

    const pat = buildPattern(vendor, ident);
    if (!pat) { toast("Konnte kein Muster erzeugen.", 2000); return; }

    addRow({
      pattern: pat,
      object: obj,
      subfolder: sub || undefined,
      note: note || (vendor || ident ? `auto: ${vendor || ""}${ident ? ` · ${ident}` : ""}`.trim() : "")
    });

    if ($("#saVendor")) $("#saVendor").value = "";
    if ($("#saId"))     $("#saId").value     = "";
    if ($("#saNote"))   $("#saNote").value   = "";
    if ($("#saSub"))    $("#saSub").value    = "";
    if ($("#saObject")) $("#saObject").value = "";

    toast("Regel hinzugefügt (bearbeitbar).", 1600);
  });

  // +Neu: leere manuelle Zeile
  $("#assignAdd")?.addEventListener("click", () => addRow({}));

  // Speichern (RegEx-Validierung; Unterordner optional)
  $("#assignSave")?.addEventListener("click", async () => {
    try {
      const rows = [...tbody.querySelectorAll("tr")].map(tr => {
        const pattern = (tr.querySelector(".as-pat")?.value || "").trim();
        const object  = (tr.querySelector(".as-obj")?.value || "").trim();
        const sub     = (tr.querySelector(".as-sub")?.value || "").trim();
        const note    = (tr.querySelector(".as-note")?.value || "").trim();

        if (!pattern || !object) return null;

       const okMain = (() => {
  const pat = String(pattern).trim();
  if (!pat) return false;        // nichts leeres speichern
  try { new RegExp(pat, "i");    // einmal komplett validieren
       return true;
  } catch { return false; }
})();

        if (!okMain) throw new Error(`Ungültiges Pattern: ${pattern}`);

        const rec = { pattern, object };
        if (sub)  rec.subfolder = sub;
        if (note) rec.note      = note;
        return rec;
      }).filter(Boolean);

      const next = { patterns: rows };
      await saveJson("assignments.json", next);

      assignmentsCfg = next;
      try { if (pdfDoc) await autoRecognize(); } catch {}

      toast("<strong>Zuordnung gespeichert</strong>", 1800);
      dlg.close?.();
    } catch (e) {
      toast(`Fehler beim Speichern: ${e?.message || e}`, 2800);
    }
  });

  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "open");
  wireDialogClose(dlg);
}


  $("#mailManageBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); openEmailsDialog(); });
  $("#manageObjectsBtn") ?.addEventListener("click", (e)=>{ e.preventDefault(); openObjectsDialog(); });
  $("#manageDocTypesBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); openTypesDialog(); });
  $("#manageAssignmentsBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); openAssignmentsDialog(); });

// === Einstellungs-Zentrale (Zahnrad) ===
(() => {
  const dlg = document.getElementById("settingsDialog");
  if (!dlg) return;

  // kleines Hilfs-Wrapper für querySelector
  const $ = (sel, el = document) => el.querySelector(sel);

  function ensureSettingsWired() {
    if (dlg.__wired) return;
    if (typeof wireDialogClose === "function") {
      wireDialogClose(dlg);
    }
    dlg.__wired = true;
  }

  // Zahnrad oben rechts öffnet die Einstellungs-Zentrale
  $("#settingsBtn")?.addEventListener("click", () => {
    ensureSettingsWired();
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "open");
  });

  // Verbindungen: Verbindungs-Zentrale (nicht Zähler)
  $("#btnSettingsConnections")?.addEventListener("click", (e) => {
    e.preventDefault();
    dlg.close?.();
    if (typeof window.openConnectionsCenter === "function") {
      window.openConnectionsCenter();
    } else {
      toast("Verbindungs-Zentrale ist nicht verfügbar.", 3000);
    }
  });

  // Versand verwalten (E-Mail)
  $("#btnSettingsEmails")?.addEventListener("click", (e) => {
    e.preventDefault();
    dlg.close?.();
    if (typeof openEmailsDialog === "function") {
      openEmailsDialog();
    } else {
      toast("E-Mail-Verwaltung ist nicht verfügbar.", 3000);
    }
  });
    // Wasserzeichen / Stempel
  $("#btnSettingsStamp")?.addEventListener("click", (e) => {
    e.preventDefault();
    dlg.close?.();
    if (typeof openStampDialog === "function") {
      openStampDialog();
    } else {
      toast("Stempel-Verwaltung ist nicht verfügbar.", 3000);
    }
  });


  // Liegenschaften verwalten
  $("#btnSettingsObjects")?.addEventListener("click", (e) => {
    e.preventDefault();
    dlg.close?.();
    if (typeof openObjectsDialog === "function") {
      openObjectsDialog();
    } else {
      toast("Liegenschafts-Verwaltung ist nicht verfügbar.", 3000);
    }
  });

  // Dokumentarten verwalten
  $("#btnSettingsTypes")?.addEventListener("click", (e) => {
    e.preventDefault();
    dlg.close?.();
    if (typeof openTypesDialog === "function") {
      openTypesDialog();
    } else {
      toast("Dokumentarten-Verwaltung ist nicht verfügbar.", 3000);
    }
  });

  // Zuordnungsmuster
  $("#btnSettingsAssignments")?.addEventListener("click", (e) => {
      // Checkboxen verwalten
  $("#btnSettingsCheckboxes")?.addEventListener("click", (e) => {
    e.preventDefault();
    dlg.close?.();
    if (typeof openCheckboxesDialog === "function") {
      openCheckboxesDialog();
    } else {
      toast("Checkboxen-Verwaltung ist nicht verfügbar.", 3000);
    }
  });

    e.preventDefault();
    dlg.close?.();
    if (typeof openAssignmentsDialog === "function") {
      openAssignmentsDialog();
    } else {
      toast("Zuordnungsmuster sind nicht verfügbar.", 3000);
    }
  });
    // Checkboxen verwalten
  $("#btnSettingsCheckboxes")?.addEventListener("click", (e) => {
    e.preventDefault();
    dlg.close?.();
    if (typeof openCheckboxesDialog === "function") {
      openCheckboxesDialog();
    } else {
      toast("Checkboxen-Verwaltung ist nicht verfügbar.", 3000);
    }
  });

})();



function arrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  const chunk = 0x8000; // 32k
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ===============================================================
// E-MAIL-PROMPT (Dialog) – wird dynamisch ins DOM gebaut
// Zeigt eine klare Entscheidung: "Nur speichern" vs. "Speichern & E-Mail senden"
// ===============================================================
function shouldAskForEmail() {
  try {
    const code = (objSel?.value || "").trim().toUpperCase();
    if (code !== "FIDELIOR" && code !== "EGYO") return false;

    // Rechnungserkennung – bei Unklarheit lieber JA (Dialog zeigen)
    let inv = true;
    if (typeof isInvoice === "function") {
      inv = !!isInvoice();
    } else if (typeSel?.selectedOptions?.[0]) {
      inv = typeSel.selectedOptions[0].dataset?.isinvoice === "true";
    }
    return inv !== false;
  } catch {
    return true; // Sicherheitsnetz: lieber zeigen
  }
}

function buildEmailPromptDialog(defaults = {}) {
  let dlg = document.getElementById("fdlEmailPrompt");
  if (dlg) return dlg;

  dlg = document.createElement("dialog");
  dlg.id = "fdlEmailPrompt";
  dlg.style.padding = "0";
  dlg.style.border = "none";

  // Datalist für Empfänger sicher aktualisieren
  if (typeof populateMailSelect === "function") {
    try { populateMailSelect(); } catch (e) {
      console.warn("[FDL] populateMailSelect im Versanddialog fehlgeschlagen:", e);
    }
  }

  dlg.innerHTML = `
    <form method="dialog" style="min-width:520px;max-width:680px">
      <div style="padding:18px 20px;border-bottom:1px solid var(--line,#E2E8F0);display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:16px">E-Mail versenden?</strong>
        <button class="dlg-close" value="cancel" aria-label="Schließen" style="font-size:20px;line-height:1;border:none;background:none;cursor:pointer">×</button>
      </div>

      <div style="padding:16px 20px;display:grid;gap:12px">
        <p style="margin:0 0 8px 0">Die Rechnung wird gespeichert. Möchten Sie sie zusätzlich per E-Mail verschicken?</p>

        <div id="fdlEmailSection" style="display:none;gap:10px">
          <label class="row" style="display:grid;gap:6px">
            <span>Empfänger:</span>
            <input id="fdlMailTo" class="input slim" list="mailBook" placeholder="name@firma.de">
          </label>

          <details id="fdlAdv" style="margin-top:4px">
            <summary style="cursor:pointer">Weitere Felder (CC/BCC, Reply-To)</summary>
            <div style="display:grid;gap:10px;margin-top:8px">
              <label class="row" style="display:grid;gap:6px">
                <span>CC:</span>
                <input id="fdlMailCc" class="input slim" placeholder="optional" list="mailBook">
              </label>
              <label class="row" style="display:grid;gap:6px">
                <span>BCC:</span>
                <input id="fdlMailBcc" class="input slim" placeholder="optional" list="mailBook">
              </label>
              <label class="row" style="display:grid;gap:6px">
                <span>Reply-To:</span>
                <input id="fdlMailReply" class="input slim" placeholder="z. B. documents@fidelior.de">
              </label>
            </div>
          </details>

          <label class="row" style="display:grid;gap:6px">
            <span>Betreff:</span>
            <input id="fdlMailSubj" class="input slim" placeholder="Betreff">
          </label>

          <!-- NEU: optionale Freitext-Nachricht -->
          <label class="row" style="display:grid;gap:6px">
            <span>Nachricht (optional):</span>
            <textarea id="fdlMailBody" class="input" rows="3"
              placeholder="Kurze Nachricht an den Empfänger"></textarea>
          </label>

          <div style="font-size:12px;color:#55637A;margin-top:2px">
            Anhang: <code id="fdlMailAttachment">dokument.pdf</code>
          </div>

          <div id="fdlGentleNote" style="display:none;font-size:12px;margin-top:6px">
            ⚠ Bitte prüfen Sie die Empfängeradresse vor dem Versand.
          </div>
        </div>
      </div>

      <div style="padding:14px 20px;border-top:1px solid var(--line,#E2E8F0);display:flex;gap:10px;justify-content:flex-end">
        <button id="fdlBtnSaveOnly" class="btn" type="button">Nur speichern</button>
        <button id="fdlBtnSaveAndSend" class="btn btn-outline" type="button" value="send">Speichern & E-Mail senden</button>
      </div>
    </form>
  `;
  document.body.appendChild(dlg);

  const to   = dlg.querySelector("#fdlMailTo");
  const cc   = dlg.querySelector("#fdlMailCc");
  const bcc  = dlg.querySelector("#fdlMailBcc");
  const subj = dlg.querySelector("#fdlMailSubj");
  const rep  = dlg.querySelector("#fdlMailReply");
  const body = dlg.querySelector("#fdlMailBody");      // NEU
  const att  = dlg.querySelector("#fdlMailAttachment");
  const sec  = dlg.querySelector("#fdlEmailSection");
  const note = dlg.querySelector("#fdlGentleNote");
  const btnSend = dlg.querySelector("#fdlBtnSaveAndSend");
  const btnOnly = dlg.querySelector("#fdlBtnSaveOnly");

  /* PATCH C1: Empfänger-Vorschläge (sanft, tippbar) */
  (function enableMailToSuggestions(){
    const input = dlg.querySelector("#fdlMailTo");
    if (!input || input.__suggestInit) return;
    input.__suggestInit = true;
    input.setAttribute("autocomplete","off");

    function showAllOnce(){
      const prev = input.value;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles:true }));
      setTimeout(() => { input.value = prev; }, 0);
    }

    input.addEventListener("focus", showAllOnce);
    input.addEventListener("click", showAllOnce);
    input.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") showAllOnce(); });
  })();

  /* PATCH C2: Betreff-Vorlagen (sanft, kein Blur/Reset) */
  (function setupSubjectDatalist(){
    if (!subj || subj.__subjectInit) return;
    subj.__subjectInit = true;
    subj.setAttribute("autocomplete","off");

    // Datalist einmalig
    let dl = document.getElementById("subjectBook");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "subjectBook";
      document.body.appendChild(dl);
    }
    subj.setAttribute("list","subjectBook");

    // Kandidaten sammeln
    const items = new Set();
    const code  = (objSel?.value || "").trim().toUpperCase();
    const isInv = (typeof isInvoice === "function") ? !!isInvoice() : true;

    try {
      if (isInv && code) {
        const per = emailsCfg?.perObject?.[code] || {};
        const inv = per.invoice || {};
        if (inv.subject) items.add(inv.subject);
        (per.templates || []).forEach(t => {
          if (t && t.subject) items.add(t.subject);
        });
      }
    } catch {}

    // Datalist füllen (ohne Duplikate)
    dl.textContent = "";
    [...items].filter(Boolean).forEach(v => {
      const o = document.createElement("option");
      o.value = v;
      dl.appendChild(o);
    });

    // Liste anzeigen – ohne blur/empty, damit Tippen nicht blockiert
    function peekList(){
      const prev = subj.value;
      subj.value = prev + " ";
      subj.dispatchEvent(new Event("input", { bubbles:true }));
      setTimeout(() => { subj.value = prev; }, 0);
    }
    subj.addEventListener("focus", peekList);
    subj.addEventListener("click", peekList);
    subj.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") peekList(); });
  })();

  btnSend.disabled = false;
  btnSend.removeAttribute("disabled");
  btnSend.style.pointerEvents = "auto";
  btnSend.setAttribute("aria-disabled", "false");

  // „Nur speichern“ schließt sicher
  btnOnly.addEventListener("click", (e) => { e.preventDefault(); dlg.close?.(); });

  // Prefill + Validierung
  dlg.__fdlPrefill = (p = {}) => {
    att.textContent = p.attachmentName || "dokument.pdf";
    to.value = ""; cc.value = ""; bcc.value = "";
    subj.value = (p.subject || "").trim();
    rep.value  = (p.replyTo || "").trim();
    if (body) body.value = (p.text || "");   // falls später einmal vorbelegt werden soll
window.getSelectedEmailTargets = function(){
  const res = { to: [], cc: [], bcc: [], subject: "", replyTo: "", status: null };

  const book = (window.emailsCfg && Array.isArray(window.emailsCfg.addressBook))
    ? window.emailsCfg.addressBook
    : [];

  const host = document.getElementById("emailTargets");
  if (!host) return res;

  const pushUnique = (arr, v) => {
    const s = (v || "").trim();
    if (!s) return;
    if (!arr.includes(s)) arr.push(s);
  };

  // Priorität: review > open > null
  const rank = (st) => st === "review" ? 2 : st === "open" ? 1 : 0;
  let bestStatus = null;

  host.querySelectorAll("input[type='checkbox']").forEach(cb => {
    if (!cb.checked) return;

    // Status sammeln (mit Priorität)
    const st = (cb.dataset.status || "").trim() || null;
    if (rank(st) > rank(bestStatus)) bestStatus = st;

    // optional: subject/replyTo direkt aus Checkbox (Verwaltung)
    const subj = (cb.dataset.subject || "").trim();
    const rep  = (cb.dataset.replyto || "").trim();
    if (!res.subject && subj) res.subject = subj;
    if (!res.replyTo && rep)  res.replyTo = rep;

    // addressBookIds -> echte E-Mails
    const ids = (cb.dataset.addrIds || "").split(",").map(s => s.trim()).filter(Boolean);
    ids.forEach(id => {
      const hit = book.find(e =>
        e && String(e.id || "").toLowerCase() === String(id || "").toLowerCase()
      );
      if (hit?.email) pushUnique(res.to, hit.email);
    });
  });

  res.status = bestStatus;

  // Falls kein subject direkt gesetzt wurde: aus Status ableiten
  if (!res.subject) {
    if (res.status === "open")   res.subject = "NEUE RECHNUNG – ZAHLUNG OFFEN";
    if (res.status === "review") res.subject = "RECHNUNGSPRÜFUNG ERFORDERLICH";
  }

  return res;
};


    // Neue Empfängervoreinstellung aus den Versand-Checkboxen
    try {
      if (typeof window.getSelectedEmailTargets === "function") {
        const sel = window.getSelectedEmailTargets() || {};
        const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

        const toList  = uniq(sel.to);
        const ccList  = uniq(sel.cc);
        const bccList = uniq(sel.bcc);

        if (toList.length || ccList.length || bccList.length) {
          to.value  = toList.join(", ");
          cc.value  = ccList.join(", ");
          bcc.value = bccList.join(", ");
          sec.style.display = "grid";
          // Betreff/Reply-To aus Checkbox-Verwaltung übernehmen (falls geliefert)
if (sel.subject && !subj.value.trim()) subj.value = String(sel.subject).trim();
if (sel.replyTo && rep && !rep.value.trim()) rep.value = String(sel.replyTo).trim();

        } else {
          sec.style.display = "none";
        }
      } else {
        sec.style.display = "none";
      }
    } catch (e) {
      console.warn("[FDL] getSelectedEmailTargets fehlgeschlagen:", e);
      sec.style.display = "none";
    }

    note.style.display = "none";

    const validate = () => {
      const open = sec.style.display !== "none";
      const ok = open ? (!!to.value.trim() && !!subj.value.trim()) : true;
      btnSend.disabled = !ok;
      const s = `${to.value},${cc.value},${bcc.value}`.toLowerCase();
      note.style.display = /yachthafen@/.test(s) ? "block" : "none";
    };
    ["input","change","keyup"].forEach(ev => {
      to.addEventListener(ev, validate);
      cc.addEventListener(ev, validate);
      bcc.addEventListener(ev, validate);
      subj.addEventListener(ev, validate);
    });
    validate();
  };


  // *** WICHTIG: erster Klick öffnet nur die Felder – KEIN Versand, KEIN close ***
  btnSend.addEventListener("click", (e) => {
    if (sec.style.display === "none") {
      e.preventDefault();
      e.stopImmediatePropagation();
      sec.style.display = "grid";
      to?.focus();
    }
  });

  return dlg;
}


// Öffnet den Dialog und gibt eine Entscheidung zurück
function promptForEmailOnce({ attachmentName, subject, replyTo }) {
  return new Promise((resolve) => {
    const dlg = buildEmailPromptDialog();
    dlg.__fdlPrefill({ attachmentName, subject, replyTo });

    // NEU: Vorlagen für die aktuelle Liegenschaft/Objekt bereitstellen
    try {
      fdlSetupMailTemplates(dlg);
    } catch (e) {
      console.warn("[FDL] Mail-Templates Setup fehlgeschlagen:", e);
    }

    const btnSend = dlg.querySelector("#fdlBtnSaveAndSend");
    const btnOnly = dlg.querySelector("#fdlBtnSaveOnly");

    let done = false; // verhindert Doppel-Resolve

    const cleanup = () => {
      dlg?.removeEventListener("close", onClose);
      btnSend?.removeEventListener("click", onClickSend);
      btnOnly?.removeEventListener("click", onClickOnly);
    };

    const finish = (mode, extra = {}) => {
      if (done) return;
      done = true;
      cleanup();
      try { dlg.close?.(); } catch {}
      resolve({ mode, ...extra });
    };

    // ❌ X / ESC / generelles Schließen → kompletter Abbruch
    const onClose = () => {
      if (done) return;
      finish("cancel");
    };

    // ✅ Button „Nur speichern“ → speichern OHNE Mail
    const onClickOnly = (e) => {
      e.preventDefault();
      finish("save_only");
    };

    // ✅ Button „Speichern & E-Mail senden“
    const onClickSend = (e) => {
      const sec = dlg.querySelector("#fdlEmailSection");

      // 1. Klick: Felder werden nur sichtbar gemacht – hier NICHT schließen
      if (sec && sec.style.display === "none") return;

      e.preventDefault();
      if (done) return;

      const to   = dlg.querySelector("#fdlMailTo")?.value || "";
      const cc   = dlg.querySelector("#fdlMailCc")?.value || "";
      const bcc  = dlg.querySelector("#fdlMailBcc")?.value || "";
      const subj = dlg.querySelector("#fdlMailSubj")?.value || "";
      const rep  = dlg.querySelector("#fdlMailReply")?.value || "";
      const body = dlg.querySelector("#fdlMailBody")?.value || ""; // NEU

      const split = s => s.split(/[;, ]+/).map(x => x.trim()).filter(Boolean);

      const extra = {
        to:      split(to),
        cc:      split(cc),
        bcc:     split(bcc),
        subject: subj.trim(),
        replyTo: rep.trim(),
        text:    body.trim()          // NEU: optionale Nachricht
      };

      finish("save_and_send", extra);
    };

    btnSend.addEventListener("click", onClickSend);
    btnOnly.addEventListener("click", onClickOnly);
    dlg.addEventListener("close", onClose, { once: true });

    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "open");
  });
}



  /* ------------------------------ Email: Senden ---------------------------- */
  async function sendMail({to=[], cc=[], bcc=[], subject="", text="", replyTo="", attachmentBytes, attachmentName}){
    const rc=(to?.length||0)+(cc?.length||0)+(bcc?.length||0); if(!rc) return { ok:true, skipped:true };
    const b64 = arrayBufferToBase64(attachmentBytes);
    const res = await fetch("/.netlify/functions/send-email", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ to, cc, bcc, subject, text, replyTo, attachments: [{ filename: attachmentName, contentBase64: b64, contentType:"application/pdf" }] }) });
    const json = await res.json().catch(()=>({})); if(!res.ok || json.ok!==true) throw new Error(json.error||("HTTP "+res.status)); return json;
  }

/* ========================================================================== */
/*  Mail-Dialog: Vorlagen pro Liegenschaft/Objekt (Empfänger + Betreff etc.)  */
/* ========================================================================== */

/**
 * Liest aus emailsCfg die Templates für die aktuell gewählte Liegenschaft /
 * Objekt und bietet sie im Mail-Dialog als Dropdown an.
 *
 * - Beim Wechsel der Vorlage werden Empfänger, CC, BCC, Betreff, Reply-To
 *   automatisch gefüllt.
 * - Nutzer kann danach alles frei anpassen.
 */
function fdlSetupMailTemplates(dlg){
  if (!dlg) return;

  const cfg = (window.emailsCfg || window.__fdlEmailsCfg || {}) || {};
  const per = cfg.perObject || {};
  const templates = [];

  // Alle Vorlagen global einsammeln (ohne Filter nach Liegenschaft)
  Object.entries(per).forEach(([objCode, perObj]) => {
    perObj = perObj || {};

    // Hauptvorlage "bei Rechnung"
    if (perObj.invoice && (perObj.invoice.subject || perObj.invoice.to || perObj.invoice.emails)) {
      templates.push({
        subject: perObj.invoice.subject || "",
        to:      perObj.invoice.to      || perObj.invoice.emails || "",
        cc:      perObj.invoice.cc      || "",
        bcc:     perObj.invoice.bcc     || "",
        replyTo: perObj.invoice.replyTo || ""
      });
    }

    // Zusätzliche Templates
    if (Array.isArray(perObj.templates)) {
      perObj.templates.forEach(t => {
        templates.push({
          subject: t.subject || "",
          to:      t.to      || t.emails || "",
          cc:      t.cc      || "",
          bcc:     t.bcc     || "",
          replyTo: t.replyTo || ""
        });
      });
    }
  });

  if (!templates.length) return;

  const toInput = dlg.querySelector("#fdlMailTo");
  const ccInput = dlg.querySelector("#fdlMailCc");
  const bccInp  = dlg.querySelector("#fdlMailBcc");
  const subjInp = dlg.querySelector("#fdlMailSubj");
  const repInp  = dlg.querySelector("#fdlMailReply");

  if (!subjInp) return;

  // eine globale Datalist für Betreff-Vorschläge benutzen
  let dl = document.getElementById("subjectBook");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "subjectBook";
    document.body.appendChild(dl);
  }

  dl.textContent = "";
  templates.forEach(t => {
    if (!t.subject) return;
    const opt = document.createElement("option");
    opt.value = t.subject;
    dl.appendChild(opt);
  });

  // Betreff-Feld mit der Datalist verbinden (kein extra Feld mehr)
  subjInp.setAttribute("list", "subjectBook");

  // optional: beim Wechsel des Betreffs die übrigen Felder NICHT automatisch überschreiben,
  // d. h. wir füllen Empfänger nur einmal, wenn der Dialog erstellt wird (z. B. über computeSubjectAndReply).
  // Wenn du möchtest, dass beim Auswählen eines Vorschlags auch Empfänger/ReplyTo gesetzt werden,
  // müssten wir hier noch einen oninput/onchange-Handler ergänzen.
}


/* -------------------------------- Speichern ------------------------------ */
/** Stempelt links vertikal: Datum – EINGEGANGEN – Kürzel (einzeilig, rotiert). */
// Helper zum Laden / Cachen der Stempel-Konfiguration
/* -------------------------------- Speichern / Stempel -------------------- */

/** Helper zum Laden / Cachen der Stempel-Konfiguration (inkl. Überweisungsstempel). */
async function getStampConfig(){
  if (stampCfg) return stampCfg;

  try {
    const cfg = await loadJson("stamp.json") || {};

    stampCfg = {
      // Hauptstempel
      enabled:       cfg.enabled !== false,
      coreText:      (cfg.coreText || "EINGEGANGEN").trim() || "EINGEGANGEN",
      includeDate:   cfg.includeDate !== false,
      includeObject: cfg.includeObject !== false,

      // Zweiter Stempel (Überweisung) – optional
      paidEnabled:   cfg.paidEnabled === true,                                 // Standard: AUS, bis in der App eingeschaltet
      paidText:      (cfg.paidText || "ÜBERWIESEN").trim() || "ÜBERWIESEN"
    };
  } catch {
    // Fallback: aktuelles Verhalten + Paid-Stempel aus, Text „ÜBERWIESEN“
    stampCfg = {
      enabled:       true,
      coreText:      "EINGEGANGEN",
      includeDate:   true,
      includeObject: true,
      paidEnabled:   false,
      paidText:      "ÜBERWIESEN"
    };
  }
  return stampCfg;
}

/**
 * Eingangsstempel: Datum / Text / Objekt (konfigurierbar)
 * + optional zweiter Stempel „ÜBERWIESEN“ o. ä. oben rechts.
 */
async function stampPdf(buf){
  if (!window.PDFLib) return buf;
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

  let cfg;
  try {
    cfg = await getStampConfig();
  } catch {
    cfg = {
      enabled:       true,
      coreText:      "EINGEGANGEN",
      includeDate:   true,
      includeObject: true,
      paidEnabled:   false,
      paidText:      "ÜBERWIESEN"
    };
  }

  // Stempel global deaktiviert → PDF unverändert zurück
  if (!cfg.enabled) return buf;

  try {
    const doc  = await PDFDocument.load(buf);
    const page = doc.getPages()[0];
    if (!page) return buf;

    const font = await doc.embedFont(StandardFonts.HelveticaBold);

    // --- Hauptstempel (links vertikal) ------------------------------------
    const dateStr = (recvDateEl?.value || (typeof today === "function"
      ? today()
      : new Date().toLocaleDateString("de-DE")));

    const objStr  = (objSel?.value || "—");

    const parts = [];

    // Objekt/Liegenschaft optional einfügen
    if (cfg.includeObject && objStr && objStr !== "—") {
      parts.push(objStr);
    }

    // Kerntext (z. B. "EINGEGANGEN:"), Leerzeichen abschneiden
    const coreText = (cfg.coreText || "EINGEGANGEN").trim() || "EINGEGANGEN";
    parts.push(coreText);

    // Erst Objekt + Kerntext mit " – " verbinden
    let text = parts.join(" – ");

    // Datum anhängen – aber OHNE Strich vor dem Datum,
    // wenn der Kerntext auf ":" endet.
    if (cfg.includeDate && dateStr) {
      const needsDash = !coreText.endsWith(":");
      text += needsDash ? " – " + dateStr : " " + dateStr;
    }

    // Position und Stil wie bisher, nur nach innen gedreht
    const size   = Math.max(10, Math.round(page.getWidth() * 0.018));
    const margin = 16;

    // Länge des Textes in PDF-Punkten
    const textLen = font.widthOfTextAtSize(text, size);

    // y so wählen, dass der Text oben beginnt, aber im Blatt bleibt:
    const yPos = page.getHeight() - margin - textLen;

    page.drawText(text, {
      x:      margin,
      y:      yPos,
      size,
      font,
      color:  rgb(0.886, 0, 0.102),     // Rot wie gehabt
      rotate: degrees(90)               // nach innen lesbar
    });

    // --- Zweiter Stempel „Überwiesen“ (oben rechts, horizontal) ----------
    const paidCheckbox = document.getElementById("chkPaid");
    const paidActive   = !!(cfg.paidEnabled && paidCheckbox && paidCheckbox.checked);

    if (paidActive) {
      const paidText = (cfg.paidText || "ÜBERWIESEN").trim() || "ÜBERWIESEN";

      const paidSize   = Math.max(10, Math.round(page.getWidth() * 0.018));
      const paidMargin = 20;
      const paidLen    = font.widthOfTextAtSize(paidText, paidSize);

    const paidX = paidMargin;

      const paidY = page.getHeight() - paidMargin - paidSize;

      page.drawText(paidText, {
        x:     paidX,
        y:     paidY,
        size:  paidSize,
        font,
        // dezent graublau
        color: rgb(0.36, 0.43, 0.56)
      });
    }

    const out = await doc.save({ useObjectStreams: true });
    return out.buffer || out; // kompatibel bleiben
  } catch (e) {
    console.error("[stampPdf] Fehler:", e);
    return buf; // niemals blockieren
  }
}

let __fdlIsSaving = false;


// === SPEICHERN & optionaler E-Mail-Versand (getrennte Buttons) ===
async function handleSaveFlow(mode = "save_only") {
  // Doppel-Aufrufe verhindern (z.B. wenn Event doppelt feuert)
  if (__fdlIsSaving) {
    return;
  }
  __fdlIsSaving = true;

  lastRootWarnKey = null;   // Root-Warnungen pro Durchlauf zurücksetzen
  try {

   
    // 0) Guard: keine Datei geladen
    if (!pdfDoc || !saveArrayBuffer) {
      toast("Keine PDF geladen.", 2000);
      return;
    }

    // 0b) Pflichtfeld: Rechnungsbetrag bei Dokumentenart "Rechnung"
    // (nutzt die vorhandene Funktion isInvoice() und amountEl aus den UI-Refs)
    if (typeof isInvoice === "function" && isInvoice() && amountEl) {
      const rawAmount = (amountEl.value || "").trim();

      if (!rawAmount) {
        toast("Bitte den Rechnungsbetrag eingeben (Pflichtfeld bei Dokumentart „Rechnung“).", 4500);
        return;
      }
    }

    // 1) Dateiname + Defaults für Betreff/Reply-To
    const previewName = (typeof effectiveFileName === "function")
      ? effectiveFileName()
      : (lastFile?.name || "dokument.pdf");

    let preSubject = "";
    let preReply   = "";

        // Status für Betreff/Reply-To aus den Versand-Checkboxen übernehmen
    try {
      if (typeof window.__fdlApplyMailStatusFromCheckboxes === "function") {
        window.__fdlApplyMailStatusFromCheckboxes();
      }
    } catch {}


    try {
      const meta = (typeof computeSubjectAndReply === "function")
        ? computeSubjectAndReply()
        : null;
      preSubject = meta?.subject || "";
      preReply   = meta?.replyTo || "";
    } catch {
      // stiller Fallback
    }

    const fileName = previewName;
    const safeName = (typeof fileSafe === "function") ? fileSafe(fileName) : fileName;

    // 2) PDF stempeln (nur im Speicher)
    let stampedBytes = saveArrayBuffer;
    try {
      stampedBytes = await stampPdf(saveArrayBuffer);
    } catch (e) {
      console.warn("Stempel fehlgeschlagen, speichere ohne Stempel:", e);
      stampedBytes = saveArrayBuffer;
    }

    // 3) Ziele auflösen, Rechte prüfen (noch kein Schreiben)
    const pf = await preflightTargets();
    if (!pf.ok) {
      toast("Speichern abgebrochen: " + (pf.reason || "Zielprüfung fehlgeschlagen"), 5000);
      return;
    }
    const t = pf.t;

    // 4) E-Mail-Entscheidung VOR dem Schreiben (nur bei mode === "send")
    let decision   = null;
    let doSendMail = false;

    if (mode === "send") {
      decision = await promptForEmailOnce({
        attachmentName: safeName,
        subject: preSubject,
        replyTo: preReply
      });

      // X / ESC / Schließen → GAR NICHT speichern
      if (!decision || decision.mode === "cancel") {
        toast("E-Mail-Versand abgebrochen.", 1800);
        return;
      }

      // „Nur speichern“ → kein Mailversand
      // „Speichern & E-Mail senden“ → später speichern + mailen
      doSendMail = decision.mode === "save_and_send";
      // decision.mode === "save_only" = nur speichern, keine Mail
    }

    // 5) Jetzt wirklich schreiben (Scope, Betriebskosten, pCloud, Lokal …)
    let okScope      = false;
    let okScopeBk    = false;
    let okPcl        = false;
    let okPclBucket  = false;
    let okLocal      = false;
    const errs       = {};
    const okCustom   = [];

    async function writeSafe(root, seg, bytes, name) {
      if (!root || !Array.isArray(seg)) return;
      if (seg.length) {
        try {
          await ensureDirPath(root, seg);
        } catch (e) {
          console.warn("ensureDirPath fehlgeschlagen:", e);
        }
      }
      await writeFileTo(root, seg, bytes, name, { unique: true });
    }

    // Scope – Hauptablage
    if (t?.scope?.root && Array.isArray(t.scope.seg)) {
      try {
        await writeSafe(t.scope.root, t.scope.seg, stampedBytes, safeName);
        okScope = true;
      } catch (e) {
        errs.scope = e?.message || String(e);
      }
    }

    // Scope – Betriebskosten
    if (t?.scopeBk?.root && Array.isArray(t.scopeBk.seg)) {
      try {
        await writeSafe(t.scopeBk.root, t.scopeBk.seg, stampedBytes, safeName);
        okScopeBk = true;
      } catch (e) {
        errs.scopeBk = e?.message || String(e);
      }
    }

    // pCloud – Objektpfad
    if (t?.pcloud?.root && Array.isArray(t.pcloud.seg)) {
      try {
        await writeSafe(t.pcloud.root, t.pcloud.seg, stampedBytes, safeName);
        okPcl = true;
      } catch (e) {
        errs.pcloud = e?.message || String(e);
      }
    }

    // pCloud – Sammelordner
    if (t?.pcloudBucket?.root && Array.isArray(t.pcloudBucket.seg)) {
      try {
        await writeSafe(t.pcloudBucket.root, t.pcloudBucket.seg, stampedBytes, safeName);
        okPclBucket = true;
      } catch (e) {
        errs.bucket = e?.message || String(e);
      }
    }

    // ---------------- Custom-Ziele (einmalig gewählte Ordner) ----------------
    // Idee: In "Checkboxen verwalten" kann jede Ablage-Checkbox optional an einen Ordner gebunden werden.
    // Der Ordner-Handle liegt in IndexedDB unter "customTarget:<checkboxId>".
    try {
      const cfg = (window.__fdlCheckboxesCfg && typeof window.__fdlCheckboxesCfg === "object")
        ? window.__fdlCheckboxesCfg
        : (JSON.parse(localStorage.getItem("fdlCheckboxesCfg") || "null") || null);

      const defs = Array.isArray(cfg?.saveTargets) ? cfg.saveTargets : [];
      for (const def of defs) {
        const id = String(def?.id || "").trim();
        if (!id) continue;

        // nur wenn Checkbox existiert und angehakt ist
        const cbEl = document.getElementById(id);
        if (!cbEl || !cbEl.checked) continue;

        const bindKey = "customTarget:" + id;
        const h = await idbGet(bindKey);
        if (!h) continue; // keine Bindung gesetzt

        try {
          await writeFileTo(h, [], stampedBytes, safeName, { unique:true });
          okCustom.push(def.label || id);
        } catch (e) {
          errs["custom:"+id] = e?.message || String(e);
        }
      }
    } catch (e) {
      console.warn("custom targets failed:", e);
    }

    // Lokal (optional)
    const wantLocal = (typeof flag === "function")
      ? flag("chkLocalSave", "chkLocal")
      : (
          document.getElementById("chkLocalSave")?.checked === true ||
          document.getElementById("chkLocal")?.checked === true
        );

    if (wantLocal && window.showSaveFilePicker) {
      try {
        const fh = await window.showSaveFilePicker({
          suggestedName: safeName,
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }]
        });

        const ws = await fh.createWritable({ keepExistingData: false });
        await ws.write(new Blob([stampedBytes], { type: "application/pdf" }));
        await ws.close();
        okLocal = true;

      } catch (e) {
        const msg = String(e?.message || e || "");

        // Benutzer klickt auf „Abbrechen“ → still ignorieren
        if (e?.name === "AbortError") {
          console.debug("[LOCAL] User aborted save dialog");
        }
        // Chrome: „User activation is required…“ → nur loggen
        else if (msg.includes("User activation is required to show a file picker")) {
          console.warn("[LOCAL] File picker ohne User-Aktivierung blockiert:", e);
        }
        // andere Fehler merken
        else {
          errs.local = msg;
        }
      }
    }

    // 6) Erfolgsauswertung
    const successTargets = [
      okScope     ? "Scopevisio"                   : null,
      okScopeBk   ? "Scopevisio – Abrechnungsbelege"  : null,
      okPcl       ? "pCloud"                       : null,
      okPclBucket ? "pCloud (Sammelordner)"        : null,
      okLocal     ? "Lokal"                        : null
      ,(okCustom.length ? ("Zusatzordner: " + okCustom.join(", ")) : null)
    ].filter(Boolean);

    if (successTargets.length === 0) {
      const reasons = [
        errs.scope     ? `Scopevisio: ${errs.scope}`     : null,
        errs.scopeBk   ? `Betriebskosten: ${errs.scopeBk}` : null,
        errs.pcloud    ? `pCloud: ${errs.pcloud}`        : null,
        errs.bucket    ? `Sammelordner: ${errs.bucket}`  : null,
        (wantLocal && errs.local) ? `Lokal: ${errs.local}` : null
      ].filter(Boolean).join("<br>");

      toast(
        `<strong>Speichern fehlgeschlagen</strong><br>${safeName}` +
        (reasons ? `<br><small>${reasons}</small>` : ""),
        8000
      );
      return;
    }

    // 7) E-Mail-Versand NACH erfolgreichem Speichern (nur wenn gewünscht)
  if (mode === "send" && doSendMail && decision) {
  const to      = (decision.to  || []).filter(Boolean);
  const cc      = (decision.cc  || []).filter(Boolean);
  const bcc     = (decision.bcc || []).filter(Boolean);
  const subject = (decision.subject || "").trim();
  const replyTo = (decision.replyTo || "").trim();

  // NEU: Body aus Dialog, Fallback auf bestehendes Template
  const textFromDialog = (decision.text || "").trim();
  const bodyText = textFromDialog ||
    (typeof computeMailBody === "function" ? computeMailBody() : "");

  const rc = to.length + cc.length + bcc.length;

  if (!rc || !subject) {
    toast("E-Mail unvollständig (Empfänger/Betreff). Versand abgebrochen.", 6000);
  } else {
    try {
      await sendMail({
        to,
        cc,
        bcc,
        subject,
        text: bodyText,
        replyTo: replyTo || undefined,
        attachmentBytes: stampedBytes,
        attachmentName: safeName
      });
      toast("<strong>E-Mail versendet</strong>", 2500);
    } catch (e) {
      toast(`⚠️ E-Mail-Versand fehlgeschlagen: ${e?.message || e}`, 4000);
    }
  }
}


    // 8) Inbox → Bearbeitet (nur wenn irgendwo gespeichert wurde)
    if (currentInboxFileHandle && (okScope || okScopeBk || okPcl || okPclBucket || okLocal)) {
      try {
        const moved = await moveInboxToProcessed();
        if (moved) toast("Inbox → Bearbeitet verschoben.", 2000);
      } catch (e) {
        console.warn("post-move failed:", e);
        toast("Verschieben aus der Inbox ist fehlgeschlagen.", 3000);
      }
    }

    // 9) Abschluss-Toast + Reset
    const okTargetsLabel = successTargets.join(" & ");

    toast(
      `<strong>Gespeichert</strong><br>${safeName}` +
      (okTargetsLabel ? `<br><em>${okTargetsLabel}</em>` : ""),
      5000
    );

    if (typeof hardReset === "function") {
      hardReset();
    }

  } catch (e) {
    console.error("[SAVE] Fehler:", e);
    toast(`<strong>Fehler</strong><br>${e?.message || e}`, 6000);
  } finally {
    __fdlIsSaving = false;
  }
}

// ---------------------------------------------------------------
// Buttons → Flow (GENAU EINMAL, direkt NACH handleSaveFlow einfügen)
// ---------------------------------------------------------------
$("#saveBtn")?.addEventListener("click", (ev) => {
  ev.preventDefault();
  handleSaveFlow("save_only");   // nur speichern
});

$("#sendEmailBtn")?.addEventListener("click", (ev) => {
  ev.preventDefault();
  handleSaveFlow("send");        // speichern + ggf. E-Mail
});

$("#cancelBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (typeof hardReset === "function") {
    hardReset();
  }
  toast("Vorgang abgebrochen.", 1500);
});
function hardReset(){
  // PDF/Preview state
  pdfDoc = null;
  renderTasks = [];
  lastFile = null;
  saveArrayBuffer = null;
  previewArrayBuffer = null;
  setStatus("");        // Statuszeile leeren

  // Inbox-Kontext vollständig leeren
  currentInboxFileHandle = null;
  currentInboxFileName = "";
  currentInboxRelPath = null; // ← wichtig: Relativpfad zurücksetzen

  // UI cleanup
  const v = $("#pdfViewer");
  if (v) v.innerHTML = "";
  $("#previewPlaceholder")?.removeAttribute("style");
  document.body.classList.remove("has-preview");
  $("#saveBtn")?.setAttribute("disabled", "disabled");

  if (lastBlobUrl) {
    try { URL.revokeObjectURL(lastBlobUrl); } catch {}
    lastBlobUrl = null;
  }

  [amountEl, invNoEl, senderEl].forEach(el => {
    if (!el) return;
    el.value = "";
    el.dataset.raw = "";
    el.classList.remove("auto");
  });

  if (invDateEl) { invDateEl.value = ""; invDateEl.classList.remove("auto"); }
  if (recvDateEl){
    recvDateEl.value = today();
    recvDateEl.classList.add("auto");
  }

  if (typeSel){ typeSel.selectedIndex = 0; }
  if (objSel){  objSel.selectedIndex  = 0; }

  if (subSel){  subSel.innerHTML = ""; }
  if (subRow){  subRow.style.display = "none"; }

  if (fileNameInput){
    if (fileNameInput.dataset.mode !== "manual") fileNameInput.value = "";
    fileNameInput.dataset.mode = "auto";
  } else if (fileNamePrev){
    fileNamePrev.textContent = "-";
  }

  if (targetPrev) targetPrev.innerHTML = "—";

  // Mail-State
  Mail.to.clear();
  Mail.cc.clear();
  Mail.bcc.clear();
  Mail.replyTo = "";
  Mail.status = null;
  Mail.perObjectSubject = "";
  Mail.perObjectReply = "";
  Mail.customSubject = "";
  Mail.baseTo = new Set();

  renderMailChips();
  if ($("#mailMetaSubject")) $("#mailMetaSubject").textContent = "-";
  if ($("#mailMetaReplyTo")) $("#mailMetaReplyTo").textContent = "-";
  updateStatusPillsVisibility();

  refreshPreview();
}

/* ------------------------------ Loaders ---------------------------------- */
async function loadDocTypes(){ try{ const j = await loadJson("document_types.json"); docTypesCfg = j; const list=(j?.types||[]); const def=j?.defaultTypeKey||""; typeSel.innerHTML = ""; const ph = new Option("(Dokumenttyp wählen)",""); ph.disabled = true; typeSel.appendChild(ph); list.forEach(t=>{ const o = new Option(t.label || t.key || "", t.key || t.label); if (t.isInvoice) o.dataset.isInvoice = "true"; if (t.key === def) o.selected = true; typeSel.appendChild(o); }); }catch{ typeSel.innerHTML = `
        <option value="" disabled>(Dokumenttyp wählen)</option>
        <option value="rechnung" data-isinvoice="true">Rechnung</option>
        <option value="sonstiges">Sonstiges</option>`; } }

async function loadObjects(){
  try{
    // 1) Datei laden
    const j = await loadJson("objects.json");
    objectsCfg = j;

    // 2) Liste holen (nichts filtern!)
    const list = Array.isArray(j?.objects) ? j.objects : [];

    // 3) Dropdown neu aufbauen
    objSel.innerHTML = "";
    objSel.appendChild(new Option("(Liegenschaft wählen)", ""));

    list.forEach(o => {
      const text  = o.displayName || o.code || o.scopevisioName || "";
      const value = o.code || o.scopevisioName || o.displayName || "";
      const opt = new Option(text, value);
      if (o.scopevisioName) opt.dataset.scopevisioName = o.scopevisioName;
      objSel.appendChild(opt);
    });

    // 4) Platzhalter aktiv lassen (kein Auto-Select)
    objSel.value = "";
  } catch (e){
    // Fallback, falls die Datei nicht gelesen werden konnte
    objSel.innerHTML = `
      <option value="">(Liegenschaft wählen)</option>
      <option value="PRIVAT">PRIVAT</option>
      <option value="FIDELIOR">FIDELIOR</option>
      <option value="ARNDTCIE">ARNDT & CIE</option>`;
  }
}

// ====== ERSATZ: objSel Change-Handler (Block 4) ======
objSel?.addEventListener("change", async () => {
  // Mail-State leeren
  Mail.to.clear();
  Mail.cc.clear();
  Mail.bcc.clear();
  Mail.customSubject = "";
  Mail.baseTo = new Set();
  Mail.recipientsTouched = false; // ← Vorbelegung wieder erlauben

  applyPerObjectMailRules();
  prefillMail();
  updateStatusPillsVisibility();
  repaintMailMeta();

  // Unterordner-Optionen normal laden (kein Zwang, UI nur wenn sinnvoll)
  await updateSubfolderOptions({ silent: false });

  // Toast-Feedback: optionales Unterordner-Feld
  const count = subSel ? subSel.options.length : 0;
  const visible = subRow && subRow.style.display !== "none";

  if (visible && count > 0) {
    // Zeig an, dass Unterordner verfügbar sind – aber optional
    const def = subSel?.value ? ` (Standard: <code>${subSel.value}</code>)` : "";
    toast(`Unterordner verfügbar – <strong>optional</strong>: ${count} Einträge${def}`, 2600);
  } else {
    // Kein Unterordner nötig/bekannt → Feld bleibt zu
    toast("Keine Unterordner erforderlich/bekannt – Feld bleibt ausgeblendet (optional).", 2200);
  }

  refreshPreview();
});

typeSel?.addEventListener("change", async () => {
  // Mail-State leeren
  Mail.to.clear();
  Mail.cc.clear();
  Mail.bcc.clear();
  Mail.customSubject = "";
  Mail.baseTo = new Set();
  Mail.recipientsTouched = false; // ← wichtig: Vorbelegung wieder erlauben
    updateAmountRequiredUI();   // <<< neu

  applyPerObjectMailRules();
  prefillMail();
  updateStatusPillsVisibility();
  repaintMailMeta();

  // Betrag-UI zurücksetzen, wenn kein Rechnungstyp
  if (!isInvoice() && amountEl) {
    amountEl.dataset.raw = "";
    amountEl.value = "";
    amountEl.classList.remove("auto");
  }

  await updateSubfolderOptions();
  refreshPreview();
});

subSel?.addEventListener("change", () => {
  // Dateiname nur automatisch überschreiben, wenn NICHT manuell editiert
  if (fileNameInput && fileNameInput.dataset.mode !== "manual") {
    fileNameInput.value = computeFileNameAuto();
  }
  refreshPreview();
});

/* ------------------------------- Boot ------------------------------------ */
async function boot() {
  // PDF.js Worker
  if (window.pdfjsLib?.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  // 1) Zuerst gespeicherte Directory-Handles wiederherstellen
  await restoreBoundHandles();
    try { await window.__fdlRefreshEmailCheckboxes?.(); } catch {}


 // 2) Konfigurationen laden (Emails/Assignments optional)
try { emailsCfg      = await loadJson("emails.json"); }       catch { emailsCfg = null; }
// Globale Aliase für Mail-Konfiguration, damit Dialoge darauf zugreifen können
window.emailsCfg      = emailsCfg || {};
window.__fdlEmailsCfg = emailsCfg || {};
try { assignmentsCfg = await loadJson("assignments.json"); }  catch { assignmentsCfg = null;

 }

  // 3) UI – neue kompakte Verbindungsanzeige (statt alter paintChips)
  paintConnectionsCompact();

  // 4) Stammdaten
  await loadObjects();
  await loadDocTypes();
  await updateSubfolderOptions();

  // 5) Mail-UI & Upload/Zoom
  populateMailSelect();
  attachMailUI();
  attachUpload();
  attachZoom();

  // 6) Checkbox-Events → Status/Preview neu
  $("#chkScope")?.addEventListener("change", () => { 
    paintConnectionsCompact(); 
    refreshPreview(); 
  });
  $("#chkPcloudExtras")?.addEventListener("change", () => { 
    paintConnectionsCompact(); 
    refreshPreview(); 
  });
  $("#chkLocal")?.addEventListener("change", refreshPreview);

  // 7) Eingangsdatum default: heute
  if (recvDateEl && !recvDateEl.value) {
    recvDateEl.value = today();
    recvDateEl.classList.add("auto");
  }

  // 8) Nutzer-Präferenzen (nur noch: scope, extras, local)
  function loadTargetPrefs(){
    try { return JSON.parse(localStorage.getItem("fdlTargets")||"{}"); }
    catch { return {}; }
  }
  function saveTargetPrefs(prefs){
    try { localStorage.setItem("fdlTargets", JSON.stringify(prefs)); } catch {}
  }
  function applyPrefs(p){
    const s  = $("#chkScope");
    const ex = $("#chkPcloudExtras");
    const lo = $("#chkLocal");
    if (s)  s.checked  = !!p.scope;
    if (ex) ex.checked = !!p.extras;
    if (lo) lo.checked = !!p.local;
  }

  let prefs = loadTargetPrefs();
  // Erststart-Defaults: Scope an, Extras aus, Lokal aus
  if (!("scope" in prefs) && !("extras" in prefs) && !("local" in prefs)) {
    prefs = { scope:true, extras:false, local:false };
    saveTargetPrefs(prefs);
  }
  applyPrefs(prefs);
  renderTargetSummary();
  ["chkScope","chkScopevisio","chkScopeBk"].forEach(id => {
  const cb = document.getElementById(id);
  if (!cb) return;
  cb.addEventListener("change", async (ev) => {
    if (!ev.target.checked) return;
    const ok = await verifyScopeRootOrWarn();
    if (!ok) ev.target.checked = false;
  });
});


   // Änderungen speichern (localStorage), damit die Wahl erhalten bleibt
  [
    "#chkScope", "#chkScopevisio",
    "#chkScopeBk",
    "#chkPcloudCollect",
    "#chkPcloudConfig",
    "#chkPcloudExtras", "#chkPcloudExtra",
    "#chkPcloudBackup",
    "#chkLocal", "#chkLocalSave"
  ].forEach(sel => {
    $(sel)?.addEventListener("change", () => {
      const next = {
        scope:   flag("chkScopevisio", "chkScope"),
        scopeBk: !!document.getElementById("chkScopeBk")?.checked,
        collect: $("#chkPcloudCollect")?.checked || false,
        config:  $("#chkPcloudConfig")?.checked || false,
        extras:  flag("chkPcloudExtra", "chkPcloudExtras"),
        backup:  !!document.getElementById("chkPcloudBackup")?.checked,
        local:   flag("chkLocalSave",  "chkLocal"),
      };
      saveTargetPrefs(next);
      refreshPreview();
    });
  });


  // Direkt nach dem Anwenden rendern
  paintConnectionsCompact();

  // 9) Erste Preview rechnen
  refreshPreview();

  // 10) Inbox-Zähler beim Start aktualisieren
  try {
    if (typeof refreshInbox === "function" && (window.inboxRootHandle || inboxRootHandle)) {
      await refreshInbox();
    }
  } catch (e) {
    console.warn("[boot] refreshInbox beim Start fehlgeschlagen:", e);
  }
// 11) Pflichtstatus Rechnungsbetrag initial setzen
  if (typeof updateAmountRequiredUI === "function") {
    updateAmountRequiredUI();
  }
}

// Boot binden (einmalig)
if (!window.__FDL_BOOT_BOUND__) {
  window.__FDL_BOOT_BOUND__ = true;
  const start = () => { boot().catch(err => console.error("Boot failed:", err)); };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    queueMicrotask(start);
  }
}


// --- DEBUG-Export für Konsole ---
try {
  window.FDLDBG = {
    getState() {
      return {
        scopeRoot:        !!scopeRootHandle,
        inboxRoot:        !!inboxRootHandle,
        bearbeitetRoot:   !!processedRootHandle,
        currentInboxFileName,
        hasInboxHandle:   !!currentInboxFileHandle
      };
    },
    move: moveInboxToProcessed
  };
  console.log("FDLDBG bereit → FDLDBG.getState(), FDLDBG.move()");
} catch (e) {
  console.warn("FDLDBG-Export fehlgeschlagen:", e);
}

try {
  window.FDLDBG = window.FDLDBG || {};
  FDLDBG.loadJson    = loadJson;
  FDLDBG.loadObjects = loadObjects;
  FDLDBG.loadDocTypes= loadDocTypes;
} catch {}

// Reagiere global auf Verschiebe-Events (zusätzliche Sicherheit)
window.addEventListener("fdl:file-moved", () => {
  try { repaintInboxList(); } catch {}
});


// ===== DEBUG-HELPER: __FDL_DEBUG() =====
window.__FDL_DEBUG = async function(){
  try{
    console.debug("[DBG] inboxRootHandle present:", !!inboxRootHandle, "name:", inboxRootHandle?.name || "(?)");
    if (inboxRootHandle?.queryPermission) {
      const perm = await inboxRootHandle.queryPermission({ mode: "readwrite" });
      console.debug("[DBG] inbox permission:", perm);
    } else {
      console.debug("[DBG] inbox permission: (API not available)");
    }

    const rootFiles = [];
    if (inboxRootHandle) {
      for await (const e of inboxRootHandle.values()){
        if (e.kind === "file") rootFiles.push(e.name);
      }
    }
    console.debug("[DBG] Inbox-ROOT files:", rootFiles);

    console.debug("[DBG] Current Inbox context:", {
      currentInboxFileName,
      currentInboxRelPath,
      hasInboxHandle: !!currentInboxFileHandle
    });
  } catch(e){
    console.warn("[DBG] failed:", e);
  }
};

// --- UI-Helfer: Inbox-Chip direkt entfernen + Repaint triggern ---
function cssEscape_(s=""){ return String(s).replace(/("|'|\\)/g,"\\$1"); }

function removeInboxChipUIByName(name){
  if(!name) return;
  // versuche über data-Attribute; passe ggf. an dein Markup an
  const sel = [
    `.file-chip[data-name="${cssEscape_(name)}"]`,
    `.file-chip[data-path$="/${cssEscape_(name)}"]`
  ].join(", ");
  const el = document.querySelector(sel);
  if(el) el.remove();
}

// === EINZIGE zentrale Repaint-Funktion ===
function repaintInboxList(){
  // Neue zentrale Anzeige (Buttons/Status) statt alter Chips
  if (typeof paintConnectionsCompact === "function") {
    try { 
      paintConnectionsCompact();
    } catch (e) {
      console.warn("paintConnectionsCompact() failed:", e);
    }

  }
  // Zähler nachziehen
  if (typeof updateCounters === "function") {
    try { updateCounters(); } catch {}
  }
}


})();


(function () {
  "use strict";

  // Falls bereits ein Namespace existiert, nutzen – sonst neu anlegen
  const Naming = (window.Naming = window.Naming || {});

  // Hilfen (neutral, kollisionsarm)
  function _normAmount(input) {
    const raw = String(input || "").trim();
    if (!raw) return { display: "", value: null };
    const numeric = raw.replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
    const v = Number(numeric);
    if (!isFinite(v)) return { display: "", value: null };
    const display = v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return { display, value: v };
  }

  function _toYmdDots(s) {
    const str = String(s || "").trim();
    if (!str) return "";
    let m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return `${m[3]}.${m[2].padStart(2,"0")}.${m[1].padStart(2,"0")}`;
    m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
    const dt = new Date(str);
    if (!isNaN(dt.getTime())) {
      const y = String(dt.getFullYear());
      const mo = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      return `${y}.${mo}.${d}`;
    }
    return "";
  }
function fileSafe(s=""){
  // Alternative fileSafe: ersetze "/" durch U+2215 statt "-"
const map = { '/':'\u2215', '\\':'-', ':':'-', '*':'x', '?':'-', '"':'-', '<':'-', '>':'-', '|':'-' };

  return String(s || "")
    .split("")
    .map(ch => Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch)
    .join("");
}
// unter fileSafe(...)
try { window.fileSafe = fileSafe; Naming.fileSafe = fileSafe; } catch {}
  function _safeChunk(s) {
    return String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\wÄÖÜäöüß ,\-]/g, "")
      .replace(/_/g, " ");
  }
function safeInvoiceId(s){
  const raw = String(s || "").trim();
  if (!raw) return "";
  // Whitespace normalisieren
  let t = raw.replace(/\s+/g, " ");

  // Zuerst ASCII-Slashes in optische Varianten umwandeln
  //  U+2215  ∕  (fraction slash)
  //  U+FF0F  ／ (fullwidth solidus) – Zweitoption
  t = t.replace(/\//g, "∕").replace(/\\/g, "⧵");

  // Steuerzeichen ausschließen (Cloud-/WebDAV-Clients mögen die nicht)
  t = t.replace(/[\u0000-\u001F]/g, "");

  return t;
}

// unter safeInvoiceId(...)
try { window.safeInvoiceId = safeInvoiceId; Naming.safeInvoiceId = safeInvoiceId; } catch {}
  function _deriveObjectCode(desc) {
    const raw = String(desc || "").trim();
    if (!raw) return "";
    const tokens = raw.split(/\s+|[\\/]/).map(t => t.replace(/[^A-Za-z0-9]/g, ""));
    const candidate = tokens.sort((a,b) => b.length - a.length).find(t => t.length >= 3) || tokens[0] || "";
    return (candidate || "").toUpperCase();
  }

  /**
   * buildNameV2 – zentrale neue Regel
   * @param {Object} p
   * @param {boolean} p.isInvoice
   * @param {string}  p.amount   – Rohtext (z.B. "45,22")
   * @param {string}  p.sender   – Aussteller
   * @param {string}  p.invoiceNo
   * @param {string}  p.targetCode   – optional (EGYO). Wenn leer, wird aus targetDesc abgeleitet.
   * @param {string}  p.targetDesc   – Beschreibung (für Ableitung)
   * @param {string}  p.date         – beliebiges Datumsformat (TT.MM.JJJJ / JJJJ-MM-TT)
   * @returns {string} Dateiname (mit .pdf), leer wenn nicht baubar
   */
  Naming.buildNameV2 = function buildNameV2(p = {}) {
    const { isInvoice, amount, sender, invoiceNo, targetCode, targetDesc, date } = p;

    const amtDisp = _normAmount(amount).display;
    const ymd     = _toYmdDots(date);
    const objCode = (targetCode && String(targetCode).trim()) || _deriveObjectCode(targetDesc);

    const parts = [];
    if (isInvoice) {
      if (amtDisp)    parts.push(_safeChunk(amtDisp));
      if (sender)     parts.push(_safeChunk(sender));
      if (invoiceNo)  parts.push(`RE ${safeInvoiceId(invoiceNo)}`);
      if (objCode)    parts.push(_safeChunk(objCode));
      if (ymd)        parts.push(_safeChunk(ymd));
    } else {
      if (sender)     parts.push(_safeChunk(sender));
      if (objCode)    parts.push(_safeChunk(objCode));
      if (ymd)        parts.push(_safeChunk(ymd));
    }
   const base = parts.filter(Boolean).join("_");
const safeBase = (typeof fileSafe === "function")
  ? fileSafe(base)
  : base.replace(/[\/\\:*?"<>|\u2215]/g, "-"); // Fallback, falls fileSafe nicht geladen ist
return safeBase ? `${safeBase}.pdf` : "";
  };
})();

/* ==================================================================================
   NEUAUFBAU — TEIL 1 (ADD-ON): Verbindungs‑Zentrale + Verbinden‑Button
   Ziel:
   • Sauberer Dialog zum Verbinden der Ordner: pCloud‑Root, pCloud‑Config, Scope‑Root,
     Inbox, Bearbeitet. (Backup zählt NUR pCloud‑Root; Config = Verwaltung)
   • Kleiner Button mit Stecker‑Icon neben dem Speichern‑Button („Verbindungen“)
   • Keine Bannermeldungen, keine Änderungen am Speichervorgang (kommen in Teil 2/3)
   • Additiv: Kann ans Dateiende deiner stabilen Backup‑app.js angefügt werden.
   ---------------------------------------------------------------------------------- */
(() => {
  // ---------- Mini‑Helfer
  const $  = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));
  const canPickDir = !!window.showDirectoryPicker;

  // ---------- Ziele (nur Handles, KEINE Checkbox‑Logik hier)
const TARGETS = [
  {
    key: "pcloudRoot",
    label: "pCloud – Root",
    varName: "pcloudRootHandle",
    hint:
      "Im Ordner-Auswahldialog bitte direkt das Laufwerk „pCloud Drive (P:)“ auswählen (oberste Ebene, hier liegen z. B. FIDELIOR, PRIVAT, OBJEKTE, DMS BACKUP PCLOUD …)."
  },
  {
    key: "pcloudConfig",
    label: "pCloud – Config-Ordner",
    varName: "pcloudConfigDir",
    hint:
      "Vom pCloud-Root (P:) aus zum Ordner „config“ navigieren: FIDELIOR → SOFTWARE → „Fidelior Dokument Manager“ → „Anastasias Development“ → „Fidelior DMS Anastasia“ → „config“."
  },
  {
    key: "scopeRoot",
    label: "Scopevisio – Root",
    varName: "scopeRootHandle",
    hint:
      "Scopevisio-Hauptordner wählen, z. B. „Scopevisio Documents\\Arndt“ (hier liegen OBJEKTE, Inbox, Bearbeitet …)."
  },
  {
  key: "inboxRoot",
  label: "Inbox – Quellordner",
  varName: "inboxRootHandle",
  hint:
    "Im Explorer: Scopevisio Documents → Arndt → den Ordner „Inbox“ auswählen (Eingangsliste für neue PDFs)."
},
{
  key: "bearbeitetRoot",
  label: "Bearbeitet – Zielordner",
  varName: "bearbeitetRootHandle",
  hint:
    "Im Explorer: Scopevisio Documents → Arndt → den Ordner „Bearbeitet“ auswählen (hier landen fertige Belege nach dem Speichern)."
}

];

 // ---------- Verbinden (generisch)
async function pickDirectory(target){
  if (!canPickDir){
    alert('Dieser Browser unterstützt den Ordner-Picker nicht. Bitte Chrome/Edge verwenden.');
    return false;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    if (!dir) return false;

    try { await dir.requestPermission?.({ mode: "readwrite" }); } catch {}

    // Standard: in globale Variable schreiben (z. B. window.scopeRootHandle)
    window[target.varName] = dir;

    // SPEZIAL: Config → alles synchronisieren
    if (target.key === "pcloudConfig") {
      syncConfigHandle(dir);
      try { await saveBoundHandles?.(); } catch {}
      try { await saveAllHandles?.(); } catch {}
    }

    window.fdlRefreshConnectionsUI?.();
    refreshConnectionsUI();
    return true;
  } catch {
    // Abbruch still
  }
  return false;
}

  // ---------- Dialog erzeugen
  function ensureConnDialog(){
    let dlg = $('#fdlConnDlg');
    if (dlg) return dlg;

    dlg = document.createElement('div');
    dlg.id = 'fdlConnDlg';
    dlg.setAttribute('role','dialog');
    dlg.setAttribute('aria-modal','true');
    dlg.style.cssText = 'position:fixed; inset:0; z-index:2000; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.35); padding:20px;';

    dlg.innerHTML = `
<div class="dialog" style="background:#fff; border-radius:14px; width:min(900px,96vw); max-width:96vw; max-height:90vh; box-shadow:0 18px 40px rgba(0,0,0,.25); overflow:hidden;">
  <div class="dialog-titlebar" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #eee">

          <div style="font-weight:700;font-size:16px">Verbindungs‑Zentrale</div>
          <button id="fdlConnClose" style="border:none;background:transparent;font-size:18px;cursor:pointer" aria-label="Schließen">✕</button>
        </div>
        <div style="padding:10px 16px; color:#3d47a3; background:#f6f8ff; border-bottom:1px solid #e6eaff;">Hier verbindest du alle Ordner. <b>Backup & Zusatzablagen</b> hängen am <b>pCloud‑Root</b>. Die <b>Config</b> ist nur für Verwaltung.</div>
        <div id="fdlConnBody" style="padding:10px 16px; max-height:70vh; overflow:auto"></div>
        <div style="display:flex; gap:8px; justify-content:flex-end; padding:12px 16px; border-top:1px solid #eee">
          <button id="fdlConnClose2" class="btn-outline" style="padding:8px 12px; border-radius:10px; border:1px solid #ddd; background:#f7f7f7; cursor:pointer">Schließen</button>
        </div>
      </div>`;

    document.body.appendChild(dlg);
    try {
  if (!dlg.__draggable) {
    makeDialogDraggable(dlg, ".dialog-titlebar");
    dlg.__draggable = true;
  }
} catch {}

    $('#fdlConnClose', dlg)?.addEventListener('click', hideConnectionsCenter);
    $('#fdlConnClose2', dlg)?.addEventListener('click', hideConnectionsCenter);
    return dlg;
  }

  function statusRows(){
    const rows = TARGETS.map(t => {
      const handle = window[t.varName];
      const ok = !!handle;
      const name = ok ? (handle.name || '(verbunden)') : 'Nicht verbunden';
      const icon = ok ? '✅' : '⚪';
      const btnLabel = ok ? 'Neu wählen…' : 'Verbinden…';
      return `<div style="display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px dashed #eee">
        <div>${icon}</div>
        <div>
          <div style="font-weight:600">${t.label}</div>
          <div style="font-size:12px;color:#666">${ok?`Verbunden: <em>${escapeHtml(name)}</em>`:'Nicht verbunden'}<span style="color:#999">${t.hint?` — ${escapeHtml(t.hint)}`:''}</span></div>
        </div>
        <div><button data-key="${t.key}" class="fdlConnPick" style="padding:6px 10px;border-radius:10px;border:1px solid #ccc;background:#fafafa;cursor:pointer">${btnLabel}</button></div>
      </div>`;
    });

    // kompakte Zusammenfassung unten: was zählt für Backup/Zusatz?
    const rootOk = !!window.pcloudRootHandle;
    const info = `<div style="margin-top:8px;font-size:12px;color:${rootOk?'#2c6a00':'#8a6d00'}">
      pCloud‑Backup & zusätzliche Ablageziele: ${rootOk?'<b>bereit (Root verbunden)</b>':'<b>aus (Root fehlt)</b>'}
    </div>`;

    return rows.join('') + info;
  }

 function renderConnBody(){
  const body = $('#fdlConnBody', ensureConnDialog());
  if (!body) return;
  body.innerHTML = statusRows();

  $$('.fdlConnPick', body).forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-key');
      const target = TARGETS.find(t => t.key === key);
      if (!target) return;

      await pickDirectory(target);   // egal ob true/false zurückkommt
      renderConnBody();              // immer neu zeichnen
    });
  });
}

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  }

  // ---------- Öffnen/Schließen + Public Hooks
  function openConnectionsCenter(){ const dlg = ensureConnDialog(); renderConnBody(); dlg.style.display = 'flex'; }
  function hideConnectionsCenter(){
  const dlg = ensureConnDialog();
  dlg.style.display = 'none';
  window.fdlRefreshConnectionsUI?.(); // auch beim Schließen aktualisieren
}


  window.openConnectionsCenter = openConnectionsCenter;
  function refreshConnectionsUI(){ // für externe Aufrufer (Teil 2/3)
    // Nur Dialog aktualisieren, falls offen
    const dlg = $('#fdlConnDlg');
    if (dlg && dlg.style.display !== 'none') renderConnBody();
    // Falls es woanders Statuszeilen gibt, können spätere Teile hier andocken
  }
  window.fdlRefreshConnectionsUI = refreshConnectionsUI;

  // ---------- Verbinden‑Button neben „Speichern“
  function ensureLauncherBtn(){
    if ($('#fdlConnBtn')) return;
    const saveBtn = $('#saveBtn');
    const host = saveBtn?.parentElement || document.body;

    const btn = document.createElement('button');
    btn.id = 'fdlConnBtn';
    btn.type = 'button';
    btn.title = 'Verbindungen';
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:8px;padding:8px 12px;border-radius:10px;border:1px solid #d9d9d9;background:#ffffff;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06)';
    btn.innerHTML = '<span aria-hidden="true">🔌</span><span>Verbindungen</span>';
    btn.addEventListener('click', openConnectionsCenter);

    if (saveBtn && host){ host.insertBefore(btn, saveBtn.nextSibling); }
    else { btn.style.position='fixed'; btn.style.right='16px'; btn.style.bottom='16px'; document.body.appendChild(btn); }
  }

  // ---------- Boot
  function bootConn(){ ensureLauncherBtn(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootConn, { once:true });
  else bootConn();
})();

/* ================= PERSISTENZ für Handles: Speichern & Wiederherstellen ================= */
(() => {
  const MAP = [
    { varName: 'pcloudRootHandle',     key: 'pcloudRoot'     },
    { varName: 'pcloudConfigDir',      key: 'pcloudConfig'   },
    { varName: 'scopeRootHandle',      key: 'scopeRoot'      },
    { varName: 'inboxRootHandle',      key: 'inboxRoot'      },
    { varName: 'bearbeitetRootHandle', key: 'bearbeitetRoot' },
  ];

  // ---- IndexedDB Mini-Helper ----
  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('fdl-handles-db', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const st = tx.objectStore('handles');
      const req = st.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, val){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      const st = tx.objectStore('handles');
      const req = st.put(val, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ---- Persistieren aller aktuell gesetzten Handles
  async function saveAllHandles(){
    try {
      for (const m of MAP) {
        const h = window[m.varName];
        if (h) { await idbSet(m.key, h); }
      }
    } catch (e) { console.warn('[FDL] saveAllHandles:', e); }
  }

  // ---- Wiederherstellen beim Start
  async function restoreAllHandles(){
    try {
      for (const m of MAP) {
        if (!window[m.varName]) {
          const h = await idbGet(m.key);
          if (h) window[m.varName] = h;
        }
      }
    } catch (e) { console.warn('[FDL] restoreAllHandles:', e); }
  }

  // ---- Rechte prüfen/anfordern (ohne Picker neu zu wählen)
  async function ensurePermission(dirHandle){
    if (!dirHandle?.queryPermission || !dirHandle?.requestPermission) return true;
    try {
      const q = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (q === 'granted') return true;
      if (q === 'denied') return false;
      const r = await dirHandle.requestPermission({ mode: 'readwrite' });
      return r === 'granted';
    } catch { return false; }
  }

  async function regrantIfNeeded(){
    let changed = false;
    for (const m of MAP) {
      const h = window[m.varName];
      if (!h) continue;
      const ok = await ensurePermission(h);
      if (!ok) {
        // bleibt gesetzt, aber ohne Rechte – UI zeigt es über Banner; hier kein Picker
        changed = true;
      } else {
        changed = true;
      }
    }
    if (changed) window.fdlRefreshConnectionsUI?.();
  }

  // ---- Speicher als „dauerhaft“ anfragen
  async function tryPersist(){
    try {
      if (navigator.storage?.persist) {
        const persisted = await navigator.storage.persisted?.();
        if (!persisted) await navigator.storage.persist();
      }
    } catch {}
  }

  // ---- Hooks einbauen: nach JEDER erfolgreichen Wahl speichern
  const _oldPick = window.openConnectionsCenter; // nur um sicherzugehen, dass Teil 1 geladen ist
  // Wir hängen uns an die Stelle, wo in Teil 1 nach dem Picker bereits fdlRefreshConnectionsUI() aufgerufen wird.
  // Zusätzlich speichern wir sofort.
  const prevRefresh = window.fdlRefreshConnectionsUI;
  window.fdlRefreshConnectionsUI = function(){
    try { prevRefresh?.(); } catch {}
    saveAllHandles(); // Status dauerhaft ablegen
  };

  // ---- Boot: wiederherstellen, Rechte prüfen, Banner/Status aktualisieren
  async function bootPersist(){
    await restoreAllHandles();
    await tryPersist();
    await regrantIfNeeded();
    window.fdlRefreshConnectionsUI?.(); // UI + Banner aktualisieren
    // leichte Nachläufe, falls Browser Handles minimal verzögert klont
    setTimeout(() => window.fdlRefreshConnectionsUI?.(), 200);
    setTimeout(() => window.fdlRefreshConnectionsUI?.(), 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootPersist, { once:true });
  } else {
    bootPersist();
  }
})();


/* ==================================================================================
   NEUAUFBAU — TEIL 2 (NEU): Präziser Ein‑Banner
   • Ersetzt die alte Teil‑2‑Version vollständig.
   • Zeigt NUR das, was tatsächlich fehlt.
   • Backup hängt NUR am pCloud‑Root (Config = Verwaltung, unabhängig).
   • Aktualisiert sich beim Laden, nach jedem Verbinden und beim Fokuswechsel zum Tab.
   • Additiv: Unter Teil 1 ans Ende deiner app.js einfügen. Die alte Teil‑2‑Datei vorher entfernen.
   ================================================================================== */
(() => {
  const $ = (s, el=document) => el.querySelector(s);

  /* ---------------- Banner: genau & einzig ---------------- */
  function ensureOneBanner(){
    // alte Banner (frühere IDs) entfernen, damit es wirklich nur einen gibt
    $('#fdlConnWarn')?.remove();
    $('#fdlDualWarn')?.remove();
    $('#fdlOneWarn')?.remove();

    let bar = $('#fdlWarnOne');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'fdlWarnOne';
    bar.style.cssText = `
      position: sticky; top: 0; z-index: 9999; display: none;
      background: #fff7cc; color: #5c4d00; border: 1px solid #f0e2a0;
      padding: 10px 12px; margin: 0 0 10px 0; border-radius: 8px; font-size: 14px;
    `;
    document.body.prepend(bar);
    return bar;
  }

  function isSet(h){
    // robust: akzeptiert auch spezielle Handle‑Objekte
    return !!(h && typeof h === 'object');
  }

  function computeMissing(){
    const pcRootOk = isSet(window.pcloudRootHandle);     // entscheidet über Backup
    const pcCfgOk  = isSet(window.configDirHandle || window.pcloudConfigDir);
    const scopeOk  = isSet(window.scopeRootHandle);      // Pflichtziel
    const inboxOk  = isSet(window.inboxRootHandle);      // Quelle
    const bearbOk  = isSet(window.bearbeitetRootHandle); // Ziel

    const msgs = [];
    if (!pcRootOk) msgs.push('Backup‑Ziel (pCloud‑Root) nicht verbunden – Datei wird ohne Backup gespeichert.');
    if (!pcCfgOk)  msgs.push('Verwaltungsdaten (pCloud‑Config) nicht verbunden – Verwalten/Empfänger/Liegenschaften/Dokumenttypen sind deaktiviert.');
    if (!scopeOk)  msgs.push('Scopevisio‑Root nicht verbunden – Speichern nach Scopevisio nicht möglich.');
    if (!inboxOk)  msgs.push('Inbox‑Ordner nicht verbunden – Quelle fehlt.');
    if (!bearbOk)  msgs.push('Bearbeitet‑Zielordner nicht verbunden – Verschieben nach Bearbeitet deaktiviert.');

    return { msgs, pcRootOk };
  }

  function updateBanner(){
    const bar = ensureOneBanner();
    const { msgs } = computeMissing();

    if (!msgs.length){
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }

    bar.innerHTML = `
      <b>⚠️ ${msgs.join(' ')}</b>
      <button id="fdlWarnConnect" style="margin-left:8px;padding:4px 8px;border-radius:8px;border:1px solid #d5c77a;background:#fff2a8;cursor:pointer">Verbinden…</button>
    `;
    $('#fdlWarnConnect')?.addEventListener('click', () => window.openConnectionsCenter?.());
    bar.style.display = 'block';
  }

  /* --------------- Öffentliche Hooks --------------- */
  // Von Teil 1 nach Verbindungsänderung aufrufbar
  const prevRefresh = window.fdlRefreshConnectionsUI;
  window.fdlRefreshConnectionsUI = function(){
    try { prevRefresh?.(); } catch {}
    try { updateBanner(); } catch {}
  };

  // Für andere Stellen verfügbar
  window.fdlUpdateConnBanner = updateBanner;

  /* --------------- Initialisierung --------------- */
  function boot(){
    updateBanner();
    // falls die Handles kurz nach DOMLoad gesetzt werden: leichte Nachinitialisierung
    setTimeout(updateBanner, 200);
    setTimeout(updateBanner, 800);
  }

  // Bei Fokuswechsel (z. B. nach Picker) erneut prüfen
  window.addEventListener('focus', () => { try { updateBanner(); } catch {} });

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  } else {
    boot();
    document.querySelectorAll("dialog").forEach(d => makeDialogDraggable(d));

  }
})();

/* ================= TEIL 3: "Speichern in" – klare Checkboxen + richtiger Backup-Status ================ */
(() => {
  const $  = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));

  function getSaveHost(){
    return document.querySelector('#saveTargets');
  }

  function killRoundTabs(){
    const host = getSaveHost();
    if (!host) return;
    const removeNow = () => {
      $$('button', host).forEach(btn => {
        const t = (btn.textContent || '').trim().toLowerCase();
        if (t === 'scopevisio' || t === 'lokal') { try { btn.remove(); } catch {} }
      });
    };
    removeNow();
    const mo = new MutationObserver(removeNow);
    mo.observe(host, { childList: true, subtree: true });
  }

  async function ensureSaveCheckboxes(){
    const host = getSaveHost();
    if (!host) return;

    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("fdlTargets") || "{}"); } catch { prefs = {}; }

    const DEFAULT_CFG = {
      saveTargets: [
        { id:"chkScopevisio",   key:"scope",   label:"Scopevisio",                   defaultChecked:true  },
        { id:"chkPcloudBackup", key:"backup",  label:"pCloud Backup (Sammelordner)", defaultChecked:true  },
        { id:"chkScopeBk",      key:"scopeBk", label:"Betriebskosten (Scopevisio)",  defaultChecked:false },
        { id:"chkPcloudExtra",  key:"extras",  label:"Ordner in pCloud",             defaultChecked:false },
        { id:"chkLocalSave",    key:"local",   label:"Lokal",                        defaultChecked:false }
      ]
    };

    // NICHT verbinden erzwingen – nur versuchen zu laden
    let cfg = null;
    try {
      cfg = await loadJson("checkboxes.json");
      if (cfg && typeof cfg === "object") {
        window.__fdlCheckboxesCfg = cfg;
        try { localStorage.setItem("fdlCheckboxesCfg", JSON.stringify(cfg)); } catch {}
      } else {
        cfg = null;
      }
    } catch {
      cfg = null;
    }

    if (!cfg) {
      try {
        const cached = JSON.parse(localStorage.getItem("fdlCheckboxesCfg") || "null");
        if (cached && typeof cached === "object") cfg = cached;
      } catch {}
    }
    if (!cfg) cfg = DEFAULT_CFG;

    const list = Array.isArray(cfg.saveTargets) ? cfg.saveTargets : DEFAULT_CFG.saveTargets;

    // erst jetzt leeren
    host.textContent = "";

    const mkRow = (def) => {
      const row = document.createElement("label");
      row.className = "chk";
      if (def.title) row.title = def.title;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = def.id || ("chk-" + Math.random().toString(36).slice(2));
      row.appendChild(cb);

      const span = document.createElement("span");
      span.textContent = def.label || def.id || cb.id;
      row.appendChild(span);

      const key = def.key;
      if (key && typeof prefs[key] === "boolean") cb.checked = !!prefs[key];
      else cb.checked = !!def.defaultChecked;

      if (cb.id === "chkPcloudBackup") {
        const info = document.createElement("span");
        info.id = "pcBackupStatus";
        info.className = "muted";
        info.style.marginLeft = ".4rem";
        row.appendChild(info);
      }

      cb.addEventListener("change", () => {
        if (!key) return;
        try {
          prefs[key] = !!cb.checked;
          localStorage.setItem("fdlTargets", JSON.stringify(prefs));
        } catch {}
      });

      return row;
    };

    list.forEach(def => host.appendChild(mkRow(def)));
  }

  window.ensureSaveCheckboxes = ensureSaveCheckboxes;

function updateBackupInfoText(){
  const info = document.getElementById('pcBackupStatus');
  if (!info) return;

  const rootOk = !!window.pcloudRootHandle;

  // Nur warnen, wenn Root fehlt – sonst Text komplett ausblenden
  if (!rootOk) {
    info.textContent = 'Backup aus (pCloud-Root nicht verbunden)';
    info.style.display = '';
    info.style.color = '#9b7700';
  } else {
    info.textContent = '';
    info.style.display = 'none';
  }
}


  async function bootSaveSection(){
    killRoundTabs();
    await ensureSaveCheckboxes();
    updateBackupInfoText();
  }
  try { setupPcloudTargetGuards(); } catch(e){ console.warn("setupPcloudTargetGuards failed:", e); }

try {
  ["chkScope","chkScopevisio","chkScopeBk"].forEach(id => {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.addEventListener("change", async (ev) => {
      if (!ev.target.checked) return;
      const ok = await verifyScopeRootOrWarn();
      if (!ok) ev.target.checked = false;
    });
  });
} catch(e){ console.warn("scope guards failed:", e); }


  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bootSaveSection, { once:true });
  } else {
    bootSaveSection();
  }

  const prevRefresh = window.fdlRefreshConnectionsUI;
  window.fdlRefreshConnectionsUI = function(){
    try { prevRefresh?.(); } catch {}
    try { updateBackupInfoText(); } catch {}
  };
})();


/* ================= TEIL 4 (NEU): Versand per E-Mail – Checkboxen aus checkboxes.json ============== */
(() => {
  const $ = (s, el=document) => el.querySelector(s);

async function loadCheckboxCfg(){
  const DEFAULTS = { saveTargets: [], emailTargets: [] };

  // 1) RAM
  if (window.__fdlCheckboxesCfg && typeof window.__fdlCheckboxesCfg === "object") {
    return window.__fdlCheckboxesCfg;
  }

  // 2) localStorage (wichtig: vor loadJson)
  try {
    const cached = JSON.parse(localStorage.getItem("fdlCheckboxesCfg") || "null");
    if (cached && typeof cached === "object") {
      window.__fdlCheckboxesCfg = cached;      // <<< wichtig!
      return cached;
    }
  } catch {}

  // 3) Datei (geht nur, wenn config verbunden ist)
  try {
    const cfg = await loadJson("checkboxes.json");
    if (cfg && typeof cfg === "object") {
      window.__fdlCheckboxesCfg = cfg;
      try { localStorage.setItem("fdlCheckboxesCfg", JSON.stringify(cfg)); } catch {}
      return cfg;
    }
  } catch {}

  return DEFAULTS;
}

async function renderEmailCheckboxesFromCfg(){
  const host = $("#emailTargets");
  if (!host) return;

  const cfg  = await loadCheckboxCfg();
  const list = Array.isArray(cfg.emailTargets) ? cfg.emailTargets : [];

  // ✅ WICHTIG: NICHT LEER RENDERN, wenn nichts geladen werden konnte
  if (!list.length) return;

  host.textContent = "";

    list.forEach(def => {
      const row = document.createElement("label");
      row.className = "chk";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = def.id || ("mail-custom-" + Math.random().toString(36).slice(2));
      cb.checked = !!def.defaultChecked;

      if (Array.isArray(def.addressBookIds)) cb.dataset.addrIds = def.addressBookIds.join(",");
      if (def.status) cb.dataset.status = String(def.status);
      if (def.subject) cb.dataset.subject = String(def.subject);
if (def.replyTo) cb.dataset.replyto = String(def.replyTo);


      row.appendChild(cb);

      const span = document.createElement("span");
      span.textContent = def.label || cb.id;
      row.appendChild(span);

      host.appendChild(row);
    });
  }

  window.__fdlRefreshEmailCheckboxes = async function(){
    try { await renderEmailCheckboxesFromCfg(); } catch (e) { console.error(e); }
  };

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", () => {
      renderEmailCheckboxesFromCfg();
    }, { once:true });
  } else {
    renderEmailCheckboxesFromCfg();
  }
})();
// ===== Boot: E-Mail-Konfig beim Start laden (damit Checkboxen sofort funktionieren) =====
(async function bootEmailsCfg(){
  try {
    // nur laden, wenn noch nichts da ist
    if (!window.emailsCfg || !Array.isArray(window.emailsCfg.addressBook)) {
      await ensureConfigConnectedOrAsk();
      const cfg = await loadJson("emails.json");
      window.emailsCfg = cfg;
      emailsCfg = cfg;
    }
  } catch (e) {
    // still: App soll ohne E-Mail-Konfig weiterlaufen
  }

  // danach: E-Mail-Checkboxen neu rendern (Mapping über addressBookIds)
  try { await window.__fdlRefreshEmailCheckboxes?.(); } catch {}
})();
function makeDialogDraggable(dialogEl, handleSel = ".dialog-titlebar"){
  const handle = dialogEl.querySelector(handleSel);
  const box    = dialogEl.querySelector(".dialog") || dialogEl;
  if (!handle || !box) return;

  let dragging = false, startX=0, startY=0, startL=0, startT=0;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  handle.style.cursor = "grab";
  handle.style.userSelect = "none";

  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, a, input, select, textarea, label")) return;

    const r = box.getBoundingClientRect();

    box.style.position = "fixed";
    box.style.margin = "0";
    box.style.left = r.left + "px";
    box.style.top  = r.top  + "px";
    box.style.transform = "none"; // wichtig, falls irgendwo centering per transform aktiv war

    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startL = r.left;
    startT = r.top;

    handle.style.cursor = "grabbing";
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const w = box.offsetWidth;
    const h = box.offsetHeight;

    const PAD = 12;

    const rawMaxL = window.innerWidth  - w - PAD;
    const rawMaxT = window.innerHeight - h - PAD;

    // Wenn Fenster größer als Viewport: min wird negativ erlaubt → kein "Festkleben"
    const minL = Math.min(PAD, rawMaxL);
    const maxL = Math.max(PAD, rawMaxL);
    const minT = Math.min(PAD, rawMaxT);
    const maxT = Math.max(PAD, rawMaxT);

    const nextL = clamp(startL + dx, minL, maxL);
    const nextT = clamp(startT + dy, minT, maxT);

    box.style.left = nextL + "px";
    box.style.top  = nextT + "px";
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.style.cursor = "grab";
  };

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}
