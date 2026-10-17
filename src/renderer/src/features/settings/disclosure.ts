import type { TFunction } from "i18next";

/** Tasks in the order the disclosure names them, the same order as the engine summary. */
const tasks = ["chat", "map", "plan", "lesson", "vision", "grading"] as const;

type Features = Record<string, { provider: string } | undefined>;

/**
 * The line that says what leaves this computer. Tasks on the local model send nothing anywhere, so with only the local
 * model the line says so, and with a mix it names which tasks stay here and which go to a vendor. A task without its
 * own engine uses the default one.
 */
export function disclosureText(input: {
  t: TFunction;
  language: string;
  features: Features | undefined;
}): string {
  const { t, features } = input;
  const providerOf = (task: string) =>
    (features?.[task] ?? features?.default)?.provider;
  const local = tasks.filter((task) => providerOf(task) === "ollama");
  const cloud = tasks.filter((task) => {
    const provider = providerOf(task);
    return provider !== undefined && provider !== "ollama";
  });
  if (!local.length) return t("engines.disclosure");
  if (!cloud.length) return t("engines.disclosureLocal");
  const list = (names: readonly string[]) =>
    new Intl.ListFormat(input.language.startsWith("it") ? "it" : "en-GB", {
      style: "long",
      type: "conjunction",
    }).format(names.map((task) => t(`engines.task.${task}`)));
  const here = list(local);
  return t("engines.disclosureMixed", {
    count: local.length,
    local: here.charAt(0).toLocaleUpperCase(input.language) + here.slice(1),
    cloud: list(cloud),
  });
}
