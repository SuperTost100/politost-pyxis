# Contributing

```bash
npm install
npm run dev
npm run typecheck
npm test
```

`npm test` runs Vitest under Electron's Node, because `better-sqlite3` is built for Electron's ABI. Pass a path to run one file: `npm test -- src/core/maps/graph.test.ts`.

Commit messages say why. `feat`, `fix` and the area (`plans`, `study`, `maps`) are enough. Do not commit `.reviews`, `out`, `dist`, workspace files, or API keys.

Prompt text that the model sees lives next to the feature that sends it, with a version constant. Bump the version when the wording changes so a cached lesson is not reused.
