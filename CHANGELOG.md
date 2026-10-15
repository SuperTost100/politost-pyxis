# Changelog

Each release lists what changed for students, in English and Italian. The GitHub release page uses the same text.

## 0.3.1

### English

Pyxis 0.3.1 is the first stable 0.3 release. 0.3.0 was only a development build and never came out as a final release, so this entry covers everything new since 0.2.3, plus the fixes from testing. The first time you open 0.3.1, Pyxis upgrades your workspace, and Pyxis 0.2.3 or older can't open it afterwards. If you may want to go back, make a backup first in Settings, under Data.

#### Setup

- Settings, under Profile and interests, has a new "Run setup again" button. It reopens the setup screens with your name, level, year, school, course and crash-report choice already filled in. Your engine choices stay as they are.
- Running setup again has no Skip. You can cancel on the first screen or go back on the profile screen, and nothing is saved until you reach the end. The last screen says "Setup updated", and "Back to Settings" takes you back to Profile and interests.
- On macOS and Windows, Settings showed Antigravity as "Sign-in required" even when you were signed in, and signing in again through Pyxis never finished. Pyxis now asks Antigravity itself whether you are signed in.
- Cancelling a sign-in before its page opens no longer shows "Sign-in did not finish". If you cancel and start again, the new sign-in keeps going.

#### Engines

- Pyxis now sets a reasoning effort for every task, also when you chose the model yourself. Chat and maps use low, lessons, quizzes, cards and photos use medium, and plans and grading use high. A model that doesn't offer a level gets the nearest one it has, and a model with no levels runs as it is.
- Settings, under AI engines, "Advanced options" has a "Reasoning effort" picker for each task. It starts at "Automatic" with the level Pyxis picked, for example "Automatic · Medium". Your pick stays when you change the model. If the new model doesn't offer it, the row says so and Pyxis uses the automatic level. "Back to automatic choice" clears your picks.
- When an engine fails, Pyxis says why instead of "Something went wrong". You are signed out, you reached the usage limit, the engine is not available, or it returned an error. "Details" shows the engine's own text. Ask, lessons, quizzes, cards, grading and plans all give these messages.
- Pyxis never sends photos to Cursor Agent or Antigravity, because they can't read images. Ask reads the text in the photo on your computer instead, and the automatic choice doesn't give them the photo task.
- Antigravity has no sign-out command, so Settings, under AI engines, no longer offers "Sign out" for it. It tells you to sign out in Antigravity itself.
- "Test" no longer sends a reasoning effort that the model doesn't list.
- The "Test" and "Sign in" buttons on each engine now name the engine, so screen readers can tell them apart.

#### Exams

- The plans tab has one toolbar, laid out like the Sources tab. It has a search box, the subject filter, an "Import" menu and "New plan", which is the only filled button. "Import" opens "From a .pyxis file" and "From a link". With no plans yet, you see "New plan" and the same menu.
- "No plans yet" no longer flashes while your plans load.
- A failed plan import no longer leaves its error showing on the Sources and Flashcards tabs.
- "Add to calendar" saves a calendar file (.ics) for one exam at a time. Use the calendar button in a plan's header, or the same button in "Plan settings". The Exams page has no button that saves every exam at once.
- Each exam is an all-day event titled "Exam:" followed by the plan's title, or "Esame:" in Italian. The description names the subject when the plan has one. Each event has a reminder at 9:00 the day before.
- Pyxis gives each exam the same ID every time, so importing the file again should update your events instead of adding copies.
- A plan with no date, or with an exam already over, has no calendar button in its header. In "Plan settings" the button is off and tells you why. It is also off while you have changed the date and not saved it ("Save the new date first.").

#### Flashcards

- Exams has a new Flashcards tab next to Sources. It lists every card from every plan in one place, 25 to a page. You can also open it from the Go menu. Cards from an archived topic are left out, as in review.
- Cards are grouped by subject, in the order you set in "Manage subjects". Plans without a subject go last, under "No subject". Under each subject, a heading names the exam and the topic.
- Search ignores case and accents, so "perche" finds "Perché". Every word has to appear on the front or the back.
- Filter by exam, by topic once you choose an exam, and by "All cards", "Due now", "Suspended" or "Removed".
- Math and cloze cards look as they do in review. A cloze shows its full sentence with the hidden words in bold. Each card says whether it is new, due or when its next review is, and has a Suspended tag when it is on hold.
- Every card has "Edit", "Suspend" or "Resume", and "Delete". Editing keeps the review schedule.
- Deleting a card you wrote asks first and is permanent. Deleting a card Pyxis wrote takes it out of your decks and reviews, and you can bring it back under "Removed" with "Restore".
- Pyxis now writes one fact, definition, formula or idea on each card. A card no longer holds a whole exercise on the front and its worked solution on the back. Cards Pyxis wrote earlier are left as they are.
- Exercises are no longer turned into flashcards. The exercise cards from 0.2.3 move to "Removed" once, the first time you open 0.3.1. Your reviews stay. Bring any of them back with "Restore". A card you restore stays restored, and cards you wrote or edited are not moved.
- The rating buttons in review are "Again", "Hard", "Good" and "Easy". They show no key number and no wait time. Keys 1 to 4 still rate, and the review summary uses the same words.

#### Studying

- Under each exercise, "How did it go?" shows two buttons, "Got it" and "Missed it". Rating is optional and counts toward your progress as half a quiz answer. "Mark as done" still works without a rating.
- You can change your rating. A rating from the last 6 hours stays chosen when you leave the page and come back. After that the exercise starts unrated, and a new rating counts as new.
- The answer options in the diagnostic, in lesson checks and in recap questions are now shuffled, so the right answer doesn't sit in the same spot. Every new quiz mixes its options too, and one attempt keeps its order. Answers you gave earlier stay on the option you chose.
- You can answer a lesson check while the lesson is still being written. You see the result at once, and the answer counts once the lesson is saved. If you press "Stop" or write the lesson again, answers on the unfinished text are dropped without an error.
- Checks in the introduction now always count toward your progress.
- Click a finished step on the path to open what you did, read only. A lesson opens as you read it, even if your settings changed since, and "Rewrite a part" is off for it. A quiz, gap drill or diagnostic opens with your answers, score and date. A simulation opens with its grading. Each has "Redo" to start again, and nothing is recorded until you hand in the new attempt.
- Exercises open with a note and no "Mark as done", and "Back to the path" takes you back. Flashcards open in review mode. Pyxis writes no new cards, and a step is added only if you rate a card.
- A quiz, drill, diagnostic or simulation that came with a shared plan has no answers, because plan files don't carry them. It says "The answers of this attempt weren't included in the shared plan." and offers "Redo" and "Back to the path".
- A shared plan now keeps the lesson and introduction checks you answered. After you import it, those checks show as answered, and answering one again doesn't count twice. Plan files from before still import.
- After a lesson, the path stays on that topic. It suggests exercises, then a quiz, and so on, until your mastery of the topic reaches 60% (or your mastery target, if that is lower) or you have done three graded activities on it. If you keep missing, the path moves on after the third.
- When you read a topic, don't touch it for 7 days and your mastery is still below the target, the path suggests a review quiz before the next chapter. Cards due today and serious gaps still come first.

#### Ask

- The Chats drawer has a search box. It looks in chat titles and message text, ignoring case and accents, and every word has to appear in the same text, in any order. A match in a message shows a short snippet under the title with the match in bold.
- Search skips what you never see: follow-up suggestions, check blocks and [P1] markers. Esc clears the box before it closes the drawer.
- The menu of each chat has "Export as Markdown" and "Export as PDF". The file has the chat title, then every message in order with who wrote it. Each answer ends with its sources, and a stopped reply is marked as stopped. Photos are numbered, not named, because Pyxis does not keep their file names. Labels follow the interface language.
- Exporting a chat that started from a passage or an answer now includes that context under the title.
- On a slow computer, the follow-up suggestions after a reply could end up below the visible area, and the page stopped following the chat for good. Now the newest content stays in view. Scrolling up to read an earlier message still stops the page from jumping.
- Follow-up suggestions keep their first characters. "3D integrals" no longer loses its "3".
- "Try again" keeps your choice of "Answer from general knowledge".
- Renaming a chat no longer moves it to the top of the list, and pressing Enter in the rename box saves once.

#### Sources

- When a free PoliTost book you added has a newer version, the Sources page says "New version available:" with the version number, and offers "Update". The free books list shows "New version available" and "Update" instead of "Add". Pyxis looks for new versions only while one of those is open.
- The book stays the same source, so your plans, cards and citations keep working. If a plan uses the book, Pyxis asks before updating, and if you decline, nothing is downloaded.
- The update runs in the background tasks and you can cancel it. If it fails or you cancel, the old version stays in use.
- Lessons and quizzes that cite text that changed are marked as out of date. Citations of unchanged text are not. Plans that use the book suggest "Rebuild topics", which picks up new chapters.

#### App

- The installers are smaller. On Linux the AppImage goes from 528 MB to 180 MB and the .deb from 372 MB to 141 MB, measured against the 0.3.0 development build. The macOS and Windows installers also drop files Pyxis never uses.
- Pyxis has a menu on Windows, macOS and Linux, in Italian or English. It follows the interface language and changes when you change it in Settings. On Windows and Linux the menu bar stays hidden until you press Alt. On macOS, Settings is in the app menu.
- File has "New exam" (Ctrl or Cmd+N), "New chat" (Ctrl or Cmd+Shift+N) and, on Windows and Linux, "Settings" (Ctrl+,). Go has "Ask", "Exams", "Library" and "Flashcards" (Ctrl or Cmd+1 to 4), and "Back" (Alt+Left, or Cmd+[ on macOS). View has "Zoom in", "Zoom out" and "Actual size".
- Help has "Keyboard shortcuts" (Ctrl or Cmd+/), "Check for updates", "Report a problem" and "About". "Check for updates" opens Settings, under Updates, and runs the check. "Report a problem" opens the GitHub issue form.
- "Keyboard shortcuts" lists the menu keys and the ones already in Ask, cards, quizzes, simulations and the whiteboard. It opens even during a quiz, so you can look a key up.
- A menu command does nothing while you are in setup, a dialog is open, you are answering a quiz or running a simulation, the plan wizard has your answers in it, or a text field has text you would lose. The Ask box is the exception because it keeps a draft for each chat.

#### Updates and backups

- When a newer stable release exists, Settings (under Updates) and the update notice offer "Download and install" next to "Open release page". Nothing downloads until you press it.
- Pyxis downloads the installer for your computer from GitHub and checks its size and checksum against the release before it uses it. You see a progress bar and "Cancel download". If the check fails, Pyxis deletes the file, says why, and offers "Try again" and "Open release page".
- This check catches a damaged download. It does not replace a signature: the checksum comes from the same GitHub release, and the installers are not signed with a developer certificate.
- On macOS, Pyxis opens the disk image in Finder. You quit Pyxis ("Quit Pyxis"), drag PoliTost Pyxis into Applications, choose Replace and open it again. "Open the disk image again" opens it once more if you closed it.
- On Windows, "Close Pyxis and install" closes Pyxis first and starts the installer once Pyxis has quit, so the installer never finds Pyxis still running. Pressing the button twice can't start two installers.
- On Linux with an AppImage, Pyxis replaces the file in place and offers "Restart Pyxis". If it can't write to that folder, it opens the new file's folder and you move it over the old one.
- On Linux with a .deb package, Pyxis only opens the folder with the downloaded file, and you open it with your software installer. Windows and Linux on Arm have no installer, so Pyxis sends you to the release page.
- If Windows can't clear the download folder, Pyxis logs it and shows the update as failed. It no longer stays stuck while downloading.
- "Check for updates" in Settings and in the Help menu now asks GitHub again instead of showing an earlier answer. Pressing it again within a minute shows the last answer.
- Pyxis waits if a backup, restore or move is running. If background tasks are running, it asks "Close Pyxis with tasks running?" first. The tasks stop, and you can resume them when Pyxis opens again.
- Pyxis now backs up your workspace on its own, at most once a day and only while Pyxis is open. It writes a ZIP to a "Pyxis backups" folder in Documents and keeps the 3 newest copies. You keep studying while it runs. "Restore" accepts these backups like any other.
- Settings, under Data, has a new "Automatic backups" section. It is on by default. It has the "Back up automatically" switch, "Change folder", "Open folder", the time and size of the last backup, and "Back up now", which saves to the same folder. "Change folder" refuses a folder inside your workspace or Pyxis's own data, because a backup there would be lost with it, and a folder Pyxis can't write to.
- When an automatic backup fails, a notice appears in the corner with the reason and a "Backup settings" button. The reasons are a folder that isn't there, such as an unplugged drive, no permission, a full disk, too many files, and a workspace over the 2 GB limit of a backup. A notice you dismiss stays away for the session. A workspace that is too large is reported once, not on every launch, and Pyxis tries again each day.
- On the first launch, the first automatic backup now waits until Pyxis has finished starting. Before, it could fail and then wait an hour to try again.
- A backup no longer starts while Pyxis is closing. Setting the clock back can't delete the backup that was just made. If you change the backup folder during a backup, the new folder starts its own first backup right away.
- "Delete all data" does not delete automatic backups. They stay in the backup folder shown under Data. The hint under the button says so, and so does the line that appears when you press it. Delete them there if you want them gone.

### Italiano

Pyxis 0.3.1 è la prima versione stabile della serie 0.3. La 0.3.0 era solo una versione di sviluppo e non è mai uscita come versione finale, quindi questa voce raccoglie tutte le novità dalla 0.2.3, più le correzioni emerse dai test. La prima volta che apri la 0.3.1, Pyxis aggiorna il tuo spazio di lavoro, e dopo Pyxis 0.2.3 o precedenti non riescono più ad aprirlo. Se pensi di voler tornare indietro, fai prima una copia di sicurezza da Impostazioni, alla voce Dati.

#### Configurazione

- In Impostazioni, sotto Profilo e interessi, c'è un nuovo pulsante "Rifai la configurazione". Riapre le schermate iniziali con nome, livello, anno, scuola, corso e scelta sulle segnalazioni dei crash già inseriti. Le scelte sui motori restano invariate.
- Quando rifai la configurazione non c'è Salta. Puoi annullare dalla prima schermata o tornare indietro da quella del profilo, e non viene salvato nulla finché non arrivi in fondo. L'ultima schermata dice "Configurazione aggiornata" e "Torna alle impostazioni" ti riporta a Profilo e interessi.
- Su macOS e Windows, Impostazioni mostrava Antigravity come "Accesso richiesto" anche quando avevi già fatto l'accesso, e rifarlo da Pyxis non finiva mai. Ora Pyxis chiede ad Antigravity stesso se hai fatto l'accesso.
- Annullare un accesso prima che si apra la sua pagina non mostra più "Accesso non completato". Se annulli e riprovi, il nuovo accesso va avanti.

#### Motori

- Pyxis ora imposta un livello di ragionamento per ogni funzione, anche quando il modello l'hai scelto tu. La chat e le mappe usano il livello basso, lezioni, quiz, schede e foto il medio, piani e correzioni l'alto. Un modello che non offre quel livello riceve il più vicino tra i suoi, e un modello senza livelli resta com'è.
- In Impostazioni, alla voce Motori AI, "Opzioni avanzate" ha un selettore "Livello di ragionamento" per ogni funzione. Parte da "Automatico" con il livello scelto da Pyxis, per esempio "Automatico · Medio". La tua scelta resta quando cambi modello. Se il nuovo modello non la offre, la riga lo dice e Pyxis usa il livello automatico. "Torna alla scelta automatica" cancella le tue scelte.
- Quando un motore non risponde, Pyxis ne dice il motivo invece di "Qualcosa non ha funzionato": hai chiuso la sessione, hai raggiunto il limite d'uso, il motore non è disponibile o ha restituito un errore. "Dettagli" mostra il testo del motore. Chiedi, lezioni, quiz, schede, correzioni e piani danno gli stessi messaggi.
- Pyxis non invia mai foto a Cursor Agent o ad Antigravity, perché non leggono le immagini. Chiedi legge invece il testo della foto sul tuo computer, e la scelta automatica non assegna loro l'attività sulle foto.
- Antigravity non ha un comando per uscire, quindi Impostazioni, alla voce Motori AI, non offre più "Esci dall'account" per lui. Ti dice di uscire da Antigravity stesso.
- "Testa" non invia più un livello di ragionamento che il modello non elenca.
- I pulsanti "Testa" e "Accedi" di ogni motore ora ne dicono il nome, così gli screen reader li distinguono.

#### Esami

- La scheda dei piani ha un'unica barra degli strumenti, come la scheda Fonti. Ha la casella di ricerca, il filtro per materia, il menu "Importa" e "Nuovo piano", l'unico pulsante pieno. "Importa" apre "Da un file .pyxis" e "Da un link". Se non hai ancora piani, vedi "Nuovo piano" e lo stesso menu.
- "Nessun piano ancora" non lampeggia più mentre i piani si caricano.
- Un'importazione di piani non riuscita non lascia più il suo errore visibile nelle schede Fonti e Flashcard.
- "Aggiungi al calendario" salva un file del calendario (.ics) per un esame alla volta. Usa il pulsante del calendario nell'intestazione di un piano, oppure lo stesso pulsante in "Impostazioni del piano". La pagina Esami non ha un pulsante che salvi tutti gli esami insieme.
- Ogni esame è un evento di un giorno intero con il titolo "Esame:" seguito dal titolo del piano, o "Exam:" se l'interfaccia è in inglese. La descrizione indica la materia, se il piano ne ha una. Ogni evento ha un promemoria alle 9:00 del giorno prima.
- Pyxis dà a ogni esame sempre lo stesso identificativo, quindi importare di nuovo il file dovrebbe aggiornare gli eventi invece di duplicarli.
- Un piano senza data, o con l'esame già passato, non ha il pulsante del calendario nell'intestazione. In "Impostazioni del piano" il pulsante è spento e ti dice perché. È spento anche finché hai cambiato la data senza salvarla ("Salva prima la nuova data.").

#### Flashcard

- Esami ha una nuova sezione, Schede, accanto a Fonti. Raccoglie in un posto solo tutte le schede di tutti i piani, 25 per pagina. Puoi aprirla anche dal menu Vai. Le schede di un argomento archiviato non compaiono, come nel ripasso.
- Le schede sono divise per materia, nell'ordine che hai scelto in "Gestisci materie". I piani senza materia vanno in fondo, sotto "Nessuna materia". Sotto ogni materia, un titolo indica l'esame e l'argomento.
- La ricerca ignora maiuscole e accenti, quindi "perche" trova "Perché". Ogni parola deve comparire sul davanti o sul dietro.
- Puoi filtrare per esame, per argomento dopo aver scelto un esame, e per "Tutte le schede", "In scadenza", "Sospese" o "Rimosse".
- Le schede con formule e le cloze si vedono come nel ripasso. Una cloze mostra la frase intera con le parole nascoste in grassetto. Ogni scheda dice se è nuova, in scadenza o quando è il prossimo ripasso, e ha l'etichetta Sospesa quando è in pausa.
- Ogni scheda ha "Modifica", "Sospendi" o "Riprendi", ed "Elimina". Modificare una scheda non cambia il calendario dei ripassi.
- Eliminare una scheda che hai scritto tu chiede conferma ed è definitivo. Eliminare una scheda preparata da Pyxis la toglie dai tuoi mazzi e dai ripassi, e puoi rimetterla da "Rimosse" con "Ripristina".
- Pyxis ora scrive un solo fatto, una definizione, una formula o un'idea su ogni scheda. Una scheda non ha più un intero esercizio davanti e la soluzione svolta dietro. Le schede scritte prima da Pyxis restano come sono.
- Gli esercizi non diventano più flashcard. Le schede di esercizi della 0.2.3 passano in "Rimosse" una sola volta, la prima volta che apri la 0.3.1. I tuoi ripassi restano. Rimettile a posto con "Ripristina". Una scheda ripristinata resta ripristinata, e le schede che hai scritto o modificato tu non vengono spostate.
- I pulsanti di valutazione nel ripasso sono "Da rivedere", "Difficile", "Bene" e "Facile". Non mostrano il numero del tasto né il tempo di attesa. I tasti da 1 a 4 valutano ancora, e il riepilogo del ripasso usa le stesse parole.

#### Studiare

- Sotto ogni esercizio, "Com'è andata?" mostra due pulsanti, "Ce l'ho fatta" e "Non ce l'ho fatta". Valutare è facoltativo e conta per i tuoi progressi come mezza risposta di un quiz. "Segna come fatto" funziona anche senza valutazione.
- Puoi cambiare la valutazione. Una valutazione data nelle ultime 6 ore resta scelta quando esci dalla pagina e ci torni. Dopo, l'esercizio riparte senza valutazione e una nuova valutazione conta come nuova.
- Le risposte della diagnosi, delle verifiche nelle lezioni e delle domande di riepilogo ora sono in ordine casuale, quindi la risposta giusta non sta sempre nello stesso posto. Anche ogni nuovo quiz mescola le sue risposte, e un tentativo mantiene il suo ordine. Le risposte che avevi dato prima restano sull'opzione che avevi scelto.
- Puoi rispondere a una verifica della lezione mentre la lezione è ancora in scrittura. Vedi subito il risultato, e la risposta conta quando la lezione è salvata. Se premi "Interrompi" o riscrivi la lezione, le risposte date sul testo incompleto vengono scartate senza errori.
- Le verifiche dell'introduzione ora contano sempre per i tuoi progressi.
- Clicca un passo finito del percorso per aprire quello che hai fatto, in sola lettura. Una lezione si apre come l'hai letta, anche se nel frattempo hai cambiato le impostazioni, e "Riscrivi una parte" è spento. Un quiz, un'esercitazione sulle lacune o una diagnosi si apre con le tue risposte, il punteggio e la data. Una simulazione si apre con la sua correzione. Ognuno ha "Rifai" per ricominciare, e non viene registrato nulla finché non consegni il nuovo tentativo.
- Gli esercizi si aprono con una nota e senza "Segna come fatto", e "Torna al percorso" ti riporta indietro. Le flashcard si aprono in modalità ripasso. Pyxis non scrive schede nuove, e un passo viene aggiunto solo se valuti una scheda.
- Un quiz, un'esercitazione, una diagnosi o una simulazione arrivati con un piano condiviso non hanno le risposte, perché i file dei piani non le includono. Compare "Le risposte di questo tentativo non erano incluse nel piano condiviso." con "Rifai" e "Torna al percorso".
- Un piano condiviso ora conserva le verifiche delle lezioni e dell'introduzione a cui hai risposto. Dopo l'importazione risultano già fatte, e rispondere di nuovo non conta due volte. I file di piano di prima si importano ancora.
- Dopo una lezione, il percorso resta su quell'argomento. Propone esercizi, poi un quiz, e così via, finché la tua padronanza dell'argomento arriva al 60% (o al tuo obiettivo di padronanza, se più basso) o hai svolto tre attività corrette su di esso. Se continui a sbagliare, il percorso va avanti dopo la terza.
- Se hai letto un argomento, non lo tocchi per 7 giorni e la padronanza è ancora sotto l'obiettivo, il percorso propone un quiz di ripasso prima del capitolo successivo. Le schede in scadenza oggi e le lacune serie restano prima.

#### Chiedi

- Nell'elenco Chat c'è una casella di ricerca. Cerca nei titoli delle chat e nel testo dei messaggi, senza badare a maiuscole e accenti, e ogni parola deve comparire nello stesso testo, in qualsiasi ordine. Se trova un messaggio, mostra sotto il titolo un breve brano con il testo trovato in grassetto.
- La ricerca salta quello che non vedi mai: i suggerimenti di approfondimento, i blocchi di verifica e i segni come [P1]. Esc svuota la casella prima di chiudere l'elenco.
- Il menu di ogni chat ha "Esporta come Markdown" e "Esporta come PDF". Il file ha il titolo della chat e poi ogni messaggio in ordine, con chi l'ha scritto. Ogni risposta finisce con le sue fonti e una risposta interrotta è segnata come tale. Le foto sono numerate, non hanno il nome, perché Pyxis non conserva i nomi dei file. Le etichette seguono la lingua dell'interfaccia.
- Se esporti una chat nata da un brano o da una risposta, il file ora include quel contesto sotto il titolo.
- Su un computer lento, i suggerimenti di approfondimento dopo una risposta potevano finire sotto la parte visibile, e la pagina smetteva di seguire la chat per sempre. Ora il contenuto più recente resta in vista. Se scorri in su per leggere un messaggio precedente, la pagina continua a non saltare.
- I suggerimenti di approfondimento conservano i primi caratteri. "3D integrals" non perde più il "3".
- "Riprova" mantiene la tua scelta di "Rispondi con le conoscenze generali".
- Rinominare una chat non la sposta più in cima all'elenco, e premere Invio nella casella di ridenominazione salva una volta sola.

#### Fonti

- Quando un libro PoliTost gratuito che hai aggiunto ha una versione più recente, la pagina Fonti dice "Nuova versione disponibile:" con il numero di versione e offre "Aggiorna". L'elenco dei libri gratuiti mostra "Nuova versione disponibile" e "Aggiorna" al posto di "Aggiungi". Pyxis cerca nuove versioni solo mentre una di queste due pagine è aperta.
- Il libro resta la stessa fonte, quindi piani, schede e citazioni continuano a funzionare. Se un piano usa il libro, Pyxis chiede conferma prima di aggiornarlo, e se rifiuti non scarica nulla.
- L'aggiornamento va avanti nelle attività in background e puoi annullarlo. Se non riesce o lo annulli, resta in uso la versione precedente.
- Le lezioni e i quiz che citano un testo cambiato sono segnati come non aggiornati. Le citazioni di testo rimasto uguale no. I piani che usano il libro suggeriscono "Ricostruisci gli argomenti", che aggiunge i nuovi capitoli.

#### App

- I programmi di installazione sono più piccoli. Su Linux l'AppImage passa da 528 MB a 180 MB e il pacchetto .deb da 372 MB a 141 MB, rispetto alla versione di sviluppo 0.3.0. Anche quelli per macOS e Windows lasciano fuori i file che Pyxis non usa mai.
- Pyxis ha un menu su Windows, macOS e Linux, in italiano o in inglese. Segue la lingua dell'interfaccia e cambia quando la cambi in Impostazioni. Su Windows e Linux la barra dei menu resta nascosta finché non premi Alt. Su macOS, Impostazioni è nel menu dell'app.
- File ha "Nuovo esame" (Ctrl o Cmd+N), "Nuova chat" (Ctrl o Cmd+Maiusc+N) e, su Windows e Linux, "Impostazioni" (Ctrl+,). Vai ha "Chiedi", "Esami", "Libreria" e "Flashcard" (Ctrl o Cmd+da 1 a 4), e "Indietro" (Alt+Freccia sinistra, o Cmd+[ su macOS). Vista ha "Ingrandisci", "Riduci" e "Dimensioni reali".
- Aiuto ha "Scorciatoie da tastiera" (Ctrl o Cmd+/), "Cerca aggiornamenti", "Segnala un problema" e "Informazioni". "Cerca aggiornamenti" apre Impostazioni, alla voce Aggiornamenti, e controlla subito. "Segnala un problema" apre il modulo delle segnalazioni su GitHub.
- "Scorciatoie da tastiera" elenca i tasti del menu e quelli che c'erano già in Chiedi, nelle schede, nei quiz, nelle simulazioni e nella lavagna. Si apre anche durante un quiz, così puoi controllare un tasto.
- Un comando del menu non fa nulla mentre sei nella configurazione, è aperta una finestra, stai rispondendo a un quiz o facendo una simulazione, la procedura guidata del piano contiene le tue risposte, o un campo di testo ha del testo che perderesti. La casella di Chiedi fa eccezione perché conserva una bozza per ogni chat.

#### Aggiornamenti e copie

- Quando esiste una versione stabile più recente, Impostazioni (alla voce Aggiornamenti) e l'avviso di aggiornamento offrono "Scarica e installa" accanto a "Apri la pagina della versione". Non viene scaricato nulla finché non lo premi.
- Pyxis scarica da GitHub il programma di installazione per il tuo computer e ne controlla dimensione e checksum con la versione prima di usarlo. Vedi una barra di avanzamento e "Annulla il download". Se il controllo non riesce, Pyxis elimina il file, dice perché e offre "Riprova" e "Apri la pagina della versione".
- Questo controllo trova un download danneggiato. Non sostituisce una firma: il checksum arriva dalla stessa versione su GitHub, e i programmi di installazione non sono firmati con un certificato di sviluppatore.
- Su macOS, Pyxis apre l'immagine disco nel Finder. Esci da Pyxis ("Esci da Pyxis"), trascina PoliTost Pyxis in Applicazioni, scegli Sostituisci e riaprilo. "Riapri l’immagine disco" la apre di nuovo se l'hai chiusa.
- Su Windows, "Chiudi Pyxis e installa" prima chiude Pyxis e fa partire il programma di installazione quando Pyxis è uscito, così non lo trova mai ancora in esecuzione. Premere il pulsante due volte non avvia due installazioni.
- Su Linux con AppImage, Pyxis sostituisce il file al suo posto e offre "Riavvia Pyxis". Se non può scrivere in quella cartella, apre la cartella del nuovo file e lo sposti tu al posto del vecchio.
- Su Linux con pacchetto .deb, Pyxis si limita ad aprire la cartella con il file scaricato, e lo apri tu con il programma che installa il software. Windows e Linux su Arm non hanno un programma di installazione, quindi Pyxis ti manda alla pagina della versione.
- Se Windows non riesce a svuotare la cartella dei download, Pyxis lo registra e mostra l'aggiornamento come non riuscito. Non resta più bloccato nel download.
- "Controlla aggiornamenti" in Impostazioni e "Cerca aggiornamenti" nel menu Aiuto ora interrogano di nuovo GitHub invece di mostrare una risposta precedente. Se lo premi di nuovo entro un minuto, vedi l'ultima risposta.
- Pyxis aspetta se è in corso una copia, un ripristino o uno spostamento. Se ci sono attività in background, prima chiede "Chiudere Pyxis con attività in corso?". Le attività si fermano e potrai riprenderle quando riapri Pyxis.
- Pyxis ora fa da solo la copia del tuo spazio di lavoro, al massimo una volta al giorno e solo mentre è aperto. Scrive uno ZIP in una cartella "Pyxis backups" dentro Documenti e tiene le 3 copie più recenti. Puoi continuare a studiare mentre lavora. "Ripristina" accetta queste copie come qualsiasi altra.
- In Impostazioni, alla voce Dati, c'è una nuova sezione "Copie automatiche". È attiva in modo predefinito. Ha l'interruttore "Copia di sicurezza automatica", "Cambia cartella", "Apri cartella", l'ora e la dimensione dell'ultima copia e "Copia ora", che salva nella stessa cartella. "Cambia cartella" rifiuta una cartella dentro il tuo spazio di lavoro o dentro i dati di Pyxis, perché una copia lì andrebbe persa insieme a loro, e una cartella in cui Pyxis non può scrivere.
- Quando una copia automatica non riesce, in un angolo compare un avviso con il motivo e un pulsante "Impostazioni copie". I motivi sono: la cartella non c'è, per esempio un disco scollegato, mancano i permessi, il disco è pieno, ci sono troppi file, oppure lo spazio di lavoro supera il limite di 2 GB di una copia. Un avviso che chiudi non torna fino alla prossima sessione. Uno spazio di lavoro troppo grande viene segnalato una sola volta, non a ogni avvio, e Pyxis riprova ogni giorno.
- Al primo avvio, la prima copia automatica ora aspetta che Pyxis abbia finito di avviarsi. Prima poteva non riuscire e poi aspettare un'ora prima di riprovare.
- Una copia non parte più mentre Pyxis si sta chiudendo. Spostare indietro l'orologio non può cancellare la copia appena fatta. Se cambi cartella durante una copia, la nuova cartella fa subito la sua prima copia.
- "Cancella tutti i dati" non cancella le copie automatiche. Restano nella cartella indicata sotto Dati. Lo dicono il testo sotto il pulsante e la riga che compare quando lo premi. Cancellale da lì se non le vuoi più.

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

- Pyxis no longer picks "Within 10 days" for you. Nothing is selected on the exam step, and Continue waits until you choose. Before, every plan got a deadline whether you had one or not.
- If your exam has no date yet, choose "No date yet". The plan has no deadline, and you can add the date later in the plan's settings.
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

- Pyxis non sceglie più "Entro 10 giorni" al posto tuo. Nel passo dell'esame non c'è nulla di selezionato e Continua aspetta la tua scelta. Prima ogni piano riceveva una scadenza, che tu l'avessi o no.
- Se il tuo esame non ha ancora una data, scegli "Nessuna data per ora". Il piano non ha scadenza e puoi aggiungere la data dopo nelle impostazioni del piano.
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
