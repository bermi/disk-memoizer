"use strict";

module.exports = gcTmpFiles;

var config = require("./config");
var debug = require("debug")("disk-memoizer:gc");
var reltime = require("reltime");
var fs = require("fs");
var glob = require("glob");
var path = require("path");
var async = require("async");

var RE_TRAIL_SLASH = /\/$/;

function gcTmpFiles() {
  var _ref = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
      _ref$maxAge = _ref.maxAge,
      maxAge = _ref$maxAge === undefined ? config.GC_LAST_ACCESS : _ref$maxAge,
      _ref$interval = _ref.interval,
      interval = _ref$interval === undefined ? config.GC_INTERVAL : _ref$interval,
      _ref$cacheDir = _ref.cacheDir,
      cacheDir = _ref$cacheDir === undefined ? config.CACHE_DIR : _ref$cacheDir;

  if (config.GC) {
    runGc();
    return setInterval(runGc, interval);
  }

  function runGc() {

    getFilesToDelete({
      cacheDir: cacheDir,
      maxAge: maxAge
    }, function (err, filesToDelete) {
      if (err) {
        debug("[warning] gc getFilesToDelete failed with error: %s", err.message);
        return;
      }

      async.eachLimit(Object.keys(filesToDelete), 100, fs.unlink, function (err) {
        if (err) {
          // When there are no files to gc we might get an error from find
          debug("[warning] gc on %s failed with error: %s", cacheDir, err.message);
        } else {
          debug("[info] gc completed on %s: %j", cacheDir, filesToDelete);
        }
        debug("[info] next gc run for %s in %dms", cacheDir, interval);
      });
    });
  }
}

function getFilesToDelete(_ref2, callback) {
  var _ref2$maxAge = _ref2.maxAge,
      maxAge = _ref2$maxAge === undefined ? config.GC_LAST_ACCESS : _ref2$maxAge,
      _ref2$cacheDir = _ref2.cacheDir,
      cacheDir = _ref2$cacheDir === undefined ? config.CACHE_DIR : _ref2$cacheDir;


  var maxAgeDate = reltime.parse(new Date(), "-" + maxAge);

  glob(path.normalize(cacheDir.replace(RE_TRAIL_SLASH, "")) + "/**/*.cache", function (err, files) {
    if (err) {
      return callback(err);
    }

    async.reduce(files, {}, function (result, filepath, callback) {

      fs.stat(filepath, function (err, stat) {
        if (err) {
          return callback(err);
        }

        if (stat.atime.getTime() < maxAgeDate.getTime()) {
          result[filepath] = stat.atime;
        }
        callback(null, result);
      });
    }, callback);
  });
}

// Expose for unit testing
if (process.env.NODE_ENV === "test") {
  module.exports.getFilesToDelete = getFilesToDelete;
}