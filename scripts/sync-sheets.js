// Roda em ambiente Node.js dentro do GitHub Actions (servidor, não navegador).
// Por isso não sofre bloqueio de CORS: essa restrição só existe em navegadores.
const https = require("https");
const fs = require("fs");
const path = require("path");

const SHEET_ID = "1qKO5q0FRT7v-6tjX0EE5WaWn0r1TgICJ";

// Uma entrada por aba a sincronizar. "file" é o nome do .json gerado em /data.
const SOURCES = [
  { label: "RMA 2026", gid: "1842889971", file: "rma-2026.json" },
  { label: "RMA 2025", gid: "1258947142", file: "rma-2025.json" },
];

function fetchCsv(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(fetchCsv(res.headers.location, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ao buscar ${url}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

// Parser CSV simples, compatível com RFC 4180 (lida com aspas e vírgulas dentro de campos).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* ignora */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

function rowsToObjects(rows) {
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) obj[h] = r[i] !== undefined ? r[i] : "";
    });
    return obj;
  });
}

// A planilha usa células mescladas para modelo/código de barras/defeito quando
// várias linhas pertencem ao mesmo atendimento. No CSV exportado, só a primeira
// linha da mesclagem carrega o valor — as demais vêm em branco. Aqui "preenchemos
// pra baixo" esses campos, sempre reiniciando ao trocar de atendimento.
const ATENDIMENTO_KEYS = ["N.º Atendimento", "Número Atendimento", "Numero Atendimento", "Nº Atendimento", "N° Atendimento"];
const FILL_COLUMNS = ["Model", "Bar Code", "Brand", "Defect", "Peso para Garantia", "Peso aferido", "Status Peso"];

function getAtendimento(obj) {
  for (const k of ATENDIMENTO_KEYS) {
    if (obj[k]) return obj[k];
  }
  return "";
}

function forwardFillMerged(objects) {
  let last = {};
  let lastAtend = null;
  objects.forEach((obj) => {
    const atend = getAtendimento(obj);
    if (atend !== lastAtend) {
      last = {};
      lastAtend = atend;
    }
    FILL_COLUMNS.forEach((col) => {
      if (col in obj) {
        if (obj[col] === "" && last[col]) obj[col] = last[col];
        else if (obj[col] !== "") last[col] = obj[col];
      }
    });
  });
  return objects;
}

async function main() {
  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });

  for (const src of SOURCES) {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${src.gid}`;
    console.log(`Sincronizando ${src.label}...`);
    const csv = await fetchCsv(url);
    const parsedRows = parseCsv(csv);
    console.log("Cabeçalhos encontrados:", JSON.stringify(parsedRows[0]));
    const objects = forwardFillMerged(rowsToObjects(parsedRows));
    const payload = {
      label: src.label,
      generated_at: new Date().toISOString(),
      rows: objects,
    };
    fs.writeFileSync(path.join(outDir, src.file), JSON.stringify(payload));
    console.log(`  -> ${objects.length} linhas salvas em data/${src.file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
