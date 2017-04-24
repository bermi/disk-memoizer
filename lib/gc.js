module.exports = gcTmpFiles;

const config = require("./config");
const debug = require("debug")("disk-memoizer:gc");
const reltime = require("reltime");
const fs = require("fs");
const glob = require("glob");
const path = require("path");
const async = require("async");

const RE_TRAIL_SLASH = /\/$/;

function gcTmpFiles({
  maxAge = config.GC_LAST_ACCESS,
  interval = config.GC_INTERVAL,
  cacheDir = config.CACHE_DIR
}) {

  if (config.GC) {
    runGc();
    return setInterval(runGc, interval);
  }

  function runGc() {

    getFilesToDelete({
      cacheDir,
      maxAge
    }, (err, filesToDelete) => {
      if (err) {
        debug("[warning] gc getFilesToDelete failed with error: %s",
          err.message);
        return;
      }

      async.eachLimit(Object.keys(filesToDelete), 100, fs.unlink, (err) => {
        if (err) {
          // When there are no files to gc we might get an error from find
          debug("[warning] gc failed with error: %s", err.message);
        } else {
          debug("[info] gc completed: %j", filesToDelete);
        }
        debug("[info] next gc run in %dms", interval);
      });
    });
  }
}

function getFilesToDelete({
    maxAge = config.GC_LAST_ACCESS,
    cacheDir = config.CACHE_DIR
  }, callback) {

  const maxAgeDate = reltime.parse(new Date(), `-${maxAge}`);

  glob(`${path.normalize(cacheDir.replace(RE_TRAIL_SLASH, ""))}/**/*.cache`,
  (err, files) => {
    if (err) {
      return callback(err);
    }

    async.reduce(files, {}, (result, filepath, callback) => {

      fs.stat(filepath, (err, stat) => {
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