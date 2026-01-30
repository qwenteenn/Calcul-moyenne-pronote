const $ = (id) => document.getElementById(id);

const btnScan = $("btnScan");
const btnRecalc = $("btnRecalc");
const statusEl = $("status");
const rowsEl = $("rows");
const avgSimpleEl = $("avgSimple");
const avgWeightedEl = $("avgWeighted");

let lastSubjects = []; // [{ subject, avg }]

function setStatus(msg, type = "info") {
  statusEl.textContent = msg;
  statusEl.style.color = (type === "ok") ? "#aef0c8" : (type === "bad") ? "#ff9aa6" : "";
}

function parseFrenchNumber(s) {
  // "15,00" -> 15.00
  const cleaned = String(s).replace(/\s/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function format2(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2).replace(".", ",");
}

function normalizeSubjectName(s) {
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

function subjectKey(subject) {
  // clé stable pour storage
  return "coef:" + subject.toLowerCase();
}

async function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

async function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function computeSimpleAverage(items) {
  const vals = items.map(x => x.avg).filter(Number.isFinite);
  if (!vals.length) return null;
  const sum = vals.reduce((a,b)=>a+b,0);
  return sum / vals.length;
}

async function computeWeightedAverage(items, coefMap) {
  let num = 0;
  let den = 0;
  for (const it of items) {
    const c = coefMap[subjectKey(it.subject)] ?? 1;
    const coef = Number(c);
    if (!Number.isFinite(it.avg)) continue;
    if (!Number.isFinite(coef) || coef <= 0) continue;
    num += it.avg * coef;
    den += coef;
  }
  if (den <= 0) return null;
  return num / den;
}

async function renderTable(items) {
  rowsEl.innerHTML = "";

  const keys = items.map(it => subjectKey(it.subject));
  const stored = await storageGet(keys);

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "r";

    const subj = document.createElement("div");
    subj.className = "subj";
    subj.textContent = it.subject;

    const val = document.createElement("div");
    val.className = "val";
    val.textContent = format2(it.avg);

    const coefWrap = document.createElement("div");
    coefWrap.className = "coef";

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.1";
    input.value = String(stored[subjectKey(it.subject)] ?? 1);

    input.addEventListener("input", async () => {
      const v = Number(input.value);
      // on sauvegarde même si c’est “bizarre”, mais le calcul ignore <=0
      await storageSet({ [subjectKey(it.subject)]: v });
      await recalc();
    });

    coefWrap.appendChild(input);

    row.appendChild(subj);
    row.appendChild(val);
    row.appendChild(coefWrap);
    rowsEl.appendChild(row);
  }
}

async function recalc() {
  if (!lastSubjects.length) return;

  const simple = computeSimpleAverage(lastSubjects);
  avgSimpleEl.textContent = format2(simple);

  const keys = lastSubjects.map(it => subjectKey(it.subject));
  const coefMap = await storageGet(keys);

  const weighted = await computeWeightedAverage(lastSubjects, coefMap);
  avgWeightedEl.textContent = format2(weighted);

  btnRecalc.disabled = false;
}

async function scanActiveTab() {
  setStatus("Scan en cours…", "info");
  avgSimpleEl.textContent = "—";
  avgWeightedEl.textContent = "—";
  rowsEl.innerHTML = "";
  btnRecalc.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("Impossible de lire l’onglet actif.", "bad");
    return;
  }

  // Injecte une fonction dans la page pour extraire matières + moyennes
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function cleanText(s) {
        return String(s || "").replace(/\s+/g, " ").replace(/\u00A0/g, " ").trim();
      }

      const avgNodes = Array.from(document.querySelectorAll('[aria-label*="Moyenne élève"]'));

      // Exemple vu dans ton HTML :
      // aria-label=" Moyenne élève : 15,00" :contentReference[oaicite:2]{index=2}
      const items = [];

      for (const node of avgNodes) {
        const aria = node.getAttribute("aria-label") || "";
        const m = aria.match(/Moyenne\s+élève\s*:\s*([0-9]+(?:[.,][0-9]+)?)/i);
        if (!m) continue;

        const avgStr = m[1];

        // On remonte à la ligne "matière"
        // Dans ton HTML, la matière est souvent dans une zone "titre-principal"
        // ex: span.ie-titre-gros "… > Physique-Chimie" :contentReference[oaicite:3]{index=3}
        const row = node.closest(".fd_ligne") || node.closest('[role="treeitem"]') || node.parentElement;

        let subject = "";
        if (row) {
          const title =
            row.querySelector(".titre-principal .ie-titre-gros") ||
            row.querySelector(".titre-principal .ie-ellipsis") ||
            row.querySelector(".zone-principale .ie-titre-gros") ||
            row.querySelector(".zone-principale .ie-ellipsis");
          if (title) subject = cleanText(title.textContent);
        }

        subject = subject || "Matière inconnue";

        // Normalise un peu : si c’est "BLOC > Matière", garde la partie à droite
        if (subject.includes(">")) {
          const parts = subject.split(">").map(p => cleanText(p));
          const right = parts[parts.length - 1];
          if (right) subject = right;
        }

        items.push({ subject, avgStr });
      }

      // Dédupe : garde la première occurrence par matière
      const seen = new Set();
      const deduped = [];
      for (const it of items) {
        const key = it.subject.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(it);
      }

      return deduped;
    }
  });

  if (!result || !Array.isArray(result) || result.length === 0) {
    setStatus("Aucune moyenne trouvée. Va sur Pronote > Notes/Moyennes, puis rescane.", "bad");
    return;
  }

  // Convertit "15,00" -> 15.00
  const parsed = result
    .map(x => {
      const avg = (() => {
        const s = String(x.avgStr).replace(/\s/g, "").replace(",", ".");
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      })();

      return { subject: normalizeSubjectName(x.subject), avg };
    })
    .filter(x => x.subject && Number.isFinite(x.avg));

  if (!parsed.length) {
    setStatus("J’ai trouvé des matières, mais les nombres n’étaient pas lisibles.", "bad");
    return;
  }

  // Tri alphabétique pour lisibilité
  parsed.sort((a, b) => a.subject.localeCompare(b.subject, "fr"));

  lastSubjects = parsed;

  setStatus(`OK : ${parsed.length} matière(s) détectée(s).`, "ok");
  await renderTable(parsed);
  await recalc();
}

btnScan.addEventListener("click", async () => {
  try {
    await scanActiveTab();
  } catch (e) {
    console.error(e);
    setStatus("Erreur pendant le scan. (Pronote a peut-être bloqué l’injection sur cette page)", "bad");
  }
});

btnRecalc.addEventListener("click", async () => {
  try {
    await recalc();
    setStatus("Recalcul OK.", "ok");
  } catch (e) {
    console.error(e);
    setStatus("Erreur pendant le recalcul.", "bad");
  }
});
