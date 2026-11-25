// Kassenbon auswerten: aus dem erkannten Text (Texterkennung auf dem Handy) Betrag, Geschäft und Datum heraussuchen.
// Die Werte sind nur ein Vorschlag – die Person prüft sie im Formular und bestätigt mit „Speichern“.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HaushaltReceipt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // bekannte Geschäfte: Suchmuster -> Name und passende Kategorie
  const SHOPS = [
    [/\blidl\b/i, 'Lidl', 'Einkaufen & Lebensmittel'],
    [/\baldi\b/i, 'Aldi', 'Einkaufen & Lebensmittel'],
    [/\brewe\b/i, 'Rewe', 'Einkaufen & Lebensmittel'],
    [/\bedeka\b/i, 'Edeka', 'Einkaufen & Lebensmittel'],
    [/\bkaufland\b/i, 'Kaufland', 'Einkaufen & Lebensmittel'],
    // „Netto“ als Geschäft – nicht die Netto-Spalte der Steuerübersicht
    [/(?<!(mwst|steuer|ust|satz)[\s.:-]*)\bnetto\b(?![\s.:-]*(betrag|summe|umsatz|brutto|\d))/i, 'Netto', 'Einkaufen & Lebensmittel'],
    [/\bpenny\b/i, 'Penny', 'Einkaufen & Lebensmittel'],
    [/\bnorma\b/i, 'Norma', 'Einkaufen & Lebensmittel'],
    [/\bglobus\b/i, 'Globus', 'Einkaufen & Lebensmittel'],
    [/\bmarktkauf\b/i, 'Marktkauf', 'Einkaufen & Lebensmittel'],
    [/\bhit\s+markt\b/i, 'HIT', 'Einkaufen & Lebensmittel'],
    [/\b(tegut)\b/i, 'tegut', 'Einkaufen & Lebensmittel'],
    [/\bdm[\s-]*drogerie|\bdm\b/i, 'dm', 'Drogerie & Haushalt'],
    [/\brossmann\b/i, 'Rossmann', 'Drogerie & Haushalt'],
    [/\bm[üu]ller\b.*(drogerie|markt)|drogerie\s+m[üu]ller/i, 'Müller', 'Drogerie & Haushalt'],
    [/\baction\b/i, 'Action', 'Drogerie & Haushalt'],
    [/\btedi\b/i, 'TEDi', 'Drogerie & Haushalt'],
    [/\bikea\b/i, 'IKEA', 'Haus & Wohnen'],
    [/\b(obi)\b/i, 'OBI', 'Haus & Wohnen'],
    [/\bbauhaus\b/i, 'Bauhaus', 'Haus & Wohnen'],
    [/\bhornbach\b/i, 'Hornbach', 'Haus & Wohnen'],
    [/\btoom\b/i, 'toom', 'Haus & Wohnen'],
    [/\bhagebau/i, 'hagebau', 'Haus & Wohnen'],
    [/\baral\b/i, 'Aral', 'Auto & Verschleiß'],
    [/\bshell\b/i, 'Shell', 'Auto & Verschleiß'],
    [/\besso\b/i, 'Esso', 'Auto & Verschleiß'],
    [/\bjet\b/i, 'JET', 'Auto & Verschleiß'],
    [/\btotal\s*energies\b/i, 'TotalEnergies', 'Auto & Verschleiß'],
    [/\b(avia|agip|eni|star|hem|orlen)\s+tank/i, 'Tankstelle', 'Auto & Verschleiß'],
    [/\b(tankstelle|super\s*e10|super\s*e5|diesel)\b/i, 'Tankstelle', 'Auto & Verschleiß'],
    [/\bapotheke\b/i, 'Apotheke', 'Gesundheit'],
    [/mc\s*donald/i, "McDonald's", 'Essen gehen & Lieferdienste'],
    [/burger\s*king/i, 'Burger King', 'Essen gehen & Lieferdienste'],
    [/\b(b[äa]ckerei|backhaus|baeckerei)\b/i, 'Bäckerei', 'Einkaufen & Lebensmittel'],
    [/\bh\s*&\s*m\b|hennes/i, 'H&M', 'Kleidung & Shopping'],
    [/\bprimark\b/i, 'Primark', 'Kleidung & Shopping'],
    [/\bkik\b/i, 'KiK', 'Kleidung & Shopping'],
    [/\bdeichmann\b/i, 'Deichmann', 'Kleidung & Shopping'],
    [/\bc\s*&\s*a\b/i, 'C&A', 'Kleidung & Shopping'],
    [/media\s*markt/i, 'MediaMarkt', 'Sonstiges'],
    // häufige Rechnungen / Online-Händler
    [/\bamazon\b/i, 'Amazon', 'Sonstiges'],
    [/\bzalando\b/i, 'Zalando', 'Kleidung & Shopping'],
    [/\botto\s*(gmbh|\.de|versand)/i, 'OTTO', 'Sonstiges'],
    [/\bebay\b/i, 'eBay', 'Sonstiges'],
    [/\btelekom\b/i, 'Telekom', 'Handy, Internet & Abos'],
    [/\bvodafone\b/i, 'Vodafone', 'Handy, Internet & Abos'],
    [/\bo2\b|telef[oó]nica/i, 'O2', 'Handy, Internet & Abos'],
    [/\bnetflix\b/i, 'Netflix', 'Handy, Internet & Abos'],
    [/\bspotify\b/i, 'Spotify', 'Handy, Internet & Abos'],
    [/stadtwerke|\be\.?on\b|vattenfall|\benbw\b|\brwe\b/i, 'Energieversorger', 'Nebenkosten & Energie'],
    [/\bsaturn\b/i, 'Saturn', 'Sonstiges'],
  ];

  // Zeilen mit dem zu zahlenden Betrag (nach Wichtigkeit) und Zeilen, die NICHT der Endbetrag sind
  const TOTAL_WORDS = [
    /zu\s*zahlen/i, /gesamt\s*betrag|gesamtsumme|endbetrag|rechnungsbetrag|endsumme|zahlbetrag|summe\s*brutto|bruttobetrag/i,
    /\bsumme\b|\bsumme\s*eur/i, /\bgesamt\b/i,
    /\btotal\b/i, /\bbetrag\b/i, /\b(ec[\s-]*karte|kartenzahlung|girocard|visa|mastercard|bar)\b/i,
  ];
  const NOT_TOTAL_RE = /(mwst|ust\b|steuer|netto|brutto\s*netto|r[üu]ckgeld|gegeben|wechselgeld|rabatt|ersparnis|gespart|pfand|punkte|zwischensumme)/i;
  // „Gesamtbetrag inkl. MwSt.“ ist der Endbetrag einer Rechnung – „inkl./zzgl. MwSt.“ allein macht keine Steuerzeile
  const NOT_TOTAL = { test: (l) => NOT_TOTAL_RE.test(l.replace(/(inkl|incl|einschl|zzgl)\.?\s*(\d+\s*%\s*)?(der\s*)?(gesetzl\.?\s*)?(mwst|ust|ust\.|umsatzsteuer|mehrwertsteuer)\.?/gi, '')) };

  // Beträge in einer Zeile: 12,99  1.234,50  12.99  (nicht Datum/Uhrzeit)
  const AMOUNT_RE = /(?<![\d.,])(\d{1,3}(?:[.\s]\d{3})*|\d+)[.,](\d{2})(?![\d.,]|\s*%)/g;
  function amountsIn(line) {
    const out = [];
    const clean = line.replace(/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/g, ' ').replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');
    for (const m of clean.matchAll(AMOUNT_RE)) {
      const n = Number(m[1].replace(/[.\s]/g, '') + '.' + m[2]);
      if (n > 0 && n < 100000) out.push(n);
    }
    return out;
  }

  function findAmount(lines) {
    for (const word of TOTAL_WORDS) {
      for (let i = 0; i < lines.length; i++) {
        if (!word.test(lines[i]) || NOT_TOTAL.test(lines[i])) continue;
        // Betrag steht in derselben Zeile oder (bei schmalen Bons) in der nächsten
        const here = amountsIn(lines[i]);
        if (here.length) return here[here.length - 1];
        const next = lines[i + 1] ? amountsIn(lines[i + 1]) : [];
        if (next.length && !NOT_TOTAL.test(lines[i + 1])) return next[next.length - 1];
      }
    }
    // kein Schlüsselwort erkannt: größter Betrag außerhalb von Steuer-/Rückgeld-Zeilen
    const all = lines.filter((l) => !NOT_TOTAL.test(l)).flatMap(amountsIn);
    return all.length ? Math.max(...all) : null;
  }

  function findDate(text, today) {
    const max = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s?[.\/-]\s?(\d{1,2})\s?[.\/-]\s?(\d{4}|\d{2})(?!\d)/g)) {
      const d = Number(m[1]), mo = Number(m[2]);
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      const date = new Date(y, mo - 1, d);
      if (date.getDate() !== d || date.getMonth() !== mo - 1) continue; // ungültiges Datum
      if (date > max || y < today.getFullYear() - 2) continue;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }

  function findShop(lines) {
    // zuerst im Kopf des Bons suchen, dann im ganzen Text
    for (const part of [lines.slice(0, 8), lines]) {
      const text = part.join('\n');
      for (const [re, name, category] of SHOPS) if (re.test(text)) return { shop: name, category };
    }
    // sonst die erste Zeile mit genug Buchstaben als Vorschlag
    const first = lines.slice(0, 5).find((l) => (l.match(/[a-zäöüß]/gi) || []).length >= 4 && !/\d{3,}/.test(l));
    return first ? { shop: first.replace(/[^\p{L}\p{N}&' .-]/gu, '').trim().slice(0, 40), category: null } : { shop: '', category: null };
  }

  // text: erkannter Text; today: für die Plausibilitätsprüfung des Datums
  function parseReceipt(text, today = new Date()) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const { shop, category } = findShop(lines);
    return { amount: findAmount(lines), date: findDate(lines.join('\n'), today), shop, category };
  }

  // ---------- Kategorie aus freiem Text erkennen („Auto heile machen“ -> Auto & Verschleiß) ----------
  // Einfache Wort-Erkennung auf dem Gerät: Stichwörter (auch als Teil zusammengesetzter Wörter) zählen nach ihrer Länge,
  // die Kategorie mit der höchsten Summe gewinnt. Kurze Stichwörter (≤ 3 Zeichen) nur als ganzes Wort.
  const KEYWORDS = {
    'Auto & Verschleiß': ['auto', 'kfz', 'pkw', 'wagen', 'werkstatt', 'reifen', 'felge', 'tüv', 'tuev', 'hu au', 'inspektion',
      'ölwechsel', 'oelwechsel', 'öl', 'tank', 'benzin', 'diesel', 'sprit', 'super e10', 'e10', 'waschanlage', 'autowäsche',
      'parken', 'parkhaus', 'parkschein', 'maut', 'vignette', 'bremse', 'batterie', 'auspuff', 'scheibenwischer', 'wischwasser',
      'zündkerze', 'kupplung', 'getriebe', 'lackier', 'delle', 'unfall', 'abschlepp', 'pannenhilfe', 'adac', 'atu', 'carglass',
      'motor', 'karosserie', 'stoßdämpfer', 'zahnriemen', 'klimaservice', 'scheinwerfer', 'aral', 'shell', 'esso'],
    'Einkaufen & Lebensmittel': ['einkauf', 'lebensmittel', 'supermarkt', 'wocheneinkauf', 'lidl', 'aldi', 'rewe', 'edeka', 'kaufland',
      'netto', 'penny', 'norma', 'bäcker', 'baecker', 'brot', 'brötchen', 'metzger', 'fleisch', 'obst', 'gemüse', 'milch',
      'getränke', 'wasserkasten', 'markt', 'türkischer laden', 'halal', 'laden', 'ladenausgabe', 'lebensmittel',
      // häufige Waren, damit auch einzelne Posten erkannt werden („Mayonnaise“, „Ketchup“)
      'mayonnaise', 'mayo', 'ketchup', 'senf', 'butter', 'margarine', 'käse', 'kaese', 'joghurt', 'quark', 'sahne', 'eier',
      'mehl', 'zucker', 'salz', 'pfeffer', 'gewürz', 'nudeln', 'spaghetti', 'reis', 'bulgur', 'linsen', 'bohnen', 'kichererbsen',
      'tomate', 'kartoffel', 'zwiebel', 'knoblauch', 'paprika', 'gurke', 'salat', 'möhre', 'karotte', 'apfel', 'äpfel', 'banane',
      'orange', 'zitrone', 'trauben', 'erdbeere', 'wurst', 'salami', 'sucuk', 'hähnchen', 'haehnchen', 'hackfleisch', 'rind',
      'lamm', 'fisch', 'thunfisch', 'konserve', 'tiefkühl', 'pizza tiefkühl', 'müsli', 'cornflakes', 'haferflocken', 'honig',
      'marmelade', 'nutella', 'schokolade', 'kekse', 'chips', 'süßigkeiten', 'snacks', 'kaffee pad', 'tee', 'saft', 'cola',
      'limonade', 'mineralwasser', 'sprudel', 'ayran', 'oliven', 'olivenöl', 'sonnenblumenöl', 'essig', 'brühe', 'soße', 'sosse',
      'toast', 'baguette', 'simit', 'börek', 'pide', 'fladenbrot', 'lavash', 'babynahrung'],
    'Drogerie & Haushalt': ['drogerie', 'dm', 'rossmann', 'müller', 'putzmittel', 'waschmittel', 'spülmittel', 'klopapier',
      'toilettenpapier', 'shampoo', 'zahnpasta', 'haushaltswaren', 'staubsauger', 'action', 'tedi'],
    'Essen gehen & Lieferdienste': ['restaurant', 'essen gehen', 'essen bestellt', 'lieferando', 'wolt', 'uber eats', 'döner', 'doener',
      'pizza', 'burger', 'mcdonald', 'kfc', 'imbiss', 'café', 'cafe', 'kaffee', 'eis essen', 'eisdiele', 'frühstück', 'sushi', 'lahmacun'],
    'Freizeit': ['kino', 'bowling', 'freizeit', 'ausflug', 'freizeitpark', 'schwimmbad', 'therme', 'konzert', 'theater', 'museum',
      'zoo', 'fitness', 'gym', 'sport', 'verein', 'spiel', 'playstation', 'netflix kino', 'minigolf', 'kletter', 'trampolin',
      'escape room', 'hobby', 'lifestyle', 'tickets', 'veranstaltung', 'fußball'],
    'Kleidung & Shopping': ['kleidung', 'klamotten', 'jacke', 'hose', 'schuhe', 'pullover', 'shirt', 'kleid', 'mantel', 'zalando',
      'h&m', 'primark', 'vinted', 'deichmann', 'shopping', 'tasche', 'socken', 'unterwäsche'],
    'Gesundheit': ['arzt', 'ärztin', 'zahnarzt', 'apotheke', 'medikament', 'tabletten', 'rezept', 'brille', 'kontaktlinsen',
      'physio', 'krankengymnastik', 'krankenhaus', 'praxisgebühr', 'zuzahlung', 'hörgerät', 'optiker'],
    'Kinder': ['kind', 'baby', 'windeln', 'kita', 'kindergarten', 'schule', 'schulsachen', 'spielzeug', 'nachhilfe',
      'schulranzen', 'babynahrung', 'kinderwagen', 'klassenfahrt', 'taschengeld'],
    'Geschenke': ['geschenk', 'geburtstag', 'hochzeit', 'mitbringsel', 'blumen', 'gutschein'],
    'Haus & Wohnen': ['miete', 'möbel', 'moebel', 'ikea', 'baumarkt', 'obi', 'bauhaus', 'hornbach', 'renovier', 'handwerker',
      'heizung', 'garten', 'pflanzen', 'werkzeug', 'lampe', 'teppich', 'küche', 'badezimmer', 'reparatur wohnung', 'farbe'],
    'Nebenkosten & Energie': ['strom', 'gas', 'wasser', 'nebenkosten', 'heizkosten', 'müllgebühr', 'abwasser', 'grundsteuer', 'stadtwerke', 'eon', 'vattenfall'],
    'Handy, Internet & Abos': ['handy', 'smartphone', 'internet', 'wlan', 'dsl', 'vertrag', 'telekom', 'vodafone', 'o2', 'netflix',
      'spotify', 'disney', 'amazon prime', 'abo', 'rundfunk', 'gez', 'icloud', 'youtube premium'],
    'Versicherungen': ['versicherung', 'haftpflicht', 'hausrat', 'kasko', 'police', 'allianz', 'huk', 'ergo', 'debeka'],
    'Urlaub': ['urlaub', 'hotel', 'flug', 'ferienwohnung', 'airbnb', 'reise', 'koffer', 'türkei urlaub', 'booking', 'camping'],
    'Spenden & Zekât': ['spende', 'zekat', 'zekât', 'zakat', 'sadaka', 'sadaqa', 'fitre', 'moschee', 'kurban', 'qurban', 'kollekte'],
    'Sparen & Rücklagen': ['sparen', 'rücklage', 'sparkonto', 'tagesgeld', 'etf', 'sparplan', 'notgroschen', 'anlage', 'geldanlage',
      'aktie', 'depot', 'invest', 'fonds', 'krypto', 'bitcoin', 'ethereum', 'goldbarren', 'goldmünze', 'silbermünze', 'trade republic',
      'scalable', 'comdirect', 'dividende', 'börse', 'boerse', 'bausparen', 'vermögen'],
    'Schulden & Raten': ['rate', 'raten', 'kredit', 'darlehen', 'ratenzahlung', 'klarna', 'abzahlung'],
  };
  const norm = (t) => String(t || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const COMPILED = Object.entries(KEYWORDS).map(([cat, words]) => [cat, words.map((w) => {
    const n = norm(w);
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // kurze Wörter nur ganz, längere auch als Teil („Autoreparatur“, „Winterreifen“)
    return { re: n.length <= 3 ? new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`) : new RegExp(esc), weight: n.length };
  })]);
  function classifyText(text) {
    const t = norm(text);
    if (!t.trim()) return null;
    let best = null, bestScore = 0;
    for (const [cat, res] of COMPILED) {
      // längere, genauere Wörter zählen mehr („Apotheke“ schlägt „Saft“ in „Hustensaft“)
      const score = res.reduce((sum, k) => sum + (k.re.test(t) ? k.weight : 0), 0);
      if (score > bestScore) { best = cat; bestScore = score; }
    }
    return best;
  }

  // Wörter, die etwas über den Zweck sagen (zum Lernen der Zuordnung): ohne Füllwörter, Zahlen, sehr kurze Wörter
  const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'mit', 'ohne', 'fuer', 'von', 'vom', 'bei', 'beim', 'im', 'in', 'am',
    'an', 'auf', 'aus', 'zum', 'zur', 'ein', 'eine', 'einen', 'einem', 'einer', 'eur', 'euro', 'gekauft', 'bezahlt', 'neu', 'neue',
    'neuer', 'neues', 'heute', 'gestern', 'wieder', 'noch', 'mal', 'fuers', 'ueber', 'etwas', 'sachen', 'paar', 'kauf', 'gemacht',
    'machen', 'fuer', 'den', 'dem', 'des', 'ist', 'war', 'wurde', 'haben', 'hat', 'auch', 'nur', 'sehr', 'viel', 'wenig', 'stueck']);
  function significantWords(text) {
    return [...new Set(norm(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w)))];
  }

  return { parseReceipt, classifyText, significantWords, normalize: norm };
});
