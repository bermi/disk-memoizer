module.exports = diskMemoizer;

const fs = require("fs");
const config = require("./config");
const debug = require("debug")("disk-memoizer");
const path = require("path");
const mkdirp = require("mkdirp");
const createHash = require("crypto").createHash;
const LruCache = require("lru-cache");


// Used to convert md5 hashes into subfolder chunks
const RE_PATHIFY = /^([a-z0-9]{2})([a-z0-9]{2})([a-z0-9]{2})(.+)/;

function diskMemoizer(unmemoizedFn, {
  maxAge,
  type,
  marshaller = marshallers.none,
  cacheDir = config.CACHE_DIR,
  memoryCacheItems = config.MEMORY_CACHE_ITEMS
}) {

  const memoryCache = memoryCacheItems > 0
    ? new LruCache({max: memoryCacheItems})
    : fakeLruCache();

  return function diskMemoized(identity, callback) {

    const key = identity instanceof Function
      ? identity()
      : identity;

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
  };
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
  marshaller,
  memoryCache = fakeLruCache(),
  type
}, callback) {
  unmemoizedFn(key, (err, unmarshalledData) => {
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

  });
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

    debug("[info] Using local cache for %s", key);

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


// Expose for unit testing
if (process.env.NODE_ENV === "test") {
  module.exports.marshallers = marshallers;
  module.exports.grabAndCache = grabAndCache;
  module.exports.getCachePath = getCachePath;
  module.exports.hasExpired = hasExpired;
  module.exports.useCachedFile = useCachedFile;
}