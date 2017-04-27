/* eslint no-sync: 0, init-declarations: 0 */

const path = require("path");
const gc = require("../dist/gc");
const getCachePath = require("../lib/disk_memoizer").getCachePath;
const fs = require("fs");
const assert = require("assert");
const cacheDir = path.normalize(`${__dirname}/fixtures/`);


describe("When performing gc", () => {
  let gcInterval;

  const startDate = new Date();
  const aPath = getCachePath("a", cacheDir);
  const bPath = getCachePath("b", cacheDir);
  const cPath = getCachePath("c", cacheDir);
  const ignoredPath = path.normalize(`${aPath}.ignored`);

  before(() => {

    const pastDate = new Date(startDate - (1000 * 60 * 60 * 2));

    fs.writeFileSync(aPath, "a");

    // Only files with the .cache suffix should be considered
    fs.utimesSync(ignoredPath, pastDate, pastDate);

    fs.utimesSync(aPath, pastDate, pastDate);
    fs.utimesSync(bPath, startDate, startDate);
    fs.utimesSync(cPath, startDate, startDate);
  });

  after((done) => {
    fs.writeFile(aPath, "a", done);
  });

  it("should list files to delete", (done) => {
    gc.getFilesToDelete({
      cacheDir,
      maxAge: "1h"
    },
      (err, files) => {
        if (err) {
          throw err;
        }
        const paths = Object.keys(files);

        // Only files with the .cache extension should be considered
        paths.forEach((path) => {
          assert(path.match(/\.cache$/), "Unexpected file name");
        });

        assert.equal(paths[0], aPath, "Didn't find file");
        assert(paths.length === 1, "Number of paths to delete didn't match");
        assert(files[paths[0]] instanceof Date, "Not a Date instance");
        assert(files[paths[0]] <= startDate, "startDate larger than expected");

        done();
      });
  });

  it("should delete old files", (done) => {
    // We should be able to clean up the interval
    // before it times out
    gcInterval = gc({
      maxAge: "1h",
      interval: 1000 * 10,
      cacheDir
    });

    setTimeout(() => {
      fs.stat(aPath, (err, stats) => {
        assert(err instanceof Error, "Didn't return an error");
        assert(err.message.includes("ENOENT"), "Invalid error");
        assert(!stats, "Didn't expect stats to be set");
        clearInterval(gcInterval);
        done();
      });

    }, 100);
  });

});