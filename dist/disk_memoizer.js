"use strict";

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

// Simple disk memoization and in memory LRU cache for high
// latency IO responses.
//
// https://github.com/bermi/disk-memoizer
//
// Check the README.md file for instructions and examples
module.exports = diskMemoizer;

var fs = require("graceful-fs");
var config = require("./config");
var gcTmpFiles = require("./gc");
var debug = require("debug")("disk-memoizer");
var path = require("path");
var mkdirp = require("mkdirp");
var createHash = require("crypto").createHash;
var LruCache = require("lru-cache");
var lockFile = require("lockfile");

var os = require("os");
var LOCK_TMP_DIR = os.tmpdir();

function diskMemoizer(unmemoizedFn) {
  var _ref = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {},
      maxAge = _ref.maxAge,
      type = _ref.type,
      _ref$marshaller = _ref.marshaller,
      marshaller = _ref$marshaller === undefined ? marshallers.none : _ref$marshaller,
      _ref$identity = _ref.identity,
      identity = _ref$identity === undefined ? firstArg : _ref$identity,
      _ref$cacheDir = _ref.cacheDir,
      cacheDir = _ref$cacheDir === undefined ? config.CACHE_DIR : _ref$cacheDir,
      _ref$memoryCacheItems = _ref.memoryCacheItems,
      memoryCacheItems = _ref$memoryCacheItems === undefined ? config.MEMORY_CACHE_ITEMS : _ref$memoryCacheItems,
      _ref$lockStale = _ref.lockStale,
      lockStale = _ref$lockStale === undefined ? config.LOCK_STALE_MS : _ref$lockStale,
      _ref$lruCacheOptions = _ref.lruCacheOptions,
      lruCacheOptions = _ref$lruCacheOptions === undefined ? {
    max: memoryCacheItems,
    maxAge: maxAge
  } : _ref$lruCacheOptions;

  var memoryCache = memoryCacheItems > 0 || lruCacheOptions.max > 0 ? new LruCache(lruCacheOptions) : fakeLruCache();

  function diskMemoized() {
    for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    var callback = args.pop();
    var key = identity(args);

    marshaller = getMarshaller({
      type: type,
      marshaller: marshaller
    });

    if (!config.FLUSH_CACHE && memoryCache.has(key)) {
      debug("[info] Using in memory cache (%d items) for %s", memoryCache.length, key);
      return callback(null, memoryCache.get(key));
    }

    var cachePath = getCachePath(key, cacheDir);

    fs.stat(cachePath, function (err, stats) {

      var expired = maxAge > 0 && hasExpired(maxAge, stats && stats.ctime);

      if (config.FLUSH_CACHE || err || expired) {
        grabAndCache({
          key: key,
          cachePath: cachePath,
          unmemoizedFn: unmemoizedFn,
          args: args,
          marshaller: marshaller,
          memoryCache: memoryCache,
          lockStale: lockStale,
          type: type
        }, callback);
      } else {
        useCachedFile({
          key: key,
          cachePath: cachePath,
          unmemoizedFn: unmemoizedFn,
          marshaller: marshaller,
          lockStale: lockStale,
          memoryCache: memoryCache,
          type: type
        }, callback);
      }
    });
  }

  var currentCacheDir = cacheDir;
  var currentMaxAge = maxAge;

  diskMemoized.gc = function gc() {
    var _ref2 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
        _ref2$interval = _ref2.interval,
        interval = _ref2$interval === undefined ? config.GC_INTERVAL : _ref2$interval,
        cacheDir = _ref2.cacheDir,
        maxAge = _ref2.maxAge;

    cacheDir = cacheDir || currentCacheDir;
    maxAge = maxAge || currentMaxAge;

    debug("[info] GC Running with options %j", {
      maxAge: maxAge,
      interval: interval,
      cacheDir: cacheDir
    });

    return gcTmpFiles({
      maxAge: maxAge,
      interval: interval,
      cacheDir: cacheDir
    });
  };

  return diskMemoized;
}

// Used to convert md5 hashes into subfolder chunks
var RE_PATHIFY = /^([a-z0-9]{2})([a-z0-9]{2})([a-z0-9]{2})(.+)/;

function getCachePath(key) {
  var cacheDir = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : config.CACHE_DIR;

  return path.normalize(cacheDir + "/" + createHash("md5").update(key).digest("hex").replace(RE_PATHIFY, "$1/$2/$3/$4") + ".cache");
}

function getLockPath(key) {
  return path.normalize(LOCK_TMP_DIR + "/" + createHash("md5").update(key).digest("hex") + ".lock");
}

function grabAndCache(_ref3, callback) {
  var key = _ref3.key,
      cachePath = _ref3.cachePath,
      unmemoizedFn = _ref3.unmemoizedFn,
      _ref3$args = _ref3.args,
      args = _ref3$args === undefined ? [key] : _ref3$args,
      marshaller = _ref3.marshaller,
      _ref3$memoryCache = _ref3.memoryCache,
      memoryCache = _ref3$memoryCache === undefined ? fakeLruCache() : _ref3$memoryCache,
      lockStale = _ref3.lockStale,
      type = _ref3.type;


  var lockPath = getLockPath(cachePath);

  lockFile.check(lockPath, { stale: lockStale }, function (err, isLocked) {
    if (err) {
      return callback(err);
    }

    if (isLocked) {
      return delayedRead({
        key: key,
        cachePath: cachePath,
        unmemoizedFn: unmemoizedFn,
        marshaller: marshaller,
        memoryCache: memoryCache,
        lockStale: lockStale,
        type: type
      }, callback);
    }

    lockFile.lock(lockPath, { stale: lockStale }, function (err) {
      if (err) {
        // A concurrent lock? We'll try to read again in a bit
        return delayedRead({
          key: key,
          cachePath: cachePath,
          unmemoizedFn: unmemoizedFn,
          marshaller: marshaller,
          memoryCache: memoryCache,
          lockStale: lockStale,
          type: type
        }, callback);
      }
      unmemoizedFn.apply(undefined, _toConsumableArray(args.concat(grabAndCacheCallback)));
    });
  });

  function unlockAndReportError(err) {
    lockFile.unlock(lockPath, function () {
      callback(err);
    });
  }

  function grabAndCacheCallback(err, unmarshalledData) {
    if (err) {
      return unlockAndReportError(err);
    }

    marshaller = getMarshaller({
      type: type,
      marshaller: marshaller
    });

    var cacheDir = path.dirname(cachePath);

    mkdirp(cacheDir, function (err) {
      if (err) {
        return unlockAndReportError(err);
      }

      marshaller.marshall(unmarshalledData, function (err, data) {
        if (err) {
          return unlockAndReportError(err);
        }

        fs.writeFile(cachePath, data, function (err) {
          if (err) {
            debug("[error] Failed saving %s. Got error: %s", cachePath, err.message);
            return unlockAndReportError(err);
          }
          lockFile.unlock(lockPath, function () {

            debug("[info] Saved cache for %s on %s", key, cachePath);
            memoryCache.set(key, unmarshalledData);

            callback(null, unmarshalledData);
          });
        });
      });
    });
  }
}

function delayedRead(_ref4, callback) {
  var key = _ref4.key,
      cachePath = _ref4.cachePath,
      unmemoizedFn = _ref4.unmemoizedFn,
      marshaller = _ref4.marshaller,
      memoryCache = _ref4.memoryCache,
      lockStale = _ref4.lockStale,
      type = _ref4.type;

  // We'll wait until the lock
  setTimeout(function () {
    useCachedFile({
      key: key,
      cachePath: cachePath,
      unmemoizedFn: unmemoizedFn,
      marshaller: marshaller,
      memoryCache: memoryCache,
      lockStale: lockStale,
      type: type
    }, callback);
  }, 10);
}

function useCachedFile(_ref5, callback) {
  var key = _ref5.key,
      cachePath = _ref5.cachePath,
      unmemoizedFn = _ref5.unmemoizedFn,
      _ref5$marshaller = _ref5.marshaller,
      marshaller = _ref5$marshaller === undefined ? marshallers.none : _ref5$marshaller,
      _ref5$memoryCache = _ref5.memoryCache,
      memoryCache = _ref5$memoryCache === undefined ? fakeLruCache() : _ref5$memoryCache,
      lockStale = _ref5.lockStale,
      type = _ref5.type;


  marshaller = getMarshaller({
    type: type,
    marshaller: marshaller
  });

  var lockPath = getLockPath(cachePath);
  lockFile.check(lockPath, { stale: lockStale }, function (err, isLocked) {
    if (err) {
      return callback(err);
    }
    if (isLocked) {
      // If we've got this far and there's still a lock file, we've
      // probably hit a race condition with another concurrent process.
      // We'll retry when the lock is released.
      return delayedRead({
        key: key,
        cachePath: cachePath,
        unmemoizedFn: unmemoizedFn,
        marshaller: marshaller,
        memoryCache: memoryCache,
        lockStale: lockStale,
        type: type
      }, callback);
    }

    fs.readFile(cachePath, function (err, dataFromCache) {

      if (err) {
        debug("[warning] Failed reading file %s from cache %s", key, cachePath);
        return grabAndCache({
          key: key,
          cachePath: cachePath,
          unmemoizedFn: unmemoizedFn,
          marshaller: marshaller,
          lockStale: lockStale,
          type: type
        }, callback);
      }

      debug("[info] Using disk cache for %s from %s", key, cachePath);

      marshaller.unmarshall(dataFromCache, function (err, data) {
        if (err) {
          debug("[warning] Not caching %s. Failed marshalling data. Got error %s", key, err.message);
          unmemoizedFn(key, callback);
          return;
        }

        memoryCache.set(key, data);
        callback(null, data);
      });
    });
  });
}

function hasExpired(maxAge, creationTime) {
  return maxAge && creationTime ? new Date().getTime() - maxAge > creationTime.getTime() : false;
}

var errorObject = { value: null };

function tryCatch(fn, ctx, args) {
  try {
    return fn.apply(ctx, args);
  } catch (error) {
    errorObject.value = error;
    return errorObject;
  }
}

var marshallers = {
  none: {
    marshall: function marshall(data, callback) {
      return callback(null, data);
    },
    unmarshall: function unmarshall(data, callback) {
      return callback(null, data);
    }
  },
  json: {
    marshall: function marshall(data, callback) {
      var result = tryCatch(JSON.stringify, null, [data]);
      if (result === errorObject) {
        callback(new Error("Can't stringify data. Got error\n        " + result.value.message));
      } else {
        callback(null, result);
      }
    },
    unmarshall: function unmarshall(data, callback) {
      if (!(data instanceof String) && !(data instanceof Buffer)) {
        return callback(null, data);
      }
      var result = tryCatch(JSON.parse, null, [data]);
      if (result === errorObject) {
        callback(new Error("Invalid JSON. Got error " + result.value.message));
      } else {
        callback(null, result);
      }
    }
  }
};

function getMarshaller(_ref6) {
  var type = _ref6.type,
      marshaller = _ref6.marshaller;

  if (marshallers[type]) {
    marshaller = marshallers[type];
  }
  return marshaller;
}

function fakeLruCache() {
  return {
    has: function has() {
      return false;
    },
    set: function set() {
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