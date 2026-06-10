# Packing List PDF → Excel

Tool per convertire i programmi di carico Serchio Distribuzione SRL da PDF a Excel.

## Struttura

```
packing-proxy/
├── server.js      ← proxy Node.js (nasconde la API key)
├── index.html     ← interfaccia utente (va hostato separatamente)
├── package.json
└── railway.toml
```

---

## Deploy in 5 minuti su Railway

### 1. Crea un repo GitHub

```bash
cd packing-proxy
git init
git add .
git commit -m "init"
# crea repo su github.com e fai push
git remote add origin https://github.com/TUO-USERNAME/packing-proxy.git
git push -u origin main
```

### 2. Deploy su Railway

1. Vai su **railway.app** → "New Project" → "Deploy from GitHub repo"
2. Seleziona il repo `packing-proxy`
3. Railway rileva Node.js automaticamente

### 3. Aggiungi la variabile d'ambiente

In Railway → il tuo progetto → **Variables** → aggiungi:

```
ANTHROPIC_API_KEY = sk-ant-...la tua chiave...
```

### 4. Ottieni l'URL pubblico

In Railway → Settings → **Domains** → "Generate Domain"
Otterrai qualcosa come: `https://packing-proxy-production.up.railway.app`

---

## Configura il frontend

Apri `index.html` e alla riga:

```js
const PROXY_URL = 'YOUR_PROXY_URL/api/convert';
```

Sostituisci con il tuo URL Railway:

```js
const PROXY_URL = 'https://packing-proxy-production.up.railway.app/api/convert';
```

---

## Host del frontend

Opzione più semplice — **GitHub Pages** (gratis):

1. Metti `index.html` in un repo GitHub (può essere lo stesso)
2. Repository Settings → Pages → Source: "Deploy from branch main"
3. Il tool sarà disponibile su `https://TUO-USERNAME.github.io/packing-proxy`

Oppure trascina `index.html` su **Netlify Drop** (netlify.com/drop) per avere un URL in 30 secondi.

---

## Costo stimato

- Railway free tier: **500 ore/mese gratis** (più che sufficiente)
- Anthropic API: ~**$0.01–0.03 per conversione** (Sonnet 4)
