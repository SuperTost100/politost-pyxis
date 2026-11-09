# Copy

Every word on screen is part of the design. Pyxis talks like a calm tutor who sits beside you: plain words, sentence case, the specific thing.

| Rule                                       | Non così                            | Così                                                                       |
| ------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------- |
| Say plainly what is happening              | Elaborazione in corso…              | Sto leggendo le slide del corso                                            |
| A button names its action                  | OK                                  | Crea l'esame                                                               |
| Headings say what is there                 | Impostazioni generali               | Come ti spiega                                                             |
| No filler badges                           | Lezione «Moto nel piano» NUOVO · AI | Lezione «Moto nel piano»                                                   |
| No labels the layout already gives         | Stato: completato                   | Finita alle 10:42                                                          |
| Sentence case                              | Nuova Flashcard                     | Nuova flashcard                                                            |
| An error says what happened and the fix    | Errore 429                          | Gemini ha finito le richieste per oggi. Falle con Claude o aspetta domani. |
| The names people know                      | Codex, schede                       | ChatGPT, flashcard                                                         |
| No dashes as punctuation; «» around titles | Lezione - Moto nel piano            | Lezione «Moto nel piano»                                                   |
| Italian numbers                            | 12/37 · 2.4GB                       | 12 di 37 · 2,4 GB                                                          |

No emoji in the interface.

## Italian and English, in step

- Write the Italian first. The English says the same thing in natural English, not word for word.
- Both locale files (`src/renderer/src/locales/it.json` and `en.json`) change in the same pull request. A key that exists in only one language fails review.
- Italian runs about 20% longer, so every screen is checked in Italian at 960px.
- _Tu_ in Italian and _you_ in English, never the formal _Lei_.
