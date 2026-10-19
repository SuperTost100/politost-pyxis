/** Lower case, no accents, one kind of apostrophe: "perche" finds "Perché" and "dell'energia" finds "dell’energia". */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’ʼ]/g, "'")
    .toLocaleLowerCase();
}
