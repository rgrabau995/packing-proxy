// JARVIS — Portale Programma di Carico, Serchio Distribuzione
// Logistica (ruolo 'ufficio'): carica conferme d'ordine e spedizioni fornitore, controlla, chiude con il DDT.
// Magazzino: vede gli ordini da preparare, inserisce i rotoli (online o foto del foglio) e conferma.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, tx, DATA_DIR } = require('./lib/db');
const ai = require('./lib/ai');
const { resolve, checkOrder, norm } = require('./lib/match');
const { importRegister, exportRegister } = require('./lib/register');

const app = express();
app.use(express.json({ limit: '40mb' }));

// Versione del portale: cambia a ogni deploy. La pagina la confronta e si ricarica da sola quando è vecchia.
const APP_VERSION = process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now());
app.use((req, res, next) => { res.setHeader('X-App-Version', APP_VERSION); next(); });

// ── Accesso ─────────────────────────────────────────────────
// UFFICIO_CODE (o il vecchio ACCESS_CODE) = logistica, MAGAZZINO_CODE = magazzino. Si impostano su Railway.
const ROLE_LABEL = { ufficio: 'Logistica', magazzino: 'Magazzino' };
const CODES = { ufficio: process.env.UFFICIO_CODE || process.env.ACCESS_CODE || '', magazzino: process.env.MAGAZZINO_CODE || '' };
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('pk|' + CODES.ufficio + '|' + CODES.magazzino + '|' + (process.env.ANTHROPIC_API_KEY || '')).digest('hex');
const DEV_OPEN = !CODES.ufficio && !CODES.magazzino && !process.env.RAILWAY_ENVIRONMENT; // solo in locale senza codici
const sameCode = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
function readSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)pk=([^;]+)/);
  if (!m) return null;
  const [b, s] = m[1].split('.');
  if (!b || !s) return null;
  const good = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}
const auth = (...roles) => (req, res, next) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'Accesso scaduto: rientrare con il proprio codice.' });
  if (roles.length && !roles.includes(s.r)) return res.status(403).json({ error: 'Operazione riservata alla logistica.' });
  req.user = s; next();
};
const ah = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.message || 'Errore del server' });
});
const fail = (status, msg) => Object.assign(new Error(msg), { status });

app.post('/api/login', (req, res) => {
  const { codice } = req.body || {};
  let role = null;
  if (DEV_OPEN) role = String(codice).trim().toLowerCase() === 'magazzino' ? 'magazzino' : 'ufficio';
  else if (CODES.ufficio && codice && sameCode(codice, CODES.ufficio)) role = 'ufficio';
  else if (CODES.magazzino && codice && sameCode(codice, CODES.magazzino)) role = 'magazzino';
  if (!role) return res.status(401).json({ error: 'Codice di accesso errato.' });
  const days = 30;
  const p = { n: ROLE_LABEL[role], r: role, exp: Date.now() + days * 86400000 };
  res.setHeader('Set-Cookie', `pk=${sign(p)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${process.env.RAILWAY_ENVIRONMENT ? '; Secure' : ''}`);
  res.json({ nome: p.n, ruolo: role });
});
app.post('/api/logout', (_, res) => { res.setHeader('Set-Cookie', 'pk=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { const s = readSession(req); res.json(s ? { nome: ROLE_LABEL[s.r], ruolo: s.r } : null); });

// ── File caricati (conferme, foto del foglio, spedizioni) ──
const FILES = path.join(DATA_DIR, 'files');
const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
function checkFile(f, kinds = Object.keys(EXT)) {
  if (!f || typeof f.data !== 'string' || !f.data) throw fail(400, 'Nessun file ricevuto.');
  if (!kinds.includes(f.media_type)) throw fail(400, 'Formato non supportato: caricare un PDF o una foto (JPG/PNG).');
}
function saveFile(f, prefix) {
  const name = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${EXT[f.media_type] || '.bin'}`;
  fs.writeFileSync(path.join(FILES, name), Buffer.from(f.data, 'base64'));
  return name;
}
app.get('/api/files/:name', auth('ufficio'), (req, res) => {
  const name = path.basename(req.params.name);
  const p = path.join(FILES, name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ── Ordini ──────────────────────────────────────────────────
const getOrder = id => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  if (!o) throw fail(404, 'Ordine non trovato.');
  return o;
};
const getLines = id => db.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY item, pos').all(Number(id));
// Il magazzino vede solo l'ordine da preparare e le sue righe: i controlli sono dell'ufficio.
const forWarehouse = (req, o) => {
  if (req.user.r !== 'ufficio' && o.status !== 'da_preparare') throw fail(403, 'Ordine già confermato e passato alla logistica.');
};
function orderView(o, role = 'ufficio') {
  const lines = getLines(o.id);
  if (role !== 'ufficio') {
    const { file, scan_file, ddt, closed_by, closed_at, ...rest } = o;
    return { ...rest, items: JSON.parse(o.items), lines: lines.map(({ roll_id, ...l }) => l) };
  }
  const check = checkOrder(o, lines);
  return { ...o, items: JSON.parse(o.items), lines: check.lines, check: { items: check.items, problemi: check.problemi, avvisi: check.avvisi, nonVerificabili: check.nonVerificabili } };
}

app.get('/api/orders', auth(), (req, res) => {
  const rows = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id AND TRIM(COALESCE(l.roll_input,'')) != '') AS rotoli
    FROM orders o ${req.user.r === 'ufficio' ? '' : "WHERE o.status = 'da_preparare'"} ORDER BY CASE o.status WHEN 'da_preparare' THEN 0 WHEN 'preparato' THEN 1 ELSE 2 END, o.id DESC LIMIT 300`).all();
  res.json(rows.map(o => {
    const items = JSON.parse(o.items);
    return { id: o.id, n_ordine: o.n_ordine, data_ordine: o.data_ordine, cliente: o.cliente, localita: o.localita, status: o.status,
      magazzino: o.magazzino, rotoli: o.rotoli, colli: items.reduce((s, i) => s + (i.colli || 0), 0), articoli: items.length,
      prepared_by: o.prepared_by, prepared_date: o.prepared_date, ddt: o.ddt, created_at: o.created_at };
  }));
});

app.post('/api/orders', auth('ufficio'), ah(async (req, res) => {
  const { file, magazzino } = req.body || {};
  checkFile(file, ['application/pdf']);
  const d = await ai.readOrder(file);
  const fname = saveFile(file, 'conferma');
  const items = (d.prodotti || []).map(p => ({ codice: p.codice, descrizione: p.descrizione, gr_mq: p.gr_mq, colli: p.colli, quantita_kg: p.quantita_kg }));
  const r = db.prepare(`INSERT INTO orders (n_ordine, data_ordine, cliente, indirizzo, localita, telefono, email, cod_cliente, modalita_carico, note_carico, magazzino, items, file, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.n_ordine, d.data_ordine, d.destinatario_nome, d.destinatario_indirizzo, d.localita, d.telefono, d.email,
    d.cod_cliente, d.modalita_carico, d.note_carico, (magazzino || '').trim() || d.magazzino_partenza || null, JSON.stringify(items), fname, req.user.n);
  res.json(orderView(getOrder(r.lastInsertRowid)));
}));

app.get('/api/orders/:id', auth(), ah((req, res) => {
  const o = getOrder(req.params.id);
  forWarehouse(req, o);
  res.json(orderView(o, req.user.r));
}));

// Dati dell'ordine modificabili dalla logistica (magazzino di partenza, cliente, articoli...).
app.patch('/api/orders/:id', auth(), ah((req, res) => {
  const o = getOrder(req.params.id);
  const isMag = req.user.r !== 'ufficio';
  if (isMag) forWarehouse(req, o);
  // Il magazzino può scegliere solo il magazzino di partenza; il resto è della logistica.
  const fields = isMag ? ['magazzino'] : ['n_ordine', 'data_ordine', 'cliente', 'indirizzo', 'localita', 'telefono', 'email', 'cod_cliente', 'modalita_carico', 'note_carico', 'magazzino'];
  const b = req.body || {};
  if (isMag && Array.isArray(b.items)) throw fail(403, 'Operazione riservata alla logistica.');
  for (const f of fields) if (f in b) db.prepare(`UPDATE orders SET ${f} = ? WHERE id = ?`).run(b[f] === '' ? null : b[f], o.id);
  if (Array.isArray(b.items)) db.prepare('UPDATE orders SET items = ? WHERE id = ?').run(JSON.stringify(b.items.map(i => ({
    codice: i.codice || null, descrizione: i.descrizione || '', gr_mq: i.gr_mq ?? null, colli: i.colli ?? null, quantita_kg: i.quantita_kg ?? null }))), o.id);
  res.json(orderView(getOrder(o.id), req.user.r));
}));

app.delete('/api/orders/:id', auth('ufficio'), ah((req, res) => {
  const o = getOrder(req.params.id);
  if (o.status === 'chiuso') throw fail(409, 'Ordine chiuso: prima riaprirlo.');
  db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  res.json({ ok: true });
}));

// Salva i rotoli inseriti (bozza o conferma del magazzino).
const saveLines = tx((orderId, lines) => {
  db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(orderId);
  const ins = db.prepare('INSERT INTO order_lines (order_id, item, pos, pallet, roll_input, kg_input, note) VALUES (?,?,?,?,?,?,?)');
  const pos = {};
  for (const l of lines) {
    const roll = String(l.roll_input ?? '').trim(), kg = l.kg_input === '' || l.kg_input == null ? null : Number(String(l.kg_input).replace(',', '.'));
    const pallet = String(l.pallet ?? '').trim(), note = String(l.note ?? '').trim();
    if (!roll && kg == null && !pallet && !note) continue;
    const item = Number(l.item) || 0;
    pos[item] = (pos[item] || 0) + 1;
    ins.run(orderId, item, pos[item], pallet || null, roll || null, Number.isFinite(kg) ? kg : null, note || null);
  }
});
app.put('/api/orders/:id/lines', auth(), ah((req, res) => {
  const o = getOrder(req.params.id);
  if (o.status === 'chiuso') throw fail(409, 'Ordine già chiuso dalla logistica: non è più modificabile.');
  forWarehouse(req, o);
  saveLines(o.id, Array.isArray(req.body?.lines) ? req.body.lines : []);
  // "Preparato da" e data: scritti liberamente da chi prepara (la data dal calendario).
  const b = req.body || {};
  if ('prepared_by' in b || 'prepared_date' in b) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.prepared_date || '')) ? b.prepared_date : null;
    db.prepare('UPDATE orders SET prepared_by = ?, prepared_date = ? WHERE id = ?').run(String(b.prepared_by || '').trim().slice(0, 80) || null, date, o.id);
  }
  if (b.submit) db.prepare(`UPDATE orders SET status = 'preparato', prepared_at = datetime('now') WHERE id = ?`).run(o.id);
  res.json(orderView(getOrder(o.id), req.user.r));
}));

// Riconosce al volo un rotolo mentre lo si scrive.
app.get('/api/orders/:id/resolve', auth('ufficio'), ah((req, res) => {
  const o = getOrder(req.params.id);
  const it = JSON.parse(o.items)[Number(req.query.item) || 0] || {};
  res.json(resolve(it.codice, req.query.q, o.id, req.query.kg ? Number(String(req.query.kg).replace(',', '.')) : null));
}));

// Legge la foto / scansione del foglio compilato a mano. Non salva: le righe tornano alla pagina da controllare.
app.post('/api/orders/:id/scan', auth(), ah(async (req, res) => {
  const o = getOrder(req.params.id);
  forWarehouse(req, o);
  const { file } = req.body || {};
  checkFile(file);
  const items = JSON.parse(o.items);
  const cand = items.map(it => it.codice ? db.prepare(`SELECT roll_no, kg FROM rolls WHERE product_code = ? AND (status = 'stock' OR order_id = ?) ORDER BY arrival_date DESC LIMIT 400`).all(it.codice, o.id) : []);
  const r = await ai.readSheet(file, o, cand);
  const fname = saveFile(file, 'foglio');
  db.prepare('UPDATE orders SET scan_file = ? WHERE id = ?').run(fname, o.id);
  const lines = [];
  for (const a of r.articoli || []) {
    const item = (a.articolo || 1) - 1;
    if (!items[item]) continue;
    for (const x of a.righe || []) {
      const written = norm(x.rotolo_scritto);
      const prob = x.rotolo_probabile && norm(x.rotolo_probabile);
      const useProb = prob && cand[item].some(c => c.roll_no === prob);
      const notes = [];
      if (useProb && !prob.endsWith(written)) notes.push(`sul foglio: ${x.rotolo_scritto}`);
      if (x.incerto) notes.push('lettura incerta');
      lines.push({ item, pallet: '', roll_input: useProb ? prob : x.rotolo_scritto, kg_input: x.kg, note: notes.join(' · ') });
    }
  }
  res.json({ lines, note: r.note, scan_file: fname });
}));

// Chiusura (logistica): i rotoli escono dalla giacenza e finiscono nello storico con cliente e DDT.
const closeOrder = tx((o, label, ddt, user) => {
  const check = checkOrder(o, getLines(o.id));
  let seq = (db.prepare('SELECT MAX(seq) m FROM rolls').get().m || 0);
  const upd = db.prepare(`UPDATE rolls SET status = 'out', out_label = ?, out_date = date('now'), order_id = ?, seq = ? WHERE id = ?`);
  let n = 0;
  for (const l of check.lines) {
    if (!['ok', 'kg'].includes(l.match.state) || !l.match.roll) continue;
    upd.run(label, o.id, ++seq, l.match.roll.id); // nel registro resta il peso del packing list fornitore
    db.prepare('UPDATE order_lines SET roll_id = ? WHERE id = ?').run(l.match.roll.id, l.id);
    n++;
  }
  db.prepare(`UPDATE orders SET status = 'chiuso', ddt = ?, closed_by = ?, closed_at = datetime('now') WHERE id = ?`).run(ddt, user, o.id);
  return n;
});
app.post('/api/orders/:id/close', auth('ufficio'), ah((req, res) => {
  const o = getOrder(req.params.id);
  if (o.status === 'chiuso') throw fail(409, 'Ordine già chiuso.');
  const ddt = String(req.body?.ddt || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!ddt) throw fail(400, 'Inserire il numero di DDT.');
  if (!label) throw fail(400, 'Inserire il nome da scrivere nel registro.');
  const check = checkOrder(o, getLines(o.id));
  if ((check.problemi || check.avvisi) && !req.body?.force) return res.status(409).json({ error: 'Ci sono rotoli da controllare.', needForce: true });
  const n = closeOrder(o, label.includes(ddt) ? label : `${label} Ddt ${ddt}`, ddt, req.user.n);
  res.json({ ...orderView(getOrder(o.id)), scaricati: n });
}));
app.post('/api/orders/:id/reopen', auth('ufficio'), ah((req, res) => {
  const o = getOrder(req.params.id);
  tx(() => {
    db.prepare(`UPDATE rolls SET status = 'stock', out_label = NULL, out_date = NULL, order_id = NULL, seq = NULL WHERE order_id = ?`).run(o.id);
    db.prepare('UPDATE order_lines SET roll_id = NULL WHERE order_id = ?').run(o.id);
    db.prepare(`UPDATE orders SET status = 'preparato', ddt = NULL, closed_by = NULL, closed_at = NULL WHERE id = ?`).run(o.id);
  })();
  res.json(orderView(getOrder(o.id)));
}));
// La logistica rimanda l'ordine al magazzino (es. rotoli da correggere): torna "da preparare".
app.post('/api/orders/:id/back', auth('ufficio'), ah((req, res) => {
  const o = getOrder(req.params.id);
  if (o.status === 'chiuso') throw fail(409, 'Ordine chiuso: prima riaprirlo.');
  db.prepare(`UPDATE orders SET status = 'da_preparare' WHERE id = ?`).run(o.id);
  res.json(orderView(getOrder(o.id)));
}));
// Suggerisce come si chiama il cliente nel registro (com'è stato scritto le volte precedenti).
app.get('/api/orders/:id/label', auth('ufficio'), ah((req, res) => {
  const o = getOrder(req.params.id);
  const words = String(o.cliente || '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 2);
  let prev = null;
  if (words.length) {
    const rows = db.prepare(`SELECT out_label FROM rolls WHERE out_label IS NOT NULL ${words.map(() => 'AND out_label LIKE ?').join(' ')} ORDER BY seq DESC LIMIT 1`).all(...words.map(w => `%${w}%`));
    if (rows[0]) prev = rows[0].out_label.replace(/\s*Ddt\s*\S+\s*$/i, '').trim();
  }
  const title = String(o.cliente || '').toLowerCase().replace(/(^|[\s.(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(Di|De|Del|Della|E)\b/g, s => s.toLowerCase());
  res.json({ label: prev || title });
}));

// ── Magazzino: prodotti e giacenza ──────────────────────────
app.get('/api/products', auth('ufficio'), (req, res) => {
  res.json(db.prepare(`SELECT p.*,
    (SELECT COUNT(*) FROM rolls r WHERE r.product_code = p.code AND r.status = 'stock') AS rotoli,
    (SELECT COALESCE(SUM(kg),0) FROM rolls r WHERE r.product_code = p.code AND r.status = 'stock') AS kg,
    (SELECT COUNT(*) FROM rolls r WHERE r.product_code = p.code AND r.status = 'out') AS uscite
    FROM products p ORDER BY p.code`).all());
});
app.get('/api/products/:code', auth('ufficio'), ah((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE code = ?').get(req.params.code);
  if (!p) throw fail(404, 'Prodotto non trovato.');
  const stock = db.prepare(`SELECT * FROM rolls WHERE product_code = ? AND status = 'stock' ORDER BY arrival_date, id`).all(p.code);
  const out = db.prepare(`SELECT * FROM rolls WHERE product_code = ? AND status = 'out' ORDER BY seq DESC, id DESC LIMIT 300`).all(p.code);
  const map = db.prepare('SELECT supplier_code FROM supplier_map WHERE product_code = ?').all(p.code).map(x => x.supplier_code);
  res.json({ ...p, stock, out, supplier_codes: map });
}));
app.post('/api/products', auth('ufficio'), ah((req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,}$/.test(code)) throw fail(400, 'Codice articolo non valido.');
  db.prepare('INSERT OR IGNORE INTO products (code, title, height) VALUES (?,?,?)').run(code, req.body?.title || null, req.body?.height || null);
  res.json({ code });
}));
app.patch('/api/products/:code', auth('ufficio'), ah((req, res) => {
  for (const f of ['title', 'height', 'description']) if (f in (req.body || {})) db.prepare(`UPDATE products SET ${f} = ? WHERE code = ?`).run(req.body[f] || null, req.params.code);
  res.json({ ok: true });
}));
app.post('/api/products/:code/import', auth('ufficio'), ah((req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const f = req.body?.file;
  if (!f?.data) throw fail(400, 'Nessun file ricevuto.');
  try { res.json(importRegister(code, Buffer.from(f.data, 'base64'))); }
  catch (e) { throw e.status ? e : fail(422, 'Excel non leggibile: ' + e.message); }
}));
app.get('/api/products/:code/export', auth('ufficio'), ah((req, res) => {
  const buf = exportRegister(req.params.code);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.code.replace(/[^\w-]/g, '')}.xlsx"`);
  res.send(buf);
}));
// Correzione manuale di un rotolo (peso, numero, rimessa in giacenza).
app.patch('/api/rolls/:id', auth('ufficio'), ah((req, res) => {
  const r = db.prepare('SELECT * FROM rolls WHERE id = ?').get(Number(req.params.id));
  if (!r) throw fail(404, 'Rotolo non trovato.');
  if ('kg' in req.body) db.prepare('UPDATE rolls SET kg = ? WHERE id = ?').run(Number(req.body.kg), r.id);
  if ('delete' in req.body && req.body.delete && !r.order_id) db.prepare('DELETE FROM rolls WHERE id = ?').run(r.id);
  res.json({ ok: true });
}));
app.post('/api/products/:code/rolls', auth('ufficio'), ah((req, res) => {
  const { roll_no, kg, arrival_date } = req.body || {};
  if (!roll_no) throw fail(400, 'Numero rotolo mancante.');
  db.prepare(`INSERT INTO rolls (roll_no, product_code, kg, arrival_date, source) VALUES (?,?,?,?, 'manuale')`).run(norm(roll_no), req.params.code, kg ?? null, arrival_date || new Date().toISOString().slice(0, 10));
  res.json({ ok: true });
}));

// ── Spedizioni fornitore: leggono il packing list e caricano la giacenza ──
const itDate = s => { const m = String(s || '').match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
function suggestProduct(a) {
  if (a.codice_materiale_cliente) {
    const m = db.prepare('SELECT product_code FROM supplier_map WHERE supplier_code = ?').get(a.codice_materiale_cliente);
    if (m) return { code: m.product_code, how: 'abbinamento salvato' };
  }
  if (a.grammatura && a.larghezza_mm) {
    const h = 'H' + Math.round(a.larghezza_mm / 10);
    const c = db.prepare('SELECT code FROM products').all().map(p => p.code).filter(code => code.includes(String(a.grammatura)) && code.endsWith(h));
    if (c.length === 1) return { code: c[0], how: `grammatura ${a.grammatura} e altezza ${h}` };
    if (c.length > 1) return { code: null, options: c };
  }
  return { code: null };
}
app.post('/api/shipments/read', auth('ufficio'), ah(async (req, res) => {
  const { file } = req.body || {};
  checkFile(file, ['application/pdf']);
  const d = await ai.readShipment(file);
  const fname = saveFile(file, 'spedizione');
  const known = db.prepare('SELECT product_code, status FROM rolls WHERE roll_no = ?');
  d.articoli = (d.articoli || []).map(a => {
    const seen = a.rotoli.map(r => known.get(norm(r.numero))).filter(Boolean);
    return { ...a, suggerito: suggestProduct(a), gia_presenti: seen.length };
  });
  res.json({ ...d, file: fname, prodotti: db.prepare('SELECT code, title FROM products ORDER BY code').all() });
}));
app.post('/api/shipments', auth('ufficio'), ah((req, res) => {
  const b = req.body || {};
  const arts = (b.articoli || []).filter(a => a.product_code && (a.rotoli || []).length);
  if (!arts.length) throw fail(400, 'Nessun articolo abbinato a un codice articolo.');
  const out = tx(() => {
    const sh = db.prepare('INSERT INTO shipments (supplier, number, invoice, date, warehouse, file, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(b.fornitore || null, b.numero_spedizione || null, b.numero_fattura || null, itDate(b.data_arrivo) || itDate(b.data_spedizione), b.consegna_presso || null, b.file || null, req.user.n);
    const date = itDate(b.data_arrivo) || itDate(b.data_spedizione) || new Date().toISOString().slice(0, 10);
    const ins = db.prepare(`INSERT OR IGNORE INTO rolls (roll_no, product_code, kg, arrival_date, shipment_id, status, source) VALUES (?,?,?,?,?, 'stock', 'spedizione')`);
    let added = 0, skipped = 0;
    for (const a of arts) {
      const code = String(a.product_code).trim().toUpperCase();
      db.prepare('INSERT OR IGNORE INTO products (code, title, description) VALUES (?,?,?)').run(code, a.descrizione || null, a.descrizione || null);
      if (a.codice_materiale_cliente) db.prepare('INSERT OR REPLACE INTO supplier_map (supplier_code, product_code) VALUES (?,?)').run(a.codice_materiale_cliente, code);
      for (const r of a.rotoli) { ins.run(norm(r.numero), code, r.kg ?? null, date, sh.lastInsertRowid).changes ? added++ : skipped++; }
    }
    return { added, skipped };
  })();
  res.json(out);
}));
app.get('/api/shipments', auth('ufficio'), (req, res) => {
  res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM rolls r WHERE r.shipment_id = s.id) AS rotoli FROM shipments s ORDER BY id DESC LIMIT 100`).all());
});

// ── Giacenze in kg, arrivi dai fornitori, abbinamento codici (pagina Giacenza, solo logistica) ──
const stock = require('./lib/stock');

app.get('/api/stock', auth('ufficio'), ah((req, res) => res.json(stock.stockView(req.query.date))));
app.post('/api/stock/import', auth('ufficio'), ah((req, res) => {
  const f = req.body?.file;
  if (!f?.data) throw fail(400, 'Nessun file ricevuto.');
  try { res.json(stock.importLista(Buffer.from(f.data, 'base64'))); }
  catch (e) { throw e.status ? e : fail(422, 'Excel non leggibile: ' + e.message); }
}));

// Legge la conferma del fornitore (o il nostro ordine a fornitore) e propone il codice interno per ogni riga.
app.post('/api/arrivals/read', auth('ufficio'), ah(async (req, res) => {
  const { file } = req.body || {};
  checkFile(file, ['application/pdf']);
  const d = await ai.readSupplierDoc(file);
  const fname = saveFile(file, 'fornitore');
  const righe = (d.righe || []).map(r => ({ ...r, match: stock.matchLine(r, d.fornitore) }));
  const catalogo = db.prepare('SELECT code, family, ptype, gsm, width_mm FROM products WHERE in_list = 1 ORDER BY code').all();
  const giaCaricati = d.nostro_ordine ? db.prepare(`SELECT COUNT(*) n FROM arrivals WHERE our_order = ? AND status = 'in_arrivo'`).get(String(d.nostro_ordine)).n : 0;
  res.json({ ...d, righe, file: fname, catalogo, gia_caricati: giaCaricati });
}));

// Conferma: salva gli abbinamenti e mette le righe "in arrivo" con la data.
// Se lo stesso nostro ordine era già caricato (es. prima l'ordine 319, poi la conferma Mondi), le righe vengono sostituite.
app.post('/api/arrivals', auth('ufficio'), ah((req, res) => {
  const b = req.body || {};
  const righe = (b.righe || []).filter(r => r.product_code && Number(r.kg) > 0);
  if (!righe.length) throw fail(400, 'Nessuna riga con codice interno e kg.');
  const out = tx(() => {
    let replaced = 0;
    if (b.nostro_ordine) replaced = db.prepare(`DELETE FROM arrivals WHERE our_order = ? AND status = 'in_arrivo'`).run(String(b.nostro_ordine)).changes;
    const ins = db.prepare(`INSERT INTO arrivals (product_code, kg, date, date_to, our_order, supplier, supplier_conf, supplier_code, description, source, file)
      VALUES (?,?,?,?,?,?,?,?,?, 'documento', ?)`);
    const map = db.prepare(`INSERT INTO supplier_map (supplier_code, product_code, created_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(supplier_code) DO UPDATE SET product_code = excluded.product_code`);
    let saved = 0;
    for (const r of righe) {
      const code = String(r.product_code).trim().toUpperCase();
      db.prepare('INSERT OR IGNORE INTO products (code, description) VALUES (?, ?)').run(code, r.descrizione || null);
      ins.run(code, Number(r.kg), itDate(r.consegna_dal), itDate(r.consegna_al), b.nostro_ordine || null, b.fornitore || null, b.conferma_fornitore || null,
        r.codice_cliente || r.codice_fornitore || null, r.descrizione || null, b.file || null);
      for (const k of [r.codice_cliente, r.codice_fornitore].map(stock.ncode).filter(Boolean)) {
        if (k === stock.ncode(code)) continue;
        map.run(k, code); saved++;
      }
    }
    return { righe: righe.length, sostituite: replaced, abbinamenti: saved };
  })();
  res.json(out);
}));
app.get('/api/arrivals', auth('ufficio'), (req, res) => {
  res.json(db.prepare(`SELECT a.*, p.family FROM arrivals a LEFT JOIN products p ON p.code = a.product_code
    ORDER BY a.status = 'arrivato', a.date IS NULL, a.date, a.id LIMIT 500`).all());
});
// Merce arrivata: i kg passano dalla colonna "in arrivo" alla giacenza.
app.post('/api/arrivals/:id/arrived', auth('ufficio'), ah((req, res) => {
  const a = db.prepare('SELECT * FROM arrivals WHERE id = ?').get(Number(req.params.id));
  if (!a) throw fail(404, 'Arrivo non trovato.');
  if (a.status === 'arrivato') throw fail(409, 'Già registrato come arrivato.');
  tx(() => {
    db.prepare(`UPDATE arrivals SET status = 'arrivato', arrived_at = datetime('now') WHERE id = ?`).run(a.id);
    db.prepare('UPDATE products SET stock_kg = COALESCE(stock_kg, 0) + ? WHERE code = ?').run(a.kg, a.product_code);
  })();
  res.json({ ok: true });
}));
app.patch('/api/arrivals/:id', auth('ufficio'), ah((req, res) => {
  const b = req.body || {};
  if ('date' in b) db.prepare('UPDATE arrivals SET date = ? WHERE id = ?').run(/^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null, Number(req.params.id));
  if ('kg' in b && Number(b.kg) > 0) db.prepare('UPDATE arrivals SET kg = ? WHERE id = ?').run(Number(b.kg), Number(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/arrivals/:id', auth('ufficio'), ah((req, res) => {
  db.prepare(`DELETE FROM arrivals WHERE id = ? AND status = 'in_arrivo'`).run(Number(req.params.id));
  res.json({ ok: true });
}));

app.get('/api/mappings', auth('ufficio'), (req, res) => {
  res.json(db.prepare(`SELECT m.supplier_code, m.product_code, m.created_at, p.family, p.ptype, p.gsm, p.width_mm
    FROM supplier_map m LEFT JOIN products p ON p.code = m.product_code ORDER BY m.product_code, m.supplier_code`).all());
});
app.put('/api/mappings', auth('ufficio'), ah((req, res) => {
  const k = stock.ncode(req.body?.supplier_code), code = String(req.body?.product_code || '').trim().toUpperCase();
  if (!k || !code) throw fail(400, 'Servono codice fornitore e codice interno.');
  if (!db.prepare('SELECT 1 FROM products WHERE code = ?').get(code)) throw fail(400, `Il codice interno ${code} non è in giacenza.`);
  db.prepare(`INSERT INTO supplier_map (supplier_code, product_code, created_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(supplier_code) DO UPDATE SET product_code = excluded.product_code`).run(k, code);
  res.json({ ok: true });
}));
app.delete('/api/mappings/:code', auth('ufficio'), ah((req, res) => {
  db.prepare('DELETE FROM supplier_map WHERE supplier_code = ?').run(req.params.code);
  res.json({ ok: true });
}));

// ── Pagine ──────────────────────────────────────────────────
app.get('/api/config', (_, res) => res.json({ codeRequired: !DEV_OPEN, ai: ai.aiReady() }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));
// La pagina e gli script si ricaricano sempre: dopo un aggiornamento nessuno resta con la versione vecchia.
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', etag: true, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log('Portale avviato su', process.env.PORT || 3000, '— dati in', DATA_DIR));
}
module.exports = { app };
