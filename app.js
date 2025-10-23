/* ==========================================================================
   Fidelior – app.js  (FINAL • 2025-10-21 r20)
   Fixes & polish:
   • Status-Pills (tri-state): Betreff aus defaults.invoice.Fidelior.subjectByStatus,
     Empfänger aus defaults.invoice.Fidelior.toByStatus; perObject-Empfänger bleiben,
     keine Duplikate, Abwahl erlaubt → manueller Betreff.
   • Dateiname live & korrekt; ARNDT & CIE exakt so im Dateinamen; keine „·“-DisplayNames
     in Pfadberechnung (Scopevisio nutzt scopevisioName, pCloud nutzt pcloudName).
   • Subfolder-Dropdown wieder da (auch für Nicht‑Rechnung); B75 Spezialordner sichtbar.
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
// ===== Helper: Quelle im Inbox-ROOT erkennen (Name + Größe) =====
async function tryBindInboxContextForFileByName(file) {
  if (!inboxRootHandle || !file?.name) return false;
  try {
    // Versuche, im Inbox-ROOT eine Datei gleichen Namens zu holen
    const h = await inboxRootHandle.getFileHandle(file.name, { create: false });
    const f2 = await h.getFile();
    // Heuristik: gleicher Name + gleiche Größe ⇒ wir behandeln es als Inbox-Quelle (Root)
    if (f2 && f2.size && f2.size === file.size) {
      currentInboxFileHandle = h;
      currentInboxFileName   = file.name;
      currentInboxRelPath    = [file.name]; // Root-Fall
      return true;
    }
  } catch {}
  return false;
}

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


  /* --------------------------- Auto-Erkennung ------------------------------ */
  async function extractTextFirstPages(pdf, maxPages=3){ const N=Math.min(maxPages, pdf.numPages); let out=[]; for(let i=1;i<=N;i++){ const p=await pdf.getPage(i); const c=await p.getTextContent({ normalizeWhitespace:true, disableCombineTextItems:false }); out.push((c.items||[]).map(it=>it.str).join(" ")); } return out.join("\n"); }
  function euroToNum(s){ let x=(s||"").replace(/[€\s]/g,"").replace(/−/g,"-"); if(x.includes(",")&&x.includes(".")) x=x.replace(/\./g,"").replace(",","."); else if(x.includes(",")) x=x.replace(",","."); const v=Number(x); return isFinite(v)?v:NaN; }
  async function autoRecognize(){ try{ const txt = (await extractTextFirstPages(pdfDoc,3)) || ""; const moneyHits=[...txt.matchAll(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/g)].map(m=>m[0]); if(moneyHits.length){ const pick = moneyHits.map(v=>({v,n:euroToNum(v)})).sort((a,b)=>b.n-a.n)[0].v; amountEl.dataset.raw=pick; amountEl.value=formatAmountDisplay(pick); amountEl.classList.add("auto"); } // --- NEU: Datum erkennen (auch Monatsnamen) und niemals Zukunft wählen ---
const MONTHS = {
  januar:1,februar:2,maerz:3,märz:3,april:4,mai:5,juni:6,
  juli:7,august:8,september:9,oktober:10,november:11,dezember:12
};
const isoFromDMY = (d,m,y) => {
  const yy = String(y).length === 2 ? (+y < 50 ? 2000 + +y : 1900 + +y) : +y;
  return `${yy}-${pad2(m)}-${pad2(d)}`;
};

const dateHits = [];

// 1) 01.02.2025 / 1-2-25
for (const m of txt.matchAll(/\b(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})\b/g)) {
  dateHits.push( isoFromDMY(+m[1], +m[2], m[3]) );
}

// 2) 23. November 2025
for (const m of txt.matchAll(/\b(\d{1,2})\.\s*(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})\b/gi)) {
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon) dateHits.push( isoFromDMY(+m[1], mon, m[3]) );
}

// 3) „im November 2025“ → 01.11.2025
for (const m of txt.matchAll(/\b(?:im\s+)?(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})\b/gi)) {
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon) dateHits.push( isoFromDMY(1, mon, m[2]) );
}
// Auswahl: NIE in der Zukunft. Wenn nichts Vergangenes/Heute gefunden → nimm heute.
const todayIso = new Date().toISOString().slice(0,10);

// Eindeutige Treffer, sortiert (YYYY-MM-DD sortiert lexikographisch korrekt)
const uniq = Array.from(new Set(dateHits)).filter(Boolean).sort();

// alles ≤ heute
const nonFuture = uniq.filter(d => d <= todayIso);

// Wahl: letztes nicht-zukünftiges Datum, sonst heute
const picked = nonFuture.length ? nonFuture[nonFuture.length - 1] : todayIso;

invDateEl.value = isoToDisp(picked);
invDateEl.classList.add("auto");


      if(assignmentsCfg?.patterns?.length){ const t=txt.toLowerCase(); const hit=assignmentsCfg.patterns.find(p=> String(p.pattern||"").split("|").some(rx=>{ try{ return new RegExp(rx,"i").test(t); }catch{ return t.includes(rx.toLowerCase()); } })); if(hit?.object){ const before=objSel.value; objSel.value = hit.object; if(objSel.value!==before) toast(`Zuordnung: <strong>${hit.object}</strong>`,2000); } }
      applyPerObjectMailRules(); prefillMail(); updateStatusPillsVisibility(); const found = []; if(amountEl.value) found.push("Betrag"); if(invDateEl.value) found.push("Rechnungsdatum"); if(invNoEl.value) found.push("Rechnungsnr."); if(found.length) toast(`<strong>Automatisch erkannt</strong><br>${found.join(" · ")}`,3000); refreshPreview(); }catch(e){ console.warn("Auto-Erkennung fehlgeschlagen", e); toast("Auto-Erkennung fehlgeschlagen.", 2500); } }

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

 function computeFileNameAuto(){
  const betragRaw = (amountEl?.value || "").trim();
  const objCode   = (objSel?.value  || "").trim();
  const sub       = (subSel?.value  || "").trim();   // Unterordner

  // Objekt-Teil (Standard)
  let objektPart = (() => {
    const c = String(objCode).toUpperCase();
    if (c === "ARNDTCIE" || c === "ARNDT&CIE" || c === "ARNDT & CIE") return "ARNDT & CIE";
    return objCode;
  })();

  // B75 + D1/D4 → B75-D1 / B75-D4
  if (/^B75$/i.test(objCode) && /^(D1|D4)$/i.test(sub)) {
    objektPart = `B75-${sub.toUpperCase()}`;
  }

  const absender = (senderEl?.value || "").trim();
  const datum =
    (dispToIso(invDateEl?.value) || dispToIso(recvDateEl?.value) || "").replace(/-/g,".")
    || today().split(".").reverse().join(".");

  const includeAmount = isInvoice() && betragRaw && !/^0+(?:[.,]00)?$/.test(betragRaw);

  const parts = [];
  if (includeAmount) parts.push(betragRaw);
  if (objektPart)    parts.push(objektPart);
  if (absender)      parts.push(absender);
  parts.push(datum);

  return (parts.join("_") || "dokument") + ".pdf";
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

  async function updateSubfolderOptions(){
    if(!subRow || !subSel) return; const code=(objSel?.value||"").trim(); const invoice=isInvoice(); subRow.style.display="none"; subSel.innerHTML="";
    if(!code || code === "PRIVAT") return;
    if (code === "FIDELIOR") { if (!invoice) { if (!pcloudRootHandle) return; const base=["FIDELIOR","VERWALTUNG"]; const options=await listChildFolders(pcloudRootHandle, base); if (options.length){ subSel.innerHTML = options.map(v=>`<option value="${v}">${v}</option>`).join(""); subSel.value = options[0]||""; subRow.style.display="grid"; } } return; }
    const { scopeName, pcloudName } = getFolderNames(code);
    const scopeBase=["OBJEKTE", scopeName, (invoice?"Rechnungsbelege":"Objektdokumente")];
    let pclBase=null; if (!isArndtCie(code)) { if (code === "A15" && invoice) pclBase=["FIDELIOR","OBJEKTE","A15 Ahrweiler Straße 15","Buchhaltung","Rechnungsbelege"]; else pclBase=["FIDELIOR","OBJEKTE", pcloudName, (invoice?"Rechnungsbelege":"Objektdokumente")]; }
    const known = new Set(getKnownSubfolders(code)); if (invoice) known.add("Rechnungsbelege"); else known.add("Objektdokumente");
    const lists=[]; if (scopeRootHandle) lists.push(listChildFolders(scopeRootHandle, scopeBase)); if (pcloudRootHandle && pclBase) lists.push(listChildFolders(pcloudRootHandle, pclBase));
    const foundLists=(await Promise.all(lists).catch(()=>[[]])).flat(); foundLists.forEach(n=>known.add(n));
    const options=[...known].filter(Boolean);
    if (!options.length) { if (!invoice) { subSel.innerHTML = `<option value="Objektdokumente">Objektdokumente</option>`; subRow.style.display="grid"; } return; }
    subSel.innerHTML = options.map(v => `<option value="${v}">${v}</option>`).join("");
    subSel.value = invoice ? (options.includes("Rechnungsbelege")?"Rechnungsbelege":options[0]) : (options.includes("Objektdokumente")?"Objektdokumente":options[0]);
    subRow.style.display = "grid";
  }

  function refreshPreview(){
    const hasDoc = !!pdfDoc;
    if (fileNameInput){ if (!hasDoc){ if (fileNameInput.dataset.mode !== "manual") fileNameInput.value = ""; } else if (fileNameInput.dataset.mode !== "manual") { fileNameInput.value = computeFileNameAuto(); } }
    else if (fileNamePrev) { fileNamePrev.textContent = hasDoc ? computeFileNameAuto() : "-"; }
    if (!hasDoc){ targetPrev && (targetPrev.innerHTML = "—"); return; }
    const code=(objSel?.value||"").trim(); const year=String(currentYear()); const invoice=isInvoice(); const sub=(subSel?.value||"").trim();
    const wantScope=$("#chkScope")?.checked === true; const wantPcl=$("#chkPcloud")?.checked === true;
    const { scopeName, pcloudName } = getFolderNames(code); const lines=[];
    if (wantScope && code){ let seg; if (code === "FIDELIOR") seg=["FIDELIOR", (invoice?"Eingangsrechnungen":"Dokumente"), year]; else if (code === "PRIVAT") seg=["PRIVAT", (invoice?"Rechnungsbelege":"Dokumente"), year]; else if (isArndtCie(code)) seg=["ARNDT & CIE", (invoice?"Eingangsrechnungen":"Dokumente"), year]; else { const base=["OBJEKTE", scopeName, (invoice?"Rechnungsbelege":"Objektdokumente")]; const leaf=(sub && !["Rechnungsbelege","Objektdokumente"].includes(sub)) ? [sub, year] : [year]; seg=base.concat(leaf); } lines.push("Scopevisio: " + seg.join("\\")); }
    if (wantPcl && code){ let seg=null; if (code === "FIDELIOR") seg = invoice? ["FIDELIOR","VERWALTUNG","Finanzen - Buchhaltung","Eingangsrechnungen", year] : (sub ? ["FIDELIOR","VERWALTUNG", sub, year] : null); else if (code === "PRIVAT") seg=["FIDELIOR","PRIVAT", (invoice?"Rechnungsbelege":"Dokumente"), year]; else if (!isArndtCie(code)){ if (code === "A15" && invoice){ const base=["FIDELIOR","OBJEKTE","A15 Ahrweiler Straße 15","Buchhaltung","Rechnungsbelege"]; const leaf=(sub && sub!=="Rechnungsbelege")?[sub,year]:[year]; seg=base.concat(leaf);} else { if (!invoice && !sub){ seg=null; } else { const base=["FIDELIOR","OBJEKTE", pcloudName, (invoice?"Rechnungsbelege":"Objektdokumente")]; const leaf=(sub && !["Rechnungsbelege","Objektdokumente"].includes(sub)) ? [sub, year] : [year]; seg=base.concat(leaf);} } } lines.push("pCloud: " + (seg ? seg.join("\\") : "—")); }
    if (!wantScope && !wantPcl) lines.push($("#chkLocal")?.checked ? "Nur lokal" : "—");
    targetPrev && (targetPrev.innerHTML = lines.join("<br>"));
  }

  function resolveTargets(){
    const code=(objSel?.value||"").trim(); const year=String(currentYear()); const invoice=isInvoice(); const sub=(subSel?.value||"").trim();
    const wantScope=$("#chkScope")?.checked === true; const wantPcl=$("#chkPcloud")?.checked === true;
    const { scopeName, pcloudName } = getFolderNames(code); const out={ scope:null, pcloud:null };
    if(!code) return out;
    if (wantScope && scopeRootHandle){ if (code === "FIDELIOR") out.scope = { root:scopeRootHandle, seg:["FIDELIOR", (invoice?"Eingangsrechnungen":"Dokumente"), year] }; else if (code === "PRIVAT") out.scope = { root:scopeRootHandle, seg:["PRIVAT", (invoice?"Rechnungsbelege":"Dokumente"), year] }; else if (isArndtCie(code)) out.scope = { root:scopeRootHandle, seg:["ARNDT & CIE", (invoice?"Eingangsrechnungen":"Dokumente"), year] }; else { const base=["OBJEKTE", scopeName, (invoice?"Rechnungsbelege":"Objektdokumente")]; const leaf=(sub && !["Rechnungsbelege","Objektdokumente"].includes(sub)) ? [sub, year] : [year]; out.scope = { root:scopeRootHandle, seg: base.concat(leaf) }; } }
    if (wantPcl && pcloudRootHandle){ if (code === "FIDELIOR") out.pcloud = invoice? { root: pcloudRootHandle, seg: ["FIDELIOR","VERWALTUNG","Finanzen - Buchhaltung","Eingangsrechnungen", year] } : (sub ? { root: pcloudRootHandle, seg: ["FIDELIOR","VERWALTUNG", sub, year] } : null); else if (code === "PRIVAT") out.pcloud = { root:pcloudRootHandle, seg:["FIDELIOR","PRIVAT", (invoice?"Rechnungsbelege":"Dokumente"), year] }; else if (!isArndtCie(code)){ if (code === "A15" && invoice){ const base=["FIDELIOR","OBJEKTE","A15 Ahrweiler Straße 15","Buchhaltung","Rechnungsbelege"]; const leaf=(sub && sub!=="Rechnungsbelege") ? [sub, year] : [year]; out.pcloud = { root:pcloudRootHandle, seg: base.concat(leaf) }; } else { if (!invoice && !sub){ out.pcloud = null; } else { const base=["FIDELIOR","OBJEKTE", pcloudName, (invoice?"Rechnungsbelege":"Objektdokumente")]; const leaf=(sub && !["Rechnungsbelege","Objektdokumente"].includes(sub)) ? [sub, year] : [year]; out.pcloud = { root:pcloudRootHandle, seg: base.concat(leaf) }; } } } }
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

    // aktuellen Wert übernehmen
    const iso = dispToIso(textInput.value);
    if (iso) hidden.value = iso;

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
async function writeFileTo(rootHandle, segments, bytes, fileName){
  if (!rootHandle) throw new Error("Root-Handle fehlt");
  if (!fileName)   throw new Error("Dateiname fehlt");

  const ok = await requestDirWrite(rootHandle);
  if (!ok) throw new Error("Schreibberechtigung verweigert");

  const dir = await ensureDirWithPrompt(rootHandle, segments || []);
  const fh  = await dir.getFileHandle(fileName, { create: true });

  let ws;
  try {
    ws = await fh.createWritable({ keepExistingData: false });
    await ws.write(new Blob([bytes], { type: "application/pdf" }));
    await ws.close();
    await tryRemoveCrSwap(dir, fileName);
    ws = undefined;

  } catch (e) {
    try { await ws?.abort(); } catch {}
    throw e;
  }
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

    try { emailsCfg   = await loadJson("config/emails.json"); } catch {}
    try { objectsCfg  = await loadJson("config/objects.json"); await loadObjects(); } catch {}
    try { docTypesCfg = await loadJson("config/document_types.json"); await loadDocTypes(); } catch {}
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
  async function loadJson(rel){
    try{ if(configDirHandle){ for await (const e of configDirHandle.values()){ if(e.kind==="file" && e.name.toLowerCase()===rel.split("/").pop().toLowerCase()){ const f=await configDirHandle.getFileHandle(e.name,{create:false}).then(h=>h.getFile()); return JSON.parse(await f.text()); } } } }catch{}
    const paths=[rel, "./"+rel, "config/"+rel, "./config/"+rel]; for(const p of paths){ try{ const r=await fetch(p,{cache:"no-store"}); if(r.ok) return await r.json(); }catch{} }
    throw new Error("Konfiguration nicht gefunden: "+rel);
  }
  async function saveJson(name, json){ if(!configDirHandle){ configDirHandle = await window.showDirectoryPicker({mode:"readwrite"}).catch(()=>null); if(!configDirHandle) throw new Error("Kein Config-Ordner verbunden."); } const fh=await configDirHandle.getFileHandle(name,{create:true}); const w=await fh.createWritable({keepExistingData:false}); await w.write(JSON.stringify(json,null,2)); await w.close(); }

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
    json = await loadJson("config/emails.json");
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
    const o = await loadJson("config/objects.json");
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
      await saveJson("config/emails.json", result);
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

  async function openObjectsDialog(){ await ensureConfigConnectedOrAsk(); const dlg=$("#manageObjectsDialog"); if(!dlg){ toast("Objekte-Dialog fehlt.",2000); return; } let j; try{ j = await loadJson("config/objects.json"); }catch{ j={objects:[]}; } const list = j.objects || []; const ul = $("#objectsList"); ul.innerHTML="";
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

  async function openTypesDialog(){ await ensureConfigConnectedOrAsk(); const dlg=$("#manageTypesDialog"); if(!dlg){ toast("Dokumentarten-Dialog fehlt.",2000); return; } let j; try{ j = await loadJson("config/document_types.json"); }catch{ j={types:[], defaultTypeKey:""}; } const list=j.types||[]; const ul=$("#typesList"); ul.innerHTML=""; const defaultKey=j.defaultTypeKey||"";
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

 // === NEU: openAssignmentsDialog mit „Einfach“-Eingabe (Stichwort + Kundennr.) ===
async function openAssignmentsDialog(){
  await ensureConfigConnectedOrAsk();

  const dlg = $("#manageAssignmentsDialog");
  if(!dlg){ toast("Zuordnungs-Dialog fehlt.",2000); return; }

  // Bestehende Regeln laden (bleiben erhalten)
  let j;
  try { j = await loadJson("config/assignments.json"); }
  catch { j = { patterns: [] }; }

  const tbody = $("#assignTbody");
  tbody.innerHTML = "";

  // ---- Tabellenzeile (wie bisher, editierbar) ----
  const addRow = (row={pattern:"", object:"", note:""}) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="input slim as-pat"  placeholder="RegEx oder mehrere per |" value="${row.pattern||""}"></td>
      <td><input class="input slim as-obj"  placeholder="Objektcode (z. B. B75)"   value="${row.object||""}"></td>
      <td><input class="input slim as-note" placeholder="Hinweis (optional)"       value="${row.note||""}"></td>
      <td class="right"><button class="icon-btn as-del" title="Löschen">🗑️</button></td>`;
    tr.querySelector(".as-del").onclick = ()=> tr.remove();
    tbody.appendChild(tr);
    return tr;
  };

  (j.patterns||[]).forEach(addRow);

  // ---- Einfach-Modus: erzeugt RegEx automatisch ----
  // Erwartet diese Felder im Dialog-HTML (oben über der Tabelle):
  // #saVendor, #saId, #saObject, #saNote, #saAddBtn
  // (Wenn sie fehlen, wird dieser Teil einfach übersprungen.)
  try {
    // Objektliste vorbefüllen, falls leer
   // Objektliste IMMER frisch befüllen (nicht nur wenn leer)
try {
  const o   = await loadJson("config/objects.json");
  const sel = $("#saObject");
  if (sel) {
    const opts = (o.objects || []).map(x => {
      const val = x.code || x.scopevisioName || x.displayName || "";
      const txt = x.displayName || x.code || x.scopevisioName || "";
      return `<option value="${val}">${txt}</option>`;
    }).join("");
    sel.innerHTML = `<option value="">(Objekt wählen)</option>` + opts;
    sel.value = ""; // Platzhalter aktiv lassen
  }
} catch {
  // Fallback, falls objects.json nicht geladen werden kann
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

  } catch {}

  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // „K1516411“ → K[-./\s]?1516[-./\s]?411 (robust gegen Trennzeichen)
  const loosenId = (id) => {
    const raw = String(id||"").trim();
    if (!raw) return "";
    const chunks = raw.replace(/\s+/g,"").match(/[A-Za-z]+|\d+/g) || [raw];

    const expandDigits = (d) => {
      if (d.length >= 7) return [d.slice(0,3), d.slice(3)];   // 3|rest
      return d.match(/\d{1,2}/g) || [d];                      // 1–2er Gruppen
    };

    const parts = chunks.flatMap(ch => /\d/.test(ch) ? expandDigits(ch) : [ch]);
    return parts.map(p => esc(p)).join("[-./\\s]?");
  };

  const buildPattern = (vendor, ident) => {
    const la = [];
    if (vendor) la.push(`(?=.*${esc(String(vendor).trim())})`);
    if (ident)  la.push(`(?=.*${loosenId(ident)})`);
    return la.join(""); // beide als Lookaheads
  };

  $("#saAddBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    const vendor = ($("#saVendor")?.value || "").trim();
    const ident  = ($("#saId")?.value     || "").trim();
    const obj    = ($("#saObject")?.value || "").trim();
    const note   = ($("#saNote")?.value   || "").trim();

    if (!vendor && !ident){ toast("Bitte Lieferant/Stichwort oder Kundennr. eingeben.", 2200); return; }
    if (!obj){ toast("Bitte ein Objekt wählen.", 2000); return; }

    const pat = buildPattern(vendor, ident);
    if (!pat){ toast("Konnte kein Muster erzeugen.", 2000); return; }

    addRow({
      pattern: pat,
      object: obj,
      note: note || (vendor || ident ? `auto: ${vendor||""}${ident?` · ${ident}`:""}`.trim() : "")
    });

    if ($("#saVendor")) $("#saVendor").value = "";
    if ($("#saId"))     $("#saId").value     = "";
    if ($("#saNote"))   $("#saNote").value   = "";
    if ($("#saObject")) $("#saObject").value = "";
    toast("Regel hinzugefügt (bearbeitbar).", 1600);
  });

  // +Neu: leere manuelle Zeile
  $("#assignAdd")?.addEventListener("click", ()=> addRow({}));

  // Speichern (unverändert, mit RegEx-Validierung)
  $("#assignSave")?.addEventListener("click", async ()=> {
    try{
      const rows = [...tbody.querySelectorAll("tr")].map(tr => {
        const pattern = tr.querySelector(".as-pat") ?.value.trim();
        const object  = tr.querySelector(".as-obj") ?.value.trim();
        const note    = tr.querySelector(".as-note")?.value.trim();
        if (!pattern || !object) return null;

        const ok = String(pattern).split("|").every(p => {
          try { new RegExp(p, "i"); return true; } catch { return false; }
        });
        if (!ok) throw new Error(`Ungültiges Muster: ${pattern}`);

        return { pattern, object, note };
      }).filter(Boolean);

      const next = { patterns: rows };
      await saveJson("assignments.json", next);
      toast("<strong>Zuordnung gespeichert</strong>", 1800);
      dlg.close?.();
    }catch(e){
      toast(`Fehler beim Speichern: ${e?.message||e}`, 2800);
    }
  });

  if (typeof dlg.showModal==="function") dlg.showModal(); else dlg.setAttribute("open","open");
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

    return true;

  } catch (e) {
    console.error("moveInboxToProcessed failed:", e);
    toast(`Verschieben fehlgeschlagen: ${e?.message || e}`, 4000);
    return false;
  }
}


  /* -------------------------------- Speichern ------------------------------ */
  async function stampPdf(buf){ if(!window.PDFLib) return buf; const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib; const doc = await PDFDocument.load(buf); const page = doc.getPages()[0]; if(!page) return buf; const font = await doc.embedFont(StandardFonts.HelveticaBold); const text = `${(objSel?.value||"—")} – EINGEGANGEN: ${recvDateEl?.value||today()}`; const size = Math.max(10, Math.round(page.getWidth()*0.018)); page.drawText(text, { x: 16, y: page.getHeight()-40, size, font, color: rgb(0.886,0,0.102), rotate: degrees(-90) }); const out = await doc.save({ useObjectStreams:true }); return out.buffer; }
  async function pickAndWriteLocal(fileName, bytes){ if (!window.showSaveFilePicker) return false; const handle=await window.showSaveFilePicker({ suggestedName:fileName, types:[{description:"PDF", accept:{ "application/pdf":[".pdf"] }}] }).catch(()=>null); if(!handle) return false; const ws=await handle.createWritable(); await ws.write(new Blob([bytes],{type:"application/pdf"})); await ws.close(); return true; }

  $("#saveBtn")?.addEventListener("click", async ()=>{
    try{
      if(!saveArrayBuffer || !pdfDoc || !lastFile) { toast("Kein Dokument geladen.",2500); return; }
      if ($("#chkScope")?.checked && !scopeRootHandle) { toast("Nicht verbunden: <strong>Scopevisio</strong>. Bitte zuerst verbinden.", 3500); return; }
      if ($("#chkPcloud")?.checked && !pcloudRootHandle){ toast("Nicht verbunden: <strong>pCloud</strong>. Bitte zuerst verbinden.", 3500); return; }
      const wantLocal = $("#chkLocal")?.checked === true;
      const fileName = effectiveFileName();
      const stamped = await stampPdf(saveArrayBuffer);
      const targets = resolveTargets();
      // --- Schreibrechte hart anstoßen (nur innerhalb des Klick-Handlers klappt der Prompt) ---
if (targets.scope) {
  const ok = await ensureWritePermissionWithPrompt(targets.scope.root, "Scopevisio");
  if (!ok) return;
}
if (targets.pcloud) {
  const ok = await ensureWritePermissionWithPrompt(targets.pcloud.root, "pCloud");
  if (!ok) return;
}


      if (targets.scope) toast(`Ziel (Scopevisio):<br><code>${targets.scope.seg.join("\\")}\\${fileName}</code>`, 2800);
      if (targets.pcloud) toast(`Ziel (pCloud):<br><code>${targets.pcloud.seg.join("\\")}\\${fileName}</code>`, 2800);
      let okScope=false, okPcl=false;
      if(targets.scope){ try{ await writeFileTo(targets.scope.root, targets.scope.seg, stamped, fileName); okScope=true; } catch(e){ toast(`⚠️ Schreiben nach <strong>Scopevisio</strong> fehlgeschlagen:<br><code>${targets.scope.seg.join("\\")}</code><br>${e?.message||e}`,6000); } }
      if(targets.pcloud){ try{ await writeFileTo(targets.pcloud.root, targets.pcloud.seg, stamped, fileName); okPcl=true; } catch(e){ toast(`⚠️ Schreiben nach <strong>pCloud</strong> fehlgeschlagen:<br><code>${targets.pcloud.seg.join("\\")}</code><br>${e?.message||e}`,6000); } }
      if(!okScope && !okPcl && !wantLocal){ if ((objSel?.value||"") === "FIDELIOR" && !isInvoice() && !subSel?.value){ toast("Kein pCloud-Ziel: Bitte unter „VERWALTUNG“ einen Unterordner wählen.", 4500); } else { toast("Es wurde in kein Ziel geschrieben.", 3500); } return; }
      if(wantLocal){ const localSaved = await pickAndWriteLocal(fileName, stamped); if(localSaved) toast("Lokale Kopie gespeichert.",1200); }
      { const to=[...Mail.to], cc=[...Mail.cc], bcc=[...Mail.bcc]; const { subject, replyTo } = computeSubjectAndReply(); if (to.length || cc.length || bcc.length){ try{ await sendMail({ to, cc, bcc, subject, text: computeMailBody(), replyTo: replyTo || undefined, attachmentBytes: stamped, attachmentName: fileName }); toast("<strong>E-Mail versendet</strong>", 2500); }catch(e){ toast(`⚠️ E-Mail-Versand fehlgeschlagen: ${e?.message||e}`, 4000); } } }
      if(currentInboxFileHandle && (okScope || okPcl || wantLocal)){console.log("MOVE? ", {
  hasHandle: !!currentInboxFileHandle,
  name: currentInboxFileName,
  okScope, okPcl, wantLocal
});
const moved = await moveInboxToProcessed(); if(moved) toast("Inbox → Bearbeitet verschoben.",1600); }
      const okTargets = [okScope?"Scopevisio":null, okPcl?"pCloud":null].filter(Boolean).join(" & ") || (wantLocal?"lokal":"—");
      toast(`<strong>Gespeichert</strong><br>${fileName}<br><em>${okTargets}</em>`, 4200);
      hardReset();
    }catch(e){ console.error(e); toast(`<strong>Fehler</strong><br>${e?.message||e}`,6000); }
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
  if (recvDateEl){ recvDateEl.value = ""; recvDateEl.classList.remove("auto"); }

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
  async function loadDocTypes(){ try{ const j = await loadJson("config/document_types.json"); docTypesCfg = j; const list=(j?.types||[]); const def=j?.defaultTypeKey||""; typeSel.innerHTML = ""; const ph = new Option("(Dokumenttyp wählen)",""); ph.disabled = true; typeSel.appendChild(ph); list.forEach(t=>{ const o = new Option(t.label || t.key || "", t.key || t.label); if (t.isInvoice) o.dataset.isInvoice = "true"; if (t.key === def) o.selected = true; typeSel.appendChild(o); }); }catch{ typeSel.innerHTML = `
        <option value="" disabled>(Dokumenttyp wählen)</option>
        <option value="rechnung" data-isinvoice="true">Rechnung</option>
        <option value="sonstiges">Sonstiges</option>`; } }
 async function loadObjects(){
  try{
    // 1) Datei laden
    const j = await loadJson("config/objects.json");
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


  objSel?.addEventListener("change", async () => {
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

  await updateSubfolderOptions();
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

  try { emailsCfg      = await loadJson("config/emails.json"); }       catch { emailsCfg = null; }
  try { assignmentsCfg = await loadJson("config/assignments.json"); } catch { assignmentsCfg = null; }

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
  $("#chkLocal") ?.addEventListener("change", refreshPreview);

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



})();
