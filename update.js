const fs = require('fs');
const path = require('path');
const crc32 = require('./crc32.js');

function getManifest(base_dir, next, base_mode) {
  let manifest = [];
  function doit(dir, next) {
    let left = 1;
    let any_err;
    function done(err) {
      if (err) {
        any_err = err;
      }
      --left;
      if (left === 0) {
        return next(any_err);
      }
    }

    fs.readdir(dir, function (err, files) {
      if (err) {
        console.warn(err);
      }
      files.forEach(function (filename) {
        if (filename[0] === '.') {
          return;
        }
        let fn = `${dir}/${filename}`;
        ++left;
        fs.stat(fn, function (err, stat) {
          if (err) {
            return done(err);
          }
          if (stat.isDirectory()) {
            ++left;
            doit(fn, done);
          } else if (stat.isFile()) {
            let ext = path.extname(fn).toLowerCase();
            if (ext === '.png' || ext === '.wav' || path.basename(path.dirname(fn)) === 'scripts' ||
              fn.match(/\/scripts\//u) ||
              base_mode && path.basename(fn) !== 'manifest.txt' ||
              path.basename(path.dirname(fn)) === 'data' && path.basename(fn) === 'charTemplate.txt' ||
              path.basename(path.dirname(fn)) === 'ATITD' && ext === '.txt' // carrot_config.txt, ThistleReference.txt
            ) {
              ++left;
              fs.readFile(fn, function (err, data) {
                if (err) {
                  return done(err);
                }
                let crc = crc32.crc32(data);
                fn = path.relative(base_dir, fn);
                manifest.push({ fn: fn, crc: crc, mt: (Number(stat.mtime) / 1000), size: stat.size });
                done();
              });
            } else {
              if (fn.endsWith('README.md') || fn.endsWith('LICENSE')) {
                // expected files, ignore
              } else {
                console.log(`Skipping ${fn}`, path.basename(path.dirname(fn)), path.dirname(fn));
              }
            }
          }
          done();
        });
      });
      done();
    });
  }
  doit(base_dir, function () {
    let ii;
    let data = [];
    data.push('Version 1');
    manifest.sort(function (a, b) {
      if (a.fn.toLowerCase() < b.fn.toLowerCase()) {
        return -1;
      } else if (a.fn.toLowerCase() > b.fn.toLowerCase()) {
        return 1;
      }
      return 0;
    });
    for (ii = 0; ii < manifest.length; ++ii) {
      let m = manifest[ii];
      data.push('ManifestFileEntry');
      data.push(`    filename "${m.fn}"`);
      data.push(`    crc ${m.crc}`);
      //data.push('    time ' + m.mt);
      data.push(`    size ${m.size}`);
      data.push('End');
    }
    next(data.join('\n'));
  });
}

exports.getManifest = getManifest;

if (require.main === module) {
  getManifest('.', console.log, process.argv[2] === '--base');
}
