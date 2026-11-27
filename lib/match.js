// Riconosce i rotoli scritti dal magazzino e controlla l'ordine contro la giacenza.
// Il magazzino scrive di solito solo le ultime cifre (es. "726" per 1626070726):
// si cerca il rotolo che finisce con quelle cifre tra i rotoli dello stesso prodotto.
const { db } = require('./db');

const KG_TOLLERANZA = 2; // kg di differenza accettati tra foglio e packing list fornitore

const norm = s => String(s ?? '').toUpperCase().replace(/[\s.\-\/]/g, '');

const qByProduct = db.prepare(`SELECT * FROM rolls WHERE product_code = ? AND (roll_no = ? OR roll_no LIKE ?)`);
const qAnyStock = db.prepare(`SELECT * FROM rolls WHERE status = 'stock' AND (roll_no = ? OR roll_no LIKE ?) LIMIT 6`);
const qProduct = db.prepare(`SELECT code FROM products WHERE code = ?`);
const qOtherOrders = db.prepare(`
  SELECT o.id, o.n_ordine, o.cliente, l.roll_input, l.item, o.items
  FROM order_lines l JOIN orders o ON o.id = l.order_id
  WHERE o.status != 'chiuso' AND o.id != ?`);

const qStockOf = db.prepare(`SELECT * FROM rolls WHERE product_code = ? AND (status = 'stock' OR order_id = ?)`);

// Rotoli in giacenza che differiscono di una sola cifra da quella scritta (tipico errore di calligrafia: 715 / 775).
function similar(productCode, q, orderId, kg) {
  if (q.length < 2) return [];
  return qStockOf.all(productCode, orderId).filter(r => {
    const tail = norm(r.roll_no).slice(-q.length);
    if (tail.length !== q.length) return false;
    let d = 0; for (let i = 0; i < q.length; i++) if (tail[i] !== q[i]) d++;
    return d === 1;
  }).sort((a, b) => kg == null || kg === '' ? 0 : Math.abs((a.kg ?? 1e9) - kg) - Math.abs((b.kg ?? 1e9) - kg)).slice(0, 8);
}

const brief = r => ({ id: r.id, roll_no: r.roll_no, kg: r.kg, arrival_date: r.arrival_date, product_code: r.product_code, status: r.status, out_label: r.out_label });

function resolve(productCode, input, orderId, kg) {
  const q = norm(input);
  if (!q) return { state: 'vuoto' };
  if (!productCode || !qProduct.get(productCode)) {
    const other = q.length >= 6 ? qAnyStock.all(q, '%' + q) : []; // con poche cifre i suggerimenti da altri prodotti confondono
    return { state: 'no_giacenza', msg: 'Prodotto non presente nel magazzino del portale: rotolo non verificabile', candidates: other.map(brief) };
  }
  const found = qByProduct.all(productCode, q, '%' + q);
  const usable = found.filter(r => r.status === 'stock' || r.order_id === orderId);
  if (usable.length === 1) return { state: 'ok', roll: brief(usable[0]) };
  if (usable.length > 1) {
    // Se uno coincide esattamente vince lui.
    const exact = usable.find(r => norm(r.roll_no) === q);
    if (exact) return { state: 'ok', roll: brief(exact) };
    return { state: 'ambiguo', msg: `${usable.length} rotoli in giacenza finiscono con ${q}: scrivere più cifre`, candidates: usable.slice(0, 6).map(brief) };
  }
  const near = similar(productCode, q, orderId, kg).map(brief);
  const hint = near.length ? ` — forse uno di questi?` : '';
  if (found.length) {
    const r = [...found].sort((a, b) => String(b.arrival_date).localeCompare(String(a.arrival_date)) || b.id - a.id)[0];
    return { state: 'uscito', msg: `Rotolo già uscito${r.out_label ? ': ' + r.out_label : ''}${hint}`, roll: brief(r), candidates: near };
  }
  const other = q.length >= 5 ? qAnyStock.all(q, '%' + q) : [];
  if (other.length) return { state: 'altro_prodotto', msg: `Non è di questo prodotto: trovato in ${[...new Set(other.map(o => o.product_code))].join(', ')}${hint}`, candidates: near.length ? near : other.map(brief) };
  return { state: 'non_trovato', msg: 'Rotolo non presente in giacenza' + hint, candidates: near };
}

// Controllo completo di un ordine: per ogni riga lo stato, per ogni articolo i totali.
function checkOrder(order, lines) {
  const items = JSON.parse(order.items);
  const others = qOtherOrders.all(order.id);
  const seen = new Map();
  const out = lines.map(l => {
    const it = items[l.item] || {};
    const m = resolve(it.codice, l.roll_input, order.id, l.kg_input);
    if (m.roll) {
      if (m.state === 'ok' && l.kg_input != null && l.kg_input !== '' && m.roll.kg != null && Math.abs(Number(l.kg_input) - m.roll.kg) > KG_TOLLERANZA) {
        m.state = 'kg';
        m.msg = `Kg diversi: sul foglio ${l.kg_input}, packing list fornitore ${m.roll.kg}`;
      }
      if (seen.has(m.roll.id)) { m.state = 'doppio'; m.msg = 'Rotolo scritto due volte in questo ordine'; }
      seen.set(m.roll.id, true);
      if (m.state === 'ok' || m.state === 'kg') {
        const clash = others.find(o => {
          const oi = JSON.parse(o.items)[o.item] || {};
          if (oi.codice !== it.codice) return false;
          const r = resolve(oi.codice, o.roll_input, o.id);
          return r.roll && r.roll.id === m.roll.id;
        });
        if (clash) { m.state = 'conflitto'; m.msg = `Rotolo già caricato sull'ordine ${clash.n_ordine} (${clash.cliente})`; }
      }
    }
    return { ...l, match: m };
  });
  const perItem = items.map((it, i) => {
    const ls = out.filter(l => l.item === i && l.match.state !== 'vuoto');
    const kgFoglio = ls.reduce((s, l) => s + (Number(l.kg_input) || 0), 0);
    const kgFornitore = ls.reduce((s, l) => s + (l.match.roll && l.match.state !== 'uscito' ? l.match.roll.kg || 0 : 0), 0);
    const problemi = ls.filter(l => !['ok', 'no_giacenza'].includes(l.match.state)).length;
    const msgs = [];
    if (it.colli && !it.rimosso && ls.length !== it.colli) msgs.push(`Rotoli caricati ${ls.length}, ordinati ${it.colli}`);
    return { rotoli: ls.length, colli: it.colli, kgFoglio, kgFornitore, kgOrdinati: it.quantita_kg, problemi, msgs };
  });
  const problemi = out.filter(l => !['ok', 'vuoto', 'no_giacenza'].includes(l.match.state)).length;
  const nonVerificabili = out.filter(l => l.match.state === 'no_giacenza').length;
  return { lines: out, items: perItem, problemi, nonVerificabili, avvisi: perItem.reduce((s, x) => s + x.msgs.length, 0) };
}

module.exports = { resolve, checkOrder, norm, KG_TOLLERANZA };
