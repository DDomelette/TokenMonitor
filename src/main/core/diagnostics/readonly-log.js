const nodeFs = require('node:fs');
const nodePath = require('node:path');

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_MATCHES = 20;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES = 100;

function positiveLimit(value, fallback, ceiling) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), ceiling);
}

function findMatchingFiles(options = {}) {
  const fsApi = options.fs || nodeFs;
  const pathApi = options.path || nodePath;
  const root = typeof options.root === 'string' ? options.root : '';
  const match = options.match;
  const maxEntries = positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
  if (!root || !match || typeof fsApi.lstatSync !== 'function' || typeof fsApi.readdirSync !== 'function') {
    return [];
  }

  const matches = [];
  const directories = [root];
  let entries = 0;
  while (directories.length && entries < maxEntries && matches.length < DEFAULT_MAX_MATCHES) {
    const directory = directories.pop();
    let names;
    try {
      const directoryStat = fsApi.lstatSync(directory);
      if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
      names = fsApi.readdirSync(directory).slice().sort();
    } catch (_) {
      continue;
    }

    const childDirectories = [];
    for (const name of names) {
      if (entries >= maxEntries || matches.length >= DEFAULT_MAX_MATCHES) break;
      entries += 1;
      const candidate = pathApi.join(directory, name);
      let stat;
      try {
        stat = fsApi.lstatSync(candidate);
      } catch (_) {
        continue;
      }
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        childDirectories.push(candidate);
      } else if (stat.isFile()) {
        let accepted = false;
        try {
          if (typeof match === 'function') accepted = !!match(name, candidate);
          else if (typeof match.test === 'function') {
            match.lastIndex = 0;
            accepted = match.test(name);
            match.lastIndex = 0;
          }
        } catch (_) {
          accepted = false;
        }
        if (accepted) matches.push(candidate);
      }
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      directories.push(childDirectories[index]);
    }
  }
  return matches;
}

function readJsonlSample(options = {}) {
  const fsApi = options.fs || nodeFs;
  const file = typeof options.file === 'string' ? options.file : '';
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
  const maxLines = positiveLimit(options.maxLines, DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
  if (!file || typeof fsApi.openSync !== 'function' || typeof fsApi.readSync !== 'function'
    || typeof fsApi.closeSync !== 'function' || typeof fsApi.statSync !== 'function') return [];

  let size;
  try {
    size = Number(fsApi.statSync(file).size);
  } catch (_) {
    return [];
  }
  if (!Number.isFinite(size) || size <= 0) return [];
  const bytesToRead = Math.min(maxBytes, Math.floor(size));
  const offset = Math.max(0, Math.floor(size) - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  let descriptor = null;
  try {
    descriptor = fsApi.openSync(file, 'r');
    const bytesRead = fsApi.readSync(descriptor, buffer, 0, bytesToRead, offset);
    let text = buffer.subarray(0, Math.max(0, Number(bytesRead) || 0)).toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline < 0) return [];
      text = text.slice(firstNewline + 1);
    }
    const lines = text.split('\n');
    if (!text.endsWith('\n')) lines.pop();
    return lines
      .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
      .filter((line) => line.length > 0)
      .slice(-maxLines);
  } catch (_) {
    return [];
  } finally {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch (_) { /* fail closed */ }
    }
  }
}

module.exports = { findMatchingFiles, readJsonlSample };
