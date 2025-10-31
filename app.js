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
  if (!inboxRootHandle || !file?.name) return false;
  try {
    const h = await inboxRootHandle.getFileHandle(file.name, { create: false });
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

/** Baut die Inbox-Liste/Zähler neu auf (nutzt vorhandene Funktionen, fällt sonst still zurück). */
function __fdlRepaintInboxList() {
  if (typeof refreshInbox === "function") {
    try { refreshInbox(); return; } catch(e) { console.warn("refreshInbox() failed:", e); }
  }
  if (typeof updateCounters === "function") {
    try { updateCounters(); } catch {}
  }
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
}

// Speichern der verbundenen Handles
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
    const p = await idbGet("pcloudRootHandle");   // optional
    const c = await idbGet("configDirHandle");    // optional

    if (s) scopeRootHandle     = s;
    if (i) inboxRootHandle     = i;
    if (b) processedRootHandle = b;
    if (p) pcloudRootHandle    = p;
    if (c) configDirHandle     = c;

    // Permissions prüfen (ohne Popup). 'prompt' ist ok — wir fragen erst beim Schreiben aktiv nach.
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
      catch { processedRootHandle = null; }
    }

    paintChips();
    if (okInbox) await refreshInbox();

    if (!okScope || !okInbox || !okBearb) {
      // nur ein Hinweis, kein Fehler
      toast("Hinweis: Ordner ggf. einmalig freigeben (beim Speichern erscheint die Abfrage).", 2800);
    }
  } catch (e) {
    console.warn("restoreBoundHandles failed:", e);
  }
}


// ----- Zusatz-Helper: sichere Dateinamen & Ordner-Guards -----

// Falls im Ziel bereits eine Datei gleichen Namens existiert, hänge " (2)", " (3)", … an.
async function uniqueName(dirHandle, baseName) {
  const m = String(baseName).match(/^(.*?)(\.[^.]+)?$/);
  const stem = m?.[1] ?? baseName, ext = m?.[2] ?? "";
  let n = 1, candidate = baseName;
  while (true) {
    try {
      await dirHandle.getFileHandle(candidate, { create: false });
      n += 1; candidate = `${stem} (${n})${ext}`;
    } catch {
      return candidate; // frei
    }
  }
}

// Prüft, ob processedRootHandle fälschlich unterhalb der Inbox liegt (gefährlich!)
async function assertProcessedNotInsideInbox(inboxDir, processedDir) {
  if (!inboxDir || !processedDir || typeof inboxDir.resolve !== "function") return;
  try {
    const path = await inboxDir.resolve(processedDir); // Array oder null
    if (Array.isArray(path) && path.length) {
      // processedDir ist innerhalb inboxDir → strikt untersagen
      throw new Error("Konfiguration fehlerhaft: 'Bearbeitet' liegt innerhalb der Inbox.");
    }
  } catch (e) {
    if (/fehlerhaft/i.test(String(e))) throw e;
    // ältere Browser ohne resolve(): kein harter Fehler
  }
}


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
  let objectsCfg=null, docTypesCfg=null, emailsCfg=null, assignmentsCfg=null;

  // UI Refs
  const amountEl=$("#amountInput"), senderEl=$("#senderInput");
  const recvDateEl=$("#receivedDate"), invDateEl=$("#invoiceDate"), invNoEl=$("#invoiceNo");
  const typeSel=$("#docTypeSelect"), objSel=$("#objectSelect");
  const subRow=$("#subfolderRow"), subSel=$("#genericSubfolder");
  const fileNamePrev=$("#fileNamePreview"), targetPrev=$("#targetPreview");
  // Manuelle Eingaben merken (überschreibt Auto-Erkennung)
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
  if(row) row.style.display = isFideliorInvoice()?"grid":"none";
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
    const r=(raw||"").replace(/[^\d,]/g,"").replace(/,+/g,","); const parts=r.split(",");
    const euros=(parts[0]||"0").replace(/^0+(?=\d)/,"").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const cents=((parts[1]||"")+"00").slice(0,2);
    return `${euros||"0"},${cents}`;
  }
  if (amountEl){
    amountEl.addEventListener("input",(e)=>{ amountEl.dataset.raw = e.target.value; refreshPreview(); });
    amountEl.addEventListener("blur",()=>{ amountEl.value = formatAmountDisplay(amountEl.dataset.raw||amountEl.value||""); refreshPreview(); });
  }
  senderEl?.addEventListener("input", ()=>{ refreshPreview(); });
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
    const pdfViewer = $("#pdfViewer"); if (!pdfViewer || !pdfDoc) return; const myToken = ++zoomToken; cancelRenders();
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= pdfDoc.numPages; i++){
      if (myToken !== zoomToken) return; const page = await pdfDoc.getPage(i); if (myToken !== zoomToken) return;
      const viewport = page.getViewport({ scale: zoom }); const wrap = document.createElement("div");
      wrap.className = "pdf-page"; wrap.style.width = viewport.width + "px"; wrap.style.position = "relative";
      const canvas = document.createElement("canvas"); wrap.appendChild(canvas);
      const ctx = fitCanvas(canvas, viewport); const task = page.render({ canvasContext: ctx, viewport }); renderTasks.push(task);
      await task.promise; if (myToken !== zoomToken) return; wmPreview(wrap, viewport, i); frag.appendChild(wrap);
    }
    pdfViewer.replaceChildren(frag); $("#previewPlaceholder")?.setAttribute("style","display:none");
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

      const picks = await window.showOpenFilePicker({
        startIn: inboxRootHandle || "documents",
        multiple: false,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }]
      });
      if (!picks?.length) return;

      const pickedFileHandle = picks[0];
      const pickedFile = await pickedFileHandle.getFile();

      console.debug("[PICK] picked:", pickedFileHandle.name, pickedFile.size, "bytes");
      console.debug("[PICK] have inboxRootHandle:", !!inboxRootHandle, "name:", inboxRootHandle?.name || "(?)");

      // --- MINIMAL: Nur Inbox-ROOT prüfen (kein resolve, keine Rekursion) ---
      let isInInbox = false;
      let relPath = null;
      let inboxFileHandle = null;

      try {
        if (inboxRootHandle) {
          // Einmalig Schreibrecht anstoßen (innerhalb User-Gesture)
          await ensureWritePermissionWithPrompt(inboxRootHandle, "Inbox");

          // Gibt es im Inbox-ROOT eine Datei gleichen Namens?
          const h = await inboxRootHandle.getFileHandle(pickedFileHandle.name, { create: false });
          // Wenn ja → als Inbox-Datei behandeln
          isInInbox = true;
          relPath = [pickedFileHandle.name];
          inboxFileHandle = h;
        }
      } catch {
        // nicht im Inbox-ROOT -> extern
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


// === Helper: STRIKTE Rechnungsnummer-Erkennung (lieber leer als falsch) ===
function findInvoiceNumberStrict(rawText) {
  if (!rawText) return "";

  const text = String(rawText)
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2013\u2014\u2212]/g, "-");

  const labelRxs = [
    /\b(rechnungs?(nummer|nr|no)\.?|rg-?nr\.?|rn\.?|beleg(nr|nummer)|rechnung\s*#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/gi,
    /\b(invoice\s*(no|nr|number)?|inv\.?\s*no\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._\/-]{2,})/gi,
  ];
  const candidates = [];

  for (const rx of labelRxs) {
    let m; while ((m = rx.exec(text))) candidates.push({ c: m[4], score: 3 });
  }

  for (const m of text.matchAll(/\b([A-Z]{1,5}[-_/]?\d{3,}|\d{3,}[-_/][A-Z0-9]{2,})\b/gi)) {
    candidates.push({ c: m[1], score: 1 });
  }

  const bad = {
    date: /^(\d{1,2}[.\-/]){2}\d{2,4}$/i,
    iban: /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/i,
    phone:/^\+?\d{2,3}[\s/-]?(?:\d{2,4}[\s/-]?){2,4}\d{2,}$/i,
    zip:  /^\d{5}$/,
    money: /(?:€|\bEUR\b)\s*\d/,
    badPrefix: /^(kdnr|kunde|kundennr|bestell|auftrag)\b/i
  };
  const clean = s => String(s||"").trim().replace(/^[#:.\-]+/,"").replace(/[,;:.]+$/,"").toUpperCase();
  const invalid = s => !s || s.length<4 || bad.date.test(s) || bad.iban.test(s) || bad.phone.test(s) ||
                       bad.zip.test(s)  || bad.money.test(s) || bad.badPrefix.test(s);

  const pool = [];
  for (const k of candidates){
    const x = clean(k.c);
    if (!invalid(x)) {
      let sc = k.score + (/[A-Z]/.test(x)?1:0) + ((x.length>=6&&x.length<=20)?1:0);
      pool.push({ c:x, score:sc });
    }
  }
  if (!pool.length) return "";
  pool.sort((a,b)=>b.score-a.score);
  return pool[0].c;
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
    const txt = (await extractTextFirstPages(pdfDoc, 3)) || "";

    /* Betrag */
    const moneyHits = [...txt.matchAll(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/g)].map(m => m[0]);
    if (moneyHits.length) {
      const pick = moneyHits
        .map(v => ({ v, n: euroToNum(v) }))
        .sort((a, b) => b.n - a.n)[0].v;
      amountEl.dataset.raw = pick;
      amountEl.value = formatAmountDisplay(pick);
      amountEl.classList.add("auto");
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
const autoInv = findInvoiceNumberStrict(txt);
if (invNoEl && !invNoEl.dataset.userTyped) {
  if (autoInv) {
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
    }

    /* 2) AUTO-ASSIGN: Objekt & (optional) Unterordner */
    let appliedMsg = null;
    if (assignmentsCfg && Array.isArray(assignmentsCfg.patterns) && assignmentsCfg.patterns.length) {
      const tRaw = (txt || "")
        .replace(/\u00A0/g, " ")
        .replace(/[\u2013\u2014\u2212]/g, "-"); // – — −  -> -

      const normalizeList = (rule) => {
        if (Array.isArray(rule.patterns)) return rule.patterns;
        if (Array.isArray(rule.pattern))  return rule.pattern;
        if (typeof rule.pattern === "string" && rule.pattern.trim()) return [rule.pattern];
        return [];
      };

      let hit = null;
      for (const rule of assignmentsCfg.patterns) {
        const list = normalizeList(rule);
        const matched = list.some(pat => {
          try { return new RegExp(pat, "i").test(tRaw); }
          catch { return tRaw.toLowerCase().includes(String(pat || "").toLowerCase()); }
        });
        if (matched) { hit = rule; break; }
      }

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

  // RE-Teil: Präfix nicht doppeln (RE/RG/RN/INV/INVOICE)
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
  // Rechnung:      [Betrag]_[Absender]_[RE …]_[Liegenschaft]_[JJJJ.MM.TT].pdf
  // Nicht-Rechnung: [Absender]_[Liegenschaft]_[JJJJ.MM.TT].pdf
  // =======================
  const parts = [];
  if (isInvoice()) {
    if (includeAmount) parts.push(betragRaw);
    if (absender)      parts.push(absender);
    if (rePart)        parts.push(rePart);
    if (liegenschaft)  parts.push(liegenschaft);
    parts.push(datum);
  } else {
    if (absender)      parts.push(absender);
    if (liegenschaft)  parts.push(liegenschaft);
    parts.push(datum);
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

  /* ====== BLOCK 1: updateSubfolderOptions (ERSATZ, kompletter Funktions-Body) ====== */
/* Änderung: zusätzlicher Parameter { silent=false } steuert, ob die UI sichtbar wird.
   Wenn silent===true, werden Optionen geladen & Vorwahl gesetzt, aber subRow bleibt verborgen. */
async function updateSubfolderOptions({ silent = false } = {}) {
  if (!subRow || !subSel) return;

  const code = (objSel?.value || "").trim();
  const invoice = isInvoice();

  // Standard: ausblenden & leeren
  subRow.style.display = "none";
  subSel.innerHTML = "";

  // PRAGMATIK: Für PRV/ohne Code nichts anzeigen
  if (!code || code === "PRIVAT") return;

  // Spezialfall FIDELIOR (nur bei Nicht-Rechnung sinnvoll)
 if (code === "FIDELIOR") {
  if (!invoice) {
    if (!pcloudRootHandle) return;

    const base = ["FIDELIOR", "VERWALTUNG"];
    const raw  = await listChildFolders(pcloudRootHandle, base);

    // Alphabetisch sortieren (de, case-insensitiv, numerisch), Duplikate entfernen
    const options = [...new Set(raw)]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "de", { sensitivity: "base", numeric: true }));

    if (options.length) {
      const prev = subSel.value; // Auswahl behalten, falls möglich
      subSel.innerHTML = options.map(v => `<option value="${v}">${v}</option>`).join("");
      subSel.value = options.includes(prev) ? prev : (options[0] || "");
      if (!silent) subRow.style.display = "grid";
    }
  }
  return;
}

  // Allgemeine Ermittlung aus Config + realen Ordnern
  const { scopeName, pcloudName } = getFolderNames(code);
  const scopeBase = ["OBJEKTE", scopeName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];

  let pclBase = null;
  if (!isArndtCie(code)) {
    if (code === "A15" && invoice) {
      pclBase = ["FIDELIOR", "OBJEKTE", "A15 Ahrweiler Straße 15", "Buchhaltung", "Rechnungsbelege"];
    } else {
      pclBase = ["FIDELIOR", "OBJEKTE", pcloudName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];
    }
  }

  const known = new Set(getKnownSubfolders(code));
  if (invoice) known.add("Rechnungsbelege");
  else known.add("Objektdokumente");

  const lists = [];
  if (scopeRootHandle) lists.push(listChildFolders(scopeRootHandle, scopeBase));
  if (pcloudRootHandle && pclBase) lists.push(listChildFolders(pcloudRootHandle, pclBase));

  const foundLists = (await Promise.all(lists).catch(() => [[]])).flat();
  foundLists.forEach(n => known.add(n));

  const options = [...known].filter(Boolean);

  // Wenn gar keine Optionen bekannt sind → nichts anzeigen (optional bleibt möglich via Regel)
  if (!options.length) {
    // Bei Nicht-Rechnung fallback „Objektdokumente“ als Option anbieten
    if (!invoice) {
      subSel.innerHTML = `<option value="Objektdokumente">Objektdokumente</option>`;
      if (!silent) subRow.style.display = "grid";
    }
    return;
  }

  subSel.innerHTML = options.map(v => `<option value="${v}">${v}</option>`).join("");
  subSel.value = invoice
    ? (options.includes("Rechnungsbelege") ? "Rechnungsbelege" : options[0])
    : (options.includes("Objektdokumente") ? "Objektdokumente" : options[0]);

  // Sichtbarkeit NUR wenn nicht „silent“ angefordert
  if (!silent) subRow.style.display = "grid";
}

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

  if (!hasDoc){ targetPrev && (targetPrev.innerHTML = "—"); return; }

  const code    = (objSel?.value || "").trim();
  const year    = String(currentYear());
  const invoice = isInvoice();
  const sub     = (subSel?.value || "").trim();

  const wantScope      = $("#chkScope")?.checked === true;
  const wantPcl        = $("#chkPcloud")?.checked === true;
  const wantPclBucket  = isPcloudBucketChecked();

  const { scopeName, pcloudName } = getFolderNames(code);
  const lines = [];

  // Scopevisio (nur mit Objekt sinnvoll)
  if (wantScope && code){
    let seg;
    if (code === "FIDELIOR")      seg = ["FIDELIOR", (invoice ? "Eingangsrechnungen" : "Dokumente"), year];
    else if (code === "PRIVAT")   seg = ["PRIVAT",   (invoice ? "Rechnungsbelege" : "Dokumente"), year];
    else if (isArndtCie(code))    seg = ["ARNDT & CIE", (invoice ? "Eingangsrechnungen" : "Dokumente"), year];
    else {
      const base = ["OBJEKTE", scopeName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];

      // B75 + Rechnung => immer nur Jahresordner
      const leaf = (code === "B75" && invoice)
        ? [year]
        : (sub && !["Rechnungsbelege","Objektdokumente"].includes(sub) ? [sub, year] : [year]);

      seg = base.concat(leaf);
    }
    lines.push("Scopevisio: " + seg.join("\\"));
  }

  // pCloud (Objektpfad)
  if (wantPcl && code){
    let seg = null;
    if (code === "FIDELIOR"){
      seg = invoice
        ? ["FIDELIOR","VERWALTUNG","Finanzen - Buchhaltung","Eingangsrechnungen", year]
        : (sub ? ["FIDELIOR","VERWALTUNG", sub, year] : null);
    } else if (code === "PRIVAT"){
      seg = ["FIDELIOR","PRIVAT", (invoice ? "Rechnungsbelege" : "Dokumente"), year];
    } else if (!isArndtCie(code)){
      if (code === "A15" && invoice){
        const base = ["FIDELIOR","OBJEKTE","A15 Ahrweiler Straße 15","Buchhaltung","Rechnungsbelege"];
        const leaf = (sub && sub !== "Rechnungsbelege") ? [sub, year] : [year];
        seg = base.concat(leaf);
      } else {
        if (!invoice && !sub){
          seg = null;
        } else {
          const base = ["FIDELIOR","OBJEKTE", pcloudName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];

          // B75 + Rechnung => immer nur Jahresordner
          const leaf = (code === "B75" && invoice)
            ? [year]
            : (sub && !["Rechnungsbelege","Objektdokumente"].includes(sub) ? [sub, year] : [year]);

          seg = base.concat(leaf);
        }
      }
    }
    lines.push("pCloud: " + (seg ? seg.join("\\") : "—"));
  }

  // pCloud Sammelordner (Konstante PCL_COLLECT_FOLDER nutzen)
  if (wantPclBucket){
    const seg = ["FIDELIOR", PCL_COLLECT_FOLDER];
    lines.push("pCloud (Sammelordner): " + seg.join("\\"));
  }

  // Lokal
  const wantLocal = $("#chkLocal")?.checked === true;
  if (wantLocal) lines.push("Lokal: (Dateidialog)");

  targetPrev && (targetPrev.innerHTML = lines.join("<br>"));
}


function resolveTargets(){
  const code    = (objSel?.value || "").trim();
  const year    = String(currentYear());
  const invoice = isInvoice();
  const sub     = (subSel?.value || "").trim();

  const wantScope = $("#chkScope")?.checked === true;
  const wantPcl   = $("#chkPcloud")?.checked === true;

  const out = { scope: null, pcloud: null, pcloudBucket: null };

  // Sammelordner
  const wantPclBucket = isPcloudBucketChecked();
  if (wantPclBucket && pcloudRootHandle){
    out.pcloudBucket = { root: pcloudRootHandle, seg: ["FIDELIOR", PCL_COLLECT_FOLDER] };
  }

  const { scopeName, pcloudName } = getFolderNames(code);

  // Scopevisio
  if (wantScope && scopeRootHandle && code){
    if (code === "FIDELIOR"){
      out.scope = { root: scopeRootHandle, seg: ["FIDELIOR", (invoice ? "Eingangsrechnungen" : "Dokumente"), year] };
    } else if (code === "PRIVAT"){
      out.scope = { root: scopeRootHandle, seg: ["PRIVAT", (invoice ? "Rechnungsbelege" : "Dokumente"), year] };
    } else if (isArndtCie(code)){
      out.scope = { root: scopeRootHandle, seg: ["ARNDT & CIE", (invoice ? "Eingangsrechnungen" : "Dokumente"), year] };
    } else {
      const base = ["OBJEKTE", scopeName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];

      // B75 + Rechnung => immer nur Jahresordner
      const leaf = (code === "B75" && invoice)
        ? [year]
        : (sub && !["Rechnungsbelege","Objektdokumente"].includes(sub) ? [sub, year] : [year]);

      out.scope = { root: scopeRootHandle, seg: base.concat(leaf) };
    }
  }

  // pCloud
  if (wantPcl && pcloudRootHandle && code && !isArndtCie(code)){
    if (code === "FIDELIOR"){
      out.pcloud = invoice
        ? { root: pcloudRootHandle, seg: ["FIDELIOR","VERWALTUNG","Finanzen - Buchhaltung","Eingangsrechnungen", year] }
        : (sub ? { root: pcloudRootHandle, seg: ["FIDELIOR","VERWALTUNG", sub, year] } : null);
    } else if (code === "PRIVAT"){
      out.pcloud = { root: pcloudRootHandle, seg: ["FIDELIOR","PRIVAT", (invoice ? "Rechnungsbelege" : "Dokumente"), year] };
    } else {
      if (code === "A15" && invoice){
        const base = ["FIDELIOR","OBJEKTE","A15 Ahrweiler Straße 15","Buchhaltung","Rechnungsbelege"];
        const leaf = (sub && sub !== "Rechnungsbelege") ? [sub, year] : [year];
        out.pcloud = { root: pcloudRootHandle, seg: base.concat(leaf) };
      } else if (invoice || sub){
        const base = ["FIDELIOR","OBJEKTE", pcloudName, (invoice ? "Rechnungsbelege" : "Objektdokumente")];

        // B75 + Rechnung => immer nur Jahresordner
        const leaf = (code === "B75" && invoice)
          ? [year]
          : (sub && !["Rechnungsbelege","Objektdokumente"].includes(sub) ? [sub, year] : [year]);

        out.pcloud = { root: pcloudRootHandle, seg: base.concat(leaf) };
      }
    }
  }

  return out;
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
  const chipScope=$("#chipScope"), chipPcloud=$("#chipPcloud"), chipConfig=$("#chipConfig"), chipInbox=$("#chipInbox"), chipBear=$("#chipBearbeitet");
  function setChip(el,on,label){ if(!el) return; el.textContent=`${label} ${on?"●":"○"}`; el.classList.toggle("chip--on",!!on); }
  function paintChips(){ setChip(chipScope,!!scopeRootHandle,"Scopevisio"); setChip(chipPcloud,!!pcloudRootHandle,"pCloud"); setChip(chipConfig,!!configDirHandle,"Config"); setChip(chipInbox,!!inboxRootHandle,"Inbox"); setChip(chipBear,!!processedRootHandle,"Bearbeitet"); }

  async function requestDirWrite(dirHandle){ try{ if(!dirHandle?.requestPermission) return true; let p = await dirHandle.queryPermission?.({ mode: "readwrite" }); if (p !== "granted") p = await dirHandle.requestPermission({ mode: "readwrite" }); return p === "granted"; }catch{ return true; } }
  async function ensureDirWithPrompt(rootHandle, segments){ if(!rootHandle) throw new Error("Kein Root-Handle"); let dir = rootHandle; for (const s of (segments||[])){ if(!s) continue; try { dir = await dir.getDirectoryHandle(s, { create:false }); } catch { const yes = window.confirm(`Ordner fehlt: "${s}". Jetzt anlegen?`); if (!yes) throw new Error(`Abgebrochen – fehlender Ordner: ${s}`); dir = await dir.getDirectoryHandle(s, { create:true }); } } return dir; }
// Schreiben ins Ziel (mit Prompt für Berechtigungen und Ordner-Anlage)
// Schreiben ins Ziel (mit optionaler Einzigartigkeits-Logik)
async function writeFileTo(rootHandle, segments, bytes, fileName, opts = {}) {
  if (!rootHandle) throw new Error("Root-Handle fehlt");
  if (!fileName)   throw new Error("Dateiname fehlt");

  const ok = await requestDirWrite(rootHandle);
  if (!ok) throw new Error("Schreibberechtigung verweigert");

  const dir = await ensureDirWithPrompt(rootHandle, segments || []);

  // Falls gewünscht, kollisionssicheren Namen bilden (… (2).pdf / … (3).pdf …)
  const finalName = opts.unique ? await uniqueName(dir, fileName) : fileName;

  const fh  = await dir.getFileHandle(finalName, { create: true });

  let ws;
  try {
    ws = await fh.createWritable({ keepExistingData: false });
    await ws.write(new Blob([bytes], { type: "application/pdf" }));
    await ws.close();

    // Chrome .crswap-Reste säubern
    await tryRemoveCrSwap(dir, finalName);
    ws = undefined;
  } catch (e) {
    try { await ws?.abort(); } catch {}
    throw e;
  }

  // Optional nützlich, falls du den tatsächlich verwendeten Namen anzeigen willst
  return finalName;
}



/* ---------------------- Verbindungen: Root-Ordner binden ---------------------- */

$("#btnBindScopevisio")?.addEventListener("click", async () => {
  try {
    scopeRootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    paintChips();
    await saveBoundHandles();
    toast("<strong>Scopevisio verbunden</strong>", 1500);
  } catch {}
});

$("#btnBindPcloud")?.addEventListener("click", async () => {
  try {
    pcloudRootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    paintChips();
    await saveBoundHandles();
    toast("<strong>pCloud verbunden</strong>", 1500);
  } catch {}
});

$("#btnBindConfig")?.addEventListener("click", async () => {
  try {
    configDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    paintChips();
    await saveBoundHandles();
    toast("<strong>Config verbunden</strong>", 1500);

    try { emailsCfg   = await loadJson("emails.json"); } catch {}
    try { objectsCfg  = await loadJson("objects.json"); await loadObjects(); } catch {}
    try { docTypesCfg = await loadJson("document_types.json"); await loadDocTypes(); } catch {}
    populateMailSelect(); prefillMail();
  } catch {}
});

$("#btnBindInbox")?.addEventListener("click", async () => {
  try {
    inboxRootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    paintChips();
    await saveBoundHandles();
    toast("<strong>Inbox verbunden</strong>", 1500);
    await refreshInbox();
  } catch {}
});

// Ziel „Bearbeitet“ binden (früher „Quelle“)
$("#btnBindQuelle")?.addEventListener("click", async () => {
  try {
    processedRootHandle = await window.showDirectoryPicker({ mode: "readwrite" });

    // Guard: „Bearbeitet“ darf NICHT innerhalb der Inbox liegen
    try { await assertProcessedNotInsideInbox(inboxRootHandle, processedRootHandle); }
    catch (e) {
      processedRootHandle = null;
      paintChips();
      toast(`❌ ${e.message}`, 4500);
      return;
    }

    paintChips();
    await saveBoundHandles();
    toast("<strong>Bearbeitet verbunden</strong>", 1500);
  } catch {}
});

/* ----------------------------- Inbox-Aktualisierung ----------------------------

   Fix: 0-Byte-Stubs (Cloud-Platzhalter) werden herausgefiltert.
   – Wir holen file.size, bevor wir den Eintrag anzeigen.
   – Beim Klick prüfen wir _nochmals_ die Größe (Race-Condition-Sicherheit).
--------------------------------------------------------------------------------*/

async function refreshInbox(){
  const list = $("#inboxList"), counters = $("#counters");
  if (list) list.innerHTML = "";
  let offen = 0;

  if (inboxRootHandle){
    try{
      for await (const e of inboxRootHandle.values()){
        if (e.kind !== "file") continue;
        if (!e.name.toLowerCase().endsWith(".pdf")) continue;

        // Datei-Objekt lesen, um Größe zu prüfen (0-Byte-Stubs ausblenden)
        let f;
        try {
          const h = await inboxRootHandle.getFileHandle(e.name, { create:false });
          f = await h.getFile();
        } catch { continue; }

        if (!f || f.size === 0) {
          // Optional: Wenn du sie anzeigen willst, aber deaktiviert:
          // const li = document.createElement("li");
          // li.innerHTML = `<span class="muted">${e.name} <small>(0&nbsp;B)</small></span><span class="badge">Inbox</span>`;
          // list?.appendChild(li);
          continue; // hier: komplett ausblenden
        }

        offen++;
        const li = document.createElement("li");
        li.innerHTML = `<button class="linklike" data-file="${e.name}">${e.name}</button><span class="badge">Inbox</span>`;
        list?.appendChild(li);

        // Direkt mit Handle arbeiten + takeFile nutzen
        li.querySelector("button").addEventListener("click", async () => {
          try {
            const h = await inboxRootHandle.getFileHandle(e.name, { create:false });
            const fileNow = await h.getFile();

            if (!fileNow.size) {
              toast(`„${e.name}“ ist 0 Byte (Cloud-Platzhalter) – bitte zuerst lokal synchronisieren.`, 4000);
              return;
            }

            currentInboxFileHandle = h;
            currentInboxFileName   = e.name;
            currentInboxRelPath    = [e.name]; // Datei liegt im Inbox-Root

            toast(`Inbox-Datei ausgewählt: <code>${e.name}</code>`, 1400);

            if (typeof window.__fdl_takeFile === "function"){
              await window.__fdl_takeFile(fileNow, { fromInbox:true });
            } else {
              console.warn("takeFile nicht verfügbar – attachUpload() muss geladen sein.");
            }
          } catch (err) {
            console.warn("Inbox-Auswahl fehlgeschlagen:", err);
            toast("Konnte Datei nicht öffnen.", 2500);
          }
        });
      }
    } catch (err){
      console.warn("refreshInbox", err);
    }
  }

  if (counters){
    counters.textContent = `Offen: ${offen} · In Arbeit: 0 · Fertig: 0 · Session: 0`;
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

  async function ensureConfigConnectedOrAsk(){ if (!configDirHandle){ try{ configDirHandle = await window.showDirectoryPicker({mode:"readwrite"}); paintChips(); toast("<strong>Config verbunden</strong>",1500); }catch{ toast("Config nicht verbunden.",2000); } } }

  async function openEmailsDialog(){
  await ensureConfigConnectedOrAsk();
  const dlg = $("#manageEmailsDialog");
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
  $("#emailsAdd")?.addEventListener("click", () => tbody.appendChild(addRow({})));

  // ===== Pro Liegenschaft: Vorlagen (edit/löschen) =====
  const poObjSel = $("#poObject"),
        poRec    = $("#poRecipients"),
        poSubj   = $("#poSubject"),
        poReply  = $("#poReplyTo"),
        poList   = $("#poList");

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
        const labelTxt = t.label || t.id || "Vorlage";
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
    const recs = (poRec?.value || "").split(/[;, ]+/).map(s => s.trim()).filter(Boolean);

    poRules[code] = poRules[code] || {};
    poRules[code].invoice = {
      to: recs,
      subject: (poSubj?.value || "").trim(),
      replyTo: (poReply?.value || "").trim()
    };

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
      populateMailSelect();             // Datalist/Select neu füllen
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

  async function openObjectsDialog(){ await ensureConfigConnectedOrAsk(); const dlg=$("#manageObjectsDialog"); if(!dlg){ toast("Objekte-Dialog fehlt.",2000); return; } let j; try{ j = await loadJson("objects.json"); }catch{ j={objects:[]}; } const list = j.objects || []; const ul = $("#objectsList"); ul.innerHTML="";
    const addRow=(o={displayName:"", code:"", scopevisioName:"", pcloudName:""})=>{ const li=document.createElement("li"); li.innerHTML = `
        <div class="row tight">
          <input class="input slim ob-name"  placeholder="Anzeigename" value="${o.displayName||""}">
          <input class="input slim ob-code"  placeholder="Code"        value="${o.code||""}">
          <input class="input slim ob-scope" placeholder="Scopevisio"  value="${o.scopevisioName||""}">
          <input class="input slim ob-pcl"   placeholder="pCloud"      value="${o.pcloudName||""}">
          <button class="icon-btn ob-del" title="Löschen">🗑️</button>
        </div>`; li.querySelector(".ob-del").addEventListener("click",()=>li.remove()); ul.appendChild(li); };
    list.forEach(addRow); $("#objectsAddRow")?.addEventListener("click",()=>addRow({}));
    $("#objectsSaveShared")?.addEventListener("click", async()=>{ try{ const rows=[...ul.querySelectorAll("li")].map(li=>{ const displayName=li.querySelector(".ob-name")?.value.trim(); const code=li.querySelector(".ob-code")?.value.trim(); const scope=li.querySelector(".ob-scope")?.value.trim(); const pcl=li.querySelector(".ob-pcl")?.value.trim(); if(!displayName||!code) return null; return {displayName, code, scopevisioName:scope||code, pcloudName:pcl||code}; }).filter(Boolean); const next={objects:rows}; await saveJson("objects.json", next); objectsCfg=next; await loadObjects(); toast("<strong>Liegenschaften gespeichert</strong>",1800); dlg.close?.(); }catch(e){ toast("Fehler beim Speichern der Liegenschaften.",2500); } });
    if (typeof dlg.showModal==="function") dlg.showModal(); else dlg.setAttribute("open","open"); wireDialogClose(dlg);
  }

  async function openTypesDialog(){ await ensureConfigConnectedOrAsk(); const dlg=$("#manageTypesDialog"); if(!dlg){ toast("Dokumentarten-Dialog fehlt.",2000); return; } let j; try{ j = await loadJson("document_types.json"); }catch{ j={types:[], defaultTypeKey:""}; } const list=j.types||[]; const ul=$("#typesList"); ul.innerHTML=""; const defaultKey=j.defaultTypeKey||"";
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

function arrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  const chunk = 0x8000; // 32k
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}


  /* ------------------------------ Email: Senden ---------------------------- */
  async function sendMail({to=[], cc=[], bcc=[], subject="", text="", replyTo="", attachmentBytes, attachmentName}){
    const rc=(to?.length||0)+(cc?.length||0)+(bcc?.length||0); if(!rc) return { ok:true, skipped:true };
    const b64 = arrayBufferToBase64(attachmentBytes);
    const res = await fetch("/.netlify/functions/send-email", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ to, cc, bcc, subject, text, replyTo, attachments: [{ filename: attachmentName, contentBase64: b64, contentType:"application/pdf" }] }) });
    const json = await res.json().catch(()=>({})); if(!res.ok || json.ok!==true) throw new Error(json.error||("HTTP "+res.status)); return json;
  }

// ---------------------- Inbox → Bearbeitet (robust) -----------------------
async function moveInboxToProcessed() {
  console.log("moveInboxToProcessed:start", {
    hasHandle: !!currentInboxFileHandle,
    fileName: currentInboxFileName
  });

  try {
    if (!currentInboxFileHandle || !inboxRootHandle) {
      toast("Kein Inbox-Kontext zum Verschieben.", 2500);
      return false;
    }

    // Quelle lesen
    const srcFile = await currentInboxFileHandle.getFile();
    const fileName = currentInboxFileName || srcFile.name;

    // 0-Byte-Stub früh melden
    if (!srcFile.size) {
      toast("Quelle ist 0 Byte – möglicherweise Cloud-Platzhalter. Verschieben abgebrochen.", 4000);
      return false;
    }

    // Berechtigungen
    const okIn = await ensureWritePermissionWithPrompt(inboxRootHandle, "Inbox");

    // Ziel bestimmen: bevorzugt verbundenes Bearbeitet, sonst <Inbox>\Bearbeitet
    let dstRoot = null, dstSeg = [];
    if (processedRootHandle) {
      const okOut = await ensureWritePermissionWithPrompt(processedRootHandle, "Bearbeitet");
      if (!okOut) {
        toast("Ziel „Bearbeitet“ ist nicht freigegeben.", 3500);
        return false;
      }
      dstRoot = processedRootHandle;
    } else {
      // Fallback auf <Inbox>\Bearbeitet
      const okOut = await ensureWritePermissionWithPrompt(inboxRootHandle, "Inbox/Bearbeitet");
      if (!okOut) return false;
      dstRoot = inboxRootHandle;
      dstSeg = ["Bearbeitet"];
    }

   // Beziehung zur Inbox: Relativpfad ermitteln (für korrektes Löschen)
let rel = currentInboxRelPath;
if (!rel) {
  if (inboxRootHandle?.resolve && currentInboxFileHandle) {
    try {
      const r = await inboxRootHandle.resolve(currentInboxFileHandle);
      rel = (Array.isArray(r) && r.length) ? r : [fileName]; // ⇐ Fallback auf Root
    } catch {
      rel = [fileName]; // ⇐ Fallback bei Fehler
    }
  } else {
    rel = [fileName];   // ⇐ Fallback wenn resolve() nicht vorhanden
  }
}
const canDelete = Array.isArray(rel) && rel.length > 0;


    // Zieldateiname ggf. einzigartig machen
    const dstDir = await (async () => {
      if (!dstSeg.length) return dstRoot;
      return await (async function ensureDir(root, segs){
        let d = root;
        for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
        return d;
      })(dstRoot, dstSeg);
    })();

    const finalName = await uniqueName(dstDir, fileName);

    // --- KOPIEREN (zuerst schreiben, dann löschen) ---
    const bytes = await srcFile.arrayBuffer();
    const dstFileHandle = await dstDir.getFileHandle(finalName, { create: true });
    let ws;
    try {
      ws = await dstFileHandle.createWritable({ keepExistingData: false });
      await ws.write(new Blob([bytes], { type: "application/pdf" }));
      await ws.close(); ws = undefined;
    } catch (e) {
      try { await ws?.abort(); } catch {}
      throw e;
    }

    // --- LÖSCHEN in Inbox (im korrekten Parent-Ordner) ---
let deleted = false;
if (okIn) {
  try {
    if (Array.isArray(rel) && rel.length) {
      // Wir haben einen Relativpfad → in Unterordnern löschen
      let parent = inboxRootHandle;
      const segs = rel.slice();          // ["Unterordner", "Datei.pdf"] oder ["Datei.pdf"]
      const baseName = segs.pop();       // "Datei.pdf"
      for (const s of segs) {
        parent = await parent.getDirectoryHandle(s, { create:false });
      }
      await parent.removeEntry(baseName);
      deleted = true;
    } else {
      // Fallback: keine rel-Info (resolve==null) → im Inbox-ROOT versuchen
      await inboxRootHandle.removeEntry(fileName);
      deleted = true;
    }
  } catch (e) {
    console.warn("removeEntry failed (will keep source):", e);
  }
}


    // Feedback
    if (deleted) {
      toast(`Verschoben nach „Bearbeitet“: <code>${finalName}</code>`, 2500);
    } else {
      toast(`Kopiert nach „Bearbeitet“ (Quelle blieb erhalten): <code>${finalName}</code>`, 2800);
    }

    // Aufräumen
    currentInboxRelPath = null;
    currentInboxFileHandle = null;
    currentInboxFileName = "";
// >>> UI-Refresh (sofort, ohne F5) — self-contained, ohne globale Helfer
try {
  // 1) Entferne den Eintrag rein über DOM
  const esc = s => String(s).replace(/(["'\\])/g, "\\$1");
  const sel = `button.linklike[data-file="${esc(fileName)}"]`;
  document.querySelector(sel)?.closest("li")?.remove();

  // 2) Liste aus dem Dateisystem neu aufbauen (falls vorhanden)
  const list = document.querySelector("#inboxList");
  const counters = document.querySelector("#counters");
  if (list && inboxRootHandle) {
    list.innerHTML = "";
    let offen = 0;

    for await (const e of inboxRootHandle.values()){
      if (e.kind !== "file") continue;
      if (!e.name.toLowerCase().endsWith(".pdf")) continue;

      // 0-Byte-Platzhalter ausblenden
      let f;
      try {
        const h = await inboxRootHandle.getFileHandle(e.name, { create:false });
        f = await h.getFile();
      } catch { continue; }
      if (!f || f.size === 0) continue;

      offen++;
      const li = document.createElement("li");
      li.innerHTML = `<button class="linklike" data-file="${e.name}">${e.name}</button><span class="badge">Inbox</span>`;
      list.appendChild(li);

      // Click-Handler wie in deiner Inbox-Auswahl
      li.querySelector("button").addEventListener("click", async () => {
        try {
          const h = await inboxRootHandle.getFileHandle(e.name, { create:false });
          const fileNow = await h.getFile();
          if (!fileNow.size) { toast(`„${e.name}“ ist 0 Byte – bitte zuerst lokal synchronisieren.`, 4000); return; }
          currentInboxFileHandle = h;
          currentInboxFileName   = e.name;
          currentInboxRelPath    = [e.name];
          toast(`Inbox-Datei ausgewählt: <code>${e.name}</code>`, 1400);
          if (typeof window.__fdl_takeFile === "function"){
            await window.__fdl_takeFile(fileNow, { fromInbox:true });
          }
        } catch (err) {
          console.warn("Inbox-Auswahl fehlgeschlagen:", err);
          toast("Konnte Datei nicht öffnen.", 2500);
        }
      });
    }

    if (counters){
      counters.textContent = `Offen: ${offen} · In Arbeit: 0 · Fertig: 0 · Session: 0`;
    }
  }

  // 3) Event trotzdem feuern (falls später Listener existieren)
  window.dispatchEvent(new CustomEvent("fdl:file-moved", {
    detail: { from: "Inbox", to: "Bearbeitet", srcName: fileName, dstName: finalName }
  }));
} catch(e){
  console.warn("post-move UI refresh failed:", e);
}

return true;

} catch (e) {
  console.error("moveInboxToProcessed failed:", e);
  toast(`Verschieben fehlgeschlagen: ${e?.message || e}`, 4000);
  return false;
}
}
/* -------------------------------- Speichern ------------------------------ */
/** Stempelt links vertikal: Datum – EINGEGANGEN – Kürzel (einzeilig, rotiert). */
async function stampPdf(buf){
  if (!window.PDFLib) return buf;
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

  try {
    const doc  = await PDFDocument.load(buf);
    const page = doc.getPages()[0];
    if (!page) return buf;

    const font = await doc.embedFont(StandardFonts.HelveticaBold);

    // Text in gewünschter Reihenfolge
    const dateStr = (recvDateEl?.value || (typeof today === "function" ? today() : new Date().toLocaleDateString("de-DE")));
    const objStr  = (objSel?.value || "—");
    const text    = `${dateStr} – EINGEGANGEN – ${objStr}`;

    // Größe/Farbe wie bisher, Position links oben, vertikal nach unten
    const size = Math.max(10, Math.round(page.getWidth() * 0.018));
    page.drawText(text, {
      x: 16,
      y: page.getHeight() - 40,
      size,
      font,
      color: rgb(0.886, 0, 0.102),
      rotate: degrees(-90)
    });

    const out = await doc.save({ useObjectStreams: true });
    return out.buffer || out; // kompatibel bleiben
  } catch (e) {
    console.error("[stampPdf] Fehler:", e);
    return buf; // niemals blockieren
  }
}



// === SPEICHERN: Klick-Handler ===
$("#saveBtn")?.addEventListener("click", async (ev) => {
  ev.preventDefault();

  try {
    if (!pdfDoc || !saveArrayBuffer) {
      toast("Keine PDF geladen.", 2000);
      return;
    }

    // 1) Dateiname & Bytes vorbereiten
    const fileName = (typeof effectiveFileName === "function")
      ? effectiveFileName()
      : (lastFile?.name || "dokument.pdf");

    let stampedBytes = saveArrayBuffer;
    try { stampedBytes = await stampPdf(saveArrayBuffer); } catch {}

    // 2) Ziele auflösen & schreiben
    const t = (typeof resolveTargets === "function") ? resolveTargets() : {};
    let okScope=false, okPcl=false, okPclBucket=false, okLocal=false;

    // Scopevisio
    if (t?.scope?.root && t.scope.seg?.length) {
      try {
        await writeFileTo(t.scope.root, t.scope.seg, stampedBytes, fileName, { unique:true });
        okScope = true;
      } catch (e) {
        console.warn("Scopevisio-Write failed:", e);
        toast("Scopevisio: Speichern fehlgeschlagen.", 2200);
      }
    }

    // pCloud (Objektpfad)
    if (t?.pcloud?.root && t.pcloud.seg?.length) {
      try {
        await writeFileTo(t.pcloud.root, t.pcloud.seg, stampedBytes, fileName, { unique:true });
        okPcl = true;
      } catch (e) {
        console.warn("pCloud-Write failed:", e);
        toast("pCloud: Speichern fehlgeschlagen.", 2200);
      }
    }

    // pCloud Sammelordner
    if (t?.pcloudBucket?.root && t.pcloudBucket.seg?.length) {
      try {
        await writeFileTo(t.pcloudBucket.root, t.pcloudBucket.seg, stampedBytes, fileName, { unique:true });
        okPclBucket = true;
      } catch (e) {
        console.warn("pCloud (Sammelordner) failed:", e);
        toast("pCloud (Sammelordner): Speichern fehlgeschlagen.", 2200);
      }
    }

    // Lokal (optional)
    const wantLocal = $("#chkLocal")?.checked === true;
    if (wantLocal && window.showSaveFilePicker) {
      try {
        const fh = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }]
        });
        const ws = await fh.createWritable({ keepExistingData:false });
        await ws.write(new Blob([stampedBytes], { type:"application/pdf" }));
        await ws.close();
        okLocal = true;
      } catch (e) {
        if (e?.name !== "AbortError") {
          console.warn("Local save failed:", e);
          toast("Lokal: Speichern fehlgeschlagen.", 2200);
        }
      }
    }

    // 3) E-Mail – nur wenn Empfänger vorhanden
    const to  = [...Mail.to];
    const cc  = [...Mail.cc];
    const bcc = [...Mail.bcc];
    const rc  = to.length + cc.length + bcc.length;

    if (rc) {
      const { subject, replyTo } = (typeof computeSubjectAndReply === "function")
        ? computeSubjectAndReply()
        : { subject:"", replyTo:"" };

      const subj = (subject && subject.trim()) || "(ohne Betreff)";

      const confirmText = [
        "E-Mail jetzt senden?",
        "",
        `An:       ${to.join(", ") || "—"}`,
        cc.length  ? `CC:       ${cc.join(", ")}`  : "",
        bcc.length ? `BCC:      ${bcc.join(", ")}` : "",
        `Betreff:  ${subj}`,
        `Reply-To: ${replyTo || "—"}`,
        `Anhang:   ${fileName}`
      ].filter(Boolean).join("\n");

      if (window.confirm(confirmText)) {
        try {
          await sendMail({
            to, cc, bcc,
            subject: subject || "",
            text: (typeof computeMailBody === "function" ? computeMailBody() : ""),
            replyTo: replyTo || undefined,
            attachmentBytes: stampedBytes,
            attachmentName: fileName
          });
          toast("<strong>E-Mail versendet</strong>", 2500);
        } catch (e) {
          toast(`⚠️ E-Mail-Versand fehlgeschlagen: ${e?.message || e}`, 4000);
        }
      } else {
        toast("E-Mail-Versand abgebrochen.", 1800);
      }
    }

    // 4) Inbox → Bearbeitet, wenn irgendwas gespeichert wurde oder Lokal gewünscht war
    if (currentInboxFileHandle && (okScope || okPcl || okPclBucket || okLocal || wantLocal)) {
      try {
        const moved = await moveInboxToProcessed();
        if (moved) toast("Inbox → Bearbeitet verschoben.", 1600);
      } catch (e) {
        console.warn("post-move failed:", e);
        toast("Verschieben in 'Bearbeitet' fehlgeschlagen.", 2500);
      }
    }

    // 5) Feedback & Reset
    const okTargets = [
      okScope     ? "Scopevisio"            : null,
      okPcl       ? "pCloud"                : null,
      okPclBucket ? "pCloud (Sammelordner)" : null,
      okLocal     ? "Lokal"                 : null
    ].filter(Boolean).join(" & ") || "—";

    toast(`<strong>Gespeichert</strong><br>${fileName}<br><em>${okTargets}</em>`, 4200);
    if (typeof hardReset === "function") hardReset();

  } catch (e) {
    console.error("[SAVE] Fehler:", e);
    toast(`<strong>Fehler</strong><br>${e?.message || e}`, 6000);
  }
});

// Cancel: full reset
$("#cancelBtn")?.addEventListener("click",(e)=>{ e.preventDefault(); hardReset(); toast("Vorgang abgebrochen.",1500); });


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

  // ⇩⇩⇩ WICHTIG: zuerst gespeicherte Handles wiederherstellen
  await restoreBoundHandles();

  try { emailsCfg      = await loadJson("emails.json"); }       catch { emailsCfg = null; }
  try { assignmentsCfg = await loadJson("assignments.json"); } catch { assignmentsCfg = null; }

  paintChips();
  await loadObjects();
  await loadDocTypes();
  await updateSubfolderOptions();

  populateMailSelect();
  attachMailUI();
  attachUpload();
  attachZoom();

  $("#chkScope") ?.addEventListener("change", refreshPreview);
  $("#chkPcloud")?.addEventListener("change", refreshPreview);
  $("#chkPcloudBucket") ?.addEventListener("change", refreshPreview); // ← NEU
  $("#chkPcloudCollect")?.addEventListener("change", refreshPreview); // <— NEU
  $("#chkLocal") ?.addEventListener("change", refreshPreview);

  // Eingangsdatum standardmäßig auf HEUTE setzen (falls leer)
  if (recvDateEl && !recvDateEl.value) {
    recvDateEl.value = today();
    recvDateEl.classList.add("auto");
  }

  // === Defaults + Merken der Auswahl ===
function loadTargetPrefs(){
  try { return JSON.parse(localStorage.getItem("fdlTargets")||"{}"); }
  catch { return {}; }
}
function saveTargetPrefs(prefs){
  try { localStorage.setItem("fdlTargets", JSON.stringify(prefs)); } catch {}
}
function applyPrefs(p){
  const s  = $("#chkScope");
  const pc = $("#chkPcloud");
  const pb = $("#chkPcloudBucket") || $("#chkPcloudCollect"); // je nach ID
  const lo = $("#chkLocal");
  if (s)  s.checked  = !!p.scope;
  if (pc) pc.checked = !!p.pcloud;
  if (pb) pb.checked = !!p.bucket;
  if (lo) lo.checked = !!p.local;
}

let prefs = loadTargetPrefs();
if (!("scope" in prefs) && !("bucket" in prefs) && !("pcloud" in prefs) && !("local" in prefs)) {
  // Erststart → unsere Defaults
  prefs = { scope:true, bucket:true, pcloud:false, local:false };
  saveTargetPrefs(prefs);
}
applyPrefs(prefs);

// bei Änderungen sofort speichern
["#chkScope","#chkPcloud","#chkPcloudBucket","#chkPcloudCollect","#chkLocal"].forEach(sel=>{
  const el = $(sel);
  el?.addEventListener("change", ()=>{
    const next = {
      scope:  $("#chkScope")?.checked || false,
      pcloud: $("#chkPcloud")?.checked || false,
      bucket: ($("#chkPcloudBucket")?.checked || $("#chkPcloudCollect")?.checked) || false,
      local:  $("#chkLocal")?.checked || false
    };
    saveTargetPrefs(next);
    refreshPreview();
  });
});


  refreshPreview();

}

  if (!window.__FDL_BOOT_BOUND__){ window.__FDL_BOOT_BOUND__ = true; const start = () => { boot().catch(err => console.error("Boot failed:", err)); }; if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else queueMicrotask(start); }

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

// globale Repaint-Strategie: preferiere zentrales paintChips(), fallback DOM-only
function repaintInboxList(){
  if (typeof paintChips === "function") {
    try { paintChips(); return; } catch(e){ console.warn("paintChips() failed:", e); }
  }
  // Falls kein zentraler Renderer existiert, wenigstens Zähler neu setzen, wenn du eine Funktion hast:
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

  function _safeChunk(s) {
    return String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[^\wÄÖÜäöüß ,\-]/g, "")
      .replace(/_/g, " ");
  }

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
      if (invoiceNo)  parts.push(`RE ${_safeChunk(invoiceNo)}`);
      if (objCode)    parts.push(_safeChunk(objCode));
      if (ymd)        parts.push(_safeChunk(ymd));
    } else {
      if (sender)     parts.push(_safeChunk(sender));
      if (objCode)    parts.push(_safeChunk(objCode));
      if (ymd)        parts.push(_safeChunk(ymd));
    }
    const base = parts.filter(Boolean).join("_");
    return base ? `${base}.pdf` : "";
  };
})();
