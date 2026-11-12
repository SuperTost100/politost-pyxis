# File kinds

Every file in the Library has one of seven kinds, and its cover is drawn by that kind. The kind comes from fixed rules on what Pyxis already stores about the file. No model is asked and nothing goes over the network, so the same file gets the same kind on every machine. The student can change it from the file's menu ("Tipo"), and that choice is kept.

The rules live in [`src/shared/file-kind.ts`](../src/shared/file-kind.ts) and the subject symbols in [`src/shared/subject-symbol.ts`](../src/shared/subject-symbol.ts). Core computes the kind for `sources.list`, and the window reads the same module for the kind names. Their tests read as tables: `file-kind.test.ts` with 57 real file names and `subject-symbol.test.ts` with 36 subjects.

## The seven kinds

| Kind        | Italian      | Cover                                                       |
| ----------- | ------------ | ----------------------------------------------------------- |
| `book`      | Libro        | A book in the subject's colour, with the subject's symbol   |
| `slides`    | Slide        | Two slides with a title, bullets and a small chart          |
| `exam`      | Tema d'esame | Two stapled sheets with a coloured header and numbered dots |
| `notes`     | Appunti      | A spiral notebook with a label                              |
| `exercises` | Esercizi     | A sheet with a folded corner, ticked boxes and lines        |
| `photo`     | Foto         | A photo of a blackboard                                     |
| `handout`   | Dispensa     | A stapled handout tinted in the subject's colour            |

## What the rule reads

| Input           | Where it comes from                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------- |
| File type       | `sources.kind`: `pdf`, `docx`, `pptx`, `text`, `image`, `smartbook`, `excerpt`                    |
| Name            | `sources.title`, the file's name without the extension                                            |
| Past paper      | An exam uses the file as a past exam paper (`plan_sources.role = 'past_paper'`)                   |
| Link            | `sources.origin_url`, set for a page saved from a link                                            |
| Folders         | For a linked file, the folders between the linked folder and the file (`linked_files.rel_path`)   |
| Folder material | The kinds of material setup found in the file's linked subfolder (`linked_subfolders.kinds_json`) |
| Pages           | The last page number among the passages of the file's current version                             |
| Student's kind  | `sources.chosen_kind`, set from the menu (migration 31)                                           |

## The order of the tests

The first test that answers decides.

1. The student chose a kind: that kind.
2. A free PoliTost book (`smartbook`): **book**.
3. An exam uses the file as a past paper: **exam**.
4. An image: **photo**, whatever its name says, since the cover shows a photo.
5. A PowerPoint file (`pptx`): **slides**.
6. A strong word in the name (table below): the kind of the leftmost one. An Italian name starts with what the file is, so "Esercizi d'esame svolti" is exercises and "Temi d'esame con soluzioni" an exam paper.
7. A strong word in a folder's name, from the file's own folder outwards: "Fisica 2/Esercitazioni/03.pdf" is exercises.
8. A weak word in the name, then in a folder's name.
9. A linked subfolder where setup found one kind of material only: that kind.
10. Text the student wrote or pasted (`text` or `excerpt` with no link): **notes**.
11. A PDF or Word file of 150 pages or more: **book**.
12. A PDF or Word file named "Authors - Title": **book** (see below).
13. Anything else: **handout**.

## The words

Names and folders are folded first: lower case, no accents, every run of anything but letters and digits one space, and letters split from digits ("Lez07" reads "lez 07", "appunti_fisica2" reads "appunti fisica 2"). A word matches whole.

| Kind        | Strong words                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exam`      | tema, temi, esame, esami, appello, appelli, prova, prove, compito, compiti, compitino, compitini, scritto, scritti, itinere, exam, exams, midterm, midterms, past paper(s) |
| `slides`    | slide, slides, lucidi, trasparenze, presentazione, presentazioni, presentation(s)                                                                                          |
| `notes`     | appunti, appunto, note, notes, riassunto, riassunti, sunto, sunti, sintesi, summary, summaries, schemi, quaderno, notebook                                                 |
| `exercises` | esercizi, esercizio, esercitazione, esercitazioni, eserciziario, problemi, exercise(s), problem(s), problem set(s), homework, worksheet(s)                                 |
| `handout`   | dispensa, dispense, handout(s), formulario, formulari, cheat sheet, formula sheet                                                                                          |
| `book`      | libro, libri, manuale, textbook, book, ebook, volume, edizione, edition                                                                                                    |

| Kind        | Weak words                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `slides`    | lezione, lezioni, lecture(s), lez, lect, only with a number after it ("Lezione 6", "Lez07")         |
| `exercises` | soluzione, soluzioni, solution(s), tutorato, tutoraggio, and serie or foglio with a number after it |

A weak word loses to any strong word, so "Appunti lezione 5" is notes and "Lezione 06 - slide" slides. A lecture word needs a number because "Lezioni di analisi matematica" is often a book title, and "serie" needs one because "Serie di Fourier" is a topic.

## Telling a book from a handout

A file with no word that names its kind is a book when either of these holds, and a handout otherwise:

- **It has 150 pages or more.** Pyxis stores no page count, but every passage of a PDF keeps the page it came from, so the last page among them is the file's length. Lecture notes, handouts and exercise sheets in Italian courses run from a few pages to about a hundred, while a textbook runs from about 250 to 900 pages, so 150 sits between the two. A file not yet read has no pages and is a handout until its read ends. A Word file has no page numbers, so only its name can make it a book.
- **Its name reads "Authors - Title"**, as a downloaded book is often named: one to four capitalised words before a dash, none of them a subject word (analisi, fisica, informatica...) or a kind word. "Bramanti Pagani Salsa - Analisi matematica 1" is a book, "Analisi Matematica - Limiti" is not.

The fallback is a handout because a PDF a lecturer hands out is the most common file in a course folder.

## The symbol on a book

A book's cover carries a small drawing for its subject, chosen from the subject's name (or the book's own title when it has no subject yet). The words of the name are folded as above and compared with the stems below, entry by entry: the first entry with a word that starts with one of its stems wins. A stem written `=word` must be the whole word. The more specific entries come first, so "Storia del cinema" is cinema and "Architettura dei calcolatori" a chip. A name no stem fits gets its initials: the first letter of each word that is not a small word (di, del, e, and, of...), a number kept whole, at most three characters ("Sociologia dei media" is SM, "Laboratorio 2" is L2).

| Symbol       | Stems                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| clapperboard | cinem, film, audiovisiv, regia                                                                                |
| music        | music, armonia, solfeggi                                                                                      |
| palette      | =arte, =art, pittur, scultur                                                                                  |
| chip         | elettronic, electronic, digital, calcolator, microcontroll, embedded, hardware, semicondutt                   |
| code         | informatic, programmazion, programming, software, algoritm, computer, database, =basi, python, =java, coding  |
| network      | =reti, =rete, network, telecomunicazion, internet                                                             |
| bolt         | elettrotecnic, elettric, electric, circuit, energ                                                             |
| wave         | elettromagnet, =onde, ottica, acustic, segnal, signal, =waves, fotonic                                        |
| atom         | fisic, physic, quantist, quantum, nuclear                                                                     |
| flask        | chimic, chemi, biochim                                                                                        |
| dna          | biolog, genetic, botanic, zoolog, ecolog, biotecnolog, microbiolog                                            |
| pulse        | medicin, anatomi, fisiolog, farmacolog, patolog, infermierist, clinic                                         |
| brain        | psicolog, psycholog, neuroscien, cognitiv, pedagog                                                            |
| dice         | statistic, probabilit, stocastic, probability                                                                 |
| integral     | analisi, calcolo, calculus, matematic, mathemat                                                               |
| matrix       | algebr, matric, matrix                                                                                        |
| compass      | geometri, geometry, topolog, trigonometr                                                                      |
| pencil       | disegn, design, grafic, rappresentazion, drawing                                                              |
| gear         | meccanic, mechanic, macchin, automazion, automatic, controll, robot, material, impiant, industrial, ingegneri |
| building     | architett, architect, urbanistic, ediliz, costruzion                                                          |
| chart        | econom, finanz, financ, marketing, management, gestion, aziendal, contabilit, business, impresa               |
| scales       | diritt, giurisprud, giuridic, =legge, =law, legal, costituzional                                              |
| globe        | geografi, geograph, geopolitic, internazional, politic                                                        |
| column       | stori, history, archeolog, antichit                                                                           |
| quill        | letteratur, literatur, filolog, filosofi, philosoph, poesia, =italiano                                        |
| speech       | lingu, ingles, english, frances, tedesc, spagnol, cines, giappones, russo, glottolog, traduzion, comunicazion |

The drawings are the app's own icons (Lucide, in `FileCover.tsx`), except the integral and the matrix, which the set lacks and which are drawn on the same 24-unit grid with the same stroke.

## The student's choice

"Tipo" in a file's menu, opened by its dots or a right-click, lists the seven kinds with the current one checked. Choosing one calls `sources.setKind`, which stores it in `sources.chosen_kind`. From then on the rules are not asked for that file: a new name, a new reading of a linked file and a Library copy that a linked file takes over keep the same source row, and so the choice. There is no way back to the computed kind in this version; choosing the kind the rule gave stores it like any other.
