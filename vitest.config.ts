import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@provenloop/cli": packageSource("cli"),
      "@provenloop/contracts": packageSource("contracts"),
      "@provenloop/copilot-adapter": packageSource("copilot-adapter"),
      "@provenloop/domain": packageSource("domain"),
      "@provenloop/evaluation": packageSource("evaluation"),
      "@provenloop/host": packageSource("host"),
      "@provenloop/platform-windows": packageSource("platform-windows"),
      "@provenloop/retrieval": packageSource("retrieval"),
      "@provenloop/storage-sqlite": packageSource("storage-sqlite"),
      "@provenloop/testkit": packageSource("testkit"),
    },
  },
  test: {
    include: [
      "tests/unit/**/*.test.ts"
    ],
  },
});
