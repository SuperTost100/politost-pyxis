export type UpdateView = {
  state: "unpublished" | "current" | "available" | "failed";
  current: string;
  checkedAt?: number;
  release?: { version: string; url: string; notes: string };
};
