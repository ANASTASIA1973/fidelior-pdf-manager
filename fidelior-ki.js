/* ==========================================================================
   Fidelior KI – Absender-Erkennung & Lern-Engine
   Version 1.0 — Non-invasive, standalone
   Einzige Abhängigkeit: window.fdlKiOnOcr Hook in autoRecognize() (1 Zeile)
   Berührt KEINE Ablage-Logik, KEINE Pfade.
   ========================================================================== */

(() => {
'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 1 – SENDER-EXTRAKTION
   Extrahiert den Absender aus dem OCR-Text mit mehreren Strategien
   ══════════════════════════════════════════════════════════════════════════ */

/** Bekannte Schlüsselwörter, die auf Firmennamen-Zeilen hinweisen */
const COMPANY_SUFFIXES = /\b(GmbH|AG|SE|KGaA|KG|GbR|OHG|UG|e\.V\.|eG|Stiftung|Stadtwerke|Energie|Versorgung|Handwerk|Service|Solutions|Consulting|Management)\b/i;

/** Zeilen-Muster die Absender-Hinweise geben */
const SENDER_LABELS = /^(Absender|Von|Rechnungssteller|Lieferant|Anbieter|Auftragnehmer|Kreditor|Ihre Rechnung von|Rechnung von)[:\s]+/i;

/** Blacklist – Diese Zeilen-Inhalte sind KEINE Firmennamen */
const LINE_BLACKLIST = /^(Rechnung|Invoice|Gutschrift|Angebot|Bestellung|Datum|Nummer|Seite|Page|Tel|Fax|E-Mail|www\.|http|IBAN|BIC|USt|Steuer|Konto|Bank|An\s|Herrn|Frau|Dear|Sehr geehrte|Betreff|Re:|Beleg|Dok\.|Ref\.|Kundennr|Rechnungsnr|Auftrags)/i;

/**
 * Extrahiert den wahrscheinlichsten Absender aus PDF-Text und Zeilen.
 * Gibt { value, confidence, source } oder null zurück.
 * confidence: 'high' | 'medium' | 'low'
 */
function extractSender(txt, lines, matchedRule) {
  // ── Strategie 1: Explizites sender-Feld in der Assignment-Regel ─────────
  if (matchedRule?.sender?.trim()) {
    return { value: matchedRule.sender.trim(), confidence: 'high', source: 'Zuordnungsregel' };
  }

  // ── Strategie 2: Firmenname aus dem note-Feld der Regel ─────────────────
  if (matchedRule?.note?.trim()) {
    const clean = matchedRule.note
      .replace(/^auto:\s*/i, '')
      .split(/[·\|]/)[0]
      .replace(/·?\s*\d{5,}.*$/, '') // Kundennummer am Ende entfernen
      .trim();
    if (clean.length >= 3 && clean.length <= 80 && !clean.match(/^\d+$/)) {
      return { value: clean, confidence: 'medium', source: 'Zuordnungsregel (Hinweis)' };
    }
  }

  // ── Strategie 3: Explizite Label im Volltext ─────────────────────────────
  const labelMatch = txt.match(/(?:Absender|Von|Rechnungssteller|Lieferant)[:]\s*([^\n\r]{3,80})/i);
  if (labelMatch) {
    const v = labelMatch[1].trim();
    if (v && !v.match(/^\d+$/)) {
      return { value: v, confidence: 'medium', source: 'Label im Dokument' };
    }
  }

  // ── Strategie 4: Firmennamen in den ersten 12 Zeilen (Briefkopf) ────────
  const candidateLines = (lines || []).slice(0, 12);
  const candidates = [];

  for (const rawLine of candidateLines) {
    const line = rawLine.trim();
    if (!line || line.length < 3 || line.length > 90) continue;
    if (LINE_BLACKLIST.test(line)) continue;
    // Bevorzuge Zeilen mit bekannten Firmen-Suffixes
    if (COMPANY_SUFFIXES.test(line)) {
      candidates.unshift({ value: line, score: 10 }); // Beste Kandidaten vorne
    }
  }

  if (candidates.length > 0) {
    return { value: candidates[0].value, confidence: 'low', source: 'Briefkopf (OCR)' };
  }

  // ── Strategie 5: RegEx für GmbH/AG/etc. im Volltext ──────────────────────
  const companyRx = /([A-ZÄÖÜ][a-zäöüßA-ZÄÖÜ\s&\-,\.]{2,40}(?:GmbH|AG\b|SE\b|KGaA|KG\b|GbR|e\.V\.|Stadtwerke|Energie|Versorgung)(?:\s*(?:&|u\.)\s*Co\.?\s*KG)?)/;
  const compMatch = txt.match(companyRx);
  if (compMatch) {
    return { value: compMatch[1].trim().replace(/\s{2,}/g, ' '), confidence: 'low', source: 'Volltext (OCR)' };
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 2 – CSS
   ══════════════════════════════════════════════════════════════════════════ */

function injectKiCSS() {
  if (document.getElementById('fdl-ki-css')) return;
  const s = document.createElement('style');
  s.id = 'fdl-ki-css';
  s.textContent = `

/* ── KI-Konfidenz-Badge am Absender-Feld ── */
.fdl-ki-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; font-weight: 600; padding: 2px 8px;
  border-radius: 5px; vertical-align: middle; margin-left: 6px;
  cursor: default; transition: opacity .2s;
}
.fdl-ki-badge.high   { background: rgba(26,122,69,.12);  color: #1A7A45; }
.fdl-ki-badge.medium { background: rgba(200,160,0,.1);   color: #8A6000; }
.fdl-ki-badge.low    { background: rgba(91,27,112,.1);   color: #5B1B70; }
.fdl-ki-badge .fdl-ki-src {
  font-weight: 400; font-size: 10px; opacity: .7;
}

/* ── Lern-Panel (slide-in unter dem Formular) ── */
.fdl-ki-learn {
  border: 1.5px solid var(--primary);
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(91,27,112,.04) 0%, rgba(91,27,112,.01) 100%);
  padding: .9rem 1.1rem;
  margin-top: .75rem;
  animation: fdlKiSlideDown .22s ease;
  position: relative;
}
@keyframes fdlKiSlideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: none; }
}
.fdl-ki-learn-title {
  font-size: 11.5px; font-weight: 700; color: var(--primary);
  margin-bottom: .6rem; display: flex; align-items: center; gap: .4rem;
}
.fdl-ki-learn-body {
  display: grid; grid-template-columns: 1fr 1fr; gap: .5rem;
  margin-bottom: .7rem;
}
.fdl-ki-learn-field label {
  display: block; font-size: 10.5px; font-weight: 600;
  color: var(--muted); margin-bottom: .2rem;
}
.fdl-ki-learn-field input,
.fdl-ki-learn-field select {
  width: 100%; font-family: var(--font-ui); font-size: 12px;
  padding: 5px 8px; border-radius: 7px;
  border: 1.5px solid var(--border); background: var(--surface); color: var(--text);
}
.fdl-ki-learn-field input:focus,
.fdl-ki-learn-field select:focus {
  outline: none; border-color: var(--primary); box-shadow: var(--focus-ring);
}
.fdl-ki-learn-field.full { grid-column: 1 / -1; }
.fdl-ki-learn-actions { display: flex; gap: .4rem; align-items: center; }
.fdl-ki-save {
  font-family: var(--font-ui); font-size: 12px; font-weight: 600;
  padding: 6px 16px; border-radius: 8px; border: none;
  background: var(--primary); color: #fff; cursor: pointer;
}
.fdl-ki-save:hover { background: var(--primary-600, #6a2483); }
.fdl-ki-dismiss {
  font-family: var(--font-ui); font-size: 12px; font-weight: 500;
  padding: 6px 12px; border-radius: 8px;
  border: 1.5px solid var(--border); background: transparent;
  color: var(--muted); cursor: pointer;
}
.fdl-ki-learn-close {
  position: absolute; top: .7rem; right: .8rem;
  width: 22px; height: 22px; border-radius: 6px; border: none;
  background: transparent; color: var(--muted); font-size: 12px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.fdl-ki-learn-close:hover { background: var(--border); color: var(--text); }

/* ── Pattern-Preview in Lern-Panel ── */
.fdl-ki-pattern-hint {
  font-size: 10.5px; color: var(--muted); margin-top: .2rem;
  font-family: monospace; word-break: break-all;
}

/* ── KI-Status-Zeile (kompakt, unter Upload-Status) ── */
.fdl-ki-status {
  font-size: 11px; color: var(--muted); margin-top: .2rem;
  display: flex; align-items: center; gap: .3rem; min-height: 16px;
}
.fdl-ki-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
}
.fdl-ki-dot.high   { background: #1A7A45; }
.fdl-ki-dot.medium { background: #B87A00; }
.fdl-ki-dot.low    { background: #5B1B70; }

/* ── Sender-Feld-Wrapper ── */
#fdl-ki-sender-wrap {
  position: relative;
}
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 3 – DOM-HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

function getSenderEl()  { return document.getElementById('senderInput'); }
function getObjSel()    { return document.getElementById('objectSelect'); }
function getSubSel()    { return document.getElementById('genericSubfolder'); }
function getTypeSel()   { return document.getElementById('docTypeSelect'); }
function getAmountEl()  { return document.getElementById('amountInput'); }
function getInvNoEl()   { return document.getElementById('invoiceNo'); }
function getInvDateEl() { return document.getElementById('invoiceDate'); }

/** Escape für RegEx */
function escRx(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Baut ein RegEx-Suchmuster aus einem Stichwort (Vendor-Name) */
function buildPatternFromVendor(vendor) {
  if (!vendor) return '';
  // Kernwort nehmen (z.B. "Stadtwerke Bonn GmbH" → "Stadtwerke Bonn")
  const core = vendor
    .replace(/\b(GmbH|AG|SE|KGaA|KG|GbR|OHG|UG|e\.V\.|eG)\b.*$/i, '')
    .trim();
  if (!core) return escRx(vendor);
  return escRx(core);
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 4 – BADGE & STATUS
   ══════════════════════════════════════════════════════════════════════════ */

let currentBadge = null;

function showSenderBadge(confidence, source) {
  removeSenderBadge();
  const senderEl = getSenderEl();
  if (!senderEl) return;

  const badge = document.createElement('span');
  badge.className = `fdl-ki-badge ${confidence}`;
  badge.id = 'fdl-ki-sender-badge';
  badge.title = `Erkannt durch: ${source}`;
  badge.innerHTML = `🤖 KI <span class="fdl-ki-src">(${source})</span>`;
  currentBadge = badge;

  // Hinter das Sender-Label einfügen
  const label = senderEl.previousElementSibling;
  if (label && label.tagName === 'LABEL') {
    label.appendChild(badge);
  }
}

function removeSenderBadge() {
  document.getElementById('fdl-ki-sender-badge')?.remove();
  currentBadge = null;
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 5 – LERN-PANEL
   ══════════════════════════════════════════════════════════════════════════ */

let learnPanelEl = null;

function removeLearnPanel() {
  learnPanelEl?.remove();
  learnPanelEl = null;
}

async function showLearnPanel(senderValue, ocrText) {
  removeLearnPanel();

  const senderEl  = getSenderEl();
  const objSel    = getObjSel();
  const subSel    = getSubSel();
  if (!senderEl) return;

  const currentSender = senderValue || senderEl.value.trim();
  const currentObj    = objSel?.value || '';
  const currentSub    = (subSel?.closest('#subfolderRow')?.style.display !== 'none') ? (subSel?.value || '') : '';

  if (!currentSender && !currentObj) return; // Nichts zum Lernen

  // Objekt-Optionen
  const objOptions = Array.from(objSel?.options || [])
    .filter(o => o.value)
    .map(o => `<option value="${o.value}" ${o.value === currentObj ? 'selected' : ''}>${o.textContent}</option>`)
    .join('');

  const suggestedPattern = buildPatternFromVendor(currentSender);

  const panel = document.createElement('div');
  panel.className = 'fdl-ki-learn';
  panel.id = 'fdl-ki-learn-panel';
  panel.innerHTML = `
    <button class="fdl-ki-learn-close" title="Schließen" id="fdl-ki-close-btn">✕</button>
    <div class="fdl-ki-learn-title">
      🧠 Regel aus diesem Dokument merken?
    </div>
    <div class="fdl-ki-learn-body">
      <div class="fdl-ki-learn-field full">
        <label>Erkennungs-Stichwort (Absender)</label>
        <input type="text" id="fdl-ki-l-vendor" value="${currentSender.replace(/"/g,'&quot;')}"
               placeholder="z.B. Stadtwerke Bonn">
        <div class="fdl-ki-pattern-hint" id="fdl-ki-pat-preview">Muster: ${suggestedPattern || '—'}</div>
      </div>
      <div class="fdl-ki-learn-field">
        <label>Liegenschaft</label>
        <select id="fdl-ki-l-obj">
          <option value="">— wählen —</option>
          ${objOptions}
        </select>
      </div>
      <div class="fdl-ki-learn-field">
        <label>Absender-Name (im Feld)</label>
        <input type="text" id="fdl-ki-l-sender" value="${currentSender.replace(/"/g,'&quot;')}"
               placeholder="Wie er im Absender-Feld stehen soll">
      </div>
      ${currentSub ? `
      <div class="fdl-ki-learn-field">
        <label>Unterordner</label>
        <input type="text" id="fdl-ki-l-sub" value="${currentSub}">
      </div>` : `<div class="fdl-ki-learn-field">
        <label>Unterordner (optional)</label>
        <input type="text" id="fdl-ki-l-sub" value="" placeholder="z.B. D1, D4">
      </div>`}
    </div>
    <div class="fdl-ki-learn-actions">
      <button class="fdl-ki-save" id="fdl-ki-save-btn">💾 Regel speichern</button>
      <button class="fdl-ki-dismiss" id="fdl-ki-dismiss-btn">Nicht merken</button>
      <span style="font-size:10.5px;color:var(--muted);margin-left:auto">Gespeichert in Zuordnungsmuster</span>
    </div>`;

  // Unter dem Absender-Feld einfügen
  const insertAfter = senderEl.closest('.stack, .column-scroll, #leftPane .column-scroll') || senderEl.parentElement;
  // Finde den besten Eltern-Container
  const metaDiv = document.querySelector('.meta[aria-live]');
  if (metaDiv) {
    metaDiv.parentElement.insertBefore(panel, metaDiv);
  } else {
    senderEl.parentElement.appendChild(panel);
  }

  learnPanelEl = panel;

  // Live-Muster-Vorschau
  document.getElementById('fdl-ki-l-vendor')?.addEventListener('input', e => {
    const v = e.target.value.trim();
    const pat = buildPatternFromVendor(v);
    const prev = document.getElementById('fdl-ki-pat-preview');
    if (prev) prev.textContent = `Muster: ${pat || '—'}`;
  });

  // Schließen
  document.getElementById('fdl-ki-close-btn')?.addEventListener('click', removeLearnPanel);
  document.getElementById('fdl-ki-dismiss-btn')?.addEventListener('click', removeLearnPanel);

  // Speichern
  document.getElementById('fdl-ki-save-btn')?.addEventListener('click', () => saveLearnedRule());
}

async function saveLearnedRule() {
  const vendor = (document.getElementById('fdl-ki-l-vendor')?.value || '').trim();
  const obj    = (document.getElementById('fdl-ki-l-obj')?.value   || '').trim();
  const sender = (document.getElementById('fdl-ki-l-sender')?.value || '').trim();
  const sub    = (document.getElementById('fdl-ki-l-sub')?.value   || '').trim();

  if (!vendor) {
    document.getElementById('fdl-ki-l-vendor')?.focus();
    fdlToast('Bitte ein Stichwort/Absender eingeben.', 2200);
    return;
  }
  if (!obj) {
    document.getElementById('fdl-ki-l-obj')?.focus();
    fdlToast('Bitte eine Liegenschaft wählen.', 2200);
    return;
  }

  const pattern = buildPatternFromVendor(vendor);
  if (!pattern) {
    fdlToast('Konnte kein Muster erzeugen.', 2000);
    return;
  }

  // Validate pattern
  try { new RegExp(pattern, 'i'); } catch {
    fdlToast('Ungültiges Erkennungs-Muster.', 2500);
    return;
  }

  const newRule = {
    pattern,
    object: obj,
    sender: sender || vendor,
    note:   `auto: ${vendor}`,
  };
  if (sub) newRule.subfolder = sub;

  // In assignments.json laden, Regel hinzufügen, speichern
  try {
    let cfg;
    try {
      if (typeof loadJson === 'function') {
        cfg = await loadJson('assignments.json');
      }
    } catch { cfg = null; }
    if (!cfg || !Array.isArray(cfg.patterns)) cfg = { patterns: [] };

    // Duplikat-Check: Gleicher Vendor schon vorhanden?
    const exists = cfg.patterns.some(r =>
      String(r.pattern || '').toLowerCase() === pattern.toLowerCase() &&
      String(r.object  || '').toLowerCase() === obj.toLowerCase()
    );
    if (exists) {
      fdlToast('Eine ähnliche Regel ist bereits vorhanden.', 2800);
      removeLearnPanel();
      return;
    }

    cfg.patterns.push(newRule);

    if (typeof saveJson === 'function') {
      await saveJson('assignments.json', cfg);
    }

    // Live-Update im Speicher (wie openAssignmentsDialog es tut)
    if (typeof window !== 'undefined') {
      window.assignmentsCfg = cfg;
    }

    fdlToast(`<strong>Regel gelernt ✓</strong><br>${vendor} → ${obj}`, 3000);
    removeLearnPanel();
  } catch (e) {
    console.error('[FideliorKI] Speichern fehlgeschlagen:', e);
    fdlToast('Regel konnte nicht gespeichert werden.<br><small>Config-Verbindung prüfen.</small>', 4000);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 6 – HAUPT-HOOK (aufgerufen von autoRecognize)
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Wird von app.js aufgerufen: window.fdlKiOnOcr(txt, lines, assignmentsCfg)
 * Läuft NACH dem bestehenden autoRecognize → ergänzt, überschreibt nie.
 */
async function onOcr(txt, lines, assignmentsCfg) {
  try {
    const senderEl = getSenderEl();
    if (!senderEl) return;

    // Bereits vom User befüllt → KI respektiert das
    if (senderEl.dataset.userTyped === '1' && senderEl.value.trim()) {
      return;
    }

    // Gematchte Regel holen (global verfügbar)
    let matchedRule = null;
    if (typeof evaluateAssignmentRules === 'function' && assignmentsCfg) {
      matchedRule = evaluateAssignmentRules(txt, assignmentsCfg);
    }

    // Absender extrahieren
    const result = extractSender(txt, lines, matchedRule);

    if (result) {
      // Sender-Feld füllen (nur wenn noch leer)
      if (!senderEl.value.trim()) {
        senderEl.value = result.value;
        senderEl.classList.add('auto');
        senderEl.dataset.kiDetected = '1';
        senderEl.dataset.kiSource = result.source;

        // Badge anzeigen
        showSenderBadge(result.confidence, result.source);

        // Lern-Panel anbieten – nur wenn Confidence NICHT 'high'
        // (bei 'high' war es eine explizite Regel, nichts zu lernen)
        if (result.confidence !== 'high') {
          setTimeout(() => showLearnPanel(result.value, txt), 600);
        }

        // Bestehenden autoRecognize-Toast ergänzen (nicht neuen erzeugen)
        // → wird durch ein kleines Update am Sender-Feld sichtbar
        if (typeof refreshPreview === 'function') refreshPreview();
      }
    } else {
      // Kein Absender gefunden → Lern-Panel anbieten wenn Objekt gesetzt
      const objSel = getObjSel();
      if (objSel?.value) {
        setTimeout(() => showLearnPanel('', txt), 800);
      }
    }

  } catch (e) {
    console.warn('[FideliorKI] onOcr Fehler:', e);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 7 – SENDER-FELD BEOBACHTEN
   Wenn User manuell schreibt → Badge entfernen, Lern-Panel anbieten
   ══════════════════════════════════════════════════════════════════════════ */

function attachSenderWatcher() {
  const senderEl = getSenderEl();
  if (!senderEl || senderEl._kiWatching) return;
  senderEl._kiWatching = true;

  senderEl.addEventListener('input', () => {
    // User tippt → KI-Badge entfernen (Wert ist jetzt manuell)
    removeSenderBadge();
    delete senderEl.dataset.kiDetected;
    delete senderEl.dataset.kiSource;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 8 – TOAST HELPER
   Nutzt die bestehende toast()-Funktion aus app.js (sicher)
   ══════════════════════════════════════════════════════════════════════════ */

function fdlToast(html, ms) {
  try {
    if (typeof toast === 'function') {
      toast(html, ms || 3500);
    } else {
      console.log('[FideliorKI]', html);
    }
  } catch {}
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 9 – ASSIGNMENTS-DIALOG ERWEITERN
   Fügt das "Absender"-Feld zur Tabelle hinzu (rückwärtskompatibel)
   ══════════════════════════════════════════════════════════════════════════ */

function patchAssignmentsDialog() {
  // Warte bis der Dialog geöffnet wird, dann Spalte patchen
  const observer = new MutationObserver(() => {
    const dlg = document.getElementById('manageAssignmentsDialog');
    if (!dlg || !dlg.open || dlg._kiPatched) return;
    dlg._kiPatched = true;

    // Tabellen-Header um "Absender" erweitern
    const thead = dlg.querySelector('#assignTbody')?.closest('table')?.querySelector('thead tr');
    if (thead && !dlg.querySelector('.ki-sender-th')) {
      const th = document.createElement('th');
      th.className = 'ki-sender-th';
      th.textContent = 'Absender (KI)';
      th.title = 'Wird beim Abgleich automatisch ins Absender-Feld eingetragen';
      // Vor der letzten Spalte (Aktionen) einfügen
      const lastTh = thead.lastElementChild;
      thead.insertBefore(th, lastTh);
    }

    // Bestehende Zeilen um Absender-Input ergänzen
    dlg.querySelectorAll('#assignTbody tr:not([data-ki-extended])').forEach(tr => {
      if (tr.dataset.kiExtended) return;
      tr.dataset.kiExtended = '1';
      const delTd = tr.lastElementChild;
      const td = document.createElement('td');
      td.innerHTML = `<input class="input slim as-sender" placeholder="z.B. Stadtwerke Bonn" style="min-width:130px">`;
      tr.insertBefore(td, delTd);
    });

    // addRow patchen: Neue Zeilen bekommen automatisch Absender-Feld
    // (via MutationObserver auf tbody)
    const tbody = dlg.querySelector('#assignTbody');
    if (tbody && !tbody._kiObserver) {
      const tbodyObs = new MutationObserver(() => {
        tbody.querySelectorAll('tr:not([data-ki-extended])').forEach(tr => {
          tr.dataset.kiExtended = '1';
          const delTd = tr.lastElementChild;
          const td = document.createElement('td');
          td.innerHTML = `<input class="input slim as-sender" placeholder="z.B. Stadtwerke Bonn">`;
          tr.insertBefore(td, delTd);
        });
      });
      tbodyObs.observe(tbody, { childList: true });
      tbody._kiObserver = tbodyObs;
    }

    // Beim Speichern: sender-Feld mitlesen und in das gespeicherte Objekt schreiben.
    // Das geschieht durch Patch des assignSave-Listeners.
    // Wir nutzen ein Custom-Event das assignSave auslöst, oder wir patchen den Button.
    const saveBtn = dlg.querySelector('#assignSave');
    if (saveBtn && !saveBtn._kiPatched) {
      saveBtn._kiPatched = true;
      saveBtn.addEventListener('click', () => {
        // Nach dem originalen Save-Handler: sender-Felder in assignmentsCfg updaten
        setTimeout(async () => {
          try {
            const cfg = window.assignmentsCfg;
            if (!cfg?.patterns) return;
            const rows = dlg.querySelectorAll('#assignTbody tr');
            rows.forEach((tr, i) => {
              const senderVal = tr.querySelector('.as-sender')?.value?.trim() || '';
              if (cfg.patterns[i]) {
                if (senderVal) cfg.patterns[i].sender = senderVal;
                else delete cfg.patterns[i].sender;
              }
            });
            if (typeof saveJson === 'function') {
              await saveJson('assignments.json', cfg);
            }
          } catch (e) {
            console.warn('[FideliorKI] sender-Feld Speichern fehlgeschlagen:', e);
          }
        }, 300); // Nach dem Original-Handler
      }, true); // capture: true → vor Original
    }

    // Bestehende Sender-Werte aus assignmentsCfg einlesen
    const rows = dlg.querySelectorAll('#assignTbody tr');
    const patterns = window.assignmentsCfg?.patterns || [];
    rows.forEach((tr, i) => {
      const senderInput = tr.querySelector('.as-sender');
      if (senderInput && patterns[i]?.sender) {
        senderInput.value = patterns[i].sender;
      }
    });
  });

  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
}

/* ══════════════════════════════════════════════════════════════════════════
   TEIL 10 – INIT
   ══════════════════════════════════════════════════════════════════════════ */

function init() {
  injectKiCSS();
  attachSenderWatcher();
  patchAssignmentsDialog();

  // Wenn PDF-Reset ausgelöst wird: KI-UI aufräumen
  const origHardReset = window.hardReset;
  if (typeof origHardReset === 'function') {
    window.hardReset = function(...args) {
      removeSenderBadge();
      removeLearnPanel();
      return origHardReset.apply(this, args);
    };
  }

  // Hook für autoRecognize registrieren
  window.fdlKiOnOcr = onOcr;

  console.info('[FideliorKI v1.0] geladen – Absender-KI & Lern-Engine aktiv');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
