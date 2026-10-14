// Native-solc-compatible shim over solcjs (npm `solc`) for environments that cannot download
// binaries.soliditylang.org. Supports `--version` and `--standard-json` (stdin -> stdout).
// Large inputs are compiled in parallel chunks of the output selection and merged, because solcjs
// cannot serialize a very large output in one go ("Error writing output JSON").
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const ver = process.env.SOLC_SHIM_VERSION;
const solc = require(`/opt/solc/${ver}/node_modules/solc`);
const args = process.argv.slice(2);

function writeOut(out) {
  const buf = Buffer.from(out, "utf8");
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(1, buf, off, buf.length - off); }
    catch (e) { if (e.code !== "EAGAIN") throw e; }
  }
}
const roots = [process.cwd()];
for (let i = 0; i < args.length; i++) {
  if (["--base-path", "--include-path", "--allow-paths"].includes(args[i]) && args[i + 1]) {
    for (const p of args[i + 1].split(",")) roots.push(p);
  }
}
function findImports(p) {
  for (const r of roots) {
    const f = path.isAbsolute(p) ? p : path.join(r, p);
    if (fs.existsSync(f)) return { contents: fs.readFileSync(f, "utf8") };
  }
  return { error: "File not found: " + p };
}
function normalize(parsed) {
  for (const e of parsed.errors || []) if (!e.formattedMessage) e.formattedMessage = (e.type || "Error") + ": " + (e.message || "unknown");
  return parsed;
}

if (args.includes("--version")) {
  const v = solc.version().replace(".Emscripten.clang", ".Linux.g++");
  process.stdout.write(`solc, the solidity compiler commandline interface\nVersion: ${v}\n`);
} else if (args[0] === "--chunk") {
  // child: compile input file with the given file subset selected; write result file
  const input = JSON.parse(fs.readFileSync(args[1], "utf8"));
  const files = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const sel = input.settings.outputSelection;
  const base = sel["*"] || {};
  const newSel = {};
  for (const f of files) newSel[f] = base;
  input.settings.outputSelection = newSel;
  fs.writeFileSync(args[3], solc.compile(JSON.stringify(input), { import: findImports }));
} else if (args.includes("--standard-json")) {
  const input = fs.readFileSync(0, "utf8");
  const parsed = JSON.parse(input);
  const files = Object.keys(parsed.sources || {});
  const sel = parsed.settings && parsed.settings.outputSelection;
  const chunkable = files.length > 60 && sel && Object.keys(sel).length === 1 && sel["*"];
  if (!chunkable) {
    writeOut(JSON.stringify(normalize(JSON.parse(solc.compile(input, { import: findImports })))));
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solcshim-"));
    const inPath = path.join(dir, "input.json");
    fs.writeFileSync(inPath, input);
    const nChunks = Math.ceil(files.length / 40);
    const chunks = Array.from({ length: nChunks }, (_, i) => files.filter((_, j) => j % nChunks === i));
    const par = Math.max(1, Math.min(os.cpus().length, 4));
    let next = 0;
    const results = new Array(nChunks);
    const runOne = (i) => new Promise((resolve, reject) => {
      const fPath = path.join(dir, `files-${i}.json`);
      const oPath = path.join(dir, `out-${i}.json`);
      fs.writeFileSync(fPath, JSON.stringify(chunks[i]));
      const child = spawn(process.execPath, ["--stack-size=65500", "--max-old-space-size=6000", __filename, "--chunk", inPath, fPath, oPath], { env: process.env, stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", (code) => {
        if (code !== 0) return reject(new Error("chunk " + i + " exit " + code));
        results[i] = JSON.parse(fs.readFileSync(oPath, "utf8"));
        resolve();
      });
    });
    const worker = async () => { while (next < nChunks) { const i = next++; await runOne(i); } };
    Promise.all(Array.from({ length: par }, worker)).then(() => {
      const merged = { contracts: {}, sources: {}, errors: [] };
      const seenErr = new Set();
      for (const r of results) {
        for (const [f, c] of Object.entries(r.contracts || {})) merged.contracts[f] = c;
        for (const [f, s] of Object.entries(r.sources || {})) if (!merged.sources[f] || s.ast) merged.sources[f] = s;
        for (const e of r.errors || []) { const k = e.formattedMessage || e.message; if (!seenErr.has(k)) { seenErr.add(k); merged.errors.push(e); } }
      }
      if (merged.errors.length === 0) delete merged.errors;
      writeOut(JSON.stringify(normalize(merged)));
      fs.rmSync(dir, { recursive: true, force: true });
    }).catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
  }
} else {
  process.stderr.write("solc shim: unsupported args " + args.join(" ") + "\n");
  process.exit(1);
}
