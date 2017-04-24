# disk-memoizer

Simple disk memoization and in [memory LRU cache](https://www.npmjs.com/package/lru-cache) for speeding up frequently accessed high latency IO resources.


[![Build Status](https://api.travis-ci.org/bermi/disk-memoizer.svg)](http://travis-ci.org/bermi/disk-memoizer)  [![Dependency Status](https://david-dm.org/bermi/disk-memoizer.svg)](https://david-dm.org/bermi/disk-memoizer) [![](http://img.shields.io/npm/v/disk-memoizer.svg) ![](http://img.shields.io/npm/dm/disk-memoizer.svg)](https://www.npmjs.org/package/disk-memoizer)


## Installation

### As an npm module

    $ npm install disk-memoizer

## Usage

    const diskMemoizer = require("disk-memoizer");

    function fn(data, callback) {
      setTimeout(() => {
        callback(null, data);
      }, 2000);
    }

    const memoizedFn = diskMemoizer(fn, [options]);

    console.time("first");
    memoizedFn("foo", () => {
      console.timeEnd("first");

      console.time("second");
      memoizedFn("foo", () => {
        console.timeEnd("second");
      });
    });

### Options

None of the following options are required:

    {
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
      marshaller,

      // By default the first argument of the method to be memoized will be used
      // as the cache key, you can provide a custom synchronous function that
      // will receive the arguments of the original function and can return
      // a unique string as the identifier for the cache key.
      identity,

      // Where to store the cache? Defaults to the value set via the
      // environment variable DISK_MEMOIZER_CACHE_DIR
      cacheDir,

      // Number of elements to keep on the lru in memory cache. Keep in mind
      // that each worker on a cluster will keep it's own copy.
      // Defaults to 0 or the environment variable
      // DISK_MEMOIZER_MEMORY_CACHE_ITEMS
      memoryCacheItems
    }


### Environment variables

The disk-memoizer module will make use of the following defaults if set as
environment variables.

| Environment Variable | Default value | Description |
|---|---|---|
| DISK_MEMOIZER_MEMORY_CACHE_ITEMS | 0 | How many items should be kept in memory. This uses the [lru-cache](https://www.npmjs.com/package/lru-cache) module under the hood |
| DISK_MEMOIZER_CACHE_DIR | $TMPDIR/disk-memoizer | Directory where the cache will be stored. |
| DISK_MEMOIZER_FLUSH_CACHE | false | Forces re-caching items when set to true. |
| DISK_MEMOIZER_GC | true | Disables memoization garbage collection when set to false. Garbage collection will not take place on cluster workers, so you'll have to require disk-memoizer on a master process. |
| DISK_MEMOIZER_GC_INTERVAL | 300000 (5 minutes) | Seconds to wait between running the garbage collector. |
| DISK_MEMOIZER_GC_LAST_ACCESS | 1h | When removing old files only those that have not been accessed for the specified time will be removed. |



### Garbage collection

Memoized function contain a `.gc` method that will trigger garbage collection
for the selected `cacheDir` and `maxAge`.


    const memoizedFn = diskMemoizer(fn, [options]);
    const gcInterval = memoizedFn.gc({
      // Optional time in seconds between gc runs.
      // Default set via the environment variable DISK_MEMOIZER_GC_INTERVAL
      interval: 300000
    });

    // clear the gcInterval by calling clearInterval(gcInterval)



## Running tests

    npm run test

## License

(The MIT License)

Copyright (c) 2017 Fluid, Inc, Bermi Ferrer &lt;bferrer@fluid.com&gt;

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.