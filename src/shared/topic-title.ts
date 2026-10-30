/**
 * A topic's name as the student reads it beside its row number. Plans built from a book before 0.4.2 stored
 * "1. Misure e vettori" and the path draws its own number, so a leading "N. " that repeats the row's number goes. Any
 * other number is part of the name.
 */
export function rowTitle(title: string, index: number): string {
  const match = /^(\d+)\.\s+(\S.*)$/s.exec(title.trim());
  return match && Number(match[1]) === index ? match[2]! : title;
}
