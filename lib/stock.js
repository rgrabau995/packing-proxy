// Giacenze in kg per codice interno (dalla Lista Giacenze), arrivi dai fornitori con data,
// e abbinamento automatico dei codici fornitore ai codici interni.
const { unzipSync, strFromU8 } = require('fflate');
const { db, tx } = require('./db');

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
const serialToIso = n => new Date(Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 86400000).toISOString().slice(0, 10);
const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const today = () => new Date().toISOString().slice(0, 10);

// Codice "pulito" per confronti: maiuscolo, senza spazi né punteggiatura (AHG 43H80 → AHG43H80).
const ncode = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── Lettura di tutti i fogli di un .xlsx ──
function readWorkbook(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const get = p => files[p] ? strFromU8(files[p]) : '';
  const ss = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const rels = get('xl/_rels/workbook.xml.rels');
  const sheets = [];
  for (const m of get('xl/workbook.xml').matchAll(/<sheet [^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const t = (rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${m[2]}"`)) || [])[1];
    if (!t) continue;
    const xml = get('xl/' + t.replace(/^\/?xl\//, '').replace(/^\//, ''));
    const rows = [];
    for (const r of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = { r: Number(r[1]) };
      for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = c[3] || '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/), is = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        let val = null;
        if (/t="s"/.test(c[2]) && v) val = ss[Number(v[1])];
        else if (v) val = unesc(v[1]);
        else if (is) val = unesc(is[1]);
        if (val !== null && String(val).trim() !== '') row[c[1]] = String(val).trim();
      }
      rows.push(row);
    }
    sheets.push({ name: unesc(m[1]), rows });
  }
  return sheets;
}

// ── Import della Lista Giacenze ──
// Un foglio per famiglia (es. "K Kraft Bianco"); riga di intestazione con "Codice Prodotto".
// Colonne: Codice, Tipo, Fornitore, Gram., Alt.(mm), Diam.(mm), Foro, Giacenza(kg),
// Arr.1..5 (Qty, Data, N. Ordine), Totale, Part.1..5 (Qty, Cliente), Note.
function parseLista(buf) {
  const sheets = readWorkbook(buf);
  const out = [];
  for (const sh of sheets) {
    if (/riepilogo/i.test(sh.name)) continue; // il riepilogo ripete gli stessi codici
    const hi = sh.rows.findIndex(r => Object.values(r).some(v => /^codice prodotto$/i.test(String(v))));
    if (hi < 0) continue;
    const head = {};
    for (const [col, v] of Object.entries(sh.rows[hi])) if (col !== 'r') head[col] = String(v).replace(/\s+/g, ' ').trim();
    const colOf = re => Object.keys(head).find(c => re.test(head[c]));
    const C = {
      code: colOf(/^codice prodotto$/i), type: colOf(/^tipo/i), supplier: colOf(/^fornitore/i),
      gsm: colOf(/^gram/i), width: colOf(/^alt/i), diam: colOf(/^diam/i), stock: colOf(/^giacenza/i), notes: colOf(/^note/i),
    };
    const arr = [1, 2, 3, 4, 5].map(i => ({ qty: colOf(new RegExp(`^arr\\.?\\s*${i} qty`, 'i')), date: colOf(new RegExp(`^arr\\.?\\s*${i} data`, 'i')), ord: colOf(new RegExp(`^arr\\.?\\s*${i} n`, 'i')) }));
    const part = [1, 2, 3, 4, 5].map(i => ({ qty: colOf(new RegExp(`^part\\.?\\s*${i} qty`, 'i')), cust: colOf(new RegExp(`^part\\.?\\s*${i} cliente`, 'i')) }));
    const family = sh.name.trim();
    for (const r of sh.rows.slice(hi + 1)) {
      const code = r[C.code];
      if (!code || /^totale/i.test(code)) continue;
      const item = {
        code: String(code).trim(), family, ptype: r[C.type] || null, supplier: r[C.supplier] || null,
        gsm: num(r[C.gsm]), width_mm: num(r[C.width]), diam_mm: num(r[C.diam]), stock_kg: num(r[C.stock]) ?? 0, notes: r[C.notes] || null,
        arrivals: [], outgoing: [],
      };
      for (const a of arr) {
        const q = num(r[a.qty]);
        if (!q) continue;
        const d = r[a.date];
        item.arrivals.push({ kg: q, date: num(d) && num(d) > 20000 ? serialToIso(d) : null, our_order: r[a.ord] || null });
      }
      for (const p of part) {
        const q = num(r[p.qty]);
        if (q) item.outgoing.push({ kg: q, customer: r[p.cust] || null });
      }
      out.push(item);
    }
  }
  if (!out.length) throw Object.assign(new Error('Nessun articolo trovato: serve un foglio con la colonna "Codice Prodotto"'), { status: 422 });
  return out;
}

// La Lista sostituisce giacenze, arrivi e partenze presi dall'Excel; gli arrivi caricati dai documenti restano.
const importLista = tx(buf => {
  const items = parseLista(buf);
  db.prepare('UPDATE products SET in_list = 0').run();
  db.prepare("DELETE FROM arrivals WHERE source = 'excel'").run();
  db.prepare("DELETE FROM outgoing WHERE source = 'excel'").run();
  const up = db.prepare(`INSERT INTO products (code, title, family, ptype, supplier, gsm, width_mm, diam_mm, stock_kg, notes, in_list)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(code) DO UPDATE SET family=excluded.family, ptype=excluded.ptype, supplier=excluded.supplier, gsm=excluded.gsm,
      width_mm=excluded.width_mm, diam_mm=excluded.diam_mm, stock_kg=excluded.stock_kg, notes=excluded.notes, in_list=1,
      title=COALESCE(products.title, excluded.title)`);
  const insA = db.prepare(`INSERT INTO arrivals (product_code, kg, date, our_order, supplier, source) VALUES (?,?,?,?,?, 'excel')`);
  const insO = db.prepare(`INSERT INTO outgoing (product_code, kg, customer, source) VALUES (?,?,?, 'excel')`);
  let nA = 0, nO = 0, kg = 0;
  for (const it of items) {
    up.run(it.code, [it.ptype, it.gsm ? it.gsm + ' g' : null, it.width_mm ? 'h ' + it.width_mm / 10 + ' cm' : null].filter(Boolean).join(' · ') || null,
      it.family, it.ptype, it.supplier, it.gsm, it.width_mm, it.diam_mm, it.stock_kg, it.notes);
    kg += it.stock_kg || 0;
    for (const a of it.arrivals) { insA.run(it.code, a.kg, a.date, a.our_order, it.supplier); nA++; }
    for (const o of it.outgoing) { insO.run(it.code, o.kg, o.customer); nO++; }
  }
  return { articoli: items.length, giacenza_kg: kg, arrivi: nA, partenze: nO, famiglie: [...new Set(items.map(i => i.family))] };
});

// ── Disponibilità per data ──
// Disponibile al giorno X = giacenza + arrivi non ancora registrati come arrivati con data ≤ X.
function stockView(atDate) {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(String(atDate || '')) ? atDate : today();
  const prods = db.prepare(`SELECT * FROM products WHERE in_list = 1 OR code IN (SELECT product_code FROM arrivals WHERE status='in_arrivo') ORDER BY family, code`).all();
  const arr = db.prepare(`SELECT * FROM arrivals WHERE status = 'in_arrivo' ORDER BY date IS NULL, date`).all();
  const outg = db.prepare(`SELECT * FROM outgoing`).all();
  const by = (list, k = 'product_code') => list.reduce((m, x) => ((m[x[k]] ||= []).push(x), m), {});
  const A = by(arr), O = by(outg);
  return {
    date: at, today: today(),
    products: prods.map(p => {
      const a = A[p.code] || [];
      const entro = a.filter(x => x.date && x.date <= at).reduce((s, x) => s + x.kg, 0);
      return {
        code: p.code, family: p.family, ptype: p.ptype, supplier: p.supplier, gsm: p.gsm, width_mm: p.width_mm, diam_mm: p.diam_mm,
        notes: p.notes, stock_kg: p.stock_kg || 0, in_list: !!p.in_list,
        arrivals: a.map(x => ({ id: x.id, kg: x.kg, date: x.date, date_to: x.date_to, our_order: x.our_order, supplier: x.supplier, late: !!(x.date && x.date < today()) })),
        in_arrivo_kg: a.reduce((s, x) => s + x.kg, 0),
        partenze: (O[p.code] || []).map(x => ({ kg: x.kg, customer: x.customer })),
        disponibile_kg: (p.stock_kg || 0) + entro,
      };
    }),
  };
}

// ── Abbinamento codice fornitore → codice interno ──
// Ordine: abbinamento salvato → codice interno scritto nel documento → caratteristiche (gr, altezza, diametro, colore, tipo, fornitore).
const SUPPLIER_WORDS = [['mondi', /mondi/i], ['smurfit', /smurfit/i], ['nordic', /nordic/i], ['stora', /stora/i], ['sappi', /sappi/i], ['krpa', /krpa/i], ['mosaico', /mosaico/i]];
const supplierKey = s => (SUPPLIER_WORDS.find(([, re]) => re.test(String(s || ''))) || [null])[0];
// Diametro 100 nei nostri codici: "D" subito dopo l'altezza (KBSSR50ADH45D, H68DF) o in fondo (KBSSR6D, KBSSR45PSD),
// ma non il "AD" che indica la qualità (KBSSR35AD). Le note "diam 90/100" hanno la precedenza.
function isDiam100(p) {
  const txt = `${p.code} ${p.notes || ''}`.toUpperCase();
  if (/DIAM\w*\s*100/.test(txt)) return true;
  if (/DIAM\w*\s*90/.test(txt)) return false;
  const c = String(p.code).toUpperCase().split(/\s/)[0];
  return /H\d{2,3}D(?!3)/.test(c) || (/D$/.test(c) && !/AD$/.test(c));
}

function matchLine(line, supplier) {
  const keys = [line.codice_cliente, line.codice_fornitore].map(ncode).filter(Boolean);
  // 1. abbinamento già confermato
  for (const k of keys) {
    const m = db.prepare('SELECT product_code FROM supplier_map WHERE supplier_code = ?').get(k);
    if (m) return { code: m.product_code, how: 'abbinamento salvato', sure: true };
  }
  // 2. il documento riporta già il nostro codice interno
  for (const k of keys) {
    const p = db.prepare("SELECT code FROM products WHERE REPLACE(REPLACE(UPPER(code),' ',''),'-','') = ?").get(k);
    if (p) return { code: p.code, how: 'codice interno sul documento', sure: true };
  }
  // 3. caratteristiche
  const gsm = num(line.grammatura), width = num(line.larghezza_mm), diam = num(line.diametro_mm);
  const desc = String(line.descrizione || '');
  const color = line.colore || (/white|bianc|bleach/i.test(desc) ? 'bianco' : /brown|avana|natural|unbleach/i.test(desc) ? 'avana' : null);
  const ribbed = line.millerighe ?? /ribbed|millerighe|rigat/i.test(desc);
  const grease = /grease/i.test(desc);
  const sup = supplierKey(supplier);
  let cands = db.prepare('SELECT * FROM products WHERE in_list = 1').all().filter(p => {
    if (gsm && p.gsm && Math.abs(p.gsm - gsm) > 0.5) return false;
    if (width && p.width_mm && Math.abs(p.width_mm - width) > 1) return false;
    if (gsm && !p.gsm) return false;
    if (width && !p.width_mm) return false;
    if (color === 'bianco' && /avana/i.test(p.family || '')) return false;
    if (color === 'avana' && /bianc/i.test(p.family || '')) return false;
    return true;
  });
  if (!cands.length) return { code: null, how: 'nessun articolo con queste caratteristiche', options: [] };
  const scored = cands.map(p => {
    let s = 0;
    const why = [];
    const psup = supplierKey(p.supplier);
    if (sup && psup === sup) { s += 3; why.push('stesso fornitore'); } else if (sup && psup && psup !== sup) s -= 3;
    if (diam) { const d100 = isDiam100(p); if ((diam >= 950) === d100) { s += 2; why.push(diam >= 950 ? 'diam. 100' : 'diam. 90'); } else s -= 2; }
    const pr = /millerighe/i.test(p.ptype || '');
    if (pr === !!ribbed) s += 1; else s -= 2;
    if (grease === /grease/i.test(p.ptype || '')) s += 1; else s -= 3;
    return { p, s, why };
  }).sort((a, b) => b.s - a.s);
  const best = scored[0];
  const options = scored.slice(0, 6).map(x => x.p.code);
  if (scored.length === 1 || best.s > scored[1].s) {
    return { code: best.p.code, how: `${gsm ? gsm + ' g' : ''}${width ? ' · ' + width + ' mm' : ''}${best.why.length ? ' · ' + best.why.join(', ') : ''}`.replace(/^ · /, ''), sure: false, options };
  }
  return { code: null, how: 'più articoli possibili: sceglierne uno', options };
}

module.exports = { parseLista, importLista, stockView, matchLine, ncode, readWorkbook, serialToIso, today };
