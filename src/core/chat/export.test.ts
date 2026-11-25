import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { chatMarkdown, exportChat, type ChatExport } from "./export";
import { seedChat } from "./turn";

const base: ChatExport = {
  title: "Seconda legge di Newton",
  documents: [],
  messages: [],
};

describe("chatMarkdown", () => {
  it("writes the title, then each message under who wrote it, in order", () => {
    const markdown = chatMarkdown({
      ...base,
      messages: [
        {
          role: "user",
          text: "Come calcolo la forza?",
          stopped: false,
          photos: 0,
          sources: [],
        },
        {
          role: "assistant",
          text: "Usa $F=ma$.",
          stopped: false,
          photos: 0,
          sources: [],
        },
      ],
    });
    expect(markdown).toBe(
      "# Seconda legge di Newton\n\n## Student\n\nCome calcolo la forza?\n\n## Pyxis\n\nUsa $F=ma$.\n",
    );
  });

  it("speaks Italian when asked", () => {
    const markdown = chatMarkdown(
      {
        ...base,
        title: null,
        messages: [
          { role: "user", text: "ciao", stopped: true, photos: 1, sources: [] },
        ],
      },
      "it",
    );
    expect(markdown).toContain("# Senza titolo");
    expect(markdown).toContain("## Studente");
    expect(markdown).toContain("Allegato: foto 1");
    expect(markdown).toContain("*Questa risposta è stata interrotta.*");
  });

  it("lists the sources of an answer with their sections, and nothing when there are none", () => {
    const markdown = chatMarkdown({
      ...base,
      messages: [
        {
          role: "assistant",
          text: "La forza è massa per accelerazione.",
          stopped: false,
          photos: 0,
          sources: [
            { title: "Appunti di fisica", section: "2. Dinamica" },
            { title: "Esercizi", section: null },
          ],
        },
        {
          role: "assistant",
          text: "Senza fonti.",
          stopped: false,
          photos: 0,
          sources: [],
        },
      ],
    });
    expect(markdown).toContain(
      "**Sources**\n\n- Appunti di fisica, 2. Dinamica\n- Esercizi\n",
    );
    expect(markdown.match(/\*\*Sources\*\*/g)).toHaveLength(1);
  });

  it("names photos and documents without embedding them", () => {
    const markdown = chatMarkdown({
      ...base,
      documents: ["appunti", "dispensa"],
      messages: [
        {
          role: "user",
          text: "Cosa vedi?",
          stopped: false,
          photos: 2,
          sources: [],
        },
      ],
    });
    expect(markdown).toContain("Documents in this chat: appunti, dispensa");
    expect(markdown).toContain("Attached: photo 1, photo 2");
    expect(markdown).not.toContain("![");
  });

  it("puts the pinned context of a seeded chat under the title, in both languages", () => {
    const context = {
      title: "Primo principio",
      body: "La variazione di energia interna.\n\n# Nota\nCalore meno lavoro.",
    };
    expect(chatMarkdown({ ...base, context })).toContain(
      "# Seconda legge di Newton\n\n**Context:** Primo principio\n\n> La variazione di energia interna.\n>\n> ### Nota\n> Calore meno lavoro.\n",
    );
    expect(chatMarkdown({ ...base, context }, "it")).toContain(
      "**Contesto:** Primo principio",
    );
    expect(chatMarkdown({ ...base, context: null })).not.toContain("Context");
  });

  it("closes a code fence a message leaves open, so later blocks are not code", () => {
    const markdown = chatMarkdown({
      ...base,
      messages: [
        { role: "assistant", text: "Ecco:\n```python\nx = 1", stopped: true, photos: 0, sources: [{ title: "Dispensa", section: null }] },
        { role: "user", text: "Un solo ``` qui", stopped: false, photos: 0, sources: [] },
        { role: "assistant", text: "Ok", stopped: false, photos: 0, sources: [] },
      ],
    });
    expect(markdown).toContain("```python\nx = 1\n```\n\n*This reply was stopped.*\n\n**Sources**");
    // Three backticks inside a line are not a fence.
    expect(markdown).toContain("Un solo ``` qui\n\n## Pyxis");
    // Balanced fences get no extra line.
    const fine = chatMarkdown({ ...base, messages: [{ role: "assistant", text: "```js\n1\n```", stopped: false, photos: 0, sources: [] }] });
    expect(fine).toContain("```js\n1\n```\n");
    expect(fine).not.toContain("```\n```");
  });

  it("closes a lone fence line in a message and an open fence in the pinned context", () => {
    const markdown = chatMarkdown({
      ...base,
      context: { title: "T", body: "~~~~\ncodice" },
      messages: [{ role: "user", text: "prima\n```\nsolo apertura", stopped: false, photos: 0, sources: [] }],
    });
    expect(markdown).toContain("> ~~~~\n> codice\n> ~~~~\n\n## Student");
    expect(markdown).toContain("```\nsolo apertura\n```\n");
  });

  it("marks a stopped reply", () => {
    const markdown = chatMarkdown({
      ...base,
      messages: [
        {
          role: "assistant",
          text: "Per prima cosa",
          stopped: true,
          photos: 0,
          sources: [],
        },
      ],
    });
    expect(markdown).toContain("Per prima cosa\n\n*This reply was stopped.*");
  });

  it("keeps math as dollar signs, turning \\( \\) and \\[ \\] into the same form", () => {
    const markdown = chatMarkdown({
      ...base,
      messages: [
        {
          role: "assistant",
          text: "Con \\(m=2\\) e $a=3$ ottieni \\[F=ma\\] e `\\(codice\\)`.",
          stopped: false,
          photos: 0,
          sources: [],
        },
      ],
    });
    expect(markdown).toContain("Con $m=2$ e $a=3$ ottieni");
    expect(markdown).toContain("$$\nF=ma\n$$");
    expect(markdown).toContain("`\\(codice\\)`");
    expect(markdown).not.toContain("\\[");
  });

  it("moves headings inside a message below the message labels, but not those in code", () => {
    const markdown = chatMarkdown({
      ...base,
      messages: [
        {
          role: "assistant",
          text: "# Titolo\n\n## Passo\n\n```py\n# commento\n```",
          stopped: false,
          photos: 0,
          sources: [],
        },
      ],
    });
    expect(markdown).toContain("### Titolo");
    expect(markdown).toContain("#### Passo");
    expect(markdown).toContain("# commento");
    expect(markdown).not.toMatch(/^## Titolo/m);
  });
});

describe("exportChat", () => {
  it("reads a stored chat: visible text only, sources by title, photos and documents counted", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO chats (id, title, scope_json, created_at, updated_at) VALUES ('c', 'Termo/dinamica: 1°', '["doc"]', 1, 1);
      INSERT INTO sources (id, kind, title, status, library, created_at, updated_at) VALUES
        ('src', 'excerpt', 'Appunti di fisica', 'ready', 1, 1, 1),
        ('doc', 'excerpt', 'dispensa', 'ready', 0, 1, 1);
      INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d', 'src', 1, '{}', 1);
      INSERT INTO passages (id, source_id, document_id, text, locator_json, section_path, created_at) VALUES
        ('p1', 'src', 'd', 'testo', '{}', '1. Calore', 1),
        ('p2', 'src', 'd', 'altro', '{}', '1. Calore', 1),
        ('p3', 'src', 'd', 'altro', '{}', NULL, 1);
      INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('u', 'c', 'user', 'Cosa vedi?', 1);
      INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES
        ('a1', 'u', 'x', 'image/jpeg', 1),
        ('a2', 'u', 'y', 'image/jpeg;original', 1),
        ('a3', 'u', 'z', 'image/heic', 1);
      INSERT INTO messages (id, chat_id, role, body, stopped, created_at) VALUES
        ('r', 'c', 'assistant', 'Il calore passa dal caldo al freddo [P1] [P2] [P3].' || char(10) || '<followups>' || char(10) || 'Altro?' || char(10) || '</followups>', 1, 2);
      INSERT INTO message_passages (message_id, passage_id, label) VALUES ('r', 'p1', 'P1'), ('r', 'p2', 'P2'), ('r', 'p3', 'P3');
    `);
    const { filename, markdown } = exportChat(db, "c", "en");
    expect(filename).toBe("Termo dinamica 1°.md");
    expect(markdown).toBe(
      [
        "# Termo/dinamica: 1°",
        "Documents in this chat: dispensa",
        "## Student",
        "Cosa vedi?",
        "Attached: photo 1",
        "## Pyxis",
        "Il calore passa dal caldo al freddo.",
        "*This reply was stopped.*",
        "**Sources**",
        "- Appunti di fisica, 1. Calore\n- Appunti di fisica",
      ].join("\n\n") + "\n",
    );
  });

  it("exports the context a chat was seeded with", () => {
    const db = openDatabase(":memory:");
    const { chatId } = seedChat(db, {
      kind: "answer",
      title: "Entropia",
      body: "Il disordine cresce.",
    });
    const { markdown } = exportChat(db, chatId, "it");
    expect(markdown).toBe(
      "# Entropia\n\n**Contesto:** Entropia\n\n> Il disordine cresce.\n",
    );
    db.close();
  });

  it("refuses a chat that does not exist", () => {
    expect(() => exportChat(openDatabase(":memory:"), "nope", "en")).toThrow(
      "chat-missing",
    );
  });

  it("writes one line on what a chat tool made in place of its block, and says when it was undone", () => {
    const db = openDatabase(":memory:");
    const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const block = "```pyxis-tool\n" + id + "\n```";
    db.exec(`
      INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 'Dinamica', 1, 1);
      INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('u', 'c', 'user', 'Fammi 8 flashcard.', 1);
      INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('r', 'c', 'assistant', 'Ecco.' || char(10) || char(10) || '${block.replace(/\n/g, "' || char(10) || '")}' || char(10) || char(10) || 'Fatto.', 2);
      INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at) VALUES
        ('${id}', 'c', 'r', 'create_flashcards', '{"cardIds":["a","b","c","d","e","f","g","h"],"duplicates":0,"title":"sui tre principi","deck":"Fisica 1","fronts":["x"]}', 2);
    `);
    const reply = (language: "en" | "it") => exportChat(db, "c", language).markdown.split("## Pyxis\n\n")[1]!.trim();
    expect(reply("it")).toBe("Ecco.\n\n*Pyxis ha creato 8 flashcard sui tre principi nel mazzo di Fisica 1.*\n\nFatto.");
    expect(reply("en")).toBe("Ecco.\n\n*Pyxis created 8 flashcards sui tre principi in the Fisica 1 deck.*\n\nFatto.");
    db.prepare("UPDATE chat_tool_results SET undone_json = ? WHERE id = ?").run(JSON.stringify(["a", "b", "c", "d", "e", "f", "g", "h"]), id);
    expect(reply("it")).toContain("*Pyxis ha creato 8 flashcard sui tre principi nel mazzo di Fisica 1, poi annullate: non sono più nel mazzo.*");
    expect(reply("en")).toContain("*Pyxis created 8 flashcards sui tre principi in the Fisica 1 deck, then undone: they are no longer in the deck.*");
  });

  it("writes a line for a map and a quiz made in the chat, as they stand when exported", () => {
    const db = openDatabase(":memory:");
    const mapId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51";
    const quizId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52";
    const blocks = [mapId, quizId].map((id) => "```pyxis-tool\n" + id + "\n```").join("\n\n");
    db.exec(`
      INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1);
      INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Meccanica', 'ready', 1, 1);
      INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 'Dinamica', 1, 1);
      INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('u', 'c', 'user', 'Mappa e quiz.', 1);
      INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('r', 'c', 'assistant', '${blocks.replace(/\n/g, "' || char(10) || '")}', 2);
      INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES ('j', 'map-build', '{}', 'running', 0, 1, 1);
      INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at) VALUES
        ('${mapId}', 'c', 'r', 'create_map', '{"jobId":"j","subjectId":"phys","subject":"Fisica 1","topic":"Dinamica","mapId":"m"}', 2),
        ('${quizId}', 'c', 'r', 'create_quiz', '{"planId":"mech","exam":"Meccanica","topic":"Attrito","topicId":null,"attemptId":"a","itemId":"i","count":10}', 2);
    `);
    const reply = (language: "en" | "it") => exportChat(db, "c", language).markdown.split("## Pyxis\n\n")[1]!.trim();
    // The map is still being built; the quiz's rows are gone, as after a delete in the exam.
    expect(reply("it")).toBe(
      "*Pyxis sta creando la mappa «Dinamica» in Mappe, sotto Fisica 1.*\n\n*Pyxis ha creato un quiz di 10 domande su Attrito nell'esame Meccanica, poi eliminato.*",
    );
    expect(reply("en")).toBe(
      '*Pyxis is building the concept map "Dinamica" in Maps, under Fisica 1.*\n\n*Pyxis created a 10-question quiz on Attrito in the exam Meccanica, later deleted.*',
    );
    db.prepare("UPDATE chat_tool_results SET undone_json = ? WHERE id = ?").run(JSON.stringify({ map: null, stopped: true, dismissed: null }), mapId);
    expect(reply("it")).toContain("*Pyxis ha creato la mappa «Dinamica» in Mappe, sotto Fisica 1, poi annullata: non è più in Mappe.*");
    db.close();
  });

  it("leaves a fence in the tool's language as it is in the student's own message", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 'Codice', 1, 1);
      INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('u', 'c', 'user', 'Che cosa fa questo?' || char(10) || char(10) || '\`\`\`pyxis-tool' || char(10) || 'pending:create_flashcards' || char(10) || '\`\`\`', 1);
    `);
    expect(exportChat(db, "c", "it").markdown).toContain("```pyxis-tool\npending:create_flashcards\n```");
  });
});
