#!/usr/bin/env node
// Mistral companion: a thin runtime around the headless `vibe` CLI.
// Command layout and job model are modeled on openai/codex-plugin-cc (Apache-2.0).
//
// Subcommands: setup | review | adversarial-review | task | status | result | cancel | task-resume-candidate
// Every run executes in the foreground and is recorded as a job. Claude Code's
// Bash(run_in_background) is what detaches long runs; status/result/cancel read the job records.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_JOBS = 50;
const MAX_REVIEW_BYTES = 100_000;
const BRIEF_PRINT_CHARS = 4000; // cap on what is printed (and so enters Claude's context) in brief mode
const NOISE_PATHSPECS = ["*package-lock.json", "*npm-shrinkwrap.json", "*yarn.lock", "*pnpm-lock.yaml", "*.lock", "*go.sum", "*.min.js", "*.min.css", "*.map", "*.snap"]
  .map((p) => `:(exclude)${p}`);
const NOISE_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$|\.(lock|min\.js|min\.css|map|snap)$/;
const MAX_UNTRACKED_FILE_BYTES = 40_000;
const DEFAULT_TIME_LIMIT = 1800; // seconds
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_REVIEW_TURNS = 15;
const IS_WIN = process.platform === "win32";

// ---------- args ----------
function parseArgs(argv, { valueFlags = [], boolFlags = [] } = {}) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (valueFlags.includes(k)) opts[k] = inline !== undefined ? inline : argv[++i];
      else if (boolFlags.includes(k)) opts[k] = true;
      else rest.push(a);
    } else rest.push(a);
  }
  return { opts, rest };
}

// Slash commands pass $ARGUMENTS as one string; split it shell-style.
function splitRaw(argv) {
  if (argv.length !== 1) return argv;
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(argv[0]))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

// ---------- state ----------
function git(args, cwd, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function workspaceRoot(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.ok ? r.out.trim() : cwd;
}
function stateDir(cwd) {
  const ws = workspaceRoot(cwd);
  let canon = ws;
  try { canon = fs.realpathSync.native(ws); } catch {}
  const slug = (path.basename(ws) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canon).digest("hex").slice(0, 16);
  const base = process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, "state") : path.join(os.homedir(), ".cache", "mistral-companion");
  const dir = path.join(base, `${slug}-${hash}`, "jobs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
const jobFile = (dir, id) => path.join(dir, `${id}.json`);
function saveJob(dir, job) {
  job.updatedAt = new Date().toISOString();
  // Atomic write: a reader or a concurrent writer never sees a truncated file.
  const target = jobFile(dir, job.id);
  const tmp = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, target);
}
function listJobs(dir) {
  const jobs = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { jobs.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch {}
  }
  return jobs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}
function pruneJobs(dir) {
  for (const j of listJobs(dir).slice(MAX_JOBS)) {
    for (const f of fs.readdirSync(dir)) if (f.startsWith(j.id)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  }
}
function pidExists(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
// Start time (ms since epoch) of a process, or null if it could not be read (the caller checks existence separately).
function procStartMs(pid) {
  if (!pid) return null;
  const r = IS_WIN
    ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-o", "lstart=", "-p", String(Number(pid))], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  if (r.error || r.status !== 0) return null;
  const t = Date.parse((r.stdout || "").trim());
  return Number.isNaN(t) ? null : t;
}
// PID reuse guard: a process that took over a dead job's PID started after the job did.
const PID_START_SLACK_MS = 5000;
// Three outcomes: gone -> false; exists but start time unreadable -> true (never skip killing a live
// job or fail a running one because a probe broke); exists and readable -> started no later than the job.
function pidIsOurs(pid, notAfterIso, probe = procStartMs) {
  if (!pidExists(pid)) return false;
  const start = probe(pid);
  if (start === null) return true;
  const limit = Date.parse(notAfterIso);
  return Number.isNaN(limit) ? true : start <= limit + PID_START_SLACK_MS;
}
// A "running" job whose companion process died is reported as failed.
function reconcile(dir, job) {
  if ((job.status === "running" || job.status === "queued") && !pidIsOurs(job.companionPid, job.createdAt)) {
    job.status = "failed";
    job.error = job.error || "Companion process exited without recording a result.";
    saveJob(dir, job);
  }
  return job;
}
function sessionKey() { return process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null; }

// ---------- vibe ----------
function vibeVersion() {
  const r = spawnSync("vibe", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || "").trim();
}
// group=true only for children we spawned as process-group leaders (vibe, on POSIX).
function killTree(pid, { group = false } = {}) {
  if (!pid) return;
  try {
    if (IS_WIN) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(group ? -pid : pid, "SIGKILL");
  } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

// DeepSeek models always run at maximum reasoning. Vibe has no CLI flag for it, so override the model
// entry through the VIBE_MODELS environment variable for this run only (no config files are touched).
const DEEPSEEK_FALLBACK = { name: "deepseek-v4-1-flash-1017", provider: "mistral", alias: "deepseek@mistral" };
function deepseekEntry(model) {
  if (!model || !/deepseek/i.test(model)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(process.env.VIBE_HOME || path.join(os.homedir(), ".vibe"), "managed_config_cache.json"), "utf8"));
    for (const v of Object.values(cache)) {
      for (const blk of String(v.payload || "").split(/\[\[models\]\]/).slice(1)) {
        const get = (k) => (blk.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m")) || [])[1];
        if (get("alias") === model && get("name") && get("provider")) return { name: get("name"), provider: get("provider"), alias: model };
      }
    }
  } catch {}
  return model === DEEPSEEK_FALLBACK.alias ? { ...DEEPSEEK_FALLBACK } : null;
}
// compactAt: token count at which Vibe compacts the session. The global setting only reaches models that
// have no threshold of their own, so it is also written into the DeepSeek entry (whose entry we control).
function vibeEnv(model, compactAt) {
  const e = deepseekEntry(model);
  const env = { ...process.env };
  if (compactAt) env.VIBE_AUTO_COMPACT_THRESHOLD = String(compactAt);
  if (e) env.VIBE_MODELS = JSON.stringify([{ ...e, thinking: "max", ...(compactAt ? { auto_compact_threshold: compactAt } : {}) }]);
  return env;
}
const MIN_COMPACT_AT = 1000;
const MAX_COMPACT_AT = 10_000_000;
// Returns { value } (undefined when unset) or { error }.
function parseCompactAt(raw) {
  if (raw === undefined) return { value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_COMPACT_AT || n > MAX_COMPACT_AT)
    return { error: `Invalid --compact-at "${raw}". Use a whole number of tokens from ${MIN_COMPACT_AT} to ${MAX_COMPACT_AT}.` };
  return { value: n };
}

function runVibe({ cwd, dir, job, prompt, write, resumeId, model, maxTurns, timeLimit, compactAt }) {
  const promptFile = path.join(dir, `${job.id}.prompt.txt`);
  const outDir = path.join(dir, `${job.id}.out`);
  fs.writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
  const args = ["--prompt-file", promptFile, "--output-dir", outDir, "--workdir", cwd,
    "--max-turns", String(maxTurns), "--time-limit", String(timeLimit)];
  args.push(write ? "--auto-approve" : "--agent", ...(write ? [] : ["ask"]));
  if (resumeId) args.push("--resume", resumeId);
  if (model) args.push("--model", model);

  return new Promise((resolve) => {
    const child = spawn("vibe", args, { cwd, env: vibeEnv(model, compactAt), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !IS_WIN });
    job.vibePid = child.pid;
    job.vibeSpawnedAt = new Date().toISOString();
    saveJob(dir, job);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e.message), exp: null }));
    child.on("close", (code) => {
      let exp = null;
      try { exp = JSON.parse(fs.readFileSync(path.join(outDir, "export.json"), "utf8")); } catch {}
      resolve({ code, stdout, stderr, exp });
    });
  });
}

async function runJob({ kind, title, cwd, prompt, write = false, resumeId = null, model = null, maxTurns, timeLimit, json, brief = false, compactAt }) {
  const dir = stateDir(cwd);
  const job = {
    id: `${kind}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    kind, title, write, brief, status: "running", cwd,
    claudeSession: sessionKey(), companionPid: process.pid,
    createdAt: new Date().toISOString(),
  };
  saveJob(dir, job);
  pruneJobs(dir);
  const onSig = () => { killTree(job.vibePid, { group: true }); job.status = "cancelled"; saveJob(dir, job); process.exit(130); };
  process.on("SIGTERM", onSig); process.on("SIGINT", onSig);

  const r = await runVibe({ cwd, dir, job, prompt, write, resumeId, model, compactAt,
    maxTurns: maxTurns || DEFAULT_MAX_TURNS, timeLimit: timeLimit || DEFAULT_TIME_LIMIT });

  const fresh = (() => { try { return JSON.parse(fs.readFileSync(jobFile(dir, job.id), "utf8")); } catch { return job; } })();
  if (fresh.status === "cancelled") { console.log(`${job.id} was cancelled.`); return 1; }

  const exp = r.exp;
  job.sessionId = exp?.session_id || null;
  job.usage = exp?.usage || null;
  job.costUsd = exp?.cost_usd ?? null;
  job.stopReason = exp?.stop_reason || null;
  job.exitCode = r.code;
  job.output = r.stdout.trim();
  job.stderr = r.stderr.trim().split(/\r?\n/).filter((l) => !/^Reading API keys from the system keyring/.test(l)).join("\n");
  job.status = classifyOutcome({ code: r.code, outcome: exp?.outcome, stopReason: job.stopReason, hasOutput: !!job.output });
  if (job.status === "failed") job.error = exp?.error || job.stderr || `vibe exited with code ${r.code}`;
  job.finishedAt = new Date().toISOString();
  if (write && brief) job.diffStat = git(["diff", "--stat", "HEAD"], cwd).out.trim() || null;
  saveJob(dir, job);

  if (json) console.log(JSON.stringify(job, null, 2));
  else console.log(renderResult(job));
  return job.status === "failed" ? 1 : 0;
}

// Stop reasons that mean the run was cut short (observed: "limit"). Anything else on a clean
// exit-0 run (e.g. a normal end-of-turn reason) is still a completed run.
const EARLY_STOP = /limit|max[_ -]?(turns?|tokens?|price|cost)|timeout|timed[_ -]?out|interrupt|budget/i;
function classifyOutcome({ code, outcome, stopReason, hasOutput }) {
  if (outcome === "error" || (code !== 0 && code !== 3)) return "failed";
  if (code === 3 || (stopReason && EARLY_STOP.test(stopReason))) return "partial";
  return hasOutput ? "completed" : "failed";
}

function renderResult(job) {
  const lines = [];
  if (job.status === "failed") {
    lines.push(`Mistral Vibe run failed (${job.id}).`, "", job.error || "Unknown error.");
  } else {
    if (job.status === "partial")
      lines.push(`> **Partial result:** the run stopped early (${job.stopReason || `exit ${job.exitCode}`}). Output below may be incomplete.`, "");
    const out = job.output || "(no output)";
    if (job.brief && out.length > BRIEF_PRINT_CHARS) {
      lines.push(out.slice(0, BRIEF_PRINT_CHARS), "", `[... output shortened (${out.length} chars); full text: /mistral:result ${job.id} --full]`);
    } else lines.push(out);
    if (job.diffStat) lines.push("", "Changed files (git diff --stat HEAD):", "```", job.diffStat, "```");
  }
  lines.push("", `_Job ${job.id}${job.sessionId ? ` · session ${job.sessionId}` : ""}${job.usage ? ` · ${job.usage.total_tokens} tokens` : ""}_`);
  return lines.join("\n");
}

// ---------- review ----------
function resolveBase(cwd, explicit) {
  if (explicit) return explicit;
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (head.ok && head.out.trim()) return head.out.trim();
  for (const b of ["main", "master"]) if (git(["rev-parse", "--verify", "-q", b], cwd).ok) return b;
  return null;
}
function isBinary(buf) { return buf.subarray(0, 8000).includes(0); }

function collectReviewContext(cwd, { scope, base }) {
  const status = git(["status", "--short", "--untracked-files=all"], cwd).out.trim();
  let mode = scope || "auto";
  if (!["auto", "working-tree", "branch"].includes(mode)) throw new Error(`Invalid --scope "${mode}". Use auto, working-tree or branch.`);
  if (mode === "auto") mode = status ? "working-tree" : "branch";
  let budget = MAX_REVIEW_BYTES;
  const parts = [];
  const take = (label, text) => {
    if (!text.trim() || budget <= 0) return;
    let t = text;
    if (t.length > budget) t = t.slice(0, budget) + "\n[... truncated ...]";
    budget -= t.length;
    // Fence longer than any backtick run in the content so reviewed text cannot close it.
    const longest = Math.max(0, ...(t.match(/`+/g) || []).map((m) => m.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    parts.push(`### ${label}\n${fence}\n${t}\n${fence}`);
  };
  let target;
  if (mode === "branch") {
    const b = resolveBase(cwd, base);
    if (!b) throw new Error("Could not determine a base branch. Pass --base <ref>.");
    if (!git(["rev-parse", "--verify", "-q", `${b}^{commit}`], cwd).ok) throw new Error(`Unknown base ref: ${b}`);
    target = `branch diff ${b}...HEAD`;
    take("git diff --stat", git(["diff", "--stat", `${b}...HEAD`, "--", ".", ...NOISE_PATHSPECS], cwd).out);
    take("git diff", git(["diff", `${b}...HEAD`, "--", ".", ...NOISE_PATHSPECS], cwd).out);
    if (!parts.length) return null;
  } else {
    target = "working tree (staged, unstaged and untracked changes)";
    if (!status) return null;
    take("git status --short", status);
    take("git diff --cached", git(["diff", "--cached", "--", ".", ...NOISE_PATHSPECS], cwd).out);
    take("git diff (unstaged)", git(["diff", "--", ".", ...NOISE_PATHSPECS], cwd).out);
    const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd).out.split(/\r?\n/).filter(Boolean);
    for (const f of untracked) {
      if (budget <= 0) break;
      if (NOISE_RE.test(f)) continue;
      try {
        const full = path.join(cwd, f);
        const st = fs.lstatSync(full); // lstat: never follow symlinks out of the repo
        if (!st.isFile()) continue;
        // Open without following symlinks, then re-check the opened handle (closes the lstat->open race).
        const root = fs.realpathSync.native(cwd);
        const real = fs.realpathSync.native(full);
        if (real !== root && !real.startsWith(root + path.sep)) continue;
        const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let buf, size;
        try {
          const fst = fs.fstatSync(fd);
          if (!fst.isFile()) continue;
          size = fst.size;
          buf = Buffer.alloc(Math.min(size, MAX_UNTRACKED_FILE_BYTES));
          fs.readSync(fd, buf, 0, buf.length, 0);
        } finally { fs.closeSync(fd); }
        if (isBinary(buf)) { take(`untracked file ${f}`, "[binary file omitted]"); continue; }
        take(`untracked file ${f}`, buf.toString("utf8") + (size > buf.length ? "\n[... truncated ...]" : ""));
      } catch {}
    }
  }
  return { target, body: parts.join("\n\n") };
}

function loadPrompt(name) { return fs.readFileSync(path.join(ROOT, "prompts", `${name}.md`), "utf8"); }

async function cmdReview(argv, adversarial) {
  const { opts, rest } = parseArgs(splitRaw(argv), { valueFlags: ["base", "scope", "model", "max-turns", "time-limit", "compact-at"], boolFlags: ["wait", "background", "json", "brief"] });
  const cwd = process.cwd();
  if (!git(["rev-parse", "--is-inside-work-tree"], cwd).ok) { console.error("Not inside a git repository."); return 1; }
  const ca = parseCompactAt(opts["compact-at"]);
  if (ca.error) { console.error(ca.error); return 1; }
  let ctx;
  try { ctx = collectReviewContext(cwd, { scope: opts.scope, base: opts.base }); }
  catch (e) { console.error(e.message); return 1; }
  if (!ctx) { console.log("Nothing to review: no changes found for the selected scope."); return 0; }
  const focus = rest.join(" ").trim();
  if (focus && !adversarial) { console.error("/mistral:review does not take focus text. Use /mistral:adversarial-review for that."); return 1; }
  const prompt = loadPrompt(adversarial ? "adversarial-review" : "review")
    .replace("{{TARGET}}", () => ctx.target)
    .replace("{{FOCUS}}", () => focus || "(none)")
    .replace("{{CONTEXT}}", () => ctx.body) + (opts.brief ? BRIEF_REVIEW_NOTE : "");
  return runJob({ kind: adversarial ? "adversarial-review" : "review", title: `${adversarial ? "Adversarial review" : "Review"}: ${ctx.target}`,
    cwd, prompt, write: false, model: opts.model, maxTurns: num(opts["max-turns"]) || DEFAULT_REVIEW_TURNS, timeLimit: num(opts["time-limit"]), json: opts.json, brief: !!opts.brief, compactAt: ca.value });
}
const BRIEF_REVIEW_NOTE = [
  "", "", "## Brevity (token budget)",
  "Report at most 7 findings, most severe first. One line each: `file:line — problem — fix`. No preamble, no praise, no restating the diff. If nothing material, reply `No material findings.`", "",
].join("\n");
const num = (v) => (v === undefined ? undefined : Number(v));

// ---------- task ----------
async function cmdTask(argv) {
  const { opts, rest } = parseArgs(splitRaw(argv), { valueFlags: ["model", "max-turns", "time-limit", "compact-at"],
    boolFlags: ["write", "resume-last", "fresh", "background", "wait", "json", "full"] });
  const cwd = process.cwd();
  const ca = parseCompactAt(opts["compact-at"]);
  if (ca.error) { console.error(ca.error); return 1; }
  const task = rest.join(" ").trim();
  if (!task) { console.error("Provide a task description."); return 1; }
  let resumeId = null;
  if (opts["resume-last"] && !opts.fresh) {
    const cand = resumeCandidate(cwd);
    if (!cand) { console.error("No previous Mistral task session to resume. Run without --resume-last."); return 1; }
    resumeId = cand.sessionId;
  }
  const prompt = opts.full ? task : task + BRIEF_TASK_NOTE;
  return runJob({ kind: "task", title: task.slice(0, 80), cwd, prompt, write: !!opts.write, resumeId,
    model: opts.model, maxTurns: num(opts["max-turns"]), timeLimit: num(opts["time-limit"]), json: opts.json, brief: !opts.full, compactAt: ca.value });
}
const BRIEF_TASK_NOTE = "\n\n(Token budget: when finished, reply with a short summary only — what you changed and why, under 150 words. Do not paste code or diffs.)";
function resumeCandidate(cwd) {
  const dir = stateDir(cwd);
  const key = sessionKey();
  return listJobs(dir).find((j) => j.kind === "task" && j.sessionId && j.status !== "running" && (!key || !j.claudeSession || j.claudeSession === key)) || null;
}
function cmdResumeCandidate(argv) {
  const { opts } = parseArgs(splitRaw(argv), { boolFlags: ["json"] });
  const c = resumeCandidate(process.cwd());
  const payload = { available: !!c, sessionId: c?.sessionId ?? null, jobId: c?.id ?? null, title: c?.title ?? null };
  console.log(opts.json ? JSON.stringify(payload, null, 2) : payload.available ? `Resumable: ${c.id} (${c.title})` : "No resumable task.");
  return 0;
}

// ---------- status / result / cancel ----------
function elapsed(j) {
  const end = j.finishedAt ? Date.parse(j.finishedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(j.createdAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
function findJob(dir, ref) {
  const jobs = listJobs(dir).map((j) => reconcile(dir, j));
  if (!ref) return null;
  const hits = jobs.filter((j) => j.id === ref || j.id.startsWith(ref));
  return hits.length === 1 ? hits[0] : hits.length > 1 ? "ambiguous" : undefined;
}

async function cmdStatus(argv) {
  const { opts, rest } = parseArgs(splitRaw(argv), { valueFlags: ["timeout-ms"], boolFlags: ["wait", "all", "json"] });
  const dir = stateDir(process.cwd());
  const ref = rest[0];
  if (ref) {
    let j = findJob(dir, ref);
    if (j === "ambiguous" || !j) { console.error(j ? `Ambiguous job id: ${ref}` : `No job matching ${ref}.`); return 1; }
    if (opts.wait) {
      const deadline = Date.now() + (Number(opts["timeout-ms"]) || 240000);
      while (j.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const next = findJob(dir, j.id);
        if (!next || next === "ambiguous") { console.error("Job record disappeared while waiting."); return 1; }
        j = next;
      }
    }
    if (opts.json) console.log(JSON.stringify(j, null, 2));
    else console.log([`Job ${j.id}`, `Kind: ${j.kind}`, `Status: ${j.status}`, `Elapsed: ${elapsed(j)}`, `Title: ${j.title}`,
      j.sessionId ? `Session: ${j.sessionId}` : null, j.stopReason ? `Stop reason: ${j.stopReason}` : null, j.error ? `Error: ${j.error}` : null,
      j.status === "running" ? `Cancel: /mistral:cancel ${j.id}` : `Result: /mistral:result ${j.id}`].filter(Boolean).join("\n"));
    return 0;
  }
  const key = sessionKey();
  let jobs = listJobs(dir).map((j) => reconcile(dir, j));
  if (!opts.all && key) jobs = jobs.filter((j) => !j.claudeSession || j.claudeSession === key);
  if (opts.json) { console.log(JSON.stringify(jobs, null, 2)); return 0; }
  if (!jobs.length) { console.log("No Mistral jobs recorded for this repository yet."); return 0; }
  console.log(["| Job | Kind | Status | Elapsed | Summary | Follow-up |", "|---|---|---|---|---|---|",
    ...jobs.slice(0, 15).map((j) => `| ${j.id} | ${j.kind} | ${j.status} | ${elapsed(j)} | ${j.title.replace(/\|/g, "\\|")} | ${j.status === "running" ? `/mistral:cancel ${j.id}` : `/mistral:result ${j.id}`} |`)].join("\n"));
  return 0;
}

function cmdResult(argv) {
  const { opts, rest } = parseArgs(splitRaw(argv), { boolFlags: ["json", "full"] });
  const dir = stateDir(process.cwd());
  const ref = rest[0];
  const j = ref ? findJob(dir, ref) : listJobs(dir).map((x) => reconcile(dir, x)).find((x) => x.status !== "running");
  if (j === "ambiguous") { console.error(`Ambiguous job id: ${ref}`); return 1; }
  if (!j) { console.error(ref ? `No job matching ${ref}.` : "No finished Mistral jobs found."); return 1; }
  if (j.status === "running") { console.log(`Job ${j.id} is still running. Check /mistral:status ${j.id}.`); return 0; }
  console.log(opts.json ? JSON.stringify(j, null, 2) : renderResult(opts.full ? { ...j, brief: false } : j));
  return 0;
}

function cmdCancel(argv) {
  const { rest } = parseArgs(splitRaw(argv), {});
  const dir = stateDir(process.cwd());
  const ref = rest[0];
  const jobs = listJobs(dir).map((j) => reconcile(dir, j)).filter((j) => j.status === "running");
  const j = ref ? jobs.find((x) => x.id === ref || x.id.startsWith(ref)) : jobs.length === 1 ? jobs[0] : null;
  if (!j) { console.log(ref ? `No running job matching ${ref}.` : jobs.length ? "Multiple jobs are running; pass a job id." : "No running Mistral jobs."); return 0; }
  j.status = "cancelled"; j.finishedAt = new Date().toISOString();
  saveJob(dir, j);
  // Only signal processes whose start time proves they are the ones this job created.
  if (j.vibePid && pidIsOurs(j.vibePid, j.vibeSpawnedAt || j.createdAt)) killTree(j.vibePid, { group: true });
  if (j.companionPid && pidIsOurs(j.companionPid, j.createdAt)) killTree(j.companionPid);
  console.log(`Cancelled ${j.id}.`);
  return 0;
}

// ---------- setup ----------
function cmdSetup(argv) {
  const { opts } = parseArgs(splitRaw(argv), { boolFlags: ["json"] });
  const version = vibeVersion();
  const node = process.version;
  const keyring = process.env.MISTRAL_API_KEY ? "env MISTRAL_API_KEY" : null;
  let auth = { ready: false, detail: "unknown" };
  let smoke = null;
  if (version) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-setup-"));
    const pf = path.join(tmp, "p.txt");
    fs.writeFileSync(pf, "Reply with exactly: ok", "utf8");
    const r = spawnSync("vibe", ["--prompt-file", pf, "--agent", "ask", "--max-turns", "2", "--time-limit", "60", "--workdir", tmp],
      { encoding: "utf8", timeout: 90000 });
    smoke = r.status === 0 && /ok/i.test(r.stdout || "");
    auth = { ready: smoke, detail: smoke ? (keyring || "configured") : ((r.stderr || r.stdout || "").trim().split(/\r?\n/).filter((l) => !/keyring/.test(l)).join(" ").slice(0, 300) || "headless run failed") };
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const report = {
    ready: !!version && auth.ready, node, vibe: { available: !!version, version }, auth,
    nextSteps: !version ? ["Install Mistral Vibe (see https://docs.mistral.ai/), then rerun /mistral:setup."]
      : !auth.ready ? ["Run `!vibe --setup` to configure your API key, then rerun /mistral:setup."] : [],
  };
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log([`Mistral setup: ${report.ready ? "ready" : "NOT ready"}`, `- Node: ${node}`, `- vibe: ${version || "not found on PATH"}`,
    `- Headless run: ${auth.ready ? "ok" : `failed (${auth.detail})`}`, ...report.nextSteps.map((s) => `- Next: ${s}`)].join("\n"));
  return 0;
}

export { parseCompactAt, vibeEnv, deepseekEntry, NOISE_RE, renderResult, classifyOutcome, splitRaw, parseArgs, collectReviewContext, listJobs, saveJob, pruneJobs, findJob, pidIsOurs, MAX_JOBS };

// ---------- main ----------
// Compare real paths: Node resolves the entry point's realpath, so symlinks or Windows case
// differences would otherwise make every command silently do nothing.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(fileURLToPath(import.meta.url)); }
  catch { return true; }
})();
const [cmd, ...args] = isMain ? process.argv.slice(2) : [];
const table = {
  setup: () => cmdSetup(args),
  review: () => cmdReview(args, false),
  "adversarial-review": () => cmdReview(args, true),
  task: () => cmdTask(args),
  "task-resume-candidate": () => cmdResumeCandidate(args),
  status: () => cmdStatus(args),
  result: () => cmdResult(args),
  cancel: () => cmdCancel(args),
};
if (isMain && !table[cmd]) {
  console.error("Usage: mistral-companion <setup|review|adversarial-review|task|status|result|cancel|task-resume-candidate> [options]");
  process.exit(2);
}
if (isMain) Promise.resolve(table[cmd]()).then((c) => process.exit(c ?? 0), (e) => { console.error(e?.stack || String(e)); process.exit(1); });
