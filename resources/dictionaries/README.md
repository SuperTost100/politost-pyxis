# Spelling dictionaries

The spell checker on Windows and Linux uses these two Hunspell dictionaries, which ship next to `app.asar` in the installers. Main copies them into the profile's `Dictionaries` folder before Chromium looks there, so Chromium never downloads one. [`src/main/spellcheck.ts`](../../src/main/spellcheck.ts) has the mechanism, and macOS ships neither file because it uses the system's checker.

| File              | Language     | Size          | SHA-256                                                            |
| ----------------- | ------------ | ------------- | ------------------------------------------------------------------ |
| `it-IT-3-0.bdic`  | Italian      | 983,219 bytes | `8b83a0d4bba4cfcd4a4e7ee89b703014a00a5c08e721e568a5c552a732827fff` |
| `en-US-10-2.bdic` | English (US) | 451,982 bytes | `b0d80e6b6c5491879365e176ecbd98074602a663429bcfcfb0a5a8375c051f13` |

`src/main/spellcheck.test.ts` checks both sums, and the packaged-app check in `tests/e2e/window.spec.ts` checks them in the built app.

## Where they come from

Both files are byte for byte the ones in `hunspell_dictionaries.zip` of the [Electron 45.3.0 release](https://github.com/electron/electron/releases/tag/v45.3.0), the Electron version Pyxis pins. That zip's SHA-256, `36e7ca1a00d2ef7489abd1ccdcb0bd66e4b7ff8f2aa0f39f4081a7a35ce99566`, matches the release's `SHASUMS256.txt`.

The zip holds Chromium's own files. Electron 45.3.0 runs Chromium 156.0.8078.96, whose `DEPS` pins [`chromium/deps/hunspell_dictionaries`](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/cee14e319bb7603a1157bb4d1e216be64ee82b77) at revision `cee14e319bb7603a1157bb4d1e216be64ee82b77`, and both `.bdic` files at that revision have the same SHA-256 as the copies here. Chromium builds each `.bdic` from the language's `.aff`, `.dic` and `.dic_delta` files with its `convert_dict` tool (`chrome/tools/convert_dict`).

The number in each file name is the dictionary's format version. Chromium looks for exactly that name, so a new Electron whose Chromium renames a file needs the new file here and in `BUNDLED_DICTIONARIES`. Until then the spelling checks in `tests/e2e/network.spec.ts` and `window.spec.ts` fail.

## Licences

| Dictionary   | Upstream                                                              | Licence                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Italian      | "Dizionario italiano" 2.4 (2007) by Gianluca Turconi and Davide Prina | GPL-3.0-or-later, as the header of `it_IT.aff` says. Chromium's `README_it_IT.txt` describes the older 2.2 release as GPL 2.0 or later.                                  |
| English (US) | Kevin Atkinson's SCOWL word lists, version 2020.12.07                 | A permissive notice that asks for the copyright and permission notices in every copy. `README_en_US.txt` holds them, with the notices of the word lists SCOWL builds on. |

The notices in Settings and `docs/THIRD-PARTY-NOTICES.txt` carry the full texts, recorded in `resources/third-party-notices.json`: the Italian licence header, `README_it_IT.txt` and the GNU GPL version 3, and the English `README_en_US.txt`.

The Italian dictionary's source, which the GPL asks to make available with the compiled `.bdic` file, is in [`source/`](source/): `it_IT.aff`, `it_IT.dic` and `it_IT.dic_delta`, unchanged from Chromium's revision above. The installers come from this repository's GitHub releases, so the source is offered from the same place.

| Source file              | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `source/it_IT.aff`       | `3b949c06c73d29432f17777986d901b21ab03556748b1bec03c42ada9f67e2c9` |
| `source/it_IT.dic`       | `02e16bee63777739d404755276d04c4949435cebdcae62f152bba605230de3d5` |
| `source/it_IT.dic_delta` | `14d707a0b83cbb35b8c9f376369e86ac164fd5431ca0342506a6213a42eb4391` |

The dictionary is data that Chromium's spell checker reads at run time. Pyxis's own code doesn't contain it or derive from it, so the dictionary sits beside the MIT-licensed app as a separate work, which the GPL calls an aggregate, and the GPL applies to the dictionary only.
