const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 16000;
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// Schema JSON: la risposta del modello è sempre valida e completa.
const str = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const int = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });

const SCHEMA = obj({
  destinatario_nome: str,
  destinatario_indirizzo: str,
  telefono: str,
  email: str,
  cod_cliente: str,
  n_ordine: str,
  data_ordine: str,
  modalita_carico: str,
  prodotti: {
    type: 'array',
    items: obj({ descrizione: str, gr_mq: int, rot_pallet: int }),
  },
});

const PROMPT = `Estrai i dati da questa conferma d'ordine Serkios.

Campi:
- destinatario_nome: ragione sociale del destinatario/fornitore che appare in alto a destra sotto "SPETT.LE" (es. FLESSOBAGS S.R.L. oppure CARTIERA LOGUDORO S.R.L.). NON l'intestazione Serkios in alto a sinistra.
- destinatario_indirizzo: indirizzo completo del destinatario (via/strada + CAP città provincia), es. "STRADA TUSCANESE N.46 — 01100 VITERBO VT".
- telefono, email: dalla testata.
- cod_cliente: valore nel campo CODICE in alto a sinistra della tabella testata (es. "447" oppure "218").
- n_ordine: campo NUMERO ORDINE della testata.
- data_ordine: data ordine in formato GG/MM/AAAA.
- modalita_carico: SOLO una frase che descrive il tipo di imballo/carico, tipicamente "BOBINE SU PALLETS" o simile; di solito appare dopo la riga /S004 SPESE DI TRASPORTO o dopo l'ultimo prodotto. Ignora righe su orari, giorni, scarico, vettore, porto, fattura ("SCARICO SOLO AL MATTINO", "NON SCARICA IL LUNEDI", "VETTORE", "ADDEBITATO IN FATTURA", "VENDITA PIATTAFORMA", "COME SOPRA", date, totali). Se assente: null.
- prodotti: TUTTI i prodotti, escluse le spese di trasporto (/S004). Per ognuno:
  - descrizione: descrizione completa su una riga (includi dimensioni come DIAM e FORO se presenti)
  - gr_mq: valore intero della colonna GR/MQ (es. 43, 50)
  - rot_pallet: valore intero della colonna COLLI (es. 2, 4, 8)

Se un campo non è presente usa null.`;

function sameCode(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function describeError(e) {
  if (e instanceof Anthropic.RateLimitError) return 'troppe richieste in poco tempo, riprova tra un minuto';
  if (e instanceof Anthropic.AuthenticationError) return 'chiave API Anthropic non valida (controllare ANTHROPIC_API_KEY su Railway)';
  if (e instanceof Anthropic.BadRequestError) return 'PDF non leggibile o troppo grande (' + e.message + ')';
  if (e instanceof Anthropic.APIError) return 'servizio AI non disponibile (' + (e.status || 'rete') + '), riprova';
  return e.message;
}

app.post('/api/convert', async (req, res) => {
  if (!client) return res.status(500).json({ error: 'Configurazione mancante: impostare ANTHROPIC_API_KEY su Railway.' });
  // Senza ACCESS_CODE il servizio resta chiuso: nessuno può usarlo a vostre spese.
  if (!process.env.ACCESS_CODE) return res.status(500).json({ error: 'Configurazione mancante: impostare ACCESS_CODE su Railway.' });
  const { pdfBase64, code } = req.body || {};
  if (!code || !sameCode(code, process.env.ACCESS_CODE)) return res.status(401).json({ error: 'Codice di accesso errato.' });
  if (!pdfBase64 || typeof pdfBase64 !== 'string') return res.status(400).json({ error: 'Nessun PDF ricevuto.' });

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      // Se il modello rifiuta per errore un documento, la richiesta viene ripetuta su un modello di riserva.
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('il modello non ha potuto elaborare questo documento');
    if (msg.stop_reason === 'max_tokens') throw new Error('documento troppo lungo: la risposta è stata troncata');
    const txt = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
    res.json(JSON.parse(txt));
  } catch (e) {
    console.error('Estrazione non riuscita:', e);
    res.status(422).json({ error: 'Estrazione non riuscita: ' + describeError(e) });
  }
});

// Pagina del tool: servita direttamente da Railway (non serve più GitHub Pages)
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log('Server avviato'));
}

module.exports = { app };
