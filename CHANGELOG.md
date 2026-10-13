# Changelog

Each release lists what changed for students, in English and Italian. The GitHub release page uses the same text.

## 0.2.3

### English

#### Setup

- Sign-in opens one browser tab. Claude Code and Codex open the sign-in page themselves, so Pyxis now only shows the link instead of opening a second tab that could break the first.
- While Pyxis waits for you to sign in, you can choose "Open the sign-in page again" or "Cancel". Closing the tab no longer leaves "Complete sign-in in your browser" on screen forever, and Pyxis gives up by itself after 10 minutes.
- A second click on the sign-in button no longer breaks it. "Signed in." shows right away instead of 5 to 20 seconds later. A cancelled sign-in is not reported as a failure, and a real failure shows the message under Details.
- On Windows, Codex and Claude Code installed with npm now start from Pyxis.
- An expired sign-in tells you to sign in again. Before, it said the key was refused, even though you have no key on a subscription.
- If you skip the data notice in setup, you see it once when you arrive. Before, your first plan or chat failed. The notice now says Cursor passes the text on to the maker of the model.
- The setup dialog in Settings has a title, and screen readers announce changes in the sign-in status.
- On Linux, Antigravity tries the common terminal programs when the default one is missing.
- Updated CLI Funnel to 0.4.2.

#### Exams

- Pyxis no longer picks "Within 10 days" for you. Nothing is selected on the exam step, and Continue waits until you choose a quick option, a day or a month. Before, every plan got a deadline whether you had one or not.
- If you only know the month, pick it with "Or just the month, if the day isn't set yet". The plan aims to have you ready by the 1st. The exams list and the plan header say "Exam in March 2027" instead of counting days, and the exam counts as past only when the month ends.
- In the plan's settings, "I only know the month" switches the date to a month. Unticking it keeps the date as an exact day.
- On the day of the exam the plan says "Exam today", and after it "Past exam", instead of "0 days".
- In the plan's settings, past days can't be picked, and a shared plan keeps its day in every time zone. Plan titles are limited to 200 characters everywhere, and the topic editor stops at 30 subtopics instead of refusing the plan later.

#### Studying

- Preparation no longer stays at 0% on guided plans, on plans without topics from your sources, or on plans whose sources you removed.
- After a practice step, the path suggests a quiz on that topic: "Check what the exercises taught you." Before, it suggested the same practice again, because exercises don't change mastery. Topics already at the target skip the quiz.
- Retaking a diagnostic no longer raises mastery again for questions you already answered.
- A simulation counts the answers you give in the last 5 seconds, as quizzes do, and saves your typing as you go.
- A plan with a 100% target can now reach it. The suggestion counts all your due flashcards, not only the first 20.
- A card you rate "Impossible" comes back in the same session when it is due within 20 minutes. The page tells you when.
- The graph accepts ln(x), sen(x), π and a decimal comma. In the map, Backspace deletes the selected node, except while you type.
- Markdown, CSV and Anki exports of Italian plans use Italian labels.
- Deleting a plan also removes the exercises generated for it and the work it had queued.

#### Ask

- A first question that fails or that you stop no longer leaves an empty chat behind. Your text and files go back to the box, so trying again makes one chat and imports each file once.
- Answers follow the interface language. Before, anyone who skipped setup got Italian answers in the English interface.
- Each chat keeps its own draft and picked files. The whiteboard and the graph return to the chat you opened them from.
- Stop works from the first moment. Deleting a chat while it answers stops the reply. A stopped reply shows "Stopped", and a question without an answer offers "Try again".
- A file you attach to a question always gets a look: Pyxis sends up to four of its passages, so "summarise this file" works. A scanned PDF is refused by name, with the advice to add it to the Library and choose "Read the scan".
- Copy leaves out check blocks and [P3] markers and tells you if it worked. Follow-up suggestions no longer show raw tags after a stopped reply. Wide tables and formulas scroll inside the message, and long links wrap. Failed ratings, library saves and file dialogs now say so.
- Screen readers announce the finished reply and say who wrote each message.

#### Sources

- A file you attached in a chat and later add to the Library now stays in the Library. Before, it vanished with the chat.
- A replacement you stop or that fails keeps the earlier version searchable. Replacing a source with a scanned PDF fails with a clear message to add the scan as a new source, instead of publishing an empty version.
- A failed import says why: an encrypted or licensed smartbook, an oversized or broken archive, a broken smartbook, not enough memory, or a page with no text. The Library row shows the reason, and the jobs list names the file.
- A slow download of a free PoliTost book keeps going while data arrives instead of failing as offline after 30 seconds. The books dialog no longer shows "In your library" for a book you removed.
- PDFs that mix text and scanned pages keep their text. The scan step reads only the pages without text.
- Removing a source stops its import. Dropping more than 20 files tells you to choose their folder instead.
- "Notes.PDF" becomes "Notes". A link to a PDF takes the file's name, pages in other character sets read correctly, and text that isn't a web address gets a clear message. The Library size column follows your language.

#### App

- Only one Pyxis runs per profile. Opening it a second time brings the open window forward. Before, two copies shared your workspace, ran jobs twice and could move the folder from under each other.
- On first launch, Pyxis uses Italian or English, whichever comes first in your computer's languages, and English if neither is listed. A language you pick in Settings always wins.
- A failed update check is tried again after 15 minutes instead of a day. The message explains that GitHub limits requests, which campus networks often hit.
- A workspace on a drive that isn't connected asks you to connect it. A workspace saved by a newer Pyxis says so and offers the download. A crash that keeps repeating stops after 5 tries, and a failed restore no longer leaves every screen waiting.
- Lessons and exercises are no longer generated twice when Pyxis recovers from an internal restart.
- Backup and Restore show progress and ignore a second click. A backup over 2 GB says how large the workspace is. Sizes use your language ("1,5 MB").
- The installed app drops the default English menu with developer tools. macOS keeps App, Edit and Window, and Windows and Linux show no menu bar.

#### Fixed

- Python no longer fails on slow computers such as older Intel Macs. It gets 60 seconds to start and 90 seconds in all. If it still takes too long, Pyxis says "Python took too long to start. Try again." and keeps "unavailable" for when Python is really missing.

### Italiano

#### Configurazione

- L'accesso apre una sola scheda del browser. Claude Code e Codex aprono da soli la pagina di accesso, quindi Pyxis ora mostra solo il link invece di aprire una seconda scheda che poteva rovinare la prima.
- Mentre Pyxis aspetta che tu acceda, puoi scegliere "Riapri la pagina di accesso" o "Annulla". Chiudere la scheda non lascia più "Completa l'accesso nel browser" sullo schermo per sempre, e Pyxis rinuncia da solo dopo 10 minuti.
- Un secondo clic sul pulsante di accesso non lo rovina più. "Accesso fatto." compare subito invece di 5 o 20 secondi dopo. Un accesso annullato non viene segnalato come errore, e un errore vero mostra il messaggio sotto Dettagli.
- Su Windows, Codex e Claude Code installati con npm ora si avviano da Pyxis.
- Un accesso scaduto ti dice di accedere di nuovo. Prima diceva che la chiave era stata rifiutata, anche se con un abbonamento non hai nessuna chiave.
- Se salti l'avviso sui dati nella configurazione, lo vedi una volta quando arrivi. Prima il tuo primo piano o la prima chat fallivano. L'avviso ora dice che Cursor passa il testo al produttore del modello.
- La finestra di configurazione in Impostazioni ha un titolo, e gli screen reader annunciano i cambi di stato dell'accesso.
- Su Linux, Antigravity prova i terminali più comuni quando manca quello predefinito.
- CLI Funnel aggiornato alla 0.4.2.

#### Esami

- Pyxis non sceglie più "Entro 10 giorni" al posto tuo. Nel passo dell'esame non c'è nulla di selezionato e Continua aspetta che tu scelga un'opzione rapida, un giorno o un mese. Prima ogni piano riceveva una scadenza, che tu l'avessi o no.
- Se sai solo il mese, sceglilo con "Oppure solo il mese, se il giorno non è ancora fissato". Il piano punta a farti arrivare pronto entro il giorno 1. L'elenco degli esami e l'intestazione del piano dicono "Esame a marzo 2027" invece di contare i giorni, e l'esame risulta passato solo a fine mese.
- Nelle impostazioni del piano, "So solo il mese" trasforma la data in un mese. Se togli la spunta, la data resta come giorno preciso.
- Il giorno dell'esame il piano dice "Esame oggi", e dopo "Esame passato", invece di "0 giorni".
- Nelle impostazioni del piano non si possono scegliere giorni passati, e un piano condiviso mantiene il suo giorno in ogni fuso orario. I titoli dei piani sono limitati a 200 caratteri ovunque, e l'editor degli argomenti si ferma a 30 sottoargomenti invece di rifiutare il piano dopo.

#### Studiare

- La preparazione non resta più allo 0% nei piani guidati, nei piani senza argomenti dalle tue fonti o nei piani di cui hai rimosso le fonti.
- Dopo un esercizio, il percorso suggerisce un quiz su quell'argomento: "Verifica cosa ti hanno insegnato gli esercizi." Prima suggeriva di nuovo lo stesso esercizio, perché gli esercizi non cambiano la padronanza. Gli argomenti già all'obiettivo saltano il quiz.
- Rifare una diagnostica non alza più la padronanza per le domande a cui avevi già risposto.
- Una simulazione conta le risposte date negli ultimi 5 secondi, come i quiz, e salva quello che scrivi mentre scrivi.
- Un piano con obiettivo al 100% ora può raggiungerlo. Il suggerimento conta tutte le flashcard da ripassare, non solo le prime 20.
- Una carta valutata "Impossibile" torna nella stessa sessione se è in scadenza entro 20 minuti. La pagina ti dice quando.
- Il grafico accetta ln(x), sen(x), π e la virgola decimale. Nella mappa, Backspace elimina il nodo selezionato, tranne mentre scrivi.
- Le esportazioni in Markdown, CSV e Anki dei piani in italiano usano le etichette in italiano.
- Eliminare un piano rimuove anche gli esercizi generati per quel piano e il lavoro che aveva in coda.

#### Chiedi

- Una prima domanda che non riesce o che interrompi non lascia più una chat vuota. Testo e file tornano nella casella, così riprovare crea una sola chat e importa ogni file una volta sola.
- Le risposte seguono la lingua dell'interfaccia. Prima, chi saltava la configurazione riceveva risposte in italiano con l'interfaccia in inglese.
- Ogni chat conserva la sua bozza e i suoi file. La lavagna e il grafico tornano alla chat da cui li hai aperti.
- Interrompi funziona fin dal primo momento. Eliminare una chat mentre risponde ferma la risposta. Una risposta interrotta mostra "Interrotta", e una domanda senza risposta offre "Riprova".
- Un file allegato a una domanda viene sempre letto: Pyxis invia fino a quattro suoi brani, quindi "riassumi questo file" funziona. Un PDF scansionato viene rifiutato per nome, con il consiglio di aggiungerlo alla Libreria e scegliere "Leggi la scansione".
- Copia lascia fuori i blocchi di verifica e i segni come [P3] e ti dice se ha funzionato. I suggerimenti di approfondimento non mostrano più tag grezzi dopo una risposta interrotta. Tabelle larghe e formule scorrono dentro il messaggio, e i link lunghi vanno a capo. Valutazioni, salvataggi in Libreria e finestre dei file che non riescono ora lo dicono.
- Gli screen reader annunciano la risposta completata e dicono chi ha scritto ogni messaggio.

#### Fonti

- Un file che hai allegato in una chat e poi aggiungi alla Libreria ora resta nella Libreria. Prima spariva insieme alla chat.
- Una sostituzione che interrompi o che non riesce mantiene ricercabile la versione precedente. Sostituire una fonte con un PDF scansionato non riesce e ti dice di aggiungere la scansione come nuova fonte, invece di pubblicare una versione vuota.
- Un'importazione non riuscita dice perché: smartbook cifrato o con licenza, archivio troppo grande o danneggiato, smartbook danneggiato, memoria insufficiente o pagina senza testo. La riga della Libreria mostra il motivo e l'elenco dei lavori indica il nome del file.
- Il download lento di un libro PoliTost gratuito continua finché arrivano dati, invece di fallire come offline dopo 30 secondi. La finestra dei libri non mostra più "Nella tua libreria" per un libro che hai rimosso.
- I PDF con pagine di testo e pagine scansionate mantengono il testo. Il passo di scansione legge solo le pagine senza testo.
- Rimuovere una fonte ferma la sua importazione. Se trascini più di 20 file, Pyxis ti suggerisce di scegliere la loro cartella.
- "Appunti.PDF" diventa "Appunti". Un link a un PDF prende il nome del file, le pagine con altre codifiche si leggono correttamente e un testo che non è un indirizzo web riceve un messaggio chiaro. La colonna delle dimensioni in Libreria segue la tua lingua.

#### App

- Si apre un solo Pyxis per profilo. Aprirlo una seconda volta porta in primo piano la finestra già aperta. Prima due copie condividevano lo spazio di lavoro, eseguivano i lavori due volte e potevano spostare la cartella mentre l'altra la usava.
- Al primo avvio Pyxis usa italiano o inglese, quello che compare prima tra le lingue del computer, e l'inglese se nessuno dei due c'è. Una lingua scelta in Impostazioni ha sempre la precedenza.
- Un controllo degli aggiornamenti non riuscito viene ripetuto dopo 15 minuti invece che dopo un giorno. Il messaggio spiega che GitHub limita le richieste, un limite che le reti universitarie raggiungono spesso.
- Uno spazio di lavoro su un disco non collegato ti chiede di collegarlo. Uno spazio di lavoro salvato da un Pyxis più recente lo dice e offre il download. Un arresto che si ripete si ferma dopo 5 tentativi, e un ripristino non riuscito non lascia più ogni schermata in attesa.
- Lezioni ed esercizi non vengono più generati due volte quando Pyxis si riprende da un riavvio interno.
- Backup e Ripristino mostrano l'avanzamento e ignorano un secondo clic. Un backup oltre 2 GB dice quanto è grande lo spazio di lavoro. Le dimensioni usano la tua lingua ("1,5 MB").
- L'app installata toglie il menu inglese predefinito con gli strumenti per sviluppatori. macOS mantiene App, Modifica e Finestra, mentre Windows e Linux non mostrano la barra dei menu.

#### Corretti

- Python non fallisce più sui computer lenti, come i vecchi Mac Intel. Ha 60 secondi per avviarsi e 90 in tutto. Se ci mette comunque troppo, Pyxis dice "Python ci ha messo troppo ad avviarsi. Riprova." e riserva "non disponibile" ai casi in cui Python manca davvero.

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
