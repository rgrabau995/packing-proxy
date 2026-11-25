// Registro di magazzino per prodotto, nel formato degli Excel di oggi (es. KBSSR35ADH55.xlsx):
//   in alto la giacenza (Data arrivo | | rot. | kg) fino alla riga "Totale",
//   sotto lo storico uscite (Data arrivo | Cliente Ddt N | rot. | kg | totale kg del DDT).
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const { db, tx } = require('./db');

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const serialToIso = n => new Date(Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 86400000).toISOString().slice(0, 10);
const isoToSerial = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
const colOf = ref => ref.replace(/\d+/g, '');

// Legge la prima scheda: { title, height, rows: [{ r, A, B, C, D, E }] } con valori come testo.
function readSheet(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const get = p => files[p] ? strFromU8(files[p]) : null;
  const ssXml = get('xl/sharedStrings.xml') || '';
  const ss = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const wb = get('xl/workbook.xml') || '';
  const rid = (wb.match(/<sheet [^>]*r:id="([^"]+)"/) || [])[1];
  const target = rid && (rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`)) || [])[1];
  const sheetPath = target ? 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '') : 'xl/worksheets/sheet1.xml';
  const xml = get(sheetPath) || get('xl/worksheets/sheet1.xml');
  if (!xml) throw new Error('File Excel senza fogli leggibili');
  const rows = [];
  for (const m of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = { r: Number(m[1]) };
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] || '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      const is = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      let val = null;
      if (/t="s"/.test(c[2]) && v) val = ss[Number(v[1])];
      else if (v) val = unesc(v[1]);
      else if (is) val = unesc(is[1]);
      if (val !== null && String(val).trim() !== '') row[c[1]] = String(val).trim();
    }
    rows.push(row);
  }
  const find = (col, r) => (rows.find(x => x.r === r) || {})[col];
  return { title: find('A', 2) || '', height: (find('C', 4) || '').trim(), rows };
}

const isNum = v => v != null && /^\d+(\.\d+)?$/.test(String(v));
const rollStr = v => String(v).replace(/\.0+$/, '');

// Interpreta il registro: giacenza + storico uscite.
function parseRegister(buf) {
  const { title, height, rows } = readSheet(buf);
  const totIdx = rows.findIndex(x => /^totale$/i.test(x.A || ''));
  if (totIdx < 0) throw new Error('Riga "Totale" non trovata: il file non sembra un registro di magazzino');
  const stock = [], out = [];
  let date = null;
  for (const x of rows.slice(0, totIdx)) {
    if (isNum(x.A) && Number(x.A) > 20000) date = serialToIso(x.A);
    if (x.C && isNum(x.D)) stock.push({ roll_no: rollStr(x.C), kg: Number(x.D), arrival_date: date });
  }
  date = null;
  let label = null, seq = 0;
  for (const x of rows.slice(totIdx + 1)) {
    if (isNum(x.A) && Number(x.A) > 20000) date = serialToIso(x.A);
    if (x.B && !isNum(x.B)) label = x.B;
    if (x.C && isNum(x.D)) out.push({ roll_no: rollStr(x.C), kg: Number(x.D), arrival_date: date, out_label: label, seq: ++seq });
  }
  return { title, height, stock, out };
}

// Sostituisce il registro di un prodotto con il contenuto dell'Excel.
// I rotoli già collegati a ordini del portale restano come sono.
const importRegister = tx((code, buf) => {
  const reg = parseRegister(buf);
  const p = db.prepare('SELECT * FROM products WHERE code = ?').get(code);
  if (p) db.prepare('UPDATE products SET title = ?, height = ? WHERE code = ?').run(reg.title || p.title, reg.height || p.height, code);
  else db.prepare('INSERT INTO products (code, title, height) VALUES (?, ?, ?)').run(code, reg.title, reg.height);
  db.prepare('DELETE FROM rolls WHERE product_code = ? AND order_id IS NULL').run(code);
  const ins = db.prepare(`INSERT OR IGNORE INTO rolls (roll_no, product_code, kg, arrival_date, status, out_label, seq, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'excel')`);
  let nStock = 0, nOut = 0, dup = 0;
  for (const r of reg.out) { const res = ins.run(r.roll_no, code, r.kg, r.arrival_date, 'out', r.out_label, r.seq); res.changes ? nOut++ : dup++; }
  for (const r of reg.stock) {
    // Se un rotolo compare sia in giacenza sia nelle uscite, vale la giacenza (è la parte aggiornata a mano).
    const ex = db.prepare('SELECT id, order_id FROM rolls WHERE product_code = ? AND roll_no = ?').get(code, r.roll_no);
    if (ex && !ex.order_id) { db.prepare(`UPDATE rolls SET status='stock', out_label=NULL, seq=NULL, kg=?, arrival_date=? WHERE id=?`).run(r.kg, r.arrival_date, ex.id); nStock++; nOut--; continue; }
    const res = ins.run(r.roll_no, code, r.kg, r.arrival_date, 'stock', null, null); res.changes ? nStock++ : dup++;
  }
  return { code, title: reg.title, height: reg.height, giacenza: nStock, uscite: nOut, doppi: dup };
});

// ── Export nello stesso formato ──
function exportRegister(code) {
  const p = db.prepare('SELECT * FROM products WHERE code = ?').get(code);
  if (!p) throw Object.assign(new Error('Prodotto non trovato'), { status: 404 });
  const stock = db.prepare(`SELECT * FROM rolls WHERE product_code = ? AND status = 'stock' ORDER BY arrival_date, id`).all(code);
  const out = db.prepare(`SELECT * FROM rolls WHERE product_code = ? AND status = 'out' ORDER BY seq, id`).all(code);

  const sst = [], idx = new Map();
  const si = v => { v = String(v); if (!idx.has(v)) { idx.set(v, sst.length); sst.push(v); } return idx.get(v); };
  // stili: 0 normale, 1 titolo, 2 intestazione, 3 data, 4 testo centrato, 5 numero, 6 totale, 7 cliente
  const rows = [], merges = [];
  const S = (ref, v, s) => v === null || v === undefined || v === '' ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}" t="s"><v>${si(v)}</v></c>`;
  const N = (ref, v, s) => v === null || v === undefined || v === '' ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  const F = (ref, f, s) => `<c r="${ref}" s="${s}"><f>${esc(f)}</f></c>`;
  let r = 2;
  rows.push(`<row r="2" ht="20" customHeight="1">${S('A2', p.title || code, 1)}</row>`);
  rows.push(`<row r="4">${S('A4', 'Data', 2)}${S('B4', 'Cliente', 2)}${S('C4', p.height || '', 2)}${S('D4', '', 2)}${S('E4', '', 2)}</row>`);
  rows.push(`<row r="5">${S('A5', '', 2)}${S('B5', '', 2)}${S('C5', 'rot.', 2)}${S('D5', 'kg.', 2)}${S('E5', '', 2)}</row>`);
  r = 6;
  const first = r;
  let lastDate = null;
  for (const x of stock) {
    const d = x.arrival_date !== lastDate ? x.arrival_date : null; lastDate = x.arrival_date;
    rows.push(`<row r="${r}">${N('A' + r, d ? isoToSerial(d) : '', 3)}${S('B' + r, '', 0)}${S('C' + r, x.roll_no, 4)}${N('D' + r, x.kg, 5)}</row>`);
    r++;
  }
  const lastStock = Math.max(first, r - 1);
  rows.push(`<row r="${r}">${S('A' + r, 'Totale', 6)}${S('B' + r, '', 6)}${F('C' + r, `COUNTA(C${first}:C${lastStock})`, 6)}${F('D' + r, `SUM(D${first}:D${lastStock})`, 6)}${S('E' + r, '', 6)}</row>`);
  r++;
  // storico: gruppi consecutivi con la stessa etichetta cliente/DDT
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j + 1 < out.length && out[j + 1].out_label === out[i].out_label) j++;
    const start = r, tot = out.slice(i, j + 1).reduce((s, x) => s + (x.kg || 0), 0);
    let ld = null;
    for (let k = i; k <= j; k++) {
      const x = out[k];
      const d = x.arrival_date !== ld ? x.arrival_date : null; ld = x.arrival_date;
      rows.push(`<row r="${r}">${N('A' + r, d ? isoToSerial(d) : '', 3)}${S('B' + r, k === i ? x.out_label || '' : '', 7)}${S('C' + r, x.roll_no, 4)}${N('D' + r, x.kg, 5)}${k === i ? N('E' + r, tot, 5) : `<c r="E${r}" s="5"/>`}</row>`);
      r++;
    }
    if (j > i) merges.push(`E${start}:E${r - 1}`);
    i = j + 1;
  }

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="11.9" customWidth="1"/><col min="2" max="2" width="34.4" customWidth="1"/><col min="3" max="3" width="13" customWidth="1"/><col min="4" max="4" width="8" customWidth="1"/><col min="5" max="5" width="11.7" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait"/></worksheet>`;
  const b = '<left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/>';
  const xf = (num, font, border, h) => `<xf numFmtId="${num}" fontId="${font}" fillId="0" borderId="${border}" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${h}" vertical="center"/></xf>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="12"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${b}</border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8">${xf(0, 0, 0, 'general')}${xf(0, 1, 0, 'left')}${xf(0, 2, 1, 'center')}${xf(164, 0, 1, 'center')}${xf(49, 0, 1, 'center')}${xf(0, 0, 1, 'right')}${xf(0, 2, 1, 'center')}${xf(0, 0, 1, 'left')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map(v => `<si><t xml:space="preserve">${esc(v)}</t></si>`).join('')}</sst>`;
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="${esc(code)}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/styles.xml': styles,
    'xl/sharedStrings.xml': sstXml,
    'xl/worksheets/sheet1.xml': sheet,
  };
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return Buffer.from(zipped);
}

module.exports = { parseRegister, importRegister, exportRegister, serialToIso };
