// Programma di carico stampabile (.xlsx): A4 verticale, bianco e nero, una Tabella Excel per articolo.
// ─── XLSX Builder ────────────────────────────────────────────
// Pensato per la stampa: A4 verticale, solo nero e grigio chiaro (stampanti in bianco e nero).
// Ogni articolo è un blocco a sé, sviluppato in verticale: una riga per rotolo.
// Le righe di ogni articolo sono una Tabella Excel: inserendo righe si mantengono bordi e formato,
// e i totali si aggiornano. La colonna "N. Rotolo" è in formato Testo, così gli zeri iniziali restano.
// Un articolo non viene mai spezzato tra due pagine (salvo che da solo non stia in una pagina).
function buildXlsx(d, o = {}) {
  const extra = Number.isFinite(o.extraRows) ? o.extraRows : 2;
  const magazzino = o.magazzino || d.magazzino_partenza || '';
  let prodotti = (d.prodotti || []).filter(p => p && (p.descrizione || p.colli));
  if (!prodotti.length) prodotti = [{ descrizione: '', gr_mq: null, colli: null, quantita_kg: null }];

  // ── Stili (nessun colore) ──
  const fonts = [
    '<font><sz val="10"/><name val="Arial"/></font>',
    '<font><b/><sz val="16"/><name val="Arial"/></font>',
    '<font><b/><sz val="10"/><name val="Arial"/></font>',
    '<font><b/><sz val="11"/><name val="Arial"/></font>',
    '<font><sz val="11"/><name val="Arial"/></font>',
    '<font><sz val="8"/><name val="Arial"/></font>',
    '<font><b/><sz val="12"/><name val="Arial"/></font>',
  ];
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>',
  ];
  const all = st => ['left', 'right', 'top', 'bottom'].map(k => `<${k} style="${st}"><color rgb="FF000000"/></${k}>`).join('');
  const borders = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    `<border>${all('thin')}<diagonal/></border>`,
    `<border>${all('medium')}<diagonal/></border>`,
    '<border><left/><right/><top/><bottom style="medium"><color rgb="FF000000"/></bottom><diagonal/></border>',
  ];
  // I totali a zero restano vuoti: sul foglio stampato si scrivono a mano.
  const numFmts = ['<numFmt numFmtId="164" formatCode="0&quot; rotoli&quot;;-0;&quot;&quot;"/>',
    '<numFmt numFmtId="165" formatCode="General;-General;&quot;&quot;"/>'];
  const xfs = [];
  const X = (font, fill, border, h, { num = 0, wrap = false } = {}) => {
    xfs.push(`<xf numFmtId="${num}" fontId="${font}" fillId="${fill}" borderId="${border}" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${h}" vertical="center"${wrap ? ' wrapText="1"' : ''}/></xf>`);
    return xfs.length - 1;
  };
  const S = {
    def: X(0, 0, 0, 'general'),
    title: X(1, 0, 3, 'left'),
    titleR: X(6, 0, 3, 'right'),
    co: X(5, 0, 0, 'left'),
    lbl: X(2, 3, 1, 'left', { wrap: true }),
    val: X(4, 0, 1, 'left', { wrap: true }),
    valB: X(3, 0, 1, 'left', { wrap: true }),
    art: X(3, 2, 2, 'left', { wrap: true }),
    meta: X(0, 0, 1, 'left'),
    th: X(2, 3, 1, 'center'),
    cTxt: X(4, 0, 1, 'center', { num: 49 }),   // 49 = formato Testo
    cKg: X(4, 0, 1, 'right'),
    cNote: X(4, 0, 1, 'left', { wrap: true }),
    totL: X(2, 0, 2, 'left'),
    totN: X(2, 0, 2, 'center', { num: 164 }),
    totKg: X(2, 0, 2, 'right', { num: 165 }),
    gL: X(3, 2, 2, 'left'),
    gN: X(6, 2, 2, 'center', { num: 164 }),
    gKg: X(6, 2, 2, 'right', { num: 165 }),
    gMeta: X(0, 2, 2, 'left', { wrap: true }),
  };

  // ── Colonne: A N. Rotolo | B KG | C Note  (larghezza totale ≈ 17 cm, sta in A4 al 100%)
  const W = [24, 18, 46];
  const COLS = 'ABC';
  const TOTAL_W = W.reduce((a, b) => a + b, 0);
  const lines = (text, width, k = 0.95) => Math.max(1, Math.ceil(String(text || '').length / Math.max(1, Math.floor(width * k))));

  const rows = [];      // { ht, cells: {colIdx: {s, v, t}} }
  const merges = [];
  const breaks = [];
  const tables = [];
  const PAGE_H = 745;
  const ROW_H = 19;     // riga da compilare (anche a penna)   // punti utili per pagina A4 con questi margini
  let used = 0;

  const addRow = (ht, cells = {}) => { rows.push({ ht, cells }); used += ht; return rows.length; };
  const s = (v, st) => ({ t: 's', v: v == null ? '' : String(v), s: st });
  const n = (v, st) => ({ t: 'n', v, s: st });
  const f = (v, st) => ({ t: 'f', v, s: st });
  const e = st => ({ t: 'e', s: st });
  const rich = (runs, st) => ({ t: 'r', v: runs, s: st }); // testo con parte in grassetto: [[testo, grassetto], ...]
  const merge = (r, c1, c2) => merges.push(`${COLS[c1]}${r}:${COLS[c2]}${r}`);
  const fmtKg = v => (v == null || v === '') ? '' : Number(v).toLocaleString('it-IT', { maximumFractionDigits: 2 });

  // ── Testata ordine
  let r = addRow(26, { 0: s('PROGRAMMA DI CARICO', S.title), 1: e(S.title),
    2: s(d.n_ordine ? `Ordine n. ${d.n_ordine}` : '', S.titleR) });
  merge(r, 0, 1);
  r = addRow(14, { 0: s('Serkios · Serchio Distribuzione S.r.l. — Via Luigi Luciani 22, 00197 Roma · P.IVA IT05147461007', S.co), 1: e(S.co), 2: e(S.co) });
  merge(r, 0, 2);
  addRow(6);

  const wide = (label, value, st = S.val, minH = 18) => {
    const ht = Math.max(minH, lines(value, W[1] + W[2]) * 14 + 4);
    const rr = addRow(ht, { 0: s(label, S.lbl), 1: s(value, st), 2: e(st) });
    merge(rr, 1, 2);
  };
  // Due dati sulla stessa riga: il secondo sta nella colonna C con l'etichetta in grassetto.
  const pair = (l1, v1, l2, v2, st1 = S.val) => {
    const ht = Math.max(18, lines(v1, W[1]) * 14 + 4, lines(`${l2}  ${v2 || ''}`, W[2]) * 14 + 4);
    addRow(ht, { 0: s(l1, S.lbl), 1: s(v1, st1), 2: rich([[l2 + '   ', true], [v2 || '', false]], S.val) });
  };
  wide('Destinatario', d.destinatario_nome, S.valB);
  wide('Indirizzo', d.destinatario_indirizzo);
  pair('Telefono', d.telefono, 'E-mail', d.email);
  pair('N. ordine', d.n_ordine, 'Data ordine', d.data_ordine, S.valB);
  pair('Cod. cliente', d.cod_cliente, 'Modalità carico', d.modalita_carico);
  if (d.note_carico) wide('Note di carico', d.note_carico);
  wide('Magazzino di partenza', magazzino, S.valB, 26);
  addRow(10);

  // ── Un blocco per articolo
  const totRefs = [];
  const nArt = prodotti.length;
  let kgOrdinati = 0, kgNoti = true;
  prodotti.forEach((p, i) => {
    const colli = parseInt(p.colli, 10) || 0;
    const nRows = Math.max(1, colli + extra);
    const titolo = `ARTICOLO ${i + 1} di ${nArt}  —  ${p.codice ? p.codice + '  ·  ' : ''}${p.descrizione || ''}`;
    const titleH = Math.max(20, lines(titolo, TOTAL_W, 0.85) * 15 + 5);
    const blockH = titleH + 15 + 16 + nRows * ROW_H + 18;
    if (used + blockH > PAGE_H && used > 60) { breaks.push(rows.length); used = 0; }

    let rr = addRow(titleH, { 0: s(titolo, S.art), 1: e(S.art), 2: e(S.art) });
    merge(rr, 0, 2);
    const meta = [
      p.gr_mq != null ? `GR/MQ ${p.gr_mq}` : '',
      colli ? `Colli ${colli}` : '',
      p.quantita_kg != null ? `KG ordinati ${fmtKg(p.quantita_kg)}` : '',
    ].filter(Boolean).join('     ·     ');
    if (p.quantita_kg != null) kgOrdinati += Number(p.quantita_kg) || 0; else kgNoti = false;
    rr = addRow(15, { 0: s(meta, S.meta), 1: e(S.meta), 2: e(S.meta) });
    merge(rr, 0, 2);

    const name = `Articolo${i + 1}`;
    const hdr = addRow(16, { 0: s('N. Rotolo', S.th), 1: s('KG', S.th), 2: s('Note', S.th) });
    for (let k = 0; k < nRows; k++) addRow(ROW_H, { 0: e(S.cTxt), 1: e(S.cKg), 2: e(S.cNote) });
    const tot = addRow(18, { 0: f(`SUBTOTAL(103,${name}[N. Rotolo])`, S.totN),
      1: f(`SUBTOTAL(109,${name}[KG])`, S.totKg), 2: s('Totale articolo', S.totL) });
    tables.push({ name, ref: `A${hdr}:C${tot}` });
    totRefs.push(tot);
    addRow(8);
  });

  // ── Totale ordine
  if (used + 26 > PAGE_H) { breaks.push(rows.length); used = 0; }
  const gMeta = kgNoti ? `KG ordinati ${fmtKg(kgOrdinati)}` : '';
  addRow(26, { 0: f(`SUM(${totRefs.map(t => 'A' + t).join(',')})`, S.gN),
    1: f(`SUM(${totRefs.map(t => 'B' + t).join(',')})`, S.gKg), 2: rich([['TOTALE ORDINE', true], [gMeta ? '      ' + gMeta : '', false]], S.gMeta) });

  // ── Firme (come sul foglio di oggi)
  if (used + 72 > PAGE_H) { breaks.push(rows.length); used = 0; }
  addRow(12);
  addRow(32, { 0: s('Preparato da', S.lbl), 1: d.preparato_da ? s(d.preparato_da, S.val) : e(S.val), 2: rich([['Caricato senza riserve da:', true]], S.val) });
  addRow(28, { 0: s('Data', S.lbl), 1: d.data_carico ? s(d.data_carico, S.val) : e(S.val), 2: rich([['Firma:', true]], S.val) });

  // ── Stringhe condivise
  const sst = [], sstIdx = new Map();
  const si = v => { const k = typeof v === 'string' ? v : 'R:' + JSON.stringify(v); if (!sstIdx.has(k)) { sstIdx.set(k, sst.length); sst.push(v); } return sstIdx.get(k); };
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let sheetRows = '';
  rows.forEach((row, ri) => {
    const rn = ri + 1;
    let x = `<row r="${rn}" ht="${row.ht}" customHeight="1">`;
    for (let c = 0; c < W.length; c++) {
      const cell = row.cells[c];
      if (!cell) continue;
      const ref = COLS[c] + rn;
      if (cell.t === 'r') x += `<c r="${ref}" s="${cell.s}" t="s"><v>${si(cell.v)}</v></c>`;
      else if (cell.t === 's' && cell.v !== '') x += `<c r="${ref}" s="${cell.s}" t="s"><v>${si(cell.v)}</v></c>`;
      else if (cell.t === 'n') x += `<c r="${ref}" s="${cell.s}"><v>${cell.v}</v></c>`;
      else if (cell.t === 'f') x += `<c r="${ref}" s="${cell.s}"><f>${esc(cell.v)}</f></c>`;
      else x += `<c r="${ref}" s="${cell.s}"/>`;
    }
    sheetRows += x + '</row>';
  });

  const footer = `&L&8Programma di carico — Ordine n. ${(d.n_ordine || '').replace(/&/g, '&&')} — ${(d.destinatario_nome || '').replace(/&/g, '&&')}&R&8Pagina &P di &N`;
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}>`

    + `<sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + `<cols>${W.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${sheetRows}</sheetData>`
    + `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    + `<printOptions horizontalCentered="1"/>`
    + `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.2" footer="0.25"/>`
    + `<pageSetup paperSize="9" orientation="portrait" scale="100"/>`
    + `<headerFooter><oddFooter>${esc(footer)}</oddFooter></headerFooter>`
    + (breaks.length ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map(b => `<brk id="${b}" max="16383" man="1"/>`).join('')}</rowBreaks>` : '')
    + `<ignoredErrors><ignoredError sqref="A1:A${rows.length + 500}" numberStoredAsText="1"/></ignoredErrors>`
    + `<tableParts count="${tables.length}">${tables.map((_, i) => `<tablePart r:id="rId${i + 1}"/>`).join('')}</tableParts>`
    + `</worksheet>`;

  const tableXml = (t, i) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${i + 1}" name="${t.name}" displayName="${t.name}" ref="${t.ref}" totalsRowCount="1">`
    + `<tableColumns count="3">`
    + `<tableColumn id="1" name="N. Rotolo" totalsRowFunction="count"/>`
    + `<tableColumn id="2" name="KG" totalsRowFunction="sum"/>`
    + `<tableColumn id="3" name="Note" totalsRowLabel="Totale articolo"/>`
    + `</tableColumns><tableStyleInfo name="TableStyleLight1" showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/></table>`;

  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map(v => typeof v === 'string' ? `<si><t xml:space="preserve">${esc(v)}</t></si>`
    : `<si>${v.filter(([t]) => t).map(([t, b]) => `<r><rPr>${b ? '<b/>' : ''}<sz val="${b ? 10 : 11}"/><rFont val="Arial"/></rPr><t xml:space="preserve">${esc(t)}</t></r>`).join('')}</si>`).join('')}</sst>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>`
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>`
    + `<borders count="${borders.length}">${borders.join('')}</borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><sheets><sheet name="Programma di Carico" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = items => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
  const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const ctXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>`
    + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/>`
    + `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/>`
    + tables.map((_, i) => `<Override PartName="/xl/tables/table${i + 1}.xml" ContentType="${CT}.table+xml"/>`).join('')
    + `</Types>`;

  const files = {
    '[Content_Types].xml': ctXml,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': wbXml,
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'styles', 'styles.xml'], ['rId3', 'sharedStrings', 'sharedStrings.xml']]),
    'xl/styles.xml': stylesXml,
    'xl/sharedStrings.xml': sstXml,
    'xl/worksheets/sheet1.xml': sheetXml,
    'xl/worksheets/_rels/sheet1.xml.rels': rels(tables.map((_, i) => [`rId${i + 1}`, 'table', `../tables/table${i + 1}.xml`])),
  };
  tables.forEach((t, i) => { files[`xl/tables/table${i + 1}.xml`] = tableXml(t, i); });
  return zipBlob(files);
}

function zipBlob(files){
  const enc=new TextEncoder(),parts=[],cd=[];let off=0;
  for(const[name,content]of Object.entries(files)){
    const nb=enc.encode(name),db=enc.encode(content),crc=crc32(db);
    const lh=localHeader(nb,db,crc);
    parts.push(lh,db);cd.push(centralHeader(nb,db,crc,off));off+=lh.length+db.length;
  }
  const cdBytes=concat(cd),eocd=endRecord(Object.keys(files).length,cdBytes.length,off);
  return new Blob([concat(parts),cdBytes,eocd],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
function localHeader(n,d,crc){const b=new ArrayBuffer(30+n.length),v=new DataView(b);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,crc,true);v.setUint32(18,d.length,true);v.setUint32(22,d.length,true);v.setUint16(26,n.length,true);new Uint8Array(b).set(n,30);return new Uint8Array(b);}
function centralHeader(n,d,crc,off){const b=new ArrayBuffer(46+n.length),v=new DataView(b);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint32(16,crc,true);v.setUint32(20,d.length,true);v.setUint32(24,d.length,true);v.setUint16(28,n.length,true);v.setUint32(42,off,true);new Uint8Array(b).set(n,46);return new Uint8Array(b);}
function endRecord(cnt,sz,off){const b=new ArrayBuffer(22),v=new DataView(b);v.setUint32(0,0x06054b50,true);v.setUint16(8,cnt,true);v.setUint16(10,cnt,true);v.setUint32(12,sz,true);v.setUint32(16,off,true);return new Uint8Array(b);}
function concat(a){const t=a.reduce((s,x)=>s+x.length,0),o=new Uint8Array(t);let p=0;for(const x of a){o.set(x,p);p+=x.length;}return o;}
function crc32(b){let c=0xFFFFFFFF;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xEDB88320:0);}return(c^0xFFFFFFFF)>>>0;}
