import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAhead, whenRead, type AheadQuery } from "./placesRead";

const reads = { invoke: vi.fn() };
const newCardsQuery: AheadQuery<ReturnType<typeof places>> = {
  queryKey: ["new-card-places"],
  queryFn: () => reads.invoke(),
  staleTime: 5_000,
};
const readPlacesAhead = (client: QueryClient, staleTime?: number) => readAhead(client, newCardsQuery, staleTime);
const whenPlacesRead = (client: QueryClient, open: () => void, limit?: number) =>
  whenRead(client, newCardsQuery, open, limit);

const places = (...names: string[]) => ({
  subjects: names.map((name) => ({ id: name, name, exams: [], topics: [], sources: 0 })),
  engine: true,
});

let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  reads.invoke.mockReset();
  client = new QueryClient();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("whenRead and readAhead", () => {
  it("opens in the same step when the places were read a moment ago, and reads nothing more", async () => {
    reads.invoke.mockResolvedValue(places("Analisi"));
    readPlacesAhead(client);
    await vi.advanceTimersByTimeAsync(0);
    const open = vi.fn();
    whenPlacesRead(client, open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(reads.invoke).toHaveBeenCalledTimes(1);
  });

  it("waits for a read that is still on its way, and opens once it is there", async () => {
    let answer!: (value: ReturnType<typeof places>) => void;
    reads.invoke.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const open = vi.fn();
    whenPlacesRead(client, open);
    expect(open).not.toHaveBeenCalled();
    answer(places("Analisi"));
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(newCardsQuery.queryKey)).toEqual(places("Analisi"));
  });

  it("opens without the places when the read is slower than the limit, and only once", async () => {
    let answer!: (value: ReturnType<typeof places>) => void;
    reads.invoke.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const open = vi.fn();
    whenPlacesRead(client, open, 250);
    await vi.advanceTimersByTimeAsync(249);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(1);
    answer(places("Analisi"));
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens when the read fails", async () => {
    reads.invoke.mockRejectedValue(new Error("no"));
    const open = vi.fn();
    whenPlacesRead(client, open);
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reads again once a change has marked the places stale, or the read is old, so the subjects are as they are now", async () => {
    reads.invoke.mockResolvedValueOnce(places("Analisi")).mockResolvedValueOnce(places("Analisi", "Chimica"));
    readPlacesAhead(client);
    await vi.advanceTimersByTimeAsync(0);
    await client.invalidateQueries({ queryKey: newCardsQuery.queryKey, refetchType: "none" });
    const open = vi.fn();
    whenPlacesRead(client, open);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(newCardsQuery.queryKey)).toEqual(places("Analisi", "Chimica"));

    reads.invoke.mockResolvedValueOnce(places("Chimica"));
    await vi.advanceTimersByTimeAsync(6_000);
    const later = vi.fn();
    whenPlacesRead(client, later);
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(newCardsQuery.queryKey)).toEqual(places("Chimica"));
  });

  it("does not read again for a read made ahead while it is still fresh", async () => {
    reads.invoke.mockResolvedValue(places("Analisi"));
    readPlacesAhead(client);
    await vi.advanceTimersByTimeAsync(0);
    readPlacesAhead(client);
    readPlacesAhead(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.invoke).toHaveBeenCalledTimes(1);
  });

  it("reads again when a page asks with a stale time of 0, whatever was read a moment ago", async () => {
    reads.invoke.mockResolvedValueOnce(places("Analisi")).mockResolvedValueOnce(places("Chimica"));
    readPlacesAhead(client);
    await vi.advanceTimersByTimeAsync(0);
    readPlacesAhead(client, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.invoke).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(newCardsQuery.queryKey)).toEqual(places("Chimica"));
  });
});
