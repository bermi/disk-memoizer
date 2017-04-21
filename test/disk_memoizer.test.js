/* eslint no-sync: 0, init-declarations: 0 */

const diskMemoizer = require("../lib/disk_memoizer");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("Disk memoizer", () => {
  const testingUrl = "http://echo.jsontest.com/key/value";
  const tmpDir = os.tmpdir();
  const jsonDoc = {key: "value"};
  const expectedCachePath = path.normalize(
    `${tmpDir}/disk-memoizer/c1/49/90/9e283ee6746623d46266824e7b.cache`
  );

  context("unit tests", () => {

    beforeEach((done) => {
      fs.unlink(expectedCachePath, () => done());
    });

    it("should know if the cache has expired", () => {
      // hasExpired
      assert(!diskMemoizer.hasExpired(300, new Date()),
        "it should have not expired");
      assert(!diskMemoizer.hasExpired(300, new Date(new Date() - 200)),
        "it should not have expired");
      assert(diskMemoizer.hasExpired(300, new Date(new Date() - 400)),
        "it should have expired");
    });

    it("should generate cache paths", () => {
      assert.equal(diskMemoizer.getCachePath(testingUrl),
        expectedCachePath);
    });

    it("should grab and cache", (done) => {
      assert.throws(() => {
        fs.readFileSync(expectedCachePath);
      }, Error);
      diskMemoizer.grabAndCache({
          key: testingUrl,
          type: "json",
          cachePath: expectedCachePath,
          unmemoizedFn: (url, callback) => {
            callback(null, jsonDoc);
          },
        },
        (err, doc) => {
          if (err) {
            throw err;
          }
          assert.deepEqual(doc, jsonDoc);
          assert.deepEqual(
            JSON.parse(fs.readFileSync(expectedCachePath)), jsonDoc
          );
          fs.unlinkSync(expectedCachePath);
          done();
        }
      );
    });

    it("should grab and cache", (done) => {
      assert.throws(() => {
        fs.readFileSync(expectedCachePath);
      }, Error);
      diskMemoizer.useCachedFile({
          key: testingUrl,
          type: "json",
          cachePath: expectedCachePath,
          unmemoizedFn: (url, callback) => {
            callback(null, jsonDoc);
          }
        },
        (err, doc) => {
          if (err) {
            throw err;
          }
          assert.deepEqual(doc, jsonDoc);
          assert.deepEqual(
            JSON.parse(fs.readFileSync(expectedCachePath)), jsonDoc
          );
          fs.unlinkSync(expectedCachePath);
          done();
        }
      );
    });


    it("should use a cached file and not fetch the url", (done) => {
      fs.writeFileSync(expectedCachePath, JSON.stringify(jsonDoc));
      diskMemoizer.useCachedFile({
          key: testingUrl,
          type: "json",
          cachePath: expectedCachePath,
          unmemoizedFn: (url) => {
            throw new Error(`Should not try to fetch ${url}`);
          }
        },
        (err, doc) => {
          if (err) {
            throw err;
          }
          assert.deepEqual(doc, jsonDoc);
          assert.deepEqual(
            JSON.parse(fs.readFileSync(expectedCachePath)), jsonDoc
          );
          fs.unlinkSync(expectedCachePath);
          done();
        }
      );
    });

    context("invalid JSON caused by race conditions", () => {

      it("should not use a cache file with incomplete JSON", (done) => {
        fs.writeFileSync(expectedCachePath, "{\"key\":");

        const memoizedFn = diskMemoizer((url, callback) => {
          callback(null, jsonDoc);
        }, {type: "json"});

        memoizedFn(testingUrl,
          (err, doc) => {
            if (err) {
              throw err;
            }
            assert.deepEqual(doc, jsonDoc);
            done();
          }
        );
      });
    });

  });

  context("functional tests", () => {
    const testingUrl = "http://date.jsontest.com/";
    const expectedCachePath = diskMemoizer.getCachePath(testingUrl);

    beforeEach((done) => {
      fs.unlink(expectedCachePath, () => done());
    });

    function getResponseJson() {
      return {ts: new Date().getTime()};
    }

    it("should cache JSON", (done) => {

      let firstResponse;
      const memoizedGetJson = diskMemoizer((url, callback) => {
        firstResponse = firstResponse || getResponseJson();
        callback(null, firstResponse);
      }, {
        maxAge: 100,
        type: "json"
      });

      memoizedGetJson(testingUrl, (err, doc) => {
        if (err) {
          throw err;
        }
        assert.equal(doc.ts, firstResponse.ts);

        memoizedGetJson(testingUrl, (err, doc) => {
          if (err) {
            throw err;
          }
          assert.equal(doc.ts, firstResponse.ts);

          const previousResponseTs = firstResponse.ts;
          firstResponse = null;
          setTimeout(() => {

            memoizedGetJson(testingUrl, (err, doc) => {
              if (err) {
                throw err;
              }
              assert.notEqual(doc.ts, previousResponseTs);

              fs.unlinkSync(expectedCachePath);
              done();
            });
          }, 120);

        });
      });
    });

    it("should serve JSON from memory", (done) => {

      let firstResponse;
      const memoizedGetJson = diskMemoizer((url, callback) => {
        firstResponse = firstResponse || getResponseJson();
        callback(null, firstResponse);
      }, {
        type: "json",
        memoryCacheItems: 100
      });

      memoizedGetJson(testingUrl, (err, doc) => {
        if (err) {
          throw err;
        }
        assert.equal(doc.ts, firstResponse.ts);

        fs.unlinkSync(expectedCachePath);

        const previousResponseTs = firstResponse.ts;
        firstResponse = null;
        setTimeout(() => {

          memoizedGetJson(testingUrl, (err, doc) => {
            if (err) {
              throw err;
            }
            // Although we don't have an item in the fs
            // we'll still get the copy from memory
            assert.equal(doc.ts, previousResponseTs);

            done();
          });
        }, 50);

      });
    });

    it("should limit items in memory", (done) => {

      let counter = 0;
      const memoizedGetJson = diskMemoizer((url, callback) => {
        counter += 1;
        callback(null, counter);
      }, {memoryCacheItems: 2});

      const onePath = diskMemoizer.getCachePath("one");
      const twoPath = diskMemoizer.getCachePath("two");
      const threePath = diskMemoizer.getCachePath("three");

      memoizedGetJson("one", (err, data) => {
        if (err) {
          throw err;
        }
        assert.equal(data, 1);

        memoizedGetJson("two", (err, data) => {
          if (err) {
            throw err;
          }
          assert.equal(data, 2);

          memoizedGetJson("three", (err, data) => {
            if (err) {
              throw err;
            }
            assert.equal(data, 3);
            counter = 41;
            fs.unlinkSync(onePath);

            // one should not be in memory anymore
            memoizedGetJson("one", (err, data) => {
              if (err) {
                throw err;
              }
              assert.equal(+data, 42);
              fs.unlinkSync(threePath);

              memoizedGetJson("three", (err, data) => {
                if (err) {
                  throw err;
                }
                assert.equal(data, 3);
                fs.unlinkSync(onePath);
                fs.unlinkSync(twoPath);
                // Reading from memory the cache file should
                // not be created again
                assert.throws(() => {
                  fs.unlinkSync(threePath);
                }, Error);
                done();
              });
            });
          });
        });
      });
    });

  });


});