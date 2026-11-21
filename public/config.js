// Cloud-Modus (kostenlose Datenbank bei Supabase) – Anleitung: docs/CLOUD.md
// Beide Werte findest du im Supabase-Dashboard unter „Project Settings → API“ bzw. „Connect“.
// Der Schlüssel ist der öffentliche „Publishable key“ (früher „anon public“) – NICHT der geheime „service_role“-Schlüssel.
// Bleiben beide Felder leer, verwendet die App den eigenen Node-Server (npm start).
window.HAUSHALT_CONFIG = {
  supabaseUrl: 'https://myyzspshcbtkwueiwhwy.supabase.co',
  supabaseKey: 'sb_publishable_ZeNgvFqknDrE64_pj9gmug_ilsOpV1X',
};
