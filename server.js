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
              text: `Estrai i dati da questa conferma d'ordine e restituisci SOLO un oggetto JSON valido, senza backtick, senza testo prima o dopo.

Struttura richiesta:
{
  "destinatario": "nome e indirizzo completo del fornitore/destinatario",
  "telefono": "telefono",
  "email": "email",
  "cod_cliente": "codice cliente (campo CODICE nella testata)",
  "n_ordine": "numero ordine",
  "data_ordine": "data ordine in formato GG/MM/AAAA",
  "prodotti": [
    {
      "descrizione": "descrizione prodotto completa su una riga (includi dimensioni come DIAM e FORO se presenti)",
      "gr_mq": numero intero grammi per mq,
      "rot_pallet": numero intero colli/rotoli per pallet
    }
  ]
}

Note importanti:
- rot_pallet = valore nella colonna COLLI del documento
- gr_mq = valore nella colonna GR/MQ
- Includi TUTTI i prodotti (escludi le spese di trasporto)
- Se un campo non è presente usa null`
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
