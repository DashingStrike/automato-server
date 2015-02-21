var async = require('async');
var child_process = require('child_process');
var express = require('express');
var fs = require('fs');
var path = require('path');
var update = require('./update.js');

var log_file = fs.createWriteStream('/var/data/log/automato.log.txt', { flags: 'a+' });
function log(msg) {
  console.log(msg);
  log_file.write(new Date() + ' ' + msg + '\n');
}

function dogit(project, cmd, ignore, next) {
  child_process.exec(cmd, { cwd: project.work_dir }, function(error, stdout, stderr) {
    if (error && !ignore) {
      console.log('Error running "' + cmd + '"\n' + stdout + '\n' + stderr);
      return next(error);
    }
    next(null, stdout.toString(), stderr);
  });
}

// next(version)
function getGitVersion(project, next) {
  dogit(project, 'git show --format=%h', false, function(err, stdout) {
    if (err) {
      return next(err);
    }
    var version = stdout.split('\n')[0];
    log('Git version now ' + version);
    next(version);
  });
}

function updateGit(project, next) {
  async.series([
    function mkdDirAndClone(next) {
      fs.exists(project.work_dir, function (exists) {
        if (exists) {
          return next();
        }
        log('Performing initial clone...');
        child_process.exec(
          'git clone git://github.com/DashingStrike/Automato-' + project.name + '.git ' + project.name,
          { cwd: path.join(project.work_dir, '..') },
          function(error, stdout, stderr) {
            if (error) {
              console.log('Error cloning "' + project.name + '"\n' + stdout + '\n' + stderr);
              return next(error);
            }
            next();
          }
        );
      });
    },
    //dogit.bind(null, project, 'git config --unset core.autocrlf', true),
    //dogit.bind(null, project, 'git checkout .', false),
    dogit.bind(null, project, 'git config core.autocrlf false', true),
    function (next) {
      dogit(project, 'git pull', false, function(err, stdout, stderr) {
        if (stdout) {
          log('git stdout:\n' + stdout);
        }
        if (stderr) {
          log('git stderr:\n' + stderr);
        }
        next(err);
      });
    },
    //dogit.bind(null, project, 'git config core.autocrlf true', false),
    //dogit.bind(null, project, 'rm -rf VeggieTales/', false),
    //dogit.bind(null, project, 'git checkout .', false),
  ], function (err) {
    if (err) {
      throw err;
    }
    next();
  });
}

function copyModdedFiles(src, dst, final_next) {
  function doit(dir_in, dir_out, next) {
    var left = 1;
    function done() {
      --left;
      if (left === 0) {
        next();
      }
    }
    fs.readdir(dir_in, function(err, files) {
      files.forEach(function(filename) {
        if (filename[0] === '.') {
          return;
        }
        var fn_in = dir_in + '/' + filename;
        var fn_out = dir_out + '/' + filename;
        ++left;
        fs.stat(fn_in, function(err, stat) {
          if (stat.isDirectory()) {
            ++left;
            doit(fn_in, fn_out, done);
          } else if (stat.isFile()) {
            ++left;
            fs.readFile(fn_in, function(err, data_in) {
              fs.exists(fn_out, function (exists) {
                fs.readFile(fn_out, function(err, data_out) {
                  var short_fn = fn_in.slice(src.length + 1);
                  if (!exists) {
                    log('  ' + short_fn + ' does not exist, copying...');
                  } else if (err) {
                    log('  ' + short_fn + ' unable to read: ' + err + ', copying...');
                  } else if (!data_out) {
                    log('  ' + short_fn + ' read no data, copying...');
                  } else if (data_out.toString() !== data_in.toString()) {
                    log('  ' + short_fn + ' data comparison failed, copying...');
                  } else {
                    return done();
                  }
                  fs.mkdir(path.dirname(fn_out), function() {
                    fs.writeFile(fn_out, data_in, function(err) {
                      err && log(err);
                      done();
                    });
                  });
                });
              });
            });
          }
          done();
        });
      });
      done();
    });
  }
  doit(src, dst, final_next);
}

function doUpdate(project, res, next) {
  if (project.in_progress) {
    res && res.writeHead(503, { 'Content-Type': 'text/plain' });
    res && res.end('Update already in progress\n');
    return next && next();
  }
  function status(msg) {
    res && res.write(msg + '\r\n\r\n');
    log(project.name + ': ' + msg);
  }
  project.in_progress = true;
  res && res.writeHead(200, { 'Content-Type': 'text/plain' });
  status('Pulling from Git...');
  updateGit(project, function() {
    status('Generating manifest...');
    update.getManifest(project.work_dir, function(manifest) {
      var fn = path.join(project.out_dir, 'manifest.txt');
      status('Copying files...');
      copyModdedFiles(project.work_dir, project.out_dir, function() {
        status('Checking manifest...');
        fs.readFile(fn, 'utf8', function(err, data) {
          if (!err && data.toString() === manifest.toString()) {
            status('No change detected, ignoring.');
            project.in_progress = false;
            res && res.end();
            return next && next();
          }
          status('Saving manifest...');
          fs.writeFile(fn, manifest, 'utf8', function(err) {
            err && log(err);
            // Also save with timestamp for history's sake
            fs.writeFile(fn + '.' + (Date.now() / 1000).toFixed(0), manifest, 'utf8', function(err) {
              err && log(err);
              status('Updating version.txt...');
              getGitVersion(project, function(err, version) {
                err && log(err);
                fs.writeFile(path.join(project.out_dir, 'version.txt'), version, 'utf8', function(err) {
                  err && log(err);
                  status('Complete.');
                  project.in_progress = false;
                  res && res.end();
                  return next && next();
                });
              });
            });
          });
        });
      });
    });
  });
}


//////////////////////////////////////////////////////////////////////////
var _port = 4003;
var _work_dir = path.join(__dirname, 'games');
var _out_dir = '/var/data/smb_web/dashingstrike.com/Automato/games';
var _password = require('./secrets.json').password;
var _project_names = ['AtomZombieSmasher', 'Diablo3'];

if (!fs.existsSync(_work_dir)) {
  fs.mkdirSync(_work_dir);
}
if (!fs.existsSync(_out_dir)) {
  fs.mkdirSync(_out_dir);
}
var _projects = {};
_project_names.forEach(function (name) {
  _projects[name] = {
    name: name,
    work_dir: path.join(_work_dir, name),
    out_dir: path.join(_out_dir, name),
    in_progress: false,
  };
  if (!fs.existsSync(_projects[name].out_dir)) {
    fs.mkdirSync(_projects[name].out_dir);
  }
});

var app = express();
function handler(req, res) {
  var line = req.method + ' ' + req.client.remoteAddress + ' ' + req.url;
  log(line);
  
  if (req.query.password !== _password) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Access denied\n');
  }
  var project = _projects[req.query.game];
  if (!project) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Could not find game "' + req.query.game + '"\n');
  }
  doUpdate(project, res);
}
app.get('/', handler);
app.post('/', handler);
app.listen(_port, function () {
  log('Server running on port ' + _port);
});

process.on('uncaughtException', function(e) {
  log('Uncaught Exception: ' + e.stack + '\n\n');
});

async.eachSeries(Object.keys(_projects), function (name, next) {
  doUpdate(_projects[name], null, next);
});
