import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { planFileSchema } from "../src/shared/plan-file";

// JSON Schema describes the file shape. The importer also checks reference integrity,
// text/blob hashes, graph structure and bounded JSON depth before inserting rows.
const schema = z.toJSONSchema(planFileSchema, { io: "input" });
writeFileSync(
  fileURLToPath(new URL("../docs/plan-file.schema.json", import.meta.url)),
  `${JSON.stringify(schema, null, 2)}\n`,
);
