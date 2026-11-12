// Concept maps for the radial layout's tests: unit tests lay them out, e2e specs and the route audit store them.
// Labels are written for these tests; none comes from a real student's map.

export type FixtureNode = { id: string; label: string; parent: string | null };
export type FixtureMap = {
  title: string;
  nodes: FixtureNode[];
  /** Links outside the hierarchy, drawn dashed. */
  links: Array<{ from: string; to: string; label: string }>;
};

/** Builds a map from `[id, parent, label]` rows; the first row is the root. */
function rows(title: string, list: Array<[string, string | null, string]>, links: FixtureMap["links"] = []): FixtureMap {
  return { title, nodes: list.map(([id, parent, label]) => ({ id, parent, label })), links };
}

/**
 * Seven main branches of very uneven size, three levels below the root, labels of two and three lines, four links
 * across branches. 25 concepts, so it opens unfolded.
 */
export const filmHistory = rows(
  "Storia del cinema",
  [
    ["root", null, "Linguaggio del film e storia del cinema dal muto alla Nuova Hollywood"],
    ["b1", "root", "Il muto e le avanguardie storiche degli anni Venti"],
    ["b1a", "b1", "Espressionismo tedesco: scenografie dipinte e ombre deformate"],
    ["b1b", "b1", "Montaggio sovietico: il conflitto tra inquadrature produce senso"],
    ["b1b1", "b1b", "Effetto Kulešov e costruzione dello spazio emotivo"],
    ["b2", "root", "Hollywood classica: generi, divi e studio system"],
    ["b2a", "b2", "Il western come racconto della frontiera e della legge"],
    ["b2b", "b2", "Il noir: luci contrastate, città notturne e un destino segnato"],
    ["b2c", "b2", "Il melodramma familiare e il colore espressivo"],
    ["b2d", "b2", "Commedia sofisticata e dialogo rapido"],
    ["b2e", "b2", "Il codice di autocensura e le immagini proibite"],
    ["b3", "root", "Neorealismo italiano: attori presi dalla strada e riprese dal vero"],
    ["b3a", "b3", "Città in rovina e racconto della Resistenza"],
    ["b3b", "b3", "Pedinare il quotidiano: la bicicletta rubata"],
    ["b4", "root", "Profondità di campo e piano sequenza"],
    ["b4a", "b4", "Soffitti in scena e tempo frammentato nel racconto di un magnate"],
    ["b5", "root", "Nouvelle Vague: crisi del soggetto, testo aperto e regia come scrittura"],
    ["b5a", "b5", "Jump cut e sguardo in macchina"],
    ["b5b", "b5", "La politica degli autori"],
    ["b5b1", "b5b", "Dalle riviste di critica alla macchina da presa"],
    ["b6", "root", "Cinema moderno europeo: tempi morti e alienazione"],
    ["b7", "root", "New Hollywood: road movie, controcultura e antieroi"],
    ["b7a", "b7", "Viaggio senza meta e libertà individuale"],
    ["b7b", "b7", "Violenza esplicita e fine della censura"],
    ["b7b1", "b7b", "Il rallentatore nelle sparatorie finali"],
  ],
  [
    { from: "b3", to: "b5b", label: "ispira" },
    { from: "b4a", to: "b2b", label: "luce contrastata" },
    { from: "b7", to: "b5a", label: "eredita" },
    { from: "b1b", to: "b7b1", label: "montaggio ripreso" },
  ],
);

/** A root with twelve short leaves. */
export const twelveLeaves = rows("Elementi", [
  ["root", null, "Tavola periodica"],
  ...["Idrogeno", "Elio", "Litio", "Berillio", "Boro", "Carbonio", "Azoto", "Ossigeno", "Fluoro", "Neon", "Sodio", "Magnesio"].map(
    (label, i): [string, string, string] => [`l${i}`, "root", label],
  ),
]);

/** A chain six levels deep, one child each. */
export const deepChain = rows("Catena", [
  ["root", null, "Dal problema alla soluzione"],
  ["c1", "root", "Leggere il testo"],
  ["c2", "c1", "Individuare dati e incognite"],
  ["c3", "c2", "Scegliere il modello: equazione o disequazione"],
  ["c4", "c3", "Risolvere passo per passo"],
  ["c5", "c4", "Verificare il risultato"],
  ["c6", "c5", "Scrivere la risposta con l'unità di misura"],
]);

const topics = [
  "Grandezze e misure",
  "Cinematica del punto",
  "Dinamica e leggi di Newton",
  "Lavoro, energia e potenza",
  "Quantità di moto e urti",
  "Gravitazione universale",
];
const parts = [
  "definizione",
  "esempi svolti con i dati del problema",
  "errori frequenti",
  "formule da ricordare all'esame",
  "applicazioni",
];
/** Sixty concepts: six branches, each with five sections and a few details, which opens folded. */
export const physics = rows("Fisica 1", [
  ["root", null, "Fisica 1: meccanica"],
  ...topics.flatMap((topic, t): Array<[string, string, string]> => [
    [`t${t}`, "root", topic],
    ...parts.slice(0, t % 2 ? 5 : 4).map((part, p): [string, string, string] => [`t${t}p${p}`, `t${t}`, `${topic}: ${part}`]),
  ]),
  // Details under the first sections, until the map holds sixty concepts.
  ...Array.from({ length: 26 }, (_, i): [string, string, string] => {
    const t = i % topics.length;
    const p = Math.floor(i / topics.length) % 4;
    return [`d${i}`, `t${t}p${p}`, i % 3 ? `Dettaglio ${i + 1}` : `Dettaglio ${i + 1}: un caso limite spiegato con un esempio`];
  }),
]);

/** One branch with twenty leaves beside six small ones. */
export const oneBigBranch = rows("Lessico", [
  ["root", null, "Lessico di base"],
  ["big", "root", "Verbi irregolari"],
  ...Array.from({ length: 20 }, (_, i): [string, string, string] => [`v${i}`, "big", `Verbo ${i + 1}`]),
  ...["Colori", "Numeri", "Giorni", "Mesi", "Saluti", "Famiglia"].flatMap((label, i): Array<[string, string, string]> => [
    [`s${i}`, "root", label],
    [`s${i}a`, `s${i}`, `${label}: esempi`],
  ]),
]);

export const radialFixtures = { filmHistory, twelveLeaves, deepChain, physics, oneBigBranch };

/** The map as stored: every concept at 0,0, unpinned, and a link from each parent to its children. */
export function storedGraph(map: FixtureMap, layout: "tree" | "radial" = "tree") {
  return {
    layout,
    undo: null,
    redo: null,
    nodes: map.nodes.map((node) => ({ ...node, x: 0, y: 0, pinned: false })),
    edges: [
      ...map.nodes.flatMap((node) => (node.parent ? [{ from: node.parent, to: node.id }] : [])),
      ...map.links,
    ],
  };
}
