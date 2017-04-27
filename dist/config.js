"use strict";

// Environment variables

var _process$env = process.env,
    DISK_MEMOIZER_MEMORY_CACHE_ITEMS = _process$env.DISK_MEMOIZER_MEMORY_CACHE_ITEMS,
    DISK_MEMOIZER_CACHE_DIR = _process$env.DISK_MEMOIZER_CACHE_DIR,
    DISK_MEMOIZER_FLUSH_CACHE = _process$env.DISK_MEMOIZER_FLUSH_CACHE,
    DISK_MEMOIZER_GC = _process$env.DISK_MEMOIZER_GC,
    DISK_MEMOIZER_GC_INTERVAL = _process$env.DISK_MEMOIZER_GC_INTERVAL,
    DISK_MEMOIZER_GC_LAST_ACCESS = _process$env.DISK_MEMOIZER_GC_LAST_ACCESS;


var os = require("os");
var cluster = require("cluster");

module.exports = {
  MEMORY_CACHE_ITEMS: +(DISK_MEMOIZER_MEMORY_CACHE_ITEMS || 0),
  FLUSH_CACHE: DISK_MEMOIZER_FLUSH_CACHE === "true",
  CACHE_DIR: DISK_MEMOIZER_CACHE_DIR || os.tmpdir() + "/disk-memoizer",
  GC: cluster.isMaster && DISK_MEMOIZER_GC !== "false",
  GC_INTERVAL: DISK_MEMOIZER_GC_INTERVAL || 1000 * 60 * 5,
  GC_LAST_ACCESS: DISK_MEMOIZER_GC_LAST_ACCESS || "1h"
};