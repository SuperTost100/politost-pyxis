import { QueryClient, QueryObserver, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateView } from "../../../../shared/updates";
import { createQueryClient } from "../../lib/queryClient";
import { updatesQuery } from "./updatesQuery";

afterEach(() => onlineManager.setOnline(true));

const failed: UpdateView = { state: "failed", current: "0.5.0", checkedAt: 1 };
const current: UpdateView = { state: "current", current: "0.5.0", checkedAt: 2 };

/** The window loses the network and gets it back, as its `offline` and `online` events say. */
async function dropAndRestore(client: QueryClient) {
  client.mount();
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
}

describe("the update check as a query", () => {
  it("asks again when the connection is back after a check that failed, as a new attempt and not from main's cache", async () => {
    const client = createQueryClient();
    const check = vi.fn<(force: boolean) => Promise<UpdateView>>().mockResolvedValueOnce(failed).mockResolvedValue(current);
    const observer = new QueryObserver(client, updatesQuery(client, check, () => false));
    const stop = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(failed));
    await dropAndRestore(client);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(current));
    // Main keeps a failed answer for 15 minutes for a check that does not force, so the second one has to.
    expect(check.mock.calls).toEqual([[false], [true]]);
    stop();
    client.unmount();
  });

  it("keeps a check that found out something for its day, whatever the connection does", async () => {
    const client = createQueryClient();
    const check = vi.fn<(force: boolean) => Promise<UpdateView>>().mockResolvedValue(current);
    const observer = new QueryObserver(client, updatesQuery(client, check, () => false));
    const stop = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(current));
    await dropAndRestore(client);
    expect(check).toHaveBeenCalledTimes(1);
    stop();
    client.unmount();
  });
});
