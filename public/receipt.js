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
    [/\bsaturn\b/i, 'Saturn', 'Sonstiges'],
  ];

  // Zeilen mit dem zu zahlenden Betrag (nach Wichtigkeit) und Zeilen, die NICHT der Endbetrag sind
  const TOTAL_WORDS = [
    /zu\s*zahlen/i, /gesamt\s*betrag|gesamtsumme|endbetrag/i, /\bsumme\b|\bsumme\s*eur/i, /\bgesamt\b/i,
    /\btotal\b/i, /\bbetrag\b/i, /\b(ec[\s-]*karte|kartenzahlung|girocard|visa|mastercard|bar)\b/i,
  ];
  const NOT_TOTAL = /(mwst|ust\b|steuer|netto|brutto\s*netto|r[üu]ckgeld|gegeben|wechselgeld|rabatt|ersparnis|gespart|pfand|punkte|zwischensumme)/i;

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

  return { parseReceipt };
});
