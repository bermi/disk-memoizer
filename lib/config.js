// Environment variables

const {
  // How many items should be kept in memory. This uses the
  // Lru-cache module under the hood. Defaults to 0
  DISK_MEMOIZER_MEMORY_CACHE_ITEMS,

  // Directory where the cache will be stored.
  // Defaults to $TMPDIR/disk-memoizer
  DISK_MEMOIZER_CACHE_DIR,

  // Forces re-caching items when set to true
  DISK_MEMOIZER_FLUSH_CACHE,

  // Time for a lock to be considered stale.
  // Defaults to 5000 ms (5s)
  DISK_MEMOIZER_LOCK_STALE_MS,

  // Disables memoization garbage collection when set to false
  // Garbage collection will not take place on cluster workers
  // So you'll have to require disk-memoizer on a master process
  DISK_MEMOIZER_GC,

  // Seconds to wait between running the garbage collector
  // Defaults to 300000 (5 minutes)
  DISK_MEMOIZER_GC_INTERVAL,

  // When removing old files.
  // Only those that have not been accessed for the specified time
  // will be removed.
  DISK_MEMOIZER_GC_LAST_ACCESS

} = process.env;

const os = require("os");
const cluster = require("cluster");

module.exports = {
  MEMORY_CACHE_ITEMS: +(DISK_MEMOIZER_MEMORY_CACHE_ITEMS || 0),
  FLUSH_CACHE: DISK_MEMOIZER_FLUSH_CACHE === "true",
  CACHE_DIR: DISK_MEMOIZER_CACHE_DIR ||
    `${os.tmpdir()}/disk-memoizer`,
  LOCK_STALE_MS: +(DISK_MEMOIZER_LOCK_STALE_MS || 5 * 1000),
  GC: cluster.isMaster && (DISK_MEMOIZER_GC !== "false"),
  GC_INTERVAL: +(DISK_MEMOIZER_GC_INTERVAL || 1000 * 60 * 5),
  GC_LAST_ACCESS: DISK_MEMOIZER_GC_LAST_ACCESS || "1h"
};