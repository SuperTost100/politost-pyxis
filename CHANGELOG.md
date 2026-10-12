# Changelog

Each release lists what changed for students, in English and Italian. The GitHub release page uses the same text.

## 0.2.2

### English

#### Setup

- The first screen says what Pyxis does before it asks anything. The last one takes you to your first exam.
- Setup asks which AI you already pay for: ChatGPT, Claude, Google or Cursor. Pyxis then installs that engine with its maker's official installer, with no terminal and no administrator password.
- If you pay for none of them, Pyxis starts you on Antigravity with a free Google account. It also links to the free and student plans listed on PoliTost.
- Sign-in starts by itself after the install. Codex now signs in through the browser; before, it needed a setting changed in your ChatGPT account.
- Antigravity opens a terminal and lists the steps to follow there. Pyxis carries on by itself once you are signed in.
- Settings > Engines uses the same install and sign-in steps.

#### Exams

- Start an exam from a free PoliTost book. "Free PoliTost books", in the exam wizard and in the Library, lists the books on books.politost.it. Pyxis downloads the one you pick, checks that it matches the list, and fills in the exam's name and subject.
- Pyxis connects to books.politost.it only while that list is open.

#### Studying

- A finished topic quiz counts on your path again, so the suggested next step moves on.
- Flashcards you have not reviewed yet no longer lower a topic's mastery.
- Matching questions shuffle their answers properly.
- Whole-number answers must be exact. Decimal answers keep a small tolerance.

#### Ask

- Citations such as [P1, P3] link to their passages.
- A reply that finishes after you leave its chat stays in that chat, and so do its notices.
- A chat that fails to rename or delete now says so.

#### Sources

- Imports you cancelled, or that failed, no longer show up in answers, lessons or plans.
- A folder with an unreadable subfolder still imports the rest and tells you what it skipped.
- Smartbooks up to the 256 MB import limit open.

#### App

- Pyxis opens faster. Its main script is less than half the size, and rarely used pages load the first time you open them.
- The window can no longer be moved to another page, and Pyxis refuses camera, microphone and location requests.
- An older Pyxis refuses a workspace saved by a newer version instead of risking it.
- Failed flashcard actions show a message, sizes use the decimal comma in Italian, and screen readers name the section switches.
- Updated CLI Funnel and content-core.

#### Fixed

- #35: smartbook text no longer includes stray markup left by the tool that generated the book.

### Italiano

#### Configurazione

- La prima schermata spiega cosa fa Pyxis prima di chiederti qualcosa. L'ultima ti porta al tuo primo esame.
- La configurazione ti chiede quale AI paghi già: ChatGPT, Claude, Google o Cursor. Pyxis installa quel motore con l'installer ufficiale del produttore, senza terminale e senza password di amministratore.
- Se non ne paghi nessuna, Pyxis ti fa partire con Antigravity e un account Google gratuito. Ti indica anche i piani gratuiti e per studenti elencati su PoliTost.
- L'accesso parte da solo dopo l'installazione. Codex ora accede dal browser; prima serviva cambiare un'impostazione nel tuo account ChatGPT.
- Antigravity apre un terminale ed elenca i passi da seguire lì. Pyxis va avanti da solo quando hai fatto l'accesso.
- In Impostazioni > Motori l'installazione e l'accesso seguono gli stessi passi.

#### Esami

- Crea un esame partendo da un libro PoliTost gratuito. "Libri PoliTost gratuiti", nella creazione dell'esame e nella Libreria, elenca i libri su books.politost.it. Pyxis scarica quello che scegli, controlla che corrisponda all'elenco e compila nome e materia dell'esame.
- Pyxis si collega a books.politost.it solo mentre quell'elenco è aperto.

#### Studiare

- Un quiz di argomento completato torna a contare nel percorso, quindi il passo successivo suggerito va avanti.
- Le flashcard che non hai ancora ripassato non abbassano più la padronanza di un argomento.
- Le domande di abbinamento mescolano davvero le risposte.
- Le risposte con numeri interi devono essere esatte. Quelle con decimali mantengono una piccola tolleranza.

#### Chiedi

- Le citazioni come [P1, P3] portano ai loro brani.
- Una risposta che arriva dopo che hai lasciato la chat resta in quella chat, insieme ai suoi avvisi.
- Se rinominare o eliminare una chat non riesce, ora te lo dice.

#### Fonti

- Le importazioni annullate o non riuscite non compaiono più nelle risposte, nelle lezioni o nei piani.
- Una cartella con una sottocartella illeggibile importa comunque il resto e ti dice cosa ha saltato.
- Si aprono smartbook fino al limite di importazione di 256 MB.

#### App

- Pyxis si apre più in fretta. Lo script principale è meno della metà e le pagine usate di rado si caricano la prima volta che le apri.
- La finestra non può più essere spostata su un'altra pagina e Pyxis rifiuta le richieste di fotocamera, microfono e posizione.
- Una versione più vecchia di Pyxis rifiuta un workspace salvato da una più nuova, invece di rischiare di rovinarlo.
- Le azioni sulle flashcard che non riescono mostrano un messaggio, le dimensioni usano la virgola decimale in italiano e gli screen reader leggono il nome dei selettori di sezione.
- CLI Funnel e content-core aggiornati.

#### Corretto

- #35: il testo degli smartbook non contiene più marcatori lasciati dallo strumento che ha generato il libro.

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
