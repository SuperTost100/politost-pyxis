import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { chunkText } from "./chunk";
import { retrieve } from "./retrieve";

// SRC-23 with the pinned multilingual-e5-small, run in-process with the same settings as embed-worker.ts.
// Needs the model in PYXIS_E5_DIR or .tmp/e5 and skips without it.
const modelDir = resolve(process.env.PYXIS_E5_DIR ?? ".tmp/e5");
const have = existsSync(join(modelDir, "onnx", "model_quantized.onnx"));

const physicsIt = [
  "La seconda legge di Newton afferma che la forza risultante applicata a un corpo è uguale al prodotto della sua massa per l'accelerazione. Se la forza è nulla il corpo mantiene il proprio stato di moto.",
  "Un blocco su un piano inclinato di angolo θ è soggetto alla forza peso, alla reazione normale e all'attrito. La componente del peso parallela al piano vale mg sin θ e determina l'accelerazione lungo il piano.",
  "Il teorema dell'energia cinetica dice che il lavoro della forza risultante è uguale alla variazione di energia cinetica del corpo. L'energia cinetica di una massa m con velocità v è un mezzo di m per v al quadrato.",
  "In assenza di forze dissipative l'energia meccanica totale, somma di energia cinetica e potenziale, si conserva. Un pendolo scambia continuamente energia potenziale gravitazionale ed energia cinetica.",
  "Nell'urto elastico si conservano sia la quantità di moto sia l'energia cinetica. Nell'urto completamente anelastico si conserva solo la quantità di moto e i due corpi restano uniti dopo l'urto.",
  "Il momento angolare di un corpo rigido che ruota attorno a un asse fisso è il prodotto del momento d'inerzia per la velocità angolare. In assenza di momenti esterni il momento angolare si conserva.",
  "Nel moto rettilineo uniformemente accelerato la velocità varia linearmente nel tempo e lo spazio percorso cresce con il quadrato del tempo. Il grafico velocità-tempo è una retta.",
  "Il moto circolare uniforme ha velocità di modulo costante ma direzione variabile. L'accelerazione centripeta vale v al quadrato diviso il raggio ed è diretta verso il centro della traiettoria.",
  "La forza di gravitazione universale tra due masse è proporzionale al prodotto delle masse e inversamente proporzionale al quadrato della distanza. La costante G vale circa 6,67 per 10 alla meno 11.",
  "Il lavoro di una forza costante è il prodotto scalare della forza per lo spostamento. La potenza è il lavoro compiuto nell'unità di tempo e si misura in watt.",
];
const physicsEn = [
  "Newton's second law states that the net force on a body equals its mass times its acceleration. With no net force the body keeps its state of motion.",
  "The work-energy theorem says the work done by the net force equals the change in kinetic energy. Kinetic energy is one half of mass times velocity squared.",
  "Mechanical energy is conserved when only conservative forces act. A pendulum continually trades gravitational potential energy for kinetic energy and back.",
  "In an elastic collision both momentum and kinetic energy are conserved. In a perfectly inelastic collision only momentum is conserved and the bodies stick together.",
  "Uniformly accelerated motion has a velocity that changes linearly with time, and the displacement grows with the square of the time elapsed.",
  "Angular momentum of a rigid body about a fixed axis is the moment of inertia times the angular velocity, and it is conserved when no external torque acts.",
  "Uniform circular motion has constant speed but changing direction. The centripetal acceleration is v squared over r and points toward the centre.",
  "Gravity between two masses is proportional to the product of the masses and inversely proportional to the square of the distance between them.",
];
const mathIt = [
  "La derivata di una funzione in un punto è il limite del rapporto incrementale. La derivata di una funzione composta si calcola con la regola della catena: si deriva la funzione esterna e si moltiplica per la derivata di quella interna.",
  "L'integrale definito di una funzione continua su un intervallo misura l'area con segno sotto il grafico. Il teorema fondamentale del calcolo integrale collega integrale e derivata.",
  "Una matrice quadrata è invertibile se e solo se il suo determinante è diverso da zero. Il rango di una matrice è il numero massimo di righe linearmente indipendenti.",
  "Una successione converge a un limite L se per ogni epsilon positivo esiste un indice oltre il quale i termini distano da L meno di epsilon. Le serie geometriche convergono se la ragione ha modulo minore di uno.",
  "Un sistema lineare con n equazioni e n incognite ha una sola soluzione quando la matrice dei coefficienti è invertibile. Il metodo di eliminazione di Gauss riduce il sistema a forma triangolare.",
  "Gli autovalori di una matrice sono le radici del polinomio caratteristico. Un autovettore viene solo scalato dalla trasformazione lineare associata.",
];

// A real extraction cuts a section into chunks of up to 1,400 characters (chunk.ts), so each passage mixes
// neighbouring ideas. Both shapes are measured: the short one flatters the vectors, the chunked one is what a book gives.
const shapes: Record<string, (texts: string[]) => string[]> = {
  short: (texts) => texts,
  chunked: (texts) => chunkText(texts.join(" ")).map((chunk) => chunk.text),
};
const corpora = { it: physicsIt, en: physicsEn, math: mathIt };

type Query = {
  text: string;
  source: "it" | "en" | "math";
  expect: "related" | "unrelated";
  group: string;
};
const queries: Query[] = [
  {
    group: "related IT",
    source: "it",
    expect: "related",
    text: "Come si calcola l'accelerazione di un blocco su un piano inclinato?",
  },
  {
    group: "related IT",
    source: "it",
    expect: "related",
    text: "Che cos'è il teorema dell'energia cinetica?",
  },
  {
    group: "related IT",
    source: "it",
    expect: "related",
    text: "Spiegami la conservazione della quantità di moto negli urti",
  },
  {
    group: "related IT",
    source: "it",
    expect: "related",
    text: "momento angolare di un corpo rigido",
  },
  {
    group: "related IT",
    source: "it",
    expect: "related",
    text: "Perché un pendolo conserva l'energia?",
  },
  {
    group: "related EN",
    source: "en",
    expect: "related",
    text: "What is Newton's second law?",
  },
  {
    group: "related EN",
    source: "en",
    expect: "related",
    text: "How does conservation of energy work for a pendulum?",
  },
  {
    group: "related EN",
    source: "en",
    expect: "related",
    text: "Explain elastic versus inelastic collisions",
  },
  {
    group: "related EN",
    source: "en",
    expect: "related",
    text: "centripetal acceleration in circular motion",
  },
  {
    group: "related cross",
    source: "it",
    expect: "related",
    text: "What is the work-energy theorem?",
  },
  {
    group: "related cross",
    source: "en",
    expect: "related",
    text: "Qual è la legge di gravitazione universale?",
  },
  {
    group: "unrelated IT",
    source: "it",
    expect: "unrelated",
    text: "Come si prepara la carbonara?",
  },
  {
    group: "unrelated IT",
    source: "it",
    expect: "unrelated",
    text: "Chi era Giulio Cesare e cosa fece al Rubicone?",
  },
  {
    group: "unrelated IT",
    source: "it",
    expect: "unrelated",
    text: "Qual è la capitale dell'Australia?",
  },
  {
    group: "unrelated IT",
    source: "it",
    expect: "unrelated",
    text: "Come si coltivano i pomodori sul balcone?",
  },
  {
    group: "unrelated IT",
    source: "it",
    expect: "unrelated",
    text: "Chi ha vinto il campionato di calcio quest'anno?",
  },
  {
    group: "unrelated IT",
    source: "it",
    expect: "unrelated",
    text: "Riassumi la trama dei Promessi Sposi",
  },
  {
    group: "unrelated EN",
    source: "en",
    expect: "unrelated",
    text: "What is the best way to train for a marathon?",
  },
  {
    group: "unrelated EN",
    source: "en",
    expect: "unrelated",
    text: "Who won the football league title on Sunday?",
  },
  {
    group: "unrelated EN",
    source: "en",
    expect: "unrelated",
    text: "How do I write a quarterly marketing plan?",
  },
  {
    group: "unrelated EN",
    source: "en",
    expect: "unrelated",
    text: "What is the capital of Australia?",
  },
  {
    group: "unrelated EN",
    source: "en",
    expect: "unrelated",
    text: "Summarise the plot of Romeo and Juliet",
  },
  {
    group: "math vs math",
    source: "math",
    expect: "related",
    text: "Come si calcola la derivata di una funzione composta?",
  },
  {
    group: "math vs math",
    source: "math",
    expect: "related",
    text: "Cos'è il determinante di una matrice?",
  },
  {
    group: "math vs math",
    source: "math",
    expect: "related",
    text: "How do I find eigenvalues of a matrix?",
  },
  {
    group: "math vs physics",
    source: "it",
    expect: "unrelated",
    text: "Come si calcola la derivata di una funzione composta?",
  },
  {
    group: "math vs physics",
    source: "it",
    expect: "unrelated",
    text: "Cos'è il determinante di una matrice?",
  },
  {
    group: "math vs physics",
    source: "en",
    expect: "unrelated",
    text: "How do I find eigenvalues of a matrix?",
  },
  {
    group: "physics vs math",
    source: "math",
    expect: "unrelated",
    text: "Che cos'è il teorema dell'energia cinetica?",
  },
  {
    group: "physics vs math",
    source: "math",
    expect: "unrelated",
    text: "What is Newton's second law?",
  },
];

describe.skipIf(!have)(
  "SRC-23 no-coverage answer with the pinned e5 model",
  () => {
    const db = openDatabase(":memory:");
    const vectors = new Map<string, Float32Array>();
    let embed: (text: string) => Float32Array = () => {
      throw new Error("model not loaded");
    };
    let dispose = async () => {};

    beforeAll(async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useFSCache = false;
      const extractor = await pipeline("feature-extraction", modelDir, {
        dtype: "q8",
        device: "cpu",
      });
      dispose = () => extractor.dispose();
      const wanted = [
        ...Object.values(shapes)
          .flatMap((shape) =>
            Object.values(corpora).flatMap((texts) => shape(texts)),
          )
          .map((text) => `passage: ${text}`),
        ...queries.map((entry) => `query: ${entry.text}`),
      ];
      for (const text of wanted) {
        const out = await extractor(text, { pooling: "mean", normalize: true });
        vectors.set(text, Float32Array.from(out.data as Float32Array));
      }
      embed = (text) =>
        vectors.get(text) ??
        (() => {
          throw new Error(`not precomputed: ${text}`);
        })();
      const sources: Array<[string, string[]]> = Object.entries(shapes).flatMap(
        ([shape, cut]) =>
          Object.entries(corpora).map(
            ([name, texts]) =>
              [`${name}:${shape}`, cut(texts)] as [string, string[]],
          ),
      );
      for (const [sourceId, texts] of sources) {
        db.prepare(
          `INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES (?, 'text', ?, 'ready', 1, 1)`,
        ).run(sourceId, sourceId);
        db.prepare(
          `INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES (?, ?, 1, '{}', 1)`,
        ).run(`doc-${sourceId}`, sourceId);
        texts.forEach((text) => {
          const id = uuidv7();
          db.prepare(
            `INSERT INTO passages (id, source_id, document_id, version, text, created_at) VALUES (?, ?, ?, 1, ?, 1)`,
          ).run(id, sourceId, `doc-${sourceId}`, text);
          const row = db
            .prepare(`SELECT rowid AS n FROM passages WHERE id = ?`)
            .get(id) as { n: number };
          db.prepare(
            `INSERT INTO passages_vec (passage_rowid, embedding) VALUES (?, ?)`,
          ).run(
            BigInt(row.n),
            Buffer.from(vectors.get(`passage: ${text}`)!.buffer),
          );
        });
      }
    }, 120_000);
    afterAll(async () => {
      await dispose();
      db.close();
    });

    const measured = () =>
      Object.keys(shapes).flatMap((shape) =>
        queries.map((entry) => {
          const sourceId = `${entry.source}:${shape}`;
          const q = vectors.get(`query: ${entry.text}`)!;
          const best = Math.min(
            ...shapes[shape]!(corpora[entry.source]).map((text) => {
              const v = vectors.get(`passage: ${text}`)!;
              let d = 0;
              for (let i = 0; i < v.length; i++) d += (v[i]! - q[i]!) ** 2;
              return Math.sqrt(d);
            }),
          );
          return {
            shape,
            group: entry.group,
            query: entry.text.slice(0, 40),
            l2: Math.round(best * 1000) / 1000,
            lexical: retrieve(db, entry.text, { sourceIds: [sourceId] })
              .covered,
            covered: retrieve(db, entry.text, { sourceIds: [sourceId], embed })
              .covered,
          };
        }),
      );
    const group = (rows: ReturnType<typeof measured>, name: string) =>
      rows.filter((row) => row.group === name);

    it("covers every same-language question the source answers, in Italian, English and maths", () => {
      const rows = measured();
      if (process.env.PYXIS_SHOW_TABLE) console.table(rows);
      const related = ["related IT", "related EN", "math vs math"]
        .flatMap((name) => group(rows, name))
        .filter((row) => !row.query.startsWith("How do I find eigen"));
      expect(related.length).toBe(22);
      expect(related.filter((row) => !row.covered)).toEqual([]);
    });

    it("says the material does not cover unrelated Italian and English questions, with passages short or chunked", () => {
      const rows = measured();
      const unrelated = ["unrelated IT", "unrelated EN"].flatMap((name) =>
        group(rows, name),
      );
      expect(unrelated.length).toBe(22);
      expect(unrelated.filter((row) => row.covered)).toEqual([]);
      // The word search alone never rescued one either, so the answer comes from the vectors and not from a lucky word.
      expect(unrelated.filter((row) => row.lexical)).toEqual([]);
    });

    it("separates the two groups by a margin on both sides of the coverage bound", () => {
      const rows = measured();
      const near = Math.max(
        ...["related IT", "related EN", "math vs math"]
          .flatMap((name) => group(rows, name))
          .filter((row) => !row.query.startsWith("How do I find eigen"))
          .map((row) => row.l2),
      );
      const far = Math.min(
        ...["unrelated IT", "unrelated EN"]
          .flatMap((name) => group(rows, name))
          .map((row) => row.l2),
      );
      // Measured 2026-10-04: 0.583 and 0.660. A model or chunking change that closes either gap should fail here, not in the chat.
      expect(near).toBeLessThan(0.6 - 0.01);
      expect(far).toBeGreaterThan(0.6 + 0.04);
    });
  },
);
