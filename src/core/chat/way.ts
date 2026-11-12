/**
 * How Pyxis answers a question: `solved` explains and solves it in full, `guided` takes the student one step at a time
 * and asks them to do the next one. The reply stores its template, which says which way it went (`wayOfTemplate`).
 */
export type AnswerWay = "solved" | "guided";

/** Words with which a student asks for the answer itself. They win over the guide cues: "I don't get it, just solve it". */
const SOLVE = [
  /\bsoluzion/,
  /\brisolv/,
  /\bsvolg/,
  /\bdammi (la|il) (risposta|risultato)/,
  /\bdimmi (la|il) (risposta|risultato)/,
  /\bquanto (vale|viene|fa)\b/,
  /\bsolution\b/,
  /\bsolve\b/,
  /\bjust (tell|give) me\b/,
  /\b(give|tell) me the (answer|result)\b/,
  /\bwork (it )?out\b/,
  /\bfull answer\b/,
];

/**
 * A solve verb that only names the thing the student wants help with ("guidami a risolvere", "walk me through how to
 * solve") asks for no answer. These phrases are taken out of the question before the solve cues are read.
 */
const NAMES_THE_TASK: Array<[RegExp, string]> = [
  [/\ba risolver(e|lo|la|li|le|ci)\b/g, "a"],
  [/\bcome (si |faccio a |posso |devo |dovrei |bisogna )?(risolv|svolg)\w*/g, " "],
  [/\bhow (to|do i|do you|can i|should i|would i|does one) (solve|work (it )?out)\b/g, " "],
  [/\bhelp(s)? me (to )?solve\b/g, "help me"],
];

/**
 * A refused solution ("non darmi la soluzione", "don't give me the answer", "senza la soluzione") is a request to be
 * guided. It is taken out of the question too, so the noun in it is not read as a request for the answer.
 */
const REFUSES_THE_ANSWER = [
  /\bnon (darmi|dirmi|dammi|dimmi|mi dare|mi dire|dare|dire|mostrarmi|mostrami) (subito |direttamente )?(la |il |tutta la )?(soluzion\w*|risposta|risultato)/,
  /\bsenza (darmi |dirmi |che tu mi dia )?(la |il )?(soluzion\w*|risposta|risultato)/,
  /\b(do ?n'?t|do not|never) (just )?(give|tell|show) me (just )?(the )?(answer|solution|result)/,
  /\bwithout (giving me |telling me )?(the )?(answer|solution|result)/,
];

/** Words with which a student asks to be helped through it, or shows their own attempt. */
const GUIDE = [
  /\bguidami\b/,
  /\bguidarmi\b/,
  /passo (a|per) passo/,
  /un passo alla volta/,
  /\bnon (ho )?capi(to|sco)\b/,
  /\b(aiutami|mi aiuti|mi aiutate|aiutarmi)\b/,
  /\buna mano\b/,
  /\bnon riesco a\b/,
  /\bnon so (da dove|come)\b/,
  /\bmi (viene|esce|risulta)\b/,
  /\b(e|sara) (corretto|sbagliato)\b/,
  /\bragionarci\b/,
  /\bsuggeriment/,
  /\bindizio\b/,
  /\bbloccat[oaie]\b/,
  /\bda dove (inizio|comincio|parto)\b/,
  /\bcome (si )?(imposta|comincia|inizia)\b/,
  /\bdove sbaglio\b/,
  /\bho provato\b/,
  /\be giusto\b/,
  /\bstep[- ]by[- ]step\b/,
  /\bone step at a time\b/,
  /\bguide me\b/,
  /\bwalk me through\b/,
  /\bhelp me\b/,
  /\bdon'?t (get|understand)\b/,
  /\bhint\b/,
  /\bstuck\b/,
  /\bwhere do i (start|begin)\b/,
  /\bwhere did i go wrong\b/,
  /\bis (this|it|my answer) (right|correct)\b/,
  /\bi tried\b/,
];

function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’`]/g, "'");
}

/**
 * The way to answer this question. In order: the way the student asked for with the action under an answer; the answer
 * itself when the question asks for it; a guide when the question asks for help understanding or shows an attempt; a guide
 * again while the student answers a guided step (the previous reply was guided); otherwise a solved answer.
 */
export function answerWay(input: {
  text: string;
  /** How the reply before this question answered, if there is one. */
  previous?: AnswerWay | null;
  /** The way the student chose with "Guidami passo passo" or "Dammi la soluzione". */
  asked?: AnswerWay;
}): AnswerWay {
  if (input.asked) return input.asked;
  let rest = plain(input.text);
  const refused = REFUSES_THE_ANSWER.some((cue) => cue.test(rest));
  for (const cue of REFUSES_THE_ANSWER) rest = rest.replace(cue, " ");
  for (const [cue, instead] of NAMES_THE_TASK) rest = rest.replace(cue, instead);
  if (SOLVE.some((cue) => cue.test(rest))) return "solved";
  if (refused || GUIDE.some((cue) => cue.test(rest))) return "guided";
  return input.previous === "guided" ? "guided" : "solved";
}

/** The way a stored reply answered, from its template. Replies saved before the way was automatic read the same. */
export function wayOfTemplate(template: string | null | undefined): AnswerWay {
  return template === "chat.socratic" ? "guided" : "solved";
}
