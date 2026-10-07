# Martec Tracker Gare

Applicazione statica pronta per essere pubblicata come sito e sincronizzata tra piu utenti tramite Supabase.

## Cosa e cambiato

- Il file principale della web app ora e `index.html`, cosi GitHub Pages puo pubblicarlo direttamente.
- L'app continua a funzionare in locale anche senza database esterno.
- Se configuri Supabase, i dati di `gare`, `aggiudicate`, `offerte` e i metadati dei `portali` vengono sincronizzati tra tutti gli utenti che aprono il link.
- Le credenziali sensibili dei portali (`username` e `password`) restano solo nel browser locale e non vengono inviate al database condiviso.

## Configurazione Supabase

1. Crea un progetto su Supabase.
2. Apri il SQL Editor ed esegui il contenuto di [supabase-schema.sql](/Users/gennydericcio/Downloads/Martec%20Tracker%20Gare/supabase-schema.sql).
3. Apri `config.js`.
4. Inserisci:
   - `supabaseUrl`
   - `supabaseAnonKey`
5. Salva il file.

Puoi usare [config.example.js](/Users/gennydericcio/Downloads/Martec%20Tracker%20Gare/config.example.js) come riferimento.

## Pubblicazione su GitHub Pages

1. Crea un repository GitHub e carica tutto il contenuto della cartella.
2. Verifica che il file principale sia [index.html](/Users/gennydericcio/Downloads/Martec%20Tracker%20Gare/index.html).
3. In GitHub vai su `Settings` -> `Pages`.
4. Come source scegli il branch principale e la root del repository.
5. Attendi la pubblicazione del sito e apri il link generato da GitHub Pages.

Il file `.nojekyll` e gia incluso per evitare trasformazioni indesiderate durante il deploy statico.

## Monitor Gare automatico

La pagina `Monitor Gare` mostra le procedure trovate dallo scanner automatico e permette di importare una singola gara nella Lista Gare.

Lo scanner e predisposto con GitHub Actions:

- workflow: `.github/workflows/monitor-gare.yml`
- script: `scripts/monitor-gare-scanner.mjs`
- configurazione esempio: `monitor-gare.config.example.json`

Per abilitarlo:

1. Copia `monitor-gare.config.example.json` in `monitor-gare.config.json`.
2. Configura i portali da monitorare.
3. In GitHub vai su `Settings` -> `Secrets and variables` -> `Actions`.
4. Aggiungi:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - eventuali credenziali portale, ad esempio `FAREAPPALTI_USERNAME` e `FAREAPPALTI_PASSWORD`

Lo scanner gira nelle finestre utili e lavora solo alle 09:00, 11:00 e 13:00 Europe/Rome. Salva solo metadati e link, non allegati, cosi evita consumo inutile di storage Supabase.

## Nota importante sulla sicurezza

Questa configurazione e pensata per una web app condivisa tramite link senza backend privato dedicato.

- I dati condivisi richiedono un utente autenticato e autorizzato nel workspace. Le vecchie policy anonime vengono rimosse dallo schema.
- Per questo motivo le password dei portali non vengono sincronizzate.
- Non inserire mai una chiave `service_role` nel frontend. Lo scanner la usa solo nei secret di GitHub Actions.

## Verifica sincronizzazione

Esegui `node tests/cloud-sync.test.cjs` per verificare coda dei salvataggi, snapshot immutabili, timeout, errori di rete, recupero e conflitti.

`supabase-sync-hardening.sql` documenta il timeout di 30 secondi e la rimozione dell'accesso anonimo applicati il 7 ottobre 2026. Non modifica i dati del workspace. Non e necessario rieseguirlo durante un normale deploy del sito.

Il pulsante di sincronizzazione permette di riprovare una richiesta fallita. Se il cloud e cambiato rispetto alla copia locale, il recupero viene bloccato per evitare sovrascritture. Le quote del piano gratuito restano in vigore; gli allegati incorporati nel JSON devono essere separati dai dati per ridurre ulteriormente traffico e carico.
