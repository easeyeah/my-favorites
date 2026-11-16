import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { MF_SKIP_SERVE: "1", MF_FORM: "self-hosted" },
  },
});
