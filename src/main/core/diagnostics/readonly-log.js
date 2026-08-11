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

function safeProperty(value, key, fallback) {
  try {
    const result = value && typeof value === 'object' ? value[key] : undefined;
    return result === undefined ? fallback : result;
  } catch (_) {
    return fallback;
  }
}

function safeMethod(value, key) {
  try {
    const method = value && typeof value === 'object' ? value[key] : null;
    return typeof method === 'function' ? method.bind(value) : null;
  } catch (_) {
    return null;
  }
}

function findMatchingFiles(options = {}) {
  const fsApi = safeProperty(options, 'fs', nodeFs) || nodeFs;
  const pathApi = safeProperty(options, 'path', nodePath) || nodePath;
  const rootValue = safeProperty(options, 'root', '');
  const root = typeof rootValue === 'string' ? rootValue : '';
  const match = safeProperty(options, 'match', null);
  const maxEntries = positiveLimit(safeProperty(options, 'maxEntries', undefined), DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
  const lstatSync = safeMethod(fsApi, 'lstatSync');
  const readdirSync = safeMethod(fsApi, 'readdirSync');
  const join = safeMethod(pathApi, 'join') || nodePath.join;
  if (!root || !match || !lstatSync || !readdirSync) {
    return [];
  }

  const matches = [];
  const directories = [root];
  let entries = 0;
  while (directories.length && entries < maxEntries && matches.length < DEFAULT_MAX_MATCHES) {
    const directory = directories.pop();
    let names;
    try {
      const directoryStat = lstatSync(directory);
      if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
      names = readdirSync(directory).slice().sort();
    } catch (_) {
      continue;
    }

    const childDirectories = [];
    for (const name of names) {
      if (entries >= maxEntries || matches.length >= DEFAULT_MAX_MATCHES) break;
      entries += 1;
      const candidate = join(directory, name);
      let stat;
      try {
        stat = lstatSync(candidate);
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
  const fsApi = safeProperty(options, 'fs', nodeFs) || nodeFs;
  const fileValue = safeProperty(options, 'file', '');
  const file = typeof fileValue === 'string' ? fileValue : '';
  const maxBytes = positiveLimit(safeProperty(options, 'maxBytes', undefined), DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
  const maxLines = positiveLimit(safeProperty(options, 'maxLines', undefined), DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
  const openSync = safeMethod(fsApi, 'openSync');
  const readSync = safeMethod(fsApi, 'readSync');
  const closeSync = safeMethod(fsApi, 'closeSync');
  const statSync = safeMethod(fsApi, 'statSync');
  if (!file || !openSync || !readSync || !closeSync || !statSync) return null;

  let size;
  try {
    size = Number(statSync(file).size);
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(size) || size < 0) return null;
  const bytesToRead = Math.min(maxBytes, Math.floor(size));
  const offset = Math.max(0, Math.floor(size) - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  let descriptor = null;
  try {
    descriptor = openSync(file, 'r');
    if (bytesToRead === 0) return [];
    const bytesRead = readSync(descriptor, buffer, 0, bytesToRead, offset);
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
    return null;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch (_) { /* fail closed */ }
    }
  }
}

module.exports = { findMatchingFiles, readJsonlSample };
