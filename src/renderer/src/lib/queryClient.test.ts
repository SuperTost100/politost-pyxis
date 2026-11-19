import { QueryClient, QueryObserver, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, outbound } from "./queryClient";

afterEach(() => {
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

/** Drops the connection and brings it back, as the window's `offline` and `online` events do. */
async function dropAndRestore(client: QueryClient) {
  client.mount();
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
}

describe("the shared query client", () => {
  it("does not refetch a failed local read when the connection comes back, as it was set for data that is on this computer", async () => {
    const client = createQueryClient();
    const read = vi.fn().mockRejectedValue(new Error("local"));
    const observer = new QueryObserver(client, { queryKey: ["local"], queryFn: read });
    const stop = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    await dropAndRestore(client);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    client.unmount();
  });

  it("refetches a read that goes out to the network once the connection is back, so its list recovers without leaving the page", async () => {
    const client = createQueryClient();
    // The catalog is out of reach, and then it is not.
    const catalog = vi.fn().mockRejectedValueOnce(new Error("books-offline")).mockResolvedValue([{ id: "fisica" }]);
    const observer = new QueryObserver(client, { queryKey: ["sources", "free-books"], queryFn: catalog, retry: false, ...outbound });
    const stop = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    // It asked once and was refused at once, instead of waiting for a connection that the handler says nothing about.
    expect(catalog).toHaveBeenCalledTimes(1);
    await dropAndRestore(client);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ id: "fisica" }]));
    expect(catalog).toHaveBeenCalledTimes(2);
    stop();
    client.unmount();
  });
});
