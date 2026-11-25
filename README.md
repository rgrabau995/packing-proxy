# Portale Programma di Carico — Serchio Distribuzione / Serkios

Portale web (Railway) che sostituisce il giro di fogli tra ufficio e magazzino.

## Flusso

1. **Ufficio** (Angela) carica la conferma d'ordine in PDF → l'AI legge cliente, articoli (con codice), colli e kg → l'ordine è subito visibile al magazzino.
2. **Magazzino** (Daniele) apre l'ordine:
   - scarica il foglio da stampare (A4 verticale, bianco e nero), oppure
   - inserisce i rotoli online (bastano le ultime cifre: "726" → 1626070726), oppure
   - carica la foto / scansione del foglio compilato a penna: rotoli e kg vengono letti e messi nel form da controllare.
   Poi "Invia all'ufficio".
3. **Controllo automatico** contro la giacenza caricata dai packing list del fornitore (es. Mondi): rotolo esistente, prodotto giusto, non già uscito, kg uguali (±2 kg), non doppio, n. rotoli = colli. Se una cifra è letta male propone i rotoli in giacenza che differiscono di una cifra.
4. **Ufficio** chiude con nome cliente e n. DDT → i rotoli escono dalla giacenza e finiscono nello storico del registro.
5. **Registro Excel** per prodotto (es. `KBSSR35ADH55.xlsx`) scaricabile nello stesso formato di oggi: giacenza in alto, riga Totale, storico uscite per cliente/DDT.

## Magazzino

- *Importa registro Excel*: carica gli Excel attuali (nome file = codice articolo). Sostituisce giacenza e storico di quel prodotto.
- *Arrivo merce*: packing list PDF del fornitore → rotoli (Batch No.) e kg in giacenza. Il codice fornitore (es. Mondi AHG35H55) viene abbinato al codice Serkios e ricordato.

## Variabili su Railway

| Variabile | A cosa serve |
|---|---|
| `ANTHROPIC_API_KEY` | lettura PDF e foto |
| `UFFICIO_CODE` (o `ACCESS_CODE`) | codice di accesso dell'ufficio |
| `MAGAZZINO_CODE` | codice di accesso del magazzino |
| `SESSION_SECRET` | facoltativa, firma dei login |

Serve un **Volume** Railway montato (es. `/data`): lì stanno il database SQLite (`portale.db`) e i file caricati. Senza volume i dati si perdono a ogni deploy.

## Struttura

```
server.js          API e login
lib/db.js          database (SQLite integrato in Node ≥ 24)
lib/ai.js          letture con Claude: conferma, packing list fornitore, foglio a mano
lib/match.js       riconoscimento rotoli e controlli
lib/register.js    import/export registro Excel
public/index.html  portale (ufficio e magazzino, anche da telefono)
public/packing.js  foglio di carico stampabile (.xlsx)
```

In locale senza codici impostati: codice `magazzino` = magazzino, qualsiasi altro = ufficio.
