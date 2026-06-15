// =============================================================================
// logger.js — File + Console Logger
// =============================================================================
// Writes structured log lines to /tmp/docker-garage/docker-garage.log
// (the same bind-mounted path visible on the host) so you can diagnose
// failures without needing "docker logs" access.
//
// Usage:
//   const log = require('./logger');
//   log.info('Server started on port 3000');
//   log.error('Something broke', err);
// =============================================================================

const fs   = require('fs');
const path = require('path');

const LOG_ROOT = process.env.GENERATED_ROOT || '/tmp/docker-garage';
const LOG_FILE = path.join(LOG_ROOT, 'docker-garage.log');

// Max log file size before it is rotated (5 MB)
const MAX_BYTES = 5 * 1024 * 1024;

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_ROOT, { recursive: true });
  } catch {
    // If we can't create the dir, file logging is simply skipped
  }
}

function rotatIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function writeToFile(line) {
  try {
    ensureLogDir();
    rotatIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Never crash the app because logging failed
  }
}

function format(level, msg, err) {
  const ts   = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  if (err) {
    return base + `\n  Error : ${err.message}\n  Code  : ${err.code || 'N/A'}\n  Stack : ${(err.stack || '').split('\n').slice(1, 3).join(' | ')}`;
  }
  return base;
}

function info(msg, err)    { const line = format('info',  msg, err); console.log(line);  writeToFile(line); }
function warn(msg, err)    { const line = format('warn',  msg, err); console.warn(line); writeToFile(line); }
function error(msg, err)   { const line = format('error', msg, err); console.error(line);writeToFile(line); }
function success(msg)      { const line = format('ok',    msg);      console.log(line);  writeToFile(line); }

// Writes a visible separator so each server restart is easy to find in the log
function banner(text) {
  const sep  = '='.repeat(60);
  const line = `\n${sep}\n  ${text}\n${sep}`;
  console.log(line);
  writeToFile(line);
}

module.exports = { info, warn, error, success, banner, LOG_FILE };
