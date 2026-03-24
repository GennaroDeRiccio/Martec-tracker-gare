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

## Nota importante sulla sicurezza

Questa configurazione e pensata per una web app condivisa tramite link senza backend privato dedicato.

- Chiunque abbia accesso al sito condiviso puo leggere e modificare i dati sincronizzati nel database.
- Per questo motivo le password dei portali non vengono sincronizzate.
- Se vuoi una gestione utenti sicura, bisognera aggiungere autenticazione e regole di accesso piu restrittive.
