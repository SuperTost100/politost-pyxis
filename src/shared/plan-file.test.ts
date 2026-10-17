import { describe, expect, it } from "vitest";
import { directPlanUrl, planFileReason, planFileSchema } from "./plan-file";

const ID = "1aBcD3fGhIjKlMnOpQrStUvWxYz0123456";
const drive = (id: string, extra = "") =>
  `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t${extra}`;

describe("directPlanUrl", () => {
  it("rewrites Google Drive share links", () => {
    for (const link of [
      `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://drive.google.com/file/d/${ID}/edit`,
      `https://drive.google.com/file/u/0/d/${ID}/view?usp=drive_link`,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/u/1/open?id=${ID}&usp=sharing`,
    ])
      expect(directPlanUrl(link), link).toBe(drive(ID));
  });

  it("keeps the resource key of an older Drive link", () => {
    expect(directPlanUrl(`https://drive.google.com/file/d/${ID}/view?resourcekey=0-AbC_d`)).toBe(
      drive(ID, "&resourcekey=0-AbC_d"),
    );
  });

  it("leaves Drive folders, short ids and direct Drive links alone", () => {
    for (const link of [
      "https://drive.google.com/drive/folders/1aBcD3fGhIjKlMnOpQrStUvWxYz0123456",
      "https://drive.google.com/file/d/short/view",
      `https://drive.google.com/uc?export=download&id=${ID}`,
      `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
      "https://drive.google.com/",
    ])
      expect(directPlanUrl(link), link).toBe(new URL(link).toString());
  });

  it("turns Dropbox share links into downloads", () => {
    expect(directPlanUrl("https://www.dropbox.com/s/k3j2l1m0n9b8v7c/Fisica%201.pyxis?dl=0")).toBe(
      "https://www.dropbox.com/s/k3j2l1m0n9b8v7c/Fisica%201.pyxis?dl=1",
    );
    expect(
      directPlanUrl("https://www.dropbox.com/scl/fi/abc123def456/Analisi.pyxis?rlkey=q1w2e3r4t5&st=zx9y8w7v&dl=0"),
    ).toBe("https://www.dropbox.com/scl/fi/abc123def456/Analisi.pyxis?rlkey=q1w2e3r4t5&st=zx9y8w7v&dl=1");
    expect(directPlanUrl("https://dropbox.com/s/k3j2l1m0n9b8v7c/plan.pyxis")).toBe(
      "https://dropbox.com/s/k3j2l1m0n9b8v7c/plan.pyxis?dl=1",
    );
    expect(directPlanUrl("https://www.dropbox.com/s/k3j2l1m0n9b8v7c/plan.pyxis?raw=1")).toBe(
      "https://www.dropbox.com/s/k3j2l1m0n9b8v7c/plan.pyxis?dl=1",
    );
  });

  it("leaves Dropbox folders and unrelated hosts alone", () => {
    expect(directPlanUrl("https://www.dropbox.com/sh/abc123/AAAdef?dl=0")).toBe(
      "https://www.dropbox.com/sh/abc123/AAAdef?dl=0",
    );
    expect(directPlanUrl("https://notdropbox.com/s/abc/plan.pyxis?dl=0")).toBe(
      "https://notdropbox.com/s/abc/plan.pyxis?dl=0",
    );
    expect(directPlanUrl("https://example.org/plans/fisica.pyxis")).toBe("https://example.org/plans/fisica.pyxis");
  });

  it("encodes OneDrive links as share tokens", () => {
    const token = (link: string) => `https://api.onedrive.com/v1.0/shares/u!${Buffer.from(link).toString("base64url")}/root/content`;
    const short = "https://1drv.ms/u/s!AkP3x9mZ1aBcdEfGhIjKlMnOpQrSt?e=Xy12Zz";
    expect(directPlanUrl(short)).toBe(token(short));
    const live = "https://onedrive.live.com/redir?resid=ABC123DEF456%21107&authkey=%21AbCdEf&e=Xy12Zz";
    expect(directPlanUrl(live)).toBe(token(live));
    // base64url has no padding, no plus and no slash.
    expect(directPlanUrl("https://1drv.ms/u/s!Aa~~~???")).toMatch(/^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u![\w-]+\/root\/content$/);
  });

  it("adds download=1 to OneDrive for work or school links", () => {
    expect(
      directPlanUrl("https://contoso-my.sharepoint.com/:u:/g/personal/anna_contoso_com/EaBcDeFgHiJ?e=Xy12Zz"),
    ).toBe("https://contoso-my.sharepoint.com/:u:/g/personal/anna_contoso_com/EaBcDeFgHiJ?e=Xy12Zz&download=1");
    expect(directPlanUrl("https://contoso.sharepoint.com/sites/team/Shared%20Documents/plan.pyxis")).toBe(
      "https://contoso.sharepoint.com/sites/team/Shared%20Documents/plan.pyxis",
    );
  });

  it("leaves OneDrive downloads alone", () => {
    const link = "https://onedrive.live.com/download?cid=ABC&resid=ABC%21107&authkey=%21Ab";
    expect(directPlanUrl(link)).toBe(link);
  });
});

describe("planFileReason", () => {
  const parse = (value: unknown) => {
    const result = planFileSchema.safeParse(value);
    return result.success ? null : planFileReason(result.error.issues);
  };
  const minimal = { version: 2, title: "A", topics: [], nodes: [], cards: [] };

  it("tells a newer version from a broken file", () => {
    expect(parse({ ...minimal, version: 3 })).toBe("unknown-version");
    expect(parse({ ...minimal, title: 5 })).toBe("invalid-file");
  });

  it("names a source over the size limit", () => {
    const source = { title: "Libro", sha: null, bytes: 201 * 1024 * 1024 };
    expect(parse({ ...minimal, sources: [source] })).toBe("oversized-source");
    expect(parse({ ...minimal, sources: [{ ...source, bytes: 10, mime: 4 }] })).toBe("invalid-file");
  });
});
