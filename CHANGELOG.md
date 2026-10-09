# Changelog

Each release lists what changed for students, in English and Italian. The GitHub release page uses the same text.

## 0.2.1

### English

#### Ask

- Answers that use your sources are as complete as answers without them. Only an answer with no citations is marked as general knowledge.
- Type formulas straight into the message, without LaTeX. Press `$` or the sigma button and use the formula keyboard; the formula sits inline in your text. Written answers in quizzes and exercises work the same way.

#### Studying a plan

- Lessons are smart texts: short sections with quick checks, worked examples, exercises you open one step at a time, and a recap at the end. Answering the recap completes the lesson.
- Each plan has an introduction page that says what you will study and how.
- The path is open. Every activity is available on any topic, and Pyxis suggests the next step with the reason for it. Nothing is locked.
- Quizzes correct each answer as you give it and have at most 10 questions. The results show where to start and let you review your mistakes.
- The concept map reads left to right, and you can fold its branches.
- Progress is one page: preparation, recent days, gaps, simulations and pace.

#### App

- The header spans the whole window, and each door goes back to its start page.
- Subjects are managed from the Exams page.
- Setup says what leaves this computer when you use an AI engine. You see it once, at setup, in Settings or at the first launch after the update, never in the middle of a task.
- Settings, the plan page and the task pages are tidier: one focus ring for the keyboard, tables that fit the window, and actions grouped where you use them.
- Dependency updates, including KaTeX.

#### Fixed

- #5: `npm run shoot` no longer stops at step 5 of the plan wizard.
- #24: engine setup names all four engines (Claude Code, Codex, Cursor Agent and Antigravity).
- #25: `docs/engines.md` passes the Prettier check.

### Italiano

#### Chiedi

- Le risposte basate sulle tue fonti sono complete quanto quelle senza fonti. Solo una risposta senza citazioni viene segnata come conoscenza generale.
- Scrivi le formule direttamente nel messaggio, senza LaTeX. Premi `$` o il pulsante sigma e usa la tastiera delle formule: la formula resta nel testo. Le risposte scritte nei quiz e negli esercizi funzionano allo stesso modo.

#### Studiare un piano

- Le lezioni sono testi smart: sezioni brevi con verifiche rapide, esempi svolti, esercizi da aprire un passo alla volta e un ripasso finale. Rispondere al ripasso completa la lezione.
- Ogni piano ha una pagina di introduzione che spiega cosa studierai e come.
- Il percorso è aperto. Ogni attività è disponibile su qualsiasi argomento e Pyxis suggerisce il passo successivo, con il motivo. Niente è bloccato.
- I quiz correggono ogni risposta appena la dai e hanno al massimo 10 domande. I risultati dicono da dove partire e ti fanno ripassare gli errori.
- La mappa concettuale si legge da sinistra a destra e i rami si possono chiudere.
- I progressi stanno in una sola pagina: preparazione, ultimi giorni, lacune, simulazioni e ritmo.

#### App

- L'intestazione occupa tutta la finestra e ogni sezione riporta alla sua pagina iniziale.
- Le materie si gestiscono dalla pagina Esami.
- La configurazione iniziale dice cosa esce da questo computer quando usi un motore AI. Lo vedi una volta sola: alla configurazione, nelle Impostazioni o al primo avvio dopo l'aggiornamento, mai a metà di un'attività.
- Impostazioni, pagina del piano e pagine delle attività sono più ordinate: un solo anello di focus per la tastiera, tabelle che stanno nella finestra e azioni raggruppate dove servono.
- Dipendenze aggiornate, tra cui KaTeX.

#### Corretti

- #5: `npm run shoot` non si ferma più al passo 5 della creazione del piano.
- #24: la configurazione dei motori nomina tutti e quattro i motori (Claude Code, Codex, Cursor Agent e Antigravity).
- #25: `docs/engines.md` supera il controllo di Prettier.

## 0.2.0

0.2.0 had no GitHub release. The 0.2.1 release page lists these changes too.

### English

- Pyxis picks AI engines for you and spreads the work across Claude Code, Codex, Cursor Agent and Antigravity. Cursor Agent and Antigravity are now available. Like the others, they can't read or change your files.
- Import several files and folders at once, with feedback on each one.
- The Ask page is built around one input box.
- First setup covers engines, reading scanned pages and crash reports.
- A formula keyboard for answers in chat, quizzes, simulations and exercises.
- Navigation, page widths and loading states match across the app.
- A new plan's first test no longer fails because of citations.

### Italiano

- Pyxis sceglie i motori AI per te e distribuisce il lavoro tra Claude Code, Codex, Cursor Agent e Antigravity. Cursor Agent e Antigravity ora sono disponibili. Come gli altri, non possono leggere né modificare i tuoi file.
- Importa più file e cartelle insieme, con un riscontro per ciascuno.
- La pagina Chiedi ruota attorno a un'unica casella di testo.
- La configurazione iniziale comprende i motori, la lettura delle pagine scansionate e le segnalazioni dei crash.
- Una tastiera delle formule per le risposte in chat, nei quiz, nelle simulazioni e negli esercizi.
- Navigazione, larghezza delle pagine e caricamenti sono uguali in tutta l'app.
- Il test iniziale di un nuovo piano non fallisce più a causa delle citazioni.
