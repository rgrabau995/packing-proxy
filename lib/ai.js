// Letture dei documenti con Claude: risposta sempre in JSON valido grazie agli output strutturati.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const str = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const int = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const num = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const obj = props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const arr = items => ({ type: 'array', items });

function describeError(e) {
  if (e instanceof Anthropic.RateLimitError) return 'troppe richieste in poco tempo, riprova tra un minuto';
  if (e instanceof Anthropic.AuthenticationError) return 'chiave API Anthropic non valida (controllare ANTHROPIC_API_KEY su Railway)';
  if (e instanceof Anthropic.BadRequestError) return 'documento non leggibile o troppo grande (' + e.message + ')';
  if (e instanceof Anthropic.APIError) return 'servizio AI non disponibile (' + (e.status || 'rete') + '), riprova';
  return e.message;
}

// file: { data: base64, media_type: 'application/pdf' | 'image/jpeg' | 'image/png' | ... }
async function ask(file, prompt, schema, maxTokens = 16000) {
  if (!client) throw new Error('Configurazione mancante: impostare ANTHROPIC_API_KEY su Railway.');
  const block = file.media_type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
    : { type: 'image', source: { type: 'base64', media_type: file.media_type, data: file.data } };
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('il modello non ha potuto elaborare questo documento');
    if (msg.stop_reason === 'max_tokens') throw new Error('documento troppo lungo: la risposta è stata troncata');
    return JSON.parse(msg.content.filter(c => c.type === 'text').map(c => c.text).join(''));
  } catch (e) {
    console.error('Lettura AI non riuscita:', e);
    const err = new Error('Lettura non riuscita: ' + describeError(e));
    err.status = 422;
    throw err;
  }
}

// ── 1. Conferma d'ordine Serkios / Serchio Distribuzione ──
const ORDER_SCHEMA = obj({
  destinatario_nome: str, destinatario_indirizzo: str, localita: str, telefono: str, email: str,
  cod_cliente: str, n_ordine: str, data_ordine: str, modalita_carico: str, note_carico: str, magazzino_partenza: str,
  prodotti: arr(obj({ codice: str, descrizione: str, gr_mq: int, colli: int, quantita_kg: num })),
});
const ORDER_PROMPT = `Estrai i dati da questa conferma d'ordine (Serkios / Serchio Distribuzione).

Campi:
- destinatario_nome: ragione sociale in alto a destra sotto "SPETT.LE" (NON l'intestazione del venditore in alto a sinistra).
- destinatario_indirizzo: indirizzo completo (via + CAP città provincia), es. "ZONA INDUSTRIALE STRADA C2 — 09039 VILLACIDRO CA".
- localita: solo la città del destinatario, es. "VILLACIDRO".
- telefono, email: dalla testata.
- cod_cliente: campo CODICE in alto a sinistra della testata (es. "339").
- n_ordine: NUMERO ORDINE. data_ordine: GG/MM/AAAA.
- modalita_carico: frase breve sul tipo di carico, es. "ROTOLI SU PALLETS" o "BOBINE SU PALLETS", se scritta. Altrimenti null.
- note_carico: eventuali istruzioni di carico scritte sotto i prodotti (es. "BOBINE CARICATE SU PALLET DI PESO OMOGENEO-PEDANE CENTRALI A 4 VIE ..."), su una riga. Ignora orari, vettore, porto, fattura, "COME SOPRA". Se assenti: null.
- magazzino_partenza: magazzino/deposito da cui parte la merce SOLO se scritto esplicitamente (es. "DEPOSITO ...", "RITIRO PRESSO ..."). Non usare il destinatario. Se assente: null.
- prodotti: TUTTI i prodotti escluse le spese di trasporto (/S004). Per ognuno:
  - codice: CODICE ARTICOLO esatto (es. "KBSSR35ADH55")
  - descrizione: descrizione completa su una riga, incluse dimensioni DIAM e FORO
  - gr_mq: intero dalla colonna GR/MQ
  - colli: intero dalla colonna COLLI (numero di rotoli)
  - quantita_kg: numero dalla colonna QUANTITA' ORDINE (es. "2030,0" → 2030)
Se un campo manca usa null.`;
const readOrder = file => ask(file, ORDER_PROMPT, ORDER_SCHEMA);

// ── 2. Packing list / spedizione del fornitore (es. Mondi) ──
const SHIPMENT_SCHEMA = obj({
  fornitore: str, numero_spedizione: str, numero_fattura: str, data_spedizione: str, data_arrivo: str, consegna_presso: str,
  articoli: arr(obj({
    codice_materiale_cliente: str, codice_fornitore: str, descrizione: str, grammatura: int, larghezza_mm: int,
    rotoli: arr(obj({ numero: { type: 'string' }, kg: num })),
  })),
});
const SHIPMENT_PROMPT = `Questo è il packing list di una spedizione di carta in rotoli da un fornitore (es. Mondi).
Estrai:
- fornitore: nome breve del fornitore (es. "Mondi Steti").
- numero_spedizione (Shipment No), numero_fattura (Invoice No), data_spedizione (Dispatched On) e data_arrivo (Planned Arrival Date) in formato GG/MM/AAAA.
- consegna_presso: indirizzo di consegna (Ship-to address) su una riga, es. "Serchio Distribuzione c/o Torello Landi, VIA FERRACCI N.2, PORCARI LU".
- articoli: uno per ogni posizione (Sales Order/Item). Per ognuno:
  - codice_materiale_cliente: "Customer material no." se presente (es. "AHG35H55"), altrimenti null
  - codice_fornitore: codice materiale del fornitore (es. "MB074-035-0550-0900")
  - descrizione: descrizione del materiale su una riga
  - grammatura: gsm come intero (es. 35). larghezza_mm: larghezza in mm (es. 550)
  - rotoli: TUTTI i rotoli della posizione, anche se la tabella continua sulla pagina successiva: numero = Batch No. completo come testo, kg = Gross (kg) come numero (es. "1.209" significa 1209).
Il documento può contenere copie scannerizzate dello stesso packing list e la lettera di vettura CMR: considera ogni rotolo una sola volta.`;
const readShipment = file => ask(file, SHIPMENT_PROMPT, SHIPMENT_SCHEMA, 32000);

// ── 3. Foglio del programma di carico compilato a mano dal magazzino ──
const SHEET_SCHEMA = obj({
  articoli: arr(obj({
    articolo: int,
    righe: arr(obj({ rotolo_scritto: { type: 'string' }, kg: num, rotolo_probabile: str, incerto: { type: 'boolean' } })),
  })),
  note: str,
});
function sheetPrompt(order, candidatesByItem) {
  const items = JSON.parse(order.items);
  const list = items.map((it, i) => {
    const c = candidatesByItem[i] || [];
    return `${i + 1}. ${it.descrizione || it.codice} — ${it.colli ?? '?'} rotoli` +
      (c.length ? `\n   Rotoli in giacenza per questo articolo (numero completo / kg): ${c.map(r => `${r.roll_no}/${r.kg ?? '?'}`).join(', ')}` : '');
  }).join('\n');
  return `Questo è un programma di carico compilato a mano in magazzino per l'ordine n. ${order.n_ordine || ''} (${order.cliente || ''}).
Per ogni articolo il magazzino ha scritto a penna, a coppie, il numero del rotolo (spesso solo le ultime 2-3 cifre) e i kg.

Articoli dell'ordine:
${list}

Restituisci in "articoli" un elemento per ogni articolo che ha righe scritte a mano: "articolo" è il numero (1, 2, ...) dell'elenco sopra, nell'ordine in cui compaiono sul foglio.
Per ogni coppia scritta: rotolo_scritto = esattamente le cifre scritte; kg = numero scritto; rotolo_probabile = il numero completo dall'elenco della giacenza che finisce con quelle cifre (solo se l'elenco è dato e la corrispondenza è chiara, altrimenti null); incerto = true se la calligrafia è ambigua.
Leggi riga per riga, colonna per colonna. Non inventare righe che non sono scritte. In "note" segnala in breve eventuali scritte a mano diverse (firme, totali, correzioni), altrimenti null.`;
}
const readSheet = (file, order, candidatesByItem) => ask(file, sheetPrompt(order, candidatesByItem), SHEET_SCHEMA);

module.exports = { readOrder, readShipment, readSheet, aiReady: () => Boolean(client) };
