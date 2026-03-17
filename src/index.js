const orchestrator = require("./orchestrator");
const platform = require("./platform");
const providers = require("./providers");
const api = require("./api");
const core = require("./core");
const discussion = require("./discussion");
const monitoring = require("./monitoring");
const takeover = require("./takeover");

module.exports = {
  ...core,
  ...platform,
  ...orchestrator,
  ...providers,
  ...api,
  ...discussion,
  ...monitoring,
  ...takeover,
  api,
  core,
  discussion,
  monitoring,
  orchestrator,
  platform,
  providers,
  takeover
};
