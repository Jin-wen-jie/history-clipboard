const { build } = require("electron-builder");

const buildConfig = require("../package.json").build;

build({
  config: {
    ...buildConfig,
    publish: [{
      provider: "generic",
      url: "https://example.invalid/"
    }]
  },
  publish: "always",
  win: ["nsis"]
}).catch((error) => {
  console.error(error instanceof Error ? error.message : "CI artifact build failed");
  process.exitCode = 1;
});
