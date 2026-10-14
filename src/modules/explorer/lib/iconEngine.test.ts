import { describe, expect, it } from "vitest";
import {
  createIconEngine,
  iconEngine,
  type IconifySet,
  type IconMaps,
} from "./iconEngine";

const set: IconifySet = {
  width: 16,
  height: 16,
  icons: {
    file: { body: "<path d='file'/>" },
    folder: { body: "<path d='folder'/>" },
    "folder-open": { body: "<path d='folder-open'/>" },
    "folder-src": { body: "<path d='src'/>" },
    "folder-src-open": { body: "<path d='src-open'/>" },
    typescript: { body: "<path d='ts'/>" },
    "typescript-react": { body: "<path d='tsx'/>" },
    "typescript-def": { body: "<path d='dts'/>" },
    npm: { body: "<path d='npm'/>" },
    rust: { body: "<path d='rs'/>" },
  },
  aliases: { "ts-alias": { parent: "typescript" } },
};

const maps: IconMaps = {
  fileNames: { "package.json": "npm", "broken.cfg": "does-not-exist" },
  fileExtensions: { "d.ts": "typescript_def", tsx: "typescript-react" },
  languageIds: { typescript: "ts_alias", rust: "rust" },
  extToLanguageId: { ts: "typescript", rs: "rust" },
  folderNames: { src: "folder_src", ghost: "folder_ghost" },
};

const engine = createIconEngine(set, maps);
const decode = (url: string) =>
  decodeURIComponent(url.replace("data:image/svg+xml;utf8,", ""));

describe("createIconEngine", () => {
  it("prefers an exact file name over its extension", () => {
    expect(decode(engine.fileIconUrl("package.json"))).toContain("d='npm'");
    expect(decode(engine.fileIconUrl("PACKAGE.JSON"))).toContain("d='npm'");
  });

  it("falls through compound extensions from most to least specific", () => {
    expect(decode(engine.fileIconUrl("types.d.ts"))).toContain("d='dts'");
    // `a.b.tsx` has no `b.tsx` entry, so the trailing `tsx` wins.
    expect(decode(engine.fileIconUrl("a.b.tsx"))).toContain("d='tsx'");
  });

  it("uses the language-id table when an extension has no direct icon, resolving aliases and underscores", () => {
    expect(decode(engine.fileIconUrl("main.rs"))).toContain("d='rs'");
    expect(decode(engine.fileIconUrl("index.ts"))).toContain("d='ts'");
  });

  it("falls back to the generic file icon for unknown names and dangling mappings", () => {
    const generic = engine.fileIconUrl("README");
    expect(decode(generic)).toContain("d='file'");
    expect(engine.fileIconUrl("x.unknownext")).toBe(generic);
    expect(engine.fileIconUrl("broken.cfg")).toBe(generic);
    expect(engine.fileIconUrl(".gitignore-like.")).toBe(generic);
  });

  it("maps folder names to open and closed variants", () => {
    expect(decode(engine.folderIconUrl("src", false))).toContain("d='src'");
    expect(decode(engine.folderIconUrl("SRC", true))).toContain("d='src-open'");
    expect(decode(engine.folderIconUrl("random", false))).toContain(
      "d='folder'",
    );
    expect(decode(engine.folderIconUrl("random", true))).toContain(
      "d='folder-open'",
    );
    // A mapped name whose icon is missing degrades to the plain folder.
    expect(decode(engine.folderIconUrl("ghost", true))).toContain(
      "d='folder-open'",
    );
  });

  it("returns an empty string when even the default icon is missing", () => {
    const bare = createIconEngine({ icons: {} }, maps);
    expect(bare.fileIconUrl("a.ts")).toBe("");
    expect(bare.folderIconUrl("a", false)).toBe("");
  });

  it("builds a sized SVG data URL once per icon", () => {
    const url = engine.fileIconUrl("main.rs");
    expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    expect(decode(url)).toContain('viewBox="0 0 16 16"');
    expect(engine.fileIconUrl("other.rs")).toBe(url);
  });
});

describe("bundled Catppuccin engine", () => {
  it("resolves common development files to distinct, non-generic icons", () => {
    const generic = iconEngine.fileIconUrl("zzz.unknownext");
    for (const name of [
      "main.rs",
      "index.tsx",
      "package.json",
      "README.md",
      "Dockerfile",
      "styles.css",
    ]) {
      const url = iconEngine.fileIconUrl(name);
      expect(url.startsWith("data:image/svg+xml;utf8,"), name).toBe(true);
      expect(url, name).not.toBe(generic);
    }
    expect(iconEngine.fileIconUrl("index.tsx")).not.toBe(
      iconEngine.fileIconUrl("index.ts"),
    );
  });

  it("resolves folder icons and their open variants", () => {
    expect(iconEngine.folderIconUrl("src", false)).not.toBe(
      iconEngine.folderIconUrl("src", true),
    );
    expect(iconEngine.folderIconUrl("node_modules", false)).not.toBe(
      iconEngine.folderIconUrl("zzz-not-special", false),
    );
  });
});
