const { connect } = require(".");
const os = require("os");

connect(os.tmpdir() + "/power-repl.sock");