// Simple disk memoization and in memory LRU cache for high
// latency IO responses.
//
// https://github.com/bermi/disk-memoizer
//
// Check the README.md file for instructions and examples
module.exports = diskMemoizer;

const fs = require("fs");
const config = require("./config");
const gcTmpFiles = require("./gc");
const debug = require("debug")("disk-memoizer");
const path = require("path");
const mkdirp = require("mkdirp");
const createHash = require("crypto").createHash;
const LruCache = require("lru-cache");


// Used to convert md5 hashes into subfolder chunks
const RE_PATHIFY = /^([a-z0-9]{2})([a-z0-9]{2})([a-z0-9]{2})(.+)/;

function diskMemoizer(unmemoizedFn, {

  // Number of seconds before considering the cache stale
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
  memoryCacheItems = config.MEMORY_CACHE_ITEMS

} = {}) {

  const memoryCache = memoryCacheItems > 0
    ? new LruCache({
      max: memoryCacheItems,
      maxAge
    })
    : fakeLruCache();

  function diskMemoized(...args) {

    const callback = args.pop();
    const key = identity(args);

    marshaller = getMarshaller({
      type,
      marshaller
    });

    if (!config.FLUSH_CACHE && memoryCache.has(key)) {
      debug("[info] Using in memory cache for %s", key);
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
          type
        }, callback);
      } else {
        useCachedFile({
          key,
          cachePath,
          unmemoizedFn,
          marshaller,
          memoryCache,
          type
        }, callback);
      }
    });
  }

  diskMemoized.gc = function gc({interval = config.GC_INTERVAL} = {}) {
    return gcTmpFiles({
      maxAge,
      interval,
      cacheDir
    });
  };

  return diskMemoized;
}

function getCachePath(key, cacheDir = config.CACHE_DIR) {
  return path.normalize(
    `${cacheDir}/${createHash("md5").
      update(key).
      digest("hex").
      replace(RE_PATHIFY, "$1/$2/$3/$4")}.cache`
  );
}

function grabAndCache({
  key,
  cachePath,
  unmemoizedFn,
  args = [key],
  marshaller,
  memoryCache = fakeLruCache(),
  type
}, callback) {

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

        fs.writeFile(cachePath, data, (err) => {
          if (err) {
            debug("[error] Failed saving %s. Got error: %s",
              cachePath, err.message);
          } else {
            debug("[info] Saved cache for %s on %s", key, cachePath);
          }
          memoryCache.set(key, unmarshalledData);
          callback(null, unmarshalledData);
        });

      });

    });
  }
}

function useCachedFile({
  key,
  cachePath,
  unmemoizedFn,
  marshaller = marshallers.none,
  memoryCache = fakeLruCache(),
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


const marshallers = {
  none: {
    marshall: (data, callback) => callback(null, data),
    unmarshall: (data, callback) => callback(null, data)
  },
  json: {
    marshall(data, callback) {
      try {
        callback(null, JSON.stringify(data));
      } catch (err) {
        callback(new Error(`Invalid JSON. Got error ${err.message}`));
      }
    },
    unmarshall(data, callback) {
      if (!(data instanceof String) && !(data instanceof Buffer)) {
        return callback(null, data);
      }
      try {
        callback(null, JSON.parse(data));
      } catch (err) {
        callback(new Error(`Can't stringify data. Got error ${err.message}`));
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