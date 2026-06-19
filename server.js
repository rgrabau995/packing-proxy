const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.post('/api/convert', async (req, res) => {
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 mancante' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key non configurata' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
            },
            {
              type: 'text',
              text: `Estrai i dati da questa conferma d'ordine Serkios e restituisci SOLO un oggetto JSON valido, senza backtick, senza testo prima o dopo.

Struttura richiesta:
{
  "destinatario_nome": "ragione sociale del destinatario/fornitore che appare in alto a destra sotto 'SPETT.LE', es. FLESSOBAGS S.R.L. oppure CARTIERA LOGUDORO S.R.L.",
  "destinatario_indirizzo": "indirizzo completo del destinatario (riga via/strada + CAP città provincia), es. STRADA TUSCANESE N.46 — 01100 VITERBO VT",
  "telefono": "numero di telefono nella testata",
  "email": "indirizzo email nella testata",
  "cod_cliente": "valore numerico nel campo CODICE in alto a sinistra della tabella testata (es. 447 oppure 218)",
  "n_ordine": "numero ordine dalla testata (campo NUMERO ORDINE)",
  "data_ordine": "data ordine in formato GG/MM/AAAA",
  "modalita_carico": "indica come vengono caricate le merci. Cerca una riga che descriva il tipo di imballo/carico, tipicamente nel formato 'BOBINE SU PALLETS' o simile. Questa riga appare DOPO la riga /S004 SPESE DI TRASPORTO o dopo l'ultimo prodotto. NON prendere righe che parlano di orari, giorni, scarico, vettore, porto, fattura. Se non è presente alcuna indicazione di modalità di carico, restituisci null.",
  "prodotti": [
    {
      "descrizione": "descrizione prodotto completa su una riga (includi dimensioni come DIAM e FORO se presenti)",
      "gr_mq": numero intero grammi per mq,
      "rot_pallet": numero intero colli/rotoli per pallet
    }
  ]
}

Regole importanti:
- destinatario_nome e destinatario_indirizzo: sono le righe che appaiono in alto a destra dopo "SPETT.LE", NON l'intestazione Serkios in alto a sinistra
- rot_pallet = valore nella colonna COLLI (numero intero, es. 2, 4, 8)
- gr_mq = valore nella colonna GR/MQ (numero intero, es. 43, 50)
- Includi TUTTI i prodotti, escludi le spese di trasporto (/S004)
- modalita_carico: SOLO una frase che descrive tipo di imballaggio/carico (es. "BOBINE SU PALLETS"). Ignora: "SCARICO SOLO AL MATTINO", "NON SCARICA IL LUNEDI", "VETTORE", "ADDEBITATO IN FATTURA", "VENDITA PIATTAFORMA", "COME SOPRA", date, totali
- Se un campo non è presente restituisci null`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'Errore API' });

    const text = data.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return res.status(500).json({ error: 'JSON non trovato nella risposta', raw: text });
      parsed = JSON.parse(match[0]);
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.listen(process.env.PORT || 3000, () => console.log('Server avviato'));
