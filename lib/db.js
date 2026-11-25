// Database del portale (SQLite integrato in Node). Su Railway il file sta nel volume montato in DATA_DIR.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'portale.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Prodotti a magazzino, con il codice articolo Serkios (es. KBSSR35ADH55).
CREATE TABLE IF NOT EXISTS products (
  code TEXT PRIMARY KEY,
  title TEXT,            -- es. "K.BIANCO  MONDI - SCP GR.35"
  height TEXT,           -- es. "h.cm. 55"
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Codice materiale del fornitore → codice Serkios (es. Mondi AHG35H55 → KBSSR35ADH55).
CREATE TABLE IF NOT EXISTS supplier_map (
  supplier_code TEXT PRIMARY KEY,
  product_code TEXT NOT NULL REFERENCES products(code)
);

-- Spedizioni / packing list fornitore caricate (aumentano la giacenza).
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY,
  supplier TEXT, number TEXT, invoice TEXT, date TEXT, warehouse TEXT,
  file TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now'))
);

-- Un rotolo. status: 'stock' (in giacenza) o 'out' (uscito con un DDT).
CREATE TABLE IF NOT EXISTS rolls (
  id INTEGER PRIMARY KEY,
  roll_no TEXT NOT NULL,
  product_code TEXT NOT NULL REFERENCES products(code),
  kg REAL,
  arrival_date TEXT,      -- AAAA-MM-GG
  shipment_id INTEGER REFERENCES shipments(id),
  status TEXT NOT NULL DEFAULT 'stock',
  out_label TEXT,         -- es. "F.P.C. di Trudu Marcello Ddt 769"
  out_date TEXT,
  order_id INTEGER,
  seq INTEGER,            -- ordine delle righe nello storico uscite
  source TEXT,            -- 'spedizione', 'excel', 'manuale'
  UNIQUE (product_code, roll_no)
);
CREATE INDEX IF NOT EXISTS rolls_no ON rolls(roll_no);

-- Ordine cliente (da conferma d'ordine). status: da_preparare → preparato → chiuso.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  n_ordine TEXT, data_ordine TEXT, cliente TEXT, indirizzo TEXT, localita TEXT,
  telefono TEXT, email TEXT, cod_cliente TEXT, modalita_carico TEXT, note_carico TEXT,
  magazzino TEXT,
  items TEXT NOT NULL,    -- JSON: [{codice, descrizione, gr_mq, colli, quantita_kg}]
  status TEXT NOT NULL DEFAULT 'da_preparare',
  file TEXT, scan_file TEXT,
  prepared_by TEXT, prepared_at TEXT,
  ddt TEXT, closed_by TEXT, closed_at TEXT,
  created_by TEXT, created_at TEXT DEFAULT (datetime('now'))
);

-- Rotoli caricati su un ordine, come li ha scritti il magazzino.
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item INTEGER NOT NULL,  -- indice dell'articolo in orders.items
  pos INTEGER NOT NULL,
  pallet TEXT, roll_input TEXT, kg_input REAL, note TEXT,
  roll_id INTEGER REFERENCES rolls(id)  -- rotolo riconosciuto (fissato alla chiusura)
);
`);

// Aggiunte successive allo schema.
for (const sql of [
  "ALTER TABLE orders ADD COLUMN prepared_date TEXT",
  // Catalogo dalla Lista Giacenze: caratteristiche e giacenza in kg per codice interno.
  "ALTER TABLE products ADD COLUMN family TEXT",      // es. 'K Kraft Bianco'
  "ALTER TABLE products ADD COLUMN ptype TEXT",       // es. 'MG Kraft Millerighe'
  "ALTER TABLE products ADD COLUMN supplier TEXT",
  "ALTER TABLE products ADD COLUMN gsm REAL",
  "ALTER TABLE products ADD COLUMN width_mm REAL",
  "ALTER TABLE products ADD COLUMN diam_mm REAL",
  "ALTER TABLE products ADD COLUMN stock_kg REAL",
  "ALTER TABLE products ADD COLUMN notes TEXT",
  "ALTER TABLE products ADD COLUMN in_list INTEGER DEFAULT 0",
  "ALTER TABLE supplier_map ADD COLUMN created_at TEXT",
]) { try { db.exec(sql); } catch (_) { /* già presente */ } }

db.exec(`
-- Merce in arrivo dai fornitori (kg per codice interno, con data di consegna).
CREATE TABLE IF NOT EXISTS arrivals (
  id INTEGER PRIMARY KEY,
  product_code TEXT NOT NULL,
  kg REAL NOT NULL,
  date TEXT,                -- consegna prevista AAAA-MM-GG
  date_to TEXT,             -- fine finestra di consegna, se data
  our_order TEXT,           -- nostro n. ordine a fornitore (es. 319)
  supplier TEXT,
  supplier_conf TEXT,       -- n. conferma del fornitore
  supplier_code TEXT,       -- codice dell'articolo sul documento del fornitore
  description TEXT,
  source TEXT,              -- 'excel' (Lista Giacenze) o 'documento'
  status TEXT NOT NULL DEFAULT 'in_arrivo',  -- 'in_arrivo' | 'arrivato'
  file TEXT,
  arrived_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
-- Partenze / ordini clienti dalla Lista Giacenze (kg per codice e cliente).
CREATE TABLE IF NOT EXISTS outgoing (
  id INTEGER PRIMARY KEY,
  product_code TEXT NOT NULL,
  kg REAL NOT NULL,
  customer TEXT,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const tx = fn => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

module.exports = { db, tx, DATA_DIR };
