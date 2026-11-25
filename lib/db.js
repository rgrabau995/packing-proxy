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

const tx = fn => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

module.exports = { db, tx, DATA_DIR };
