/* ==== Fidelior app.js – final (stabil) ==== */
console.log("app.js geladen");

if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/* ---------- Helpers ---------- */
const $  = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const setStatus =(t)=>{ const el=$("#uploadStatus"); if(el) el.textContent = t || ""; };

let toastHost = $("#toastHost");
if(!toastHost){
  toastHost = document.createElement("div");
  toastHost.id="toastHost";
  toastHost.className="toast-host";
  document.body.appendChild(toastHost);
}
function toast(html, ms=9000){
  const div=document.createElement("div");
  div.className="toast";
  div.innerHTML=html+`<div class="toast-actions"></div>`;
  toastHost.appendChild(div);
  const t=setTimeout(()=>div.remove(),ms);
  return { root:div, actions:div.querySelector(".toast-actions"), close:()=>{clearTimeout(t);div.remove();} };
}

// === Mail-Helfer: Datei -> Base64, Versand an Netlify, kleines Popup ===

// 1) Datei/Blob -> reines Base64 (ohne data:-Prefix)
async function fileToBase64(fileOrBlob) {
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob]);
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 2) Versand an die Netlify-Function (POST)
// [FIX] Robuster: Timeout + detailierte Fehler
async function sendEmailViaNetlify({ to=[], cc=[], bcc=[], subject="", text="", html="", attachments=[] }) {
  if (!to || !to.length) throw new Error("Kein Empfänger angegeben.");
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 15000); // 15s
  let res, bodyText = "";
  try {
    res = await fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, cc, bcc, subject, text, html, attachments }),
      signal: controller.signal
    });
    bodyText = await res.text();
  } catch (e) {
    clearTimeout(timeout);
    throw new Error("Netzwerk/Timeout beim E-Mail-Versand: " + (e?.message||e));
  }
  clearTimeout(timeout);
  let data = {};
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  if (!res.ok || data.ok !== true) {
    const msg = data.error || `HTTP ${res.status} – ${res.statusText}`;
    throw new Error("E-Mail Versand fehlgeschlagen: " + msg);
  }
  return data; // { ok:true, messageId: ... }
}

// 3) Mini-Popup (nutzt nicht das große toast-Layout)
function showPopup(msg, ok=true) {
  const div = document.createElement("div");
  div.textContent = msg;
  Object.assign(div.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    padding: "10px 12px",
    borderRadius: "10px",
    background: ok ? "#1f9d55" : "#e02424",
    color: "#fff",
    font: "14px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial",
    boxShadow: "0 10px 24px rgba(0,0,0,.2)",
    zIndex: 9999
  });
  document.body.appendChild(div);
  setTimeout(()=>div.remove(), 4000);
}

/* ---------- State ---------- */
const supportsDirPicker = !!window.showDirectoryPicker;

let pdfDoc=null, renderTasks=[], zoom=1.10, lastFile=null, lastBlobUrl=null;
/* zwei getrennte Puffer */
let saveArrayBuffer=null;    // für Save (bleibt bei uns)
let previewArrayBuffer=null; // für pdf.js

const MIN_ZOOM=0.5, MAX_ZOOM=2.5, MAX_FILE_MB=50;

let inboxDirHandle=null, moveTargetDirHandle=null;

let scopeRootHandle=null, rootObjekteHandle=null, rootPrivatHandle=null, rootFideliorHandle=null;
let pcloudRootHandle=null, pcloudObjekteHandle=null, pcloudBuchhaltungHandle=null, pcloudPrivatBase=null, pcloudFideliorDocsBase=null;

/* pCloud-Config */
let configDirHandle=null;

/* IDB */
const IDB_DB="fidelior_db", IDB_STORE="kvs";
const KEY_SCOPE_ROOT="f_scope_root", KEY_PCLOUD_ROOT="f_pc_root";
const KEY_PCLOUD_OBJEKTE="f_pc_obj", KEY_PCLOUD_BUHA="f_pc_buha", KEY_PCLOUD_PRIV="f_pc_priv", KEY_PCLOUD_FDOC="f_pc_fdoc";
const KEY_INBOX="f_inbox", KEY_MOVE="f_move", KEY_CONFIG_DIR="f_config_dir";

/* ---------- DOM refs ---------- */
const pdfViewerEl=$("#pdfViewer"), placeholder=$("#previewPlaceholder");
const amountEl=$("#amountInput"), senderEl=$("#senderInput");
const recvDateEl=$("#receivedDate"), invDateEl=$("#invoiceDate");
const typeSel=$("#docTypeSelect"), objSel=$("#objectSelect"), b75Row=$("#b75Row"), b75Sel=$("#b75Subfolder");
const fileNamePrev=$("#fileNamePreview"), targetPrev=$("#targetPreview");
const countersEl=$("#counters"), inboxList=$("#inboxList");
const chipScope=$("#chipScope"), chipPcloud=$("#chipPcloud");

/* ---------- Utils ---------- */
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const pad2=(n)=> (n<10?"0":"")+n;
const ymd=(d)=>{ if(!d) return ""; const dt=new Date(d); return `${dt.getFullYear()}.${pad2(dt.getMonth()+1)}.${pad2(dt.getDate())}`; };

/* robuster Dateiname (Windows-kompatibel) */
function sanitizeFileName(name){
  let n=(name||"").normalize("NFC");
  n=n.replace(/[<>:"/\\|?*\x00-\x1F]/g,"_").replace(/\s+/g," ").replace(/[. ]+$/g,"");
  if(!n) n="dokument";
  const base=(n.match(/^([^.]*)/)?.[1]||n).toUpperCase();
  if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) n="_"+n;
  if(n.length>240) n=n.slice(0,240);
  return n;
}

/* Betrag-Formatter */
if (amountEl) amountEl.dataset.raw="";
function formatAmountDisplay(raw){
  raw=(raw||"").replace(/[^\d,]/g,"").replace(/,+/g,",");
  const hasComma=raw.includes(","), parts=raw.split(",");
  let euros=(parts[0]||"0").replace(/[^\d]/g,""); euros=euros.replace(/^0+(?=\d)/,"").replace(/\B(?=(\d{3})+(?!\d))/g,".");
  let cents="00"; if(hasComma){ const c=(parts[1]||"").replace(/[^\d]/g,"").slice(0,2); cents = c.length===1?c+"0":(c||"00"); }
  return `${euros||"0"},${cents}`;
}
function renderAmountFromRaw(){ amountEl.value=formatAmountDisplay(amountEl.dataset.raw||""); refreshPreviewInfo(); }

/* ---------- Preview Rendering + Watermark ---------- */
function cancelRenders(){ try{renderTasks.forEach(t=>t.cancel&&t.cancel());}catch{} renderTasks=[]; }
let rerenderTimer=null; function scheduleRender(d=120){ clearTimeout(rerenderTimer); rerenderTimer=setTimeout(renderAll,d); }

function fitCanvas(canvas, viewport){
  const ratio=window.devicePixelRatio||1;
  const pxW=Math.floor(viewport.width*ratio), pxH=Math.floor(viewport.height*ratio);
  if(canvas.width!==pxW||canvas.height!==pxH){
    canvas.width=pxW; canvas.height=pxH;
    canvas.style.width=Math.floor(viewport.width)+"px";
    canvas.style.height=Math.floor(viewport.height)+"px";
  }
  const ctx=canvas.getContext("2d"); ctx.setTransform(ratio,0,0,ratio,0,0); ctx.imageSmoothingEnabled=true; return ctx;
}

/* Overlay auf der Preview – nur Anzeige, nicht gespeichert */
function applyWatermarkPreview(pageWrap, viewport, pageIndex){
  // nur Seite 1
  if (pageIndex !== 1) return;
  // ggf. alten Overlay entfernen
  pageWrap.querySelectorAll(".wm-overlay").forEach(n=>n.remove());

  const code = objSel?.value || "—";
  const date = recvDateEl?.value ? recvDateEl.value.replaceAll("-",".") : ymd(new Date());
  // B75-Suffix in Preview konsistent
  let codePart = code;
  if (code === "B75" && isRechnung()){
    const sub = (b75Sel?.value||"").trim();
    codePart = (sub && sub!=="Allgemein") ? `B75-${sub}` : "B75";
  }
  const text = `${codePart} – EINGEGANGEN: ${date}`;

  const el = document.createElement("div");
  el.className = "wm-overlay";
  const pageW = viewport.width, pageH = viewport.height;
  const fontPx = Math.max(12, Math.round(pageW * 0.045));
  el.textContent = text;
  Object.assign(el.style, {
    position: "absolute",
    left: "10px",
    top: "50%",
    transformOrigin: "left bottom",
    transform: "translateY(-50%) rotate(90deg)",
    fontWeight: "800",
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontSize: fontPx + "px",
    color: "#E53935",
    letterSpacing: "0.8px",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    userSelect: "none",
    opacity: "1",
    maxHeight: Math.round(pageH * 0.52) + "px",
    lineHeight: "1",
  });
  pageWrap.appendChild(el);
}

async function renderAll(){
  if(!pdfDoc||!pdfViewerEl) return;
  cancelRenders(); pdfViewerEl.innerHTML="";
  const pages=pdfDoc.numPages;
  for(let i=1;i<=pages;i++){
    const page=await pdfDoc.getPage(i);
    const viewport=page.getViewport({scale:zoom});
    const wrap=document.createElement("div");
    wrap.className="pdf-page";
    wrap.style.width=viewport.width+"px";

    const canvas=document.createElement("canvas");
    wrap.appendChild(canvas);
    pdfViewerEl.appendChild(wrap);

    const ctx=fitCanvas(canvas,viewport);
    const task=page.render({canvasContext:ctx,viewport});
    renderTasks.push(task);
    await task.promise;

    // Preview-Wasserzeichen nur auf Seite 1
    applyWatermarkPreview(wrap, viewport, i);
  }
  try{ pdfViewerEl.scrollTop=0; pdfViewerEl.scrollLeft=0; }catch{}
}

/* Laden – zwei Puffer */
async function loadPdfFromFile(file){
  try{
    const buf = await file.arrayBuffer();
    saveArrayBuffer    = buf.slice(0);
    previewArrayBuffer = buf.slice(0);

    const task = pdfjsLib.getDocument({ data: previewArrayBuffer });
    pdfDoc = await task.promise;
    $("#zoomLabel").textContent=`${Math.round(zoom*100)}%`;
    showPlaceholder(false); await renderAll();
  }catch(e){ console.error(e); setStatus("Fehler beim Laden der PDF."); showPlaceholder(true); }
}

function showPlaceholder(show){
  if(!placeholder||!pdfViewerEl) return;
  placeholder.style.display=show?"flex":"none";
  pdfViewerEl.style.display=show?"none":"block";
}

/* Upload */
function attachUpload(){
  const input=$("#fileInput"), btnPick=$("#btnPick"), dropZone=$("#dropZone");
  function validateFileSize(f){ const mb=f.size/1024/1024; if(mb>MAX_FILE_MB){ setStatus(`Zu groß (${mb.toFixed(1)} MB)`); showPlaceholder(true); return false; } return true; }
  function validateFileType(f){ const ok=(f.type==="application/pdf")||/\.pdf$/i.test(f.name); if(!ok){ setStatus("Nur PDF erlaubt."); showPlaceholder(true); } return ok; }
  async function loadFile(f){
    if(!f) return; if(!validateFileType(f)) return; if(!validateFileSize(f)) return;
    if(lastBlobUrl){URL.revokeObjectURL(lastBlobUrl); lastBlobUrl=null;}
    lastFile=f; lastBlobUrl=URL.createObjectURL(f);
    setStatus(`Datei geladen: ${f.name} (${(f.size/1024/1024).toFixed(2)} MB)`);
    document.body.classList.add("has-preview");
    updateUiEnabled(true);
    await loadPdfFromFile(f);
  }
  btnPick?.addEventListener("click",()=>input?.click());
  input?.addEventListener("change",(e)=>{ const f=e.target.files?.[0]; if(f) loadFile(f); });

  if(dropZone){
    const over=e=>{e.preventDefault(); dropZone.classList.add("drag");};
    const leave=e=>{e.preventDefault(); dropZone.classList.remove("drag");};
    ["dragenter","dragover"].forEach(ev=>dropZone.addEventListener(ev,over));
    ["dragleave","drop"].forEach(ev=>dropZone.addEventListener(ev,leave));
    dropZone.addEventListener("drop",(e)=>{ const f=[...e.dataTransfer.files].find(x=>x.type==="application/pdf"||/\.pdf$/i.test(x.name)); if(f) loadFile(f); });
    dropZone.addEventListener("keydown",(e)=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault(); input?.click();} });
  }
}

/* Zoom & Actions */
function attachZoom(){
  const range=$("#zoomRange"), label=$("#zoomLabel");
  const setZ=(z)=>{ zoom=clamp(z,MIN_ZOOM,MAX_ZOOM); const pct=Math.round(zoom*100); range.value=String(pct); label.textContent=`${pct}%`; scheduleRender(140); };
  range?.addEventListener("input",(e)=>setZ(e.target.valueAsNumber/100));
  $("#zoomIn")?.addEventListener("click",()=>setZ(+(zoom+0.1).toFixed(2)));
  $("#zoomOut")?.addEventListener("click",()=>setZ(+(zoom-0.1).toFixed(2)));
}
function attachActions(){
  $("#openTabBtn")?.addEventListener("click",()=>{ if(lastBlobUrl) window.open(lastBlobUrl,"_blank","noopener"); });
  $("#printBtn")?.addEventListener("click",()=>{ if(!lastBlobUrl) return; const w=window.open(lastBlobUrl,"_blank","noopener"); setTimeout(()=>{try{w&&w.print();}catch{}},600); });
  $("#downloadBtn")?.addEventListener("click",()=>{ if(!lastBlobUrl||!lastFile) return; const a=document.createElement("a"); a.href=lastBlobUrl; a.download=lastFile.name; document.body.appendChild(a); a.click(); a.remove(); });
}

/* Cancel */
function attachCancel(){
  const btn=$("#cancelBtn");
  if(!btn) return;
  btn.addEventListener("click",(e)=>{ e.preventDefault(); hardReset(); toast("Vorgang abgebrochen.",3000); });
}

/* Stammdaten – externe Config */
const CFG_FILES = { objects:"objects.json", types:"document_types.json" };

function idbOpen(){ return new Promise((res,rej)=>{ const r=indexedDB.open(IDB_DB,1); r.onupgradeneeded=()=>r.result.createObjectStore(IDB_STORE); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbGet(k){ const db=await idbOpen(); return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,"readonly"); const rq=tx.objectStore(IDB_STORE).get(k); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); }); }
async function idbSet(k,v){ const db=await idbOpen(); return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,"readwrite"); tx.objectStore(IDB_STORE).put(v,k); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }

async function getFileHandleCaseInsensitive(dir, name, createIfMissing=false){
  try { return await dir.getFileHandle(name, { create:false }); } catch {}
  const norm = s => s.normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase();
  for await (const e of dir.values()){
    if(e.kind==="file" && norm(e.name)===norm(name)){
      return await dir.getFileHandle(e.name, { create:false });
    }
  }
  return createIfMissing ? await dir.getFileHandle(name, { create:true }) : null;
}
async function readJsonFromConfig(fileName){
  if(!configDirHandle) throw new Error("Kein Config-Ordner verbunden.");
  const fh = await getFileHandleCaseInsensitive(configDirHandle, fileName, false);
  if(!fh) throw new Error(`Datei nicht gefunden: ${fileName}`);
  const f = await fh.getFile();
  return JSON.parse(await f.text());
}
async function writeJsonToConfig(fileName, data){
  if(!configDirHandle) throw new Error("Kein Config-Ordner verbunden.");
  const fh = await getFileHandleCaseInsensitive(configDirHandle, fileName, true);
  const w = await fh.createWritable({ keepExistingData:false });
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
  return true;
}
async function loadJsonSmart(rel){
  if(configDirHandle){
    try{
      const base = rel.endsWith("objects.json") ? CFG_FILES.objects
                 : rel.endsWith("document_types.json") ? CFG_FILES.types
                 : null;
      if(base){ return await readJsonFromConfig(base); }
    }catch(e){ console.warn("Config read fallback:", e); }
  }
  const tryPaths = rel.startsWith("config/") ? [rel, rel.replace(/^config\//,"./")] : [rel, "config/"+rel];
  for(const p of tryPaths){ try{ const r=await fetch(p,{cache:"no-store"}); if(r.ok) return r.json(); }catch{} }
  throw new Error("Kann nicht laden: "+rel);
}

/* Daten */
let objects=[], docTypes=[];
function renderDocTypes(){
  typeSel.innerHTML="";
  (docTypes||[]).forEach(t=>{ const o=document.createElement("option"); o.value=t.key||t.code; o.textContent=t.label||t.name; o.dataset.isInvoice = String(!!t.isInvoice); typeSel.appendChild(o); });
  const defKey = window._docTypesDefaultKey || (docTypes.find(t=>t.isInvoice)?.key) || (docTypes[0]?.key);
  if(defKey) typeSel.value = defKey;
}
function renderObjects(withPH=false){
  objSel.innerHTML="";
  if(withPH){ const f=document.createElement("option"); f.value=""; f.textContent="Bitte Liegenschaft wählen"; objSel.appendChild(f); }
  (objects||[]).forEach(o=>{
    const text = o.displayName ? `${o.code} · ${o.displayName}` : (o.scopevisioName || o.code);
    const opt=document.createElement("option");
    opt.value=o.code;
    opt.textContent=text;
    opt.dataset.scopevisioName = o.pcloudName || o.scopevisioName || o.code; // identische Namen gewünscht
    objSel.appendChild(opt);
  });
  objSel.value=""; toggleB75(); refreshPreviewInfo();
}

/* Manage-Dialoge */
function persistDocTypes(){ try{ localStorage.setItem("fidelior_docTypes_v1", JSON.stringify({types:docTypes, defaultTypeKey:typeSel?.value||"rechnung"})); }catch{} }
function persistObjects(){  try{ localStorage.setItem("fidelior_objects_v1",  JSON.stringify({objects}));  }catch{} }

function openManageTypes(){ const dlg=$("#manageTypesDialog"), list=$("#typesList"); if(!dlg||!list) return; list.innerHTML="";
  (docTypes||[]).forEach((t,i)=>{ const li=document.createElement("li");
    li.innerHTML=`<div>${t.label||t.name} <span class="badge">(${t.key||t.code})</span></div>`;
    const actions=document.createElement("div"); actions.className="actions";
    const edit=document.createElement("button"); edit.className="icon-btn"; edit.title="Bearbeiten"; edit.textContent="✎";
    const del=document.createElement("button");  del.className="icon-btn";  del.title="Löschen";    del.textContent="🗑";
    edit.onclick=()=>{ const nn=prompt("Name:",t.label||t.name); if(nn===null) return; const nc=prompt("Key (GROSS):",t.key||t.code); if(nc===null) return;
      docTypes[i]={...(t||{}),label:nn.trim(),key:nc.trim().toUpperCase(),isInvoice:!!t.isInvoice}; renderDocTypes(); openManageTypes(); persistDocTypes(); };
    del.onclick =()=>{ if(confirm(`„${t.label||t.name}“ löschen?`)){ docTypes.splice(i,1); renderDocTypes(); openManageTypes(); persistDocTypes(); } };
    actions.append(edit,del); li.appendChild(actions); list.appendChild(li);
  }); dlg.showModal();
}
function openManageObjects(){ const dlg=$("#manageObjectsDialog"), list=$("#objectsList"); if(!dlg||!list) return; list.innerHTML="";
  (objects||[]).forEach((o,i)=>{ const li=document.createElement("li");
    li.innerHTML=`<div>${o.code} – ${o.displayName||o.scopevisioName||""}</div>`;
    const actions=document.createElement("div"); actions.className="actions";
    const edit=document.createElement("button"); edit.className="icon-btn"; edit.title="Bearbeiten"; edit.textContent="✎";
    const del=document.createElement("button");  del.className="icon-btn";  del.title="Löschen";    del.textContent="🗑";
    edit.onclick=()=>{ const dn=prompt("Anzeigename:",o.displayName||""); if(dn===null) return;
      const sn=prompt("Exakter Ordnername (Scopevisio/pCloud):",o.pcloudName||o.scopevisioName||o.code); if(sn===null) return;
      const nc=prompt("Code (z. B. D50):",o.code); if(nc===null) return;
      objects[i]={...o,displayName:dn.trim(),scopevisioName:sn.trim(),pcloudName:sn.trim(),code:nc.trim()}; renderObjects(true); persistObjects(); };
    del.onclick=()=>{ if(confirm(`„${o.code}“ löschen?`)){ objects.splice(i,1); renderObjects(true); persistObjects(); openManageObjects(); } };
    actions.append(edit,del); li.appendChild(actions); list.appendChild(li);
  }); dlg.showModal();
}
function attachManage(){
  $("#addDocTypeBtn").onclick=()=>{ const n=prompt("Name:"); if(!n) return; const c=prompt("Key (GROSS):",n.replace(/\s+/g,"_").toUpperCase()); if(!c) return;
    const inv = confirm("Ist dies eine Rechnung (OK) oder Nicht-Rechnung (Abbrechen)?");
    docTypes.push({label:n.trim(),key:c.trim().toUpperCase(),isInvoice:inv}); renderDocTypes(); persistDocTypes(); };
  $("#manageDocTypesBtn").onclick=openManageTypes;

  $("#addObjectBtn").onclick=()=>{ const code=prompt("Code (z. B. D50):"); if(!code) return; const sn=prompt("Exakter Ordnername (Scopevisio/pCloud):", code.trim()); const dn=prompt("Anzeigename:", "");
    objects.push({code:code.trim(),scopevisioName:sn.trim(),pcloudName:sn.trim(),displayName:dn||""}); renderObjects(true); persistObjects(); };
  $("#manageObjectsBtn").onclick=openManageObjects;

  $("#typesConnect")?.addEventListener("click", connectConfigDir);
  $("#objectsConnect")?.addEventListener("click", connectConfigDir);

  $("#typesSaveShared")?.addEventListener("click", async ()=>{
    try{ await writeJsonToConfig("document_types.json", { types: docTypes, defaultTypeKey: (typeSel?.value || "rechnung") }); toast("document_types.json gespeichert.",4000); }
    catch{ toast("Speichern der document_types.json fehlgeschlagen.",5000); }
  });
  $("#objectsSaveShared")?.addEventListener("click", async ()=>{
    try{ await writeJsonToConfig("objects.json", { objects }); toast("objects.json gespeichert.",4000); }
    catch{ toast("Speichern der objects.json fehlgeschlagen.",5000); }
  });

  // Dialog-Buttons schließen
  $$("[data-close]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ const sel=btn.getAttribute("data-close"); const d=$(sel); try{d.close();}catch{d.removeAttribute("open");} });
  });
  $$(".dialog-close").forEach(btn=>{
    btn.addEventListener("click",()=>{ const d=btn.getAttribute("data-close"); if(d){ $(d).close(); } else { btn.closest("dialog")?.close(); } });
  });
}

async function connectConfigDir(){
  try{
    const dir = await window.showDirectoryPicker({ mode:"readwrite" });
    configDirHandle = dir;
    await idbSet(KEY_CONFIG_DIR, configDirHandle);
    toast(`<strong>Config-Ordner verbunden</strong>`);
  }catch(e){ console.warn(e); }
}

/* B75 & UI Enable */
function toggleB75(){
  const isB75=(objSel?.value==="B75");
  // nur bei Rechnung relevant, sonst ausblenden
  if (b75Row) b75Row.style.display = (isB75 && isRechnung()) ? "flex" : "none";
}
function updateUiEnabled(hasDoc){
  const disabled=!hasDoc;
  ["saveBtn","openTabBtn","printBtn","downloadBtn"].forEach(id=>{ const el=document.getElementById(id); if(el){ el.disabled=disabled; el.setAttribute("aria-disabled", String(disabled)); } });
}
function hardReset(){
  cancelRenders(); pdfDoc=null;
  if(lastBlobUrl){ URL.revokeObjectURL(lastBlobUrl); lastBlobUrl=null; }
  saveArrayBuffer=null; previewArrayBuffer=null; lastFile=null; if(pdfViewerEl) pdfViewerEl.innerHTML="";
  document.body.classList.remove("has-preview"); showPlaceholder(true); setStatus(""); updateUiEnabled(false);
  amountEl.dataset.raw=""; renderAmountFromRaw(); senderEl.value=""; recvDateEl.value=""; invDateEl.value=""; objSel.value=""; b75Sel.value="";
  toggleB75(); refreshPreviewInfo();
}

/* Name/Target Preview */
function isRechnung(){
  const opt = typeSel?.selectedOptions?.[0];
  if(!opt) return true;
  return opt.dataset.isInvoice === "true";
}
function getYear(){ const d=invDateEl?.value?new Date(invDateEl.value):new Date(); return d.getFullYear(); }
function requireSelection(){
  const code = objSel?.value || "";
  if(!code) throw new Error("Bitte Liegenschaft wählen.");
  const opt = objSel.selectedOptions[0];
  const scopevisioName = opt?.dataset?.scopevisioName || code;
  const branch = (code==="PRIVAT") ? "PRIVAT" : (code==="FIDELIOR" ? "FIDELIOR" : "OBJEKTE");
  return { code, scopevisioName, branch };
}
function refreshPreviewInfo(){
  try{
    const sel = objSel?.value ? requireSelection() : null;
    const year=getYear();
    const amtRaw=(amountEl?.dataset.raw||"").replace(/[^\d]/g,"");
    const amt = (isRechnung() && amtRaw) ? formatAmountDisplay(amountEl.dataset.raw) : null;
    const dateStr = (invDateEl?.value||new Date().toISOString().slice(0,10)).replaceAll("-",".");

    // Code-Part inkl. B75-Unterordner im Dateinamen
    let codePart = sel?.code;
    if (sel?.code === "B75" && isRechnung()){
      const sub = (b75Sel?.value||"").trim();
      codePart = (sub && sub!=="Allgemein") ? `B75-${sub}` : "B75";
    }

    const base = [amt, codePart, dateStr].filter(Boolean).join("_") || "dokument";
    const fileName = sanitizeFileName(base)+".pdf";
    fileNamePrev.textContent = fileName;

    let preview="–";
    if(sel){
      if(sel.branch==="OBJEKTE"){
        if(sel.code==="B75" && isRechnung() && (b75Sel?.value)){
          preview = `…\\OBJEKTE\\${sel.scopevisioName}\\Rechnungsbelege\\${b75Sel.value}\\${year}`;
        }else{
          const sub = isRechnung() ? "Rechnungsbelege" : "Objektdokumente";
          preview = `…\\OBJEKTE\\${sel.scopevisioName}\\${sub}\\${year}`;
        }
      }else if(sel.branch==="PRIVAT"){
        const sub = isRechnung() ? "Rechnungsbelege" : "Dokumente";
        preview = `…\\PRIVAT\\${sub}\\${year}`;
      }else{
        const sub = isRechnung() ? "Eingangsrechnungen" : "Dokumente";
        preview = `…\\FIDELIOR\\${sub}\\${year}`;
      }
    }
    targetPrev.textContent = preview;
  }catch{
    fileNamePrev.textContent="dokument.pdf";
    targetPrev.textContent="–";
  }
}

/* FS helpers */
async function ensureDir(parent, path){
  const parts=path.split("/").filter(Boolean);
  let dir=parent;
  for(const p of parts){ dir = await dir.getDirectoryHandle(p, {create:true}); }
  return dir;
}
async function getChildCaseInsensitive(dir, name, createIfMissing=false){
  try{ return await dir.getDirectoryHandle(name, {create:false}); }catch{}
  const norm=(s)=>s.normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase();
  try{
    for await(const entry of dir.values()){
      if(entry.kind==="directory" && norm(entry.name)===norm(name)){
        return await dir.getDirectoryHandle(entry.name, {create:false});
      }
    }
  }catch{}
  return createIfMissing ? await dir.getDirectoryHandle(name, {create:true}) : null;
}
async function ensurePermission(handle){
  try{
    const q = await handle?.queryPermission?.({mode:"readwrite"});
    if (q === "granted") return true;
    const r = await handle?.requestPermission?.({mode:"readwrite"});
    return r === "granted";
  }catch{ return true; }
}
// Lädt pdf-lib nur, wenn es noch nicht vorhanden ist
async function ensurePdfLib () {
  if (window.PDFLib) return; // schon geladen (z.B. via <script> in index.html)
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("pdf-lib Laden fehlgeschlagen"));
    document.head.appendChild(s);
  });
}

 /**
 * Roter Eingangsstempel – kompakter, weiter innen platziert.
 */
async function stampPdf(inputArrayBuffer) {
  await ensurePdfLib();
  const { PDFDocument, rgb, StandardFonts, degrees } = PDFLib;

  const pdf = await PDFDocument.load(inputArrayBuffer);
  const pages = pdf.getPages();
  if (pages.length === 0) return inputArrayBuffer;

  // Text ermitteln
  const codeRaw = objSel?.value || "—";
  let codePart = codeRaw;
  if (codeRaw === "B75" && isRechnung()) {
    const sub = (b75Sel?.value || "").trim();
    codePart = (sub && sub !== "Allgemein") ? `B75-${sub}` : "B75";
  }
  const date = recvDateEl?.value ? recvDateEl.value.replaceAll("-", ".") : ymd(new Date());
  const text = `${codePart} – EINGEGANGEN: ${date}`;

  const p = pages[0];
  const pageW = p.getWidth(), pageH = p.getHeight();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Schriftgröße: ~1.6 % der Seitenbreite (kompakt)
  let fontSize = Math.max(8, Math.round(pageW * 0.016));
  let textLength = font.widthOfTextAtSize(text, fontSize);

  // Max. 50 % der Seitenhöhe
  const maxLen = pageH * 0.5;
  if (textLength > maxLen) {
    fontSize = Math.max(6, Math.floor(fontSize * (maxLen / textLength)));
    textLength = font.widthOfTextAtSize(text, fontSize);
  }

  // Position: 1 cm von oben, 3 cm vom linken Rand
  const marginLeft = 18; // ~3 cm
  const marginTop  = 28; // ~1 cm
  const x = marginLeft;
  const y = pageH - marginTop - textLength;

  // Farbe & Deckkraft
  const color = rgb(229/255, 57/255, 53/255); // #E53935
  const opacity = 1;

  p.drawText(text, {
    x, y,
    size: fontSize,
    font,
    color,
    opacity,
    rotate: degrees(90),
  });

  const out = await pdf.save({ useObjectStreams: true });
  return out.buffer;
}

/* ATOMARER SAVE */
async function writeFileAtomic(dir, fileName, arrayBuffer, retries=3){
  if(!arrayBuffer || arrayBuffer.byteLength === undefined) throw new Error("Leerer PDF-Puffer.");
  let src;
  try { src = new Uint8Array(arrayBuffer); }
  catch { src = new Uint8Array(arrayBuffer.slice(0)); }
  if(src.byteLength < 5) throw new Error("PDF-Payload zu klein.");

  const finalName = sanitizeFileName(fileName.endsWith(".pdf") ? fileName : fileName + ".pdf");
  const tmpName   = `tmp_${Date.now()}_${finalName}.part`;

  for(let attempt=1; attempt<=retries; attempt++){
    try{
      const tmpHandle = await dir.getFileHandle(tmpName, { create:true });
      const w1 = await tmpHandle.createWritable({ keepExistingData:false });
      await w1.write(src);
      await w1.close();

      const tmpFile = await tmpHandle.getFile();
      const buf = new Uint8Array(await tmpFile.arrayBuffer());
      const hdr = String.fromCharCode(...buf.slice(0,5));
      const tail = new TextDecoder().decode(buf.slice(Math.max(0, buf.length-2048)));
      if(hdr !== "%PDF-" || !/%%EOF\s*$/m.test(tail)) throw new Error("PDF-Integritätsprüfung fehlgeschlagen.");

      const finalHandle = await dir.getFileHandle(finalName, { create:true });
      const w2 = await finalHandle.createWritable({ keepExistingData:false });
      await w2.write(buf);
      await w2.close();

      await dir.removeEntry(tmpName).catch(()=>{});
      return finalName;
    }catch(e){
      if(attempt===retries) throw e;
      await sleep(250*attempt*attempt);
    }
  }
}

/* Inbox & AutoMove */
async function refreshInbox(){
  let offen=0; if(inboxList) inboxList.innerHTML="";
  if(inboxDirHandle){
    try{
      for await(const entry of inboxDirHandle.values()){
        if(entry.kind==="file" && entry.name.toLowerCase().endsWith(".pdf")){
          offen++; const li=document.createElement("li"); li.innerHTML=`<div>${entry.name}</div><span class="badge">Inbox</span>`; inboxList.appendChild(li);
        }
      }
    }catch(e){ console.warn("refreshInbox",e); }
  }
  const fertig = Number(countersEl.dataset.done||0);
  countersEl.textContent = `Offen: ${offen} · In Arbeit: 0 · Fertig: ${fertig} · Session: ${countersEl.dataset.session||0}`;
}
async function tryMoveSource(fileName){
  if(!inboxDirHandle) return;
  let dstDir = moveTargetDirHandle;
  if(!dstDir){ dstDir = await ensureDir(inboxDirHandle, "Bearbeitet"); }
  try{
    const srcHandle = await inboxDirHandle.getFileHandle(fileName);
    const file = await srcHandle.getFile();
    const dstHandle = await dstDir.getFileHandle(fileName, { create:true });
    const w = await dstHandle.createWritable({ keepExistingData:false });
    await w.write(await file.arrayBuffer());
    await w.close();
    await inboxDirHandle.removeEntry(fileName).catch(()=>{});
  }catch(e){ console.warn("AutoMove", e); }
}

/* Verbindungsstatus */
function setChip(el, ok, label){ el.textContent = `${label} ${ok?"●":"○"}`; el.classList.toggle("chip-ok", !!ok); }
function updateChips(){
  setChip(chipScope, !!scopeRootHandle, "Scopevisio");
  setChip(chipPcloud, !!pcloudRootHandle, "pCloud");
  const info=$("#rootsInfo");
  if(info){
    const scopeName=scopeRootHandle?.name||"–";
    const pcloudName=pcloudRootHandle?.name||"–";
    info.textContent=`Scopevisio-Root: ${scopeName} · pCloud-Root: ${pcloudName}`;
  }
}

/* Verbinden */
async function connectScopevisio(){
  if(!supportsDirPicker) return toast("Dieser Browser unterstützt kein Ordner-Picken.");
  try{
    scopeRootHandle = await window.showDirectoryPicker({mode:"readwrite"});
    rootObjekteHandle  = await getChildCaseInsensitive(scopeRootHandle,"OBJEKTE", true);
    rootPrivatHandle   = await getChildCaseInsensitive(scopeRootHandle,"PRIVAT",  true);
    rootFideliorHandle = await getChildCaseInsensitive(scopeRootHandle,"FIDELIOR",true);
    await idbSet(KEY_SCOPE_ROOT, scopeRootHandle);
    updateChips(); toast(`<strong>Scopevisio verbunden</strong>`);
  }catch(e){ console.warn(e); }
}
async function connectPcloud(){
  if(!supportsDirPicker) return toast("Dieser Browser unterstützt kein Ordner-Picken.");
  try{
    pcloudRootHandle = await window.showDirectoryPicker({mode:"readwrite"});
    const fid = await getChildCaseInsensitive(pcloudRootHandle,"FIDELIOR", true);
    pcloudObjekteHandle     = await getChildCaseInsensitive(fid, "OBJEKTE", true);
    pcloudPrivatBase        = await getChildCaseInsensitive(fid, "PRIVAT",  true);
    pcloudFideliorDocsBase  = await getChildCaseInsensitive(fid, "Dokumente", true);
    let verw = await getChildCaseInsensitive(fid,"VERWALTUNG", true);
    let finanz=await getChildCaseInsensitive(verw,"Finanzen - Buchhaltung", true);
    pcloudBuchhaltungHandle = await getChildCaseInsensitive(finanz,"Eingangsrechnungen", true);

    await idbSet(KEY_PCLOUD_ROOT, pcloudRootHandle);
    await idbSet(KEY_PCLOUD_OBJEKTE, pcloudObjekteHandle);
    await idbSet(KEY_PCLOUD_BUHA, pcloudBuchhaltungHandle);
    await idbSet(KEY_PCLOUD_PRIV, pcloudPrivatBase);
    await idbSet(KEY_PCLOUD_FDOC, pcloudFideliorDocsBase);

    await ensurePermission(pcloudRootHandle);
    const chk = document.getElementById("chkPcloud");
    if (chk) chk.checked = true; // nach Verbinden automatisch aktiv

    updateChips(); toast(`<strong>pCloud verbunden</strong>`);
  }catch(e){ console.warn(e); }
}
async function connectInbox(){
  if(!supportsDirPicker) return toast("Dieser Browser unterstützt kein Ordner-Picken.");
  try{
    inboxDirHandle = await window.showDirectoryPicker({mode:"readwrite"});
    await idbSet(KEY_INBOX, inboxDirHandle);
    await refreshInbox();
    updateChips();
    toast(`<strong>Inbox verbunden</strong>`);
  }catch(e){ console.warn(e); }
}
async function connectMoveTarget(){
  if(!supportsDirPicker) return toast("Dieser Browser unterstützt kein Ordner-Picken.");
  try{
    moveTargetDirHandle = await window.showDirectoryPicker({mode:"readwrite"});
    await idbSet(KEY_MOVE, moveTargetDirHandle);
    updateChips(); toast(`<strong>Quelle-Ziel verbunden</strong>`);
  }catch(e){ console.warn(e); }
}

/* Zielermittlung */
function currentOutputName(){ return (fileNamePrev?.textContent||"dokument.pdf").trim(); }

async function ensureScopevisioTarget(){
  if(!scopeRootHandle) throw new Error("Scopevisio nicht verbunden.");
  const { code, scopevisioName, branch } = requireSelection();
  const year = getYear();

  if(branch==="OBJEKTE"){
    if(!rootObjekteHandle) rootObjekteHandle=await getChildCaseInsensitive(scopeRootHandle,"OBJEKTE", true);
    const objDir = await getChildCaseInsensitive(rootObjekteHandle, scopevisioName, true);
    if(code==="B75" && isRechnung()){
      const sub = b75Sel?.value || "";
      if(!sub) throw new Error("Bitte B75-Unterordner wählen (D1/D4/Allgemein).");
      return await ensureDir(objDir, `Rechnungsbelege/${sub}/${year}`);
    }
    const sub = isRechnung() ? "Rechnungsbelege" : "Objektdokumente";
    return await ensureDir(objDir, `${sub}/${year}`);
  }

  if(branch==="PRIVAT"){
    if(!rootPrivatHandle) rootPrivatHandle=await getChildCaseInsensitive(scopeRootHandle,"PRIVAT", true);
    const sub = isRechnung() ? "Rechnungsbelege" : "Dokumente";
    return await ensureDir(rootPrivatHandle, `${sub}/${year}`);
  }

  if(!rootFideliorHandle) rootFideliorHandle=await getChildCaseInsensitive(scopeRootHandle,"FIDELIOR", true);
  const sub = isRechnung() ? "Eingangsrechnungen" : "Dokumente";
  return await ensureDir(rootFideliorHandle, `${sub}/${year}`);
}
async function ensurePcloudTargets(){
  const targets = [];
  if(!$("#chkPcloud")?.checked) return targets;
  if(!pcloudRootHandle) throw new Error("pCloud nicht verbunden.");
  if (!(await ensurePermission(pcloudRootHandle))) throw new Error("pCloud-Berechtigung fehlt. Bitte erneut verbinden.");

  const { code, scopevisioName, branch } = requireSelection();
  const year = getYear();

  if(branch==="OBJEKTE"){
    if(!pcloudObjekteHandle) throw new Error("pCloud/OBJEKTE nicht verbunden.");
    const objDir = await getChildCaseInsensitive(pcloudObjekteHandle, scopevisioName, true);
    if(code==="B75" && isRechnung()){
      const sub = b75Sel?.value || "";
      if(!sub) throw new Error("Bitte B75-Unterordner wählen (D1/D4/Allgemein).");
      targets.push(await ensureDir(objDir, `Rechnungsbelege/${sub}/${year}`));
    }else{
      const sub = isRechnung() ? "Rechnungsbelege" : "Objektdokumente";
      targets.push(await ensureDir(objDir, `${sub}/${year}`));
    }
  } else if (branch==="PRIVAT"){
    if(!pcloudPrivatBase) throw new Error("pCloud/PRIVAT nicht verbunden.");
    const sub = isRechnung() ? "Rechnungsbelege" : "Dokumente";
    targets.push(await ensureDir(pcloudPrivatBase, `${sub}/${year}`));
  } else {
    if(isRechnung()){
      if(!pcloudBuchhaltungHandle) throw new Error("pCloud/…/Eingangsrechnungen fehlt.");
      targets.push(await ensureDir(pcloudBuchhaltungHandle, String(year)));
    }else{
      if(!pcloudFideliorDocsBase) throw new Error("pCloud/Dokumente nicht verbunden.");
      targets.push(await ensureDir(pcloudFideliorDocsBase, String(year)));
    }
  }
  return targets;
}

/* Speichern + Toast */
function incrDone(){ const d=Number(countersEl.dataset.done||0)+1; const s=Number(countersEl.dataset.session||0)+1; countersEl.dataset.done=String(d); countersEl.dataset.session=String(s); refreshInbox(); }

function showSavedToast(paths, moveInfo){
  const labeled = paths.map(p => `<div><code>${p}</code></div>`).join("");
  let html = `<strong>Gespeichert</strong><br><span class="muted">Ablage:</span>${labeled}`;
  if (moveInfo?.moved){
    html += `<hr class="sep" style="margin:.5rem 0"/>
             <div><span class="muted">Quelle → Erledigt:</span>
             <code>${moveInfo.dstFolder}\\${moveInfo.dstFile}</code></div>`;
  }
  const t  = toast(html, 12000);
  const ok = document.createElement("button");
  ok.className = "btn-primary";
  ok.textContent = "OK";
  ok.onclick = () => t.close();
  t.actions.append(ok);
}

// ====================================================
// Empfänger sammeln – vereinheitlicht & robust
// ====================================================
// [FIX] Unterstützt aktuelle IDs (#chkScalar, #chkSevdesk, #chkOther) + Fallbacks
function collectEmailRecipients() {
  const emails = new Set();
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  const pairIds = [
    // aktuelle UI
    ['chkScalar','mailScalar'],
    ['chkSevdesk','mailSevdesk'],
    ['chkOther','mailOther'],
    // ältere/Alternative Names
    ['mailPreset1Chk','mailPreset1'],
    ['mailPreset2Chk','mailPreset2'],
    ['mailCustomChk','mailOther'],
    ['mailCustomChk','mailCustom'],
  ];

  for (const [chkId, inputId] of pairIds) {
    const chk = document.getElementById(chkId);
    const input = document.getElementById(inputId);
    if (chk && chk.checked && input && input.value) {
      input.value.split(/[;, ]+/).map(s=>s.trim()).filter(Boolean).forEach(e=>{
        if (isEmail(e)) emails.add(e);
      });
    }
  }

  // generische .mail-group Struktur (falls vorhanden)
  document.querySelectorAll('.mail-group').forEach(group=>{
    const chk = group.querySelector('input[type="checkbox"]');
    const input = group.querySelector('input.mail-input');
    if (chk && chk.checked && input && input.value) {
      input.value.split(/[;, ]+/).map(s=>s.trim()).filter(Boolean).forEach(e=>{
        if (isEmail(e)) emails.add(e);
      });
    }
  });

  return Array.from(emails);
}

function attachSave(){
  $("#saveBtn")?.addEventListener("click", async ()=>{
    try{
      if(!saveArrayBuffer || !lastFile){ toast("Keine PDF geladen.",4000); return; }
      const outName = currentOutputName();
      requireSelection(); // erzwingt Objektwahl

      // 1) Stempel vor dem Schreiben
      saveArrayBuffer = await stampPdf(saveArrayBuffer);

      // 2) Ziele ermitteln & schreiben
      const scopeDir = $("#chkScope").checked ? await ensureScopevisioTarget() : null;
      const pcloudDirs = await ensurePcloudTargets();

      const savedPaths = [];
      if(scopeDir) savedPaths.push(`${scopeDir.name||"Ordner"}\\${await writeFileAtomic(scopeDir, outName, saveArrayBuffer)}`);
      for(const d of pcloudDirs){ savedPaths.push(`${d.name}\\${await writeFileAtomic(d, outName, saveArrayBuffer)}`); }

      // 3) E-Mail-Versand
      try {
        const recipients = collectEmailRecipients();
        console.log("[Mail] recipients:", recipients);
        if (!recipients.length) {
          // [FIX] Deutliches Feedback, kein Versandversuch
          showPopup("Keine Empfänger angehakt – PDF nur abgelegt", true);
        } else {
          const attachmentB64 = await fileToBase64(new Blob([saveArrayBuffer], { type: "application/pdf" }));
          const subject = outName;
          const body = `Automatischer Versand aus FIDELIOR DMS.\nAblage:\n- ${savedPaths.join("\n- ")}`;

          const resp = await sendEmailViaNetlify({
            to: recipients,
            subject,
            text: body,
            attachments: [
              { filename: outName, contentBase64: attachmentB64, contentType: "application/pdf" }
            ]
          });
          console.log("[Mail] response:", resp);
          showPopup("E-Mail gesendet ✔️", true);
        }
      } catch (e) {
        console.error("Mail error:", e);
        showPopup(String(e?.message||"E-Mail Versand fehlgeschlagen"), false);
      }

      // 4) Quelle → Erledigt
      const moveInfo = { moved:false };
      try{
        await tryMoveSource(lastFile.name);
        moveInfo.moved = true;
        moveInfo.dstFolder = (moveTargetDirHandle?.name || "Bearbeitet");
        moveInfo.dstFile = lastFile.name;
      }catch{}

      incrDone(); hardReset();
      showSavedToast(savedPaths, moveInfo);
    }catch(e){
      console.error(e);
      toast(`<strong>Speichern fehlgeschlagen</strong><br><span class="muted">${e?.message||e}</span>`,9000);
    }
  });
}

/* Bindings */
function attachBinding(){
  $("#btnBindInbox").onclick=connectInbox;
  $("#btnBindQuelle").onclick=connectMoveTarget;
  $("#btnBindScopevisio").onclick=connectScopevisio;
  $("#btnBindPcloud").onclick=connectPcloud;
}

/* Form-Änderungen */
function attachFormChanges(){
  [senderEl,recvDateEl,invDateEl].forEach(el=>{ el?.addEventListener("input",refreshPreviewInfo); el?.addEventListener("change",refreshPreviewInfo); });
  objSel?.addEventListener("change",()=>{ toggleB75(); refreshPreviewInfo(); scheduleRender(50); });
  b75Sel?.addEventListener("change",()=>{ refreshPreviewInfo(); scheduleRender(50); });

  amountEl.addEventListener("keydown",(e)=>{
    const isDigit=/^[0-9]$/.test(e.key), isComma=(e.key===","||e.key==="."), isBack=(e.key==="Backspace"), isDel=(e.key==="Delete");
    const nav=["ArrowLeft","ArrowRight","Home","End","Tab"].includes(e.key); if(nav) return;
    e.preventDefault(); let raw=amountEl.dataset.raw||"";
    if(isDigit) raw+=e.key; else if(isComma){ if(!raw.includes(",")) raw+=","; }
    else if(isBack) raw=raw.slice(0,-1); else if(isDel) raw="";
    amountEl.dataset.raw=raw; renderAmountFromRaw();
  });
  amountEl.addEventListener("paste",(e)=>{ e.preventDefault(); const txt=(e.clipboardData||window.clipboardData).getData("text")||""; amountEl.dataset.raw=txt.replace(/[^\d,\.]/g,"").replace(/\./g,","); renderAmountFromRaw(); });
  amountEl.addEventListener("blur", renderAmountFromRaw);

  typeSel?.addEventListener("change", () => {
    refreshPreviewInfo();
    toggleB75();
    scheduleRender(50);
  });
}

/* E-Mail-Checkboxen ↔ Eingabefelder */
function attachMailRows() {
  const pairs = [
    { chk: "#chkScalar",  inp: "#mailScalar"  },
    { chk: "#chkSevdesk", inp: "#mailSevdesk" },
    { chk: "#chkOther",   inp: "#mailOther"   }
  ];
  pairs.forEach(p => {
    const c = $(p.chk), i = $(p.inp);
    if (!c || !i) return;
    const sync = () => {
      i.disabled = !c.checked;
      if (c.checked && !i.value && i.placeholder) i.value = i.placeholder;
    };
    c.addEventListener("change", sync);
    sync();
  });
}

/* Init */
async function initData(){
  // restore handles
  scopeRootHandle       = await idbGet(KEY_SCOPE_ROOT)||null;
  pcloudRootHandle      = await idbGet(KEY_PCLOUD_ROOT)||null;
  pcloudObjekteHandle   = await idbGet(KEY_PCLOUD_OBJEKTE)||null;
  pcloudBuchhaltungHandle = await idbGet(KEY_PCLOUD_BUHA)||null;
  pcloudPrivatBase      = await idbGet(KEY_PCLOUD_PRIV)||null;
  pcloudFideliorDocsBase= await idbGet(KEY_PCLOUD_FDOC)||null;
  inboxDirHandle        = await idbGet(KEY_INBOX)||null;
  moveTargetDirHandle   = await idbGet(KEY_MOVE)||null;
  configDirHandle       = await idbGet(KEY_CONFIG_DIR)||null;

  if(scopeRootHandle){
    rootObjekteHandle = await getChildCaseInsensitive(scopeRootHandle,"OBJEKTE", true);
    rootPrivatHandle  = await getChildCaseInsensitive(scopeRootHandle,"PRIVAT",  true);
    rootFideliorHandle= await getChildCaseInsensitive(scopeRootHandle,"FIDELIOR",true);
  }

  // DocTypes
  try{
    const t=await loadJsonSmart("config/document_types.json");
    docTypes = t.types || t || [];
    window._docTypesDefaultKey = t.defaultTypeKey;
  }catch{
    docTypes=[
      {label:"Rechnung",   key:"rechnung",   isInvoice:true},
      {label:"Gutschrift", key:"gutschrift", isInvoice:true},
      {label:"Sonstiges",  key:"sonstiges",  isInvoice:false}
    ];
  }
  renderDocTypes();

  // Objects
  try{
    const o=await loadJsonSmart("config/objects.json");
    objects = o.objects || o || [];
  }catch{
    objects=[{code:"A15",displayName:"A15 · Ahrweiler Straße 15",scopevisioName:"A15 Ahrweiler Straße 15",pcloudName:"A15 Ahrweiler Straße 15"}];
  }
  renderObjects(true);

  updateChips();
}

function start(){
  updateChips();
  attachUpload(); attachZoom(); attachActions(); attachCancel(); attachFormChanges(); attachMailRows(); attachSave(); attachBinding(); attachManage();
  initData().then(()=>{ refreshPreviewInfo(); refreshInbox(); updateUiEnabled(false); renderAmountFromRaw(); console.log("✅ Fidelior initialisiert."); });
}

/* Keyboard-Zoom (nur wenn Fokus nicht in Inputs) */
document.addEventListener("keydown", (e)=>{
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (["input","select","textarea"].includes(tag)) return;
  if (e.key === "+" || e.key === "=") { e.preventDefault(); $("#zoomIn")?.click(); }
  if (e.key === "-" ) { e.preventDefault(); $("#zoomOut")?.click(); }
});

document.addEventListener("DOMContentLoaded", start);
