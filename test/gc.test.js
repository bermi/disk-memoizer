/* eslint no-sync: 0, init-declarations: 0 */

const path = require("path");
const cacheDir = path.normalize(`${__dirname}/fixtures/disk-memoizer`);

process.env.NODE_ENV = "test";

const gc = require("../lib/gc");
const fs = require("fs");
const assert = require("assert");


describe("When performing gc", () => {
  const startDate = new Date();
  let gcInterval;
  const tmpBasePath =
    path.normalize(`${__dirname}/fixtures/prefix`);

  before(() => {

    const pastDate = new Date(startDate - (1000 * 60 * 60 * 2));

    fs.writeFileSync(`${tmpBasePath}-a`, "");

    // Only files with prefix- should be considered
    fs.utimesSync(path.normalize(`${__dirname}/fixtures/please-ignore`),
      pastDate, pastDate);

    fs.utimesSync(`${tmpBasePath}-a`, pastDate, pastDate);
    fs.utimesSync(`${tmpBasePath}-b`, startDate, startDate);
    fs.utimesSync(`${tmpBasePath}-c`, startDate, startDate);
  });

  after(() => {
    clearInterval(gcInterval);
    fs.writeFileSync(`${tmpBasePath}-a`, "");
  });

  it("should list files to delete", (done) => {
    gc.getFilesToDelete(`${__dirname}/fixtures/`, {maxAge: "1h"},
      (err, files) => {
        if (err) {
          throw err;
        }
        const paths = Object.keys(files);

        // Only files with prefix- should be considered
        paths.forEach((path) => {
          assert(path.includes("prefix-"),
            "Unexpected file name");
        });

        assert(paths[0].includes("prefix-a"), "Didn't find file");
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
      fs.stat(`${tmpBasePath}-a`, (err, stats) => {
        assert(err instanceof Error, "Didn't return an error");
        assert(err.message.includes("ENOENT"), "Invalid error");
        assert(!stats, "Didn't expect stats to be set");
        done();
      });

    }, 100);
  });

});