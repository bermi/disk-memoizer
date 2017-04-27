"use strict";

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

// Simple disk memoization and in memory LRU cache for high
// latency IO responses.
//
// https://github.com/bermi/disk-memoizer
//
// Check the README.md file for instructions and examples
module.exports = diskMemoizer;

var fs = require("fs");
var config = require("./config");
var gcTmpFiles = require("./gc");
var debug = require("debug")("disk-memoizer");
var path = require("path");
var mkdirp = require("mkdirp");
var createHash = require("crypto").createHash;
var LruCache = require("lru-cache");

// Used to convert md5 hashes into subfolder chunks
var RE_PATHIFY = /^([a-z0-9]{2})([a-z0-9]{2})([a-z0-9]{2})(.+)/;

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
      memoryCacheItems = _ref$memoryCacheItems === undefined ? config.MEMORY_CACHE_ITEMS : _ref$memoryCacheItems;

  var memoryCache = memoryCacheItems > 0 ? new LruCache({
    max: memoryCacheItems,
    maxAge: maxAge
  }) : fakeLruCache();

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
      debug("[info] Using in memory cache for %s", key);
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
          type: type
        }, callback);
      } else {
        useCachedFile({
          key: key,
          cachePath: cachePath,
          unmemoizedFn: unmemoizedFn,
          marshaller: marshaller,
          memoryCache: memoryCache,
          type: type
        }, callback);
      }
    });
  }

  diskMemoized.gc = function gc() {
    var _ref2 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
        _ref2$interval = _ref2.interval,
        interval = _ref2$interval === undefined ? config.GC_INTERVAL : _ref2$interval,
        _ref2$cacheDir = _ref2.cacheDir,
        cacheDir = _ref2$cacheDir === undefined ? cacheDir : _ref2$cacheDir,
        _ref2$maxAge = _ref2.maxAge,
        maxAge = _ref2$maxAge === undefined ? maxAge : _ref2$maxAge;

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

function getCachePath(key) {
  var cacheDir = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : config.CACHE_DIR;

  return path.normalize(cacheDir + "/" + createHash("md5").update(key).digest("hex").replace(RE_PATHIFY, "$1/$2/$3/$4") + ".cache");
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
      type = _ref3.type;


  unmemoizedFn.apply(undefined, _toConsumableArray(args.concat(grabAndCacheCallback)));

  function grabAndCacheCallback(err, unmarshalledData) {
    if (err) {
      return callback(err);
    }

    marshaller = getMarshaller({
      type: type,
      marshaller: marshaller
    });

    var cacheDir = path.dirname(cachePath);

    mkdirp(cacheDir, function (err) {
      if (err) {
        return callback(err);
      }

      marshaller.marshall(unmarshalledData, function (err, data) {
        if (err) {
          return callback(err);
        }

        fs.writeFile(cachePath, data, function (err) {
          if (err) {
            debug("[error] Failed saving %s. Got error: %s", cachePath, err.message);
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

function useCachedFile(_ref4, callback) {
  var key = _ref4.key,
      cachePath = _ref4.cachePath,
      unmemoizedFn = _ref4.unmemoizedFn,
      _ref4$marshaller = _ref4.marshaller,
      marshaller = _ref4$marshaller === undefined ? marshallers.none : _ref4$marshaller,
      _ref4$memoryCache = _ref4.memoryCache,
      memoryCache = _ref4$memoryCache === undefined ? fakeLruCache() : _ref4$memoryCache,
      type = _ref4.type;


  marshaller = getMarshaller({
    type: type,
    marshaller: marshaller
  });

  fs.readFile(cachePath, function (err, dataFromCache) {

    if (err) {
      return grabAndCache({
        key: key,
        cachePath: cachePath,
        unmemoizedFn: unmemoizedFn,
        marshaller: marshaller,
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
}

function hasExpired(maxAge, creationTime) {
  return maxAge && creationTime ? new Date().getTime() - maxAge > creationTime.getTime() : false;
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
      try {
        callback(null, JSON.stringify(data));
      } catch (err) {
        callback(new Error("Invalid JSON. Got error " + err.message));
      }
    },
    unmarshall: function unmarshall(data, callback) {
      if (!(data instanceof String) && !(data instanceof Buffer)) {
        return callback(null, data);
      }
      try {
        callback(null, JSON.parse(data));
      } catch (err) {
        callback(new Error("Can't stringify data. Got error " + err.message));
      }
    }
  }
};

function getMarshaller(_ref5) {
  var type = _ref5.type,
      marshaller = _ref5.marshaller;

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