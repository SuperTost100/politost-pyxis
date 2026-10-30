import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ownReview, reviewSessionKey } from "./reviewSession";

describe("the Review a page reads", () => {
  it("is none on a page outside a Review, even while an earlier Review is still cached", () => {
    const client = new QueryClient();
    const earlier = { drills: [], progress: { questionsPending: 3 } };
    client.setQueryData(reviewSessionKey("p"), earlier);
    // A diagnostic opened after a Review: its query is off, yet the cache still answers with the Review.
    const off = new QueryObserver(client, { queryKey: reviewSessionKey("p"), enabled: false }).getCurrentResult();
    expect(off.data).toBe(earlier);
    expect(ownReview(false, off).data).toBeUndefined();
    const on = new QueryObserver(client, { queryKey: reviewSessionKey("p"), enabled: true }).getCurrentResult();
    expect(ownReview(true, on).data).toBe(earlier);
    client.clear();
  });
});
