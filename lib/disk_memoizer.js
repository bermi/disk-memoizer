// Simple disk memoization and in memory LRU cache for high
// latency IO responses.
//
// https://github.com/bermi/disk-memoizer
//
// Check the README.md file for instructions and examples
module.exports = diskMemoizer;

const fs = require("graceful-fs");
const config = require("./config");
const gcTmpFiles = require("./gc");
const debug = require("debug")("disk-memoizer");
const path = require("path");
const mkdirp = require("mkdirp");
const createHash = require("crypto").createHash;
const LruCache = require("lru-cache");
const lockFile = require("lockfile");

const os = require("os");
const LOCK_TMP_DIR = os.tmpdir();

function diskMemoizer(unmemoizedFn, {

  // Number of milliseconds before considering the cache stale
  // By default the cache won't expire
  maxAge,

  // Content type, right now only "json" is supported, for other types
  // use a custom marshaller (see bellow)
  type,

  // Optional marshaller object with a marshall and an unmarshall
  // asynchronous function that can prepare data before saving it on the
  // disk and after reading it back.
  //
  // Unmarshalled response references will be kept in memory when
  // memoryCacheItems > 0.
  //
  // Example JSON marshaller (simplified without error handing):
  // {
  //    marshall: (data, callback) => callback(null, JSON.stringify(data)),
  //    unmarshall: (data, callback) => callback(null, JSON.parse(data))
  //  }
  //
  marshaller = marshallers.none,

  // By default the first argument of the method to be memoized will be used
  // as the cache key, you can provide a custom synchronous function that
  // will receive the arguments of the original function and can return
  // a unique string as the identifier for the cache key.
  identity = firstArg,

  // Where to store the cache? Defaults to the value set via the
  // environment variable DISK_MEMOIZER_CACHE_DIR
  cacheDir = config.CACHE_DIR,

  // Number of elements to keep on the lru in memory cache. Keep in mind
  // that each worker on a cluster will keep it's own copy.
  // Defaults to 0 or the environment variable
  // DISK_MEMOIZER_MEMORY_CACHE_ITEMS
  memoryCacheItems = config.MEMORY_CACHE_ITEMS,

  // How long before considering the lock stale?
  lockStale = config.LOCK_STALE_MS,

  lruCacheOptions = {
    max: memoryCacheItems,
    maxAge
  }

} = {}) {

  const memoryCache = memoryCacheItems > 0 || lruCacheOptions.max > 0
    ? new LruCache(lruCacheOptions)
    : fakeLruCache();

  function diskMemoized(...args) {

    const callback = args.pop();
    const key = identity(args);

    marshaller = getMarshaller({
      type,
      marshaller
    });

    if (!config.FLUSH_CACHE && memoryCache.has(key)) {
      debug("[info] Using in memory cache (%d items) for %s",
        memoryCache.length,
        key
      );
      return callback(null, memoryCache.get(key));
    }

    const cachePath = getCachePath(key, cacheDir);

    fs.stat(cachePath, (err, stats) => {

      const expired = maxAge > 0 && hasExpired(maxAge, stats && stats.ctime);

      if (config.FLUSH_CACHE || err || expired) {
        grabAndCache({
          key,
          cachePath,
          unmemoizedFn,
          args,
          marshaller,
          memoryCache,
          lockStale,
          type
        }, callback);
      } else {
        useCachedFile({
          key,
          cachePath,
          unmemoizedFn,
          marshaller,
          lockStale,
          memoryCache,
          type
        }, callback);
      }
    });
  }

  const currentCacheDir = cacheDir;
  const currentMaxAge = maxAge;

  diskMemoized.gc = function gc({
    interval = config.GC_INTERVAL,
    cacheDir,
    maxAge
  } = {}) {

    cacheDir = cacheDir || currentCacheDir;
    maxAge = maxAge || currentMaxAge;

    debug("[info] GC Running with options %j", {
      maxAge,
      interval,
      cacheDir
    });

    return gcTmpFiles({
      maxAge,
      interval,
      cacheDir
    });
  };

  return diskMemoized;
}

// Used to convert md5 hashes into subfolder chunks
const RE_PATHIFY = /^([a-z0-9]{2})([a-z0-9]{2})([a-z0-9]{2})(.+)/;

function getCachePath(key, cacheDir = config.CACHE_DIR) {
  return path.normalize(
    `${cacheDir}/${createHash("md5").
      update(key).
      digest("hex").
      replace(RE_PATHIFY, "$1/$2/$3/$4")}.cache`
  );
}

function getLockPath(key) {
  return path.normalize(
    `${LOCK_TMP_DIR}/${createHash("md5").
      update(key).
      digest("hex")}.lock`
  );
}


function grabAndCache({
  key,
  cachePath,
  unmemoizedFn,
  args = [key],
  marshaller,
  memoryCache = fakeLruCache(),
  lockStale,
  type
}, callback) {

  const lockPath = getLockPath(cachePath);

  const isLocked = lockFile.checkSync(lockPath, {stale: lockStale});

  if (isLocked) {
    // We'll wait until the lock
    waitForLockRelease({
      lockPath,
      key,
      cachePath,
      unmemoizedFn,
      marshaller,
      lockStale,
      memoryCache,
      type
    }, callback);
    return;
  }

  lockFile.lockSync(lockPath, {stale: lockStale});

  unmemoizedFn(...args.concat(grabAndCacheCallback));

  function grabAndCacheCallback(err, unmarshalledData) {
    if (err) {
      return callback(err);
    }

    marshaller = getMarshaller({
      type,
      marshaller
    });

    const cacheDir = path.dirname(cachePath);

    mkdirp(cacheDir, (err) => {
      if (err) {
        return callback(err);
      }

      marshaller.marshall(unmarshalledData, (err, data) => {
        if (err) {
          return callback(err);
        }

        // We'll save the file on a temporary file to avoid in-flight files
        // from being taken as complete
        const tmpCachePath = `${cachePath}.tmp`;
        fs.writeFile(tmpCachePath, data, (err) => {
          if (err) {
            debug("[error] Failed saving %s. Got error: %s",
              tmpCachePath,
              err.message
            );
            return callback(err);
          }
          // Rename the file once it's persisted in disk to make it available
          // to any queued cache
          fs.rename(tmpCachePath, cachePath, (err) => {
            if (err) {
              debug("[error] Failed saving %s. Got error: %s",
                cachePath, err.message);
              return callback(err);
            }

            debug("[info] Saved cache for %s on %s", key, cachePath);
            memoryCache.set(key, unmarshalledData);

            lockFile.unlock(lockPath, (err) => {
              if (err) {
                return callback(err);
              }
              callback(null, unmarshalledData);
            });
          });
        });
      });
    });

  }
}

const lockWatchers = {};
function waitForLockRelease({
  lockPath,
  key,
  cachePath,
  unmemoizedFn,
  marshaller,
  lockStale,
  memoryCache,
  type
}, callback) {
  // We only want to keep one lock watcher per lock path
  const hasWatcher = !!lockWatchers[lockPath];

  lockWatchers[lockPath] = lockWatchers[lockPath] || [];
  const currentWatchList = lockWatchers[lockPath];

  if (hasWatcher) {
    // If there's already a watcher there's no need to register a new
    // one, we'll defer the execution of the task until the watcher notifies
    // about changes on the lock
    currentWatchList.push(runOnLockReleased);
  } else {

    // Register a singleton watcher for a particular lock file

    let watcherFn = null;
    watcherFn = () => {
      runOnLockReleased();
      // Run all the watchers
      currentWatchList.forEach((watcher) => watcher());
      fs.unwatchFile(lockPath, watcherFn);
      currentWatchList.splice(0, currentWatchList.length);
    };
    fs.watch(lockPath, watcherFn);
  }

  function runOnLockReleased() {
    useCachedFile({
      key,
      cachePath,
      unmemoizedFn,
      marshaller,
      lockStale,
      memoryCache,
      type
    }, callback);
  }
}

function useCachedFile({
  key,
  cachePath,
  unmemoizedFn,
  marshaller = marshallers.none,
  memoryCache = fakeLruCache(),
  lockStale,
  type
}, callback) {

  marshaller = getMarshaller({
    type,
    marshaller
  });

  fs.readFile(cachePath, (err, dataFromCache) => {

    if (err) {
      return grabAndCache({
        key,
        cachePath,
        unmemoizedFn,
        marshaller,
        lockStale,
        type
      }, callback);
    }

    debug("[info] Using disk cache for %s from %s", key, cachePath);

    marshaller.unmarshall(dataFromCache, (err, data) => {
      if (err) {
        debug("[warning] Not caching %s. Failed marshalling data. Got error %s",
          key,
          err.message);
        unmemoizedFn(key, callback);
        return;
      }

      memoryCache.set(key, data);
      callback(null, data);
    });
  });
}

function hasExpired(maxAge, creationTime) {
  return maxAge && creationTime
  ? ((new Date().getTime()) - maxAge) > creationTime.getTime()
   : false;
}

const errorObject = {value: null};

function tryCatch(fn, ctx, args) {
  try {
    return fn.apply(ctx, args);
  } catch (error) {
    errorObject.value = error;
    return errorObject;
  }
}

const marshallers = {
  none: {
    marshall: (data, callback) => callback(null, data),
    unmarshall: (data, callback) => callback(null, data)
  },
  json: {
    marshall(data, callback) {
      const result = tryCatch(JSON.stringify, null, [data]);
      if (result === errorObject) {
        callback(new Error(`Can't stringify data. Got error
        ${result.value.message}`));
      } else {
        callback(null, result);
      }
    },
    unmarshall(data, callback) {
      if (!(data instanceof String) && !(data instanceof Buffer)) {
        return callback(null, data);
      }
      const result = tryCatch(JSON.parse, null, [data]);
      if (result === errorObject) {
        callback(new Error(`Invalid JSON. Got error ${result.value.message}`));
      } else {
        callback(null, result);
      }
    }
  }
};

function getMarshaller({type, marshaller}) {
  if (marshallers[type]) {
    marshaller = marshallers[type];
  }
  return marshaller;
}

function fakeLruCache () {
  return {
    has: () => false,
    set: () => {
      // ignored
    }
  };
}

function firstArg(args) {
  return args[0];
}

// Expose for unit testing
if (process.env.NODE_ENV === "test") {
  module.exports.marshallers = marshallers;
  module.exports.grabAndCache = grabAndCache;
  module.exports.getCachePath = getCachePath;
  module.exports.hasExpired = hasExpired;
  module.exports.useCachedFile = useCachedFile;
}