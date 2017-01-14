'use strict';

var Promise = require('bluebird');
var chokidar = require('chokidar');
var fs = require('fs');
var cp = require('child_process');
var Hash = require('hashish');
var kue = require('kue');
var path = require('path');
var redis = require('redis');
var redisPromises = Promise.promisifyAll(redis, {suffix: 'Promise'});
var sprintf = require('sprintf');
var temp = require('temp');
var uuid = require('node-uuid');
var request = require('request');
var _ = require('underscore');
var logger = require('winston');
var socket = require('socket.io-client')('http://127.0.0.1:8080');
try {
  var CREDENTIALS = require('./credentials.json');
} catch (e) {
  console.log("No social credentials were found. This is running in local mode only.");
}
var emote = require('./emote');
var sessionImages = {};
var sessionId = 1;
var sessionIsComplete = false;
var SocialPublisher = require('./scripts/socialPublisher');
var express = require('express');
var http = require('http');
var socketIO = require('socket.io');
var phantomjs = require('phantomjs-prebuilt')
var phantomBinPath = phantomjs.path;
var dontPrint = false;
let socialPublisher;

let prepopulateArray = [];

logger.level = 'debug';

var highestScore = 0;

// Parse args, read config, and configure
var argv = require('minimist')(process.argv.slice(2));

try {
  var config = require('./config');
} catch (e) {
  throw "No config.js file found. Please follow the format in config.js.example";
}
 
if (!config.api_key) {
  throw "You need an API key in config.js in order to run this program. Please add to config.js";
}

config.port = argv.p || argv.port || config.port || 8081;
config.displayPort = argv.displayp || argv.displayport || config.display_port || 8080;
config.inDir = argv.w || argv.watch || config.inDir || 'in/';
config.outDir = argv.w || argv.watch || config.outDir || 'out/';

var app = express();
var server = http.Server(app);
var io = socketIO(server);


// This socket server is to provide a basic output for the image rendering
// Only basic modules are loaded into phantomjs, so we need a basic
// way of sending messages to tell the image renderer to stop.
var WebSocketServer = require('ws').Server;
var wss = new WebSocketServer({ port: 8088 });

wss.on('connection', function connection(ws) {
  ws.on('message', function incoming(message) {
    wss.clients.forEach(function each(client) {
      if (client !== ws) client.send(message);
    });
  });
});





// If the folder doesn't exist, create it
var checkDirs = [config.inDir, config.outDir, config.printDir, config.photostripDir];
checkDirs.forEach((dir) => {
  if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
  }
});

// Get array of prepopulated images
fs.readdir('prepopulate', function (err, files) {
  prepopulateArray = files;
});

// Remove all files currently contained within the `in` directory
// fs.readdir(config.inDir, function(err,files) {
//   files.forEach((file) => fs.unlink(config.inDir + file));
// })

// Create job queue
var queue = kue.createQueue();

// Redis
var client = redisPromises.createClient();
client.hkeys("image-data", function (err, replies) {
  replies.forEach(function (reply, i) {
    // delete all historical images
    client.del('image-data', reply);
  });
});

if (CREDENTIALS) {
  socialPublisher = new SocialPublisher.SocialPublisher(CREDENTIALS, saveSession);
}

// Define job mapping
var jobMapping = {
  newImage: {
    in: [],
    out: ['image_new']
  },
  sessionEnd: {
    in: [],
    out: ['session_end']
  },
  sessionComplete: {
    in: ['session_end'],
    out: []
  },
  convertToJpg: {
    in: ['image_new'],
    out: ['image_vision']
  },
  getVisionData: {
    in: ['image_vision'],
    out: ['image_finished']
  },
  finishedImage: {
    in: ['image_finished'],
    out: []
  }
};

const EMOTIONS = {
  NAMES: ['joyLikelihood', 'sorrowLikelihood', 'angerLikelihood', 'surpriseLikelihood'],
  LIKELIHOOD: {
    'VERY_UNLIKELY': 0,
    'UNLIKELY': 2,
    'POSSIBLE': 4,
    'LIKELY' : 8,
    'VERY_LIKELY': 16
  }
}

//
// Job mapping functions
//

function callNextJobs(jobName, data) {
  var outEvents = jobMapping[jobName].out;
  outEvents.forEach((outEvent) => {
    logger.debug(sprintf('%s succeeded, triggering out event: %s', jobName, outEvent));
    queue.create(outEvent, data).save();
  });
}

// Hook up a function to a job's "in" events
function hookJobToInEvents(jobName, callback) {
  jobMapping[jobName].in.forEach((eventName) => {
    queue.process(eventName, callback);
  })
}

// Use redis to track whether all jobs that feed into this one have completed.
// Returns a promise of wether the specified job is ready to run based on the
// number of input jobs and the number of completed input jobs.  This is meant
// to be called when one of the input jobs is completed and increments the
// completed input job counter.
function trackInputJobs(jobName, jobID) {
  // Job IDs are necessary for tracking
  if (!jobID) { throw new Error('No job ID'); }

  // Track the number of jobs that feed into this one
  var inEvents = jobMapping[jobName].in;
  var numInEvents = jobMapping[jobName].in.length;
  var numInputEvents = Hash(jobMapping).filter((value, key) => {
    // jobs whose outs plug into our ins ;)
    return _.intersection(value.out, inEvents).length > 0;
  }).keys.length;

  // This job was called by another, so increment the counter
  var redisKey = sprintf('%s-%s', jobID, jobName);
  return client.hincrbyPromise('finished-jobs', redisKey, 1)
  .then((numFinishedEvents) => {

    logger.debug(sprintf('Job %s received %d/%d events',
      jobName, numFinishedEvents, numInputEvents));

    // If all input jobs are completed..
    if (numInputEvents == numFinishedEvents) {
      logger.debug(sprintf('Semaphore acquired for %s, calling job function', jobName));
      return Promise.resolve(true);
    } else {
      return Promise.resolve(false);
    }

  });
}

function connectJob(jobName, func) {

  function jobWrapper(func) {
    return function callJob(job, done) {
      function finishJob(data) {
        done();
        callNextJobs(jobName, data);
      }

      try {
        trackInputJobs(jobName, job.data.id)
        .then((shouldRun) => { if (shouldRun) { func(job, finishJob); } });
      } finally {
        // Always call done, even if there is an error, otherwise the next job
        // of this type will not run, essentially freezing the queue
        done();
      }
    }
  }

  hookJobToInEvents(jobName, jobWrapper(func));
}

function scoreImageData(data) {
  let score = 0;
  const emotions = [];
  let faces = 0;
  if (data.responses) {
    if (data.responses[0].faceAnnotations) {
      faces = data.responses[0].faceAnnotations.length;
      data.responses[0].faceAnnotations.forEach((face) => {
        score += 40;
        EMOTIONS.NAMES.forEach((emotion) => {
          let emotionWeight = EMOTIONS.LIKELIHOOD[face[emotion]];
          if (EMOTIONS.NAMES[0] === emotion) {
            emotionWeight = emotionWeight / 2;
          }
          score += emotionWeight;
          if (emotionWeight) {
            emotions.push(emotion);
          }
        })
        score = score * (((emotions.length - 1) * 2) + 1);
      });
    }
  }
  // If score is 0, that means there is an error, set to last priority image
  if (score === 0) {
    score = -9999;
  }
  return {score, emotions, faces};
}

function scoreSession(sess) {
  let highScore = -100000;
  let highestScoredKey = null;
  for (const key in sess) {
    if (key !== 'complete') {
      const image = sess[key];
      const scoreData = scoreImageData(JSON.parse(fs.readFileSync(config.outDir + image.id + '-resp.json', 'utf8')));
      const score = scoreData.score;
      sess[key].emotions = scoreData.emotions;
      sess[key].score = score;
      sess[key].faces = scoreData.faces;
      if (score > highScore) {
        highScore = score;
        highestScoredKey = key;
      }
    }
  }
  highestScore = highScore;
  sess.highestScoredKey = highestScoredKey;
  return sess;
}

//
// Jobs
//

function sessionComplete(job, finish) {
  var currSessionId = sessionId;
  sessionId++;
  console.log('CURRENT SESSION ID: ', currSessionId);
  var sess = sessionImages[currSessionId];
  if (sess) {
    if (!sess.kill) {
      // sessionIsComplete = true;
      let allComplete = true;

      for (let key in sess) {
        if (sess[key] && key != 'complete') {
          if (!sess[key].complete) {
            allComplete = false;
          }
        }
      }

      if (allComplete) {
        console.log('ALL IMAGES PROCESSED');
        //client.publish('new_image', JSON.stringify(sess[scoreSession(sess)]));
        sess = scoreSession(sess);
        const topImages = topThreeImages(sess);
        if (topImages && highestScore !== -9999) {
          socket.emit('new_image', JSON.stringify(topImages));
          processFinalImages(sess);
        } else {
          console.log('No top images or no faces :( try taking more photos');
        }

        // sess.highestScoredKey = getHighestScoredKey(sess);

        // socket.emit('new_image', JSON.stringify(sess[sess.highestScoredKey]));
        // for (let key in sess) {
        //   if (sess[key].origPath) {
        //     sess[key].origPath = `${__dirname}/${sess[key].origPath}`;
        //     sess[key].finalPath = `${__dirname}/${sess[key].finalPath}`;
        //   }
        // }
        // if (argv.share) {
        //   socialPublisher.share(sess);
        // }
        // sessionIsComplete = false;
      } else {
        console.log('NOT ALL IMAGES HAVE BEEN PROCESSED!');
      }
    } else {
      console.log('SKIPPING IMAGES DUE TO KILL');
    }
  }
}
connectJob('sessionComplete', sessionComplete);

let imagesProcessing = 0;

function processNewImage(imagePath, imageData) {
  imagesProcessing++;
  if (!imageData) {
    imageData = {
      id: (new Date()).getTime(),
      path: imagePath,
      sessionId: sessionId,
      name: path.basename(imagePath, path.extname(imagePath)),
      origPath: null
    }
  }

  // copy image to /out directory
  let out = path.join(config.outDir, sprintf('%s-orig.jpg', imageData.id));
  imageData.origPath = out;
  imageData.finalPath = path.join(config.outDir, sprintf('%s-final.jpg', imageData.id));
  imageData.chromelessPath = path.join(config.outDir, sprintf('%s-final-chromeless.jpg', imageData.id));

  // TODO: this sometimes fails, leaving an empty image of 0 bytes.
  let read = fs.createReadStream(imagePath);
  let write = fs.createWriteStream(out);
  read.on('open', () => {
    console.log('writing file');
    read.pipe(write);
  });

  let error = false;

  read.on('error', (err) => {
    console.error('*************');
    console.error(err);
    error = true;
  });

  write.on('error', (err) => {
    console.error('-----------');
    console.error(err);
    error = true;
    imagesProcessing--;
  });

  write.on('close', function(){
    if (!error) {
      console.log('no error');
      var stat = fs.statSync(out);
      console.log('SIZE OF FILE: ', stat.size);
      if (!sessionImages[sessionId]) {
        sessionImages[sessionId] = {};
      }
      sessionImages[sessionId][imageData.id] = imageData;
      sessionImages[sessionId][imageData.id].wasProcessed = 0;
      callNextJobs('newImage', imageData);
    } else {
      console.log('WRITE ERROR');
      console.log(error);
      var stat = fs.statSync(out);
      console.log('SIZE OF FILE: ', stat.size);
      processNewImage(null, imageData);
    }
  });
}

function topThreeImages(sess) {

  let keys = [];
  for (let key in sess) {
    if (!!sess[key] && typeof sess[key] === 'object') {
      console.log(sess[key].score);
      if (typeof sess[key].score !== "undefined") {
        keys.push([key, sess[key].score]);
      }
    }
  }
  let topKeys = keys.sort(function(a, b) {return b[1] - a[1]}).slice(0, 3);

  if (topKeys.length === 0) {
    return null;
  }

  let topImages = [];
  topKeys.forEach((key) => {
    if (sess[key[0]].emotions.length) {
      topImages.push(sess[key[0]]);
    }
  })

  if (!topImages.length) {
    topImages.push(sess[topKeys[0][0]]);
  }

  return topImages;
}

function newImage(imagePath) {
  logger.debug('*********');
  logger.info(sprintf('Detected new file in directory: %s', imagePath));

  processNewImage(imagePath);
}

function convertToJpg(job, finish) {
  var image = job.data.path;

  logger.info(sprintf('Converting image to jpg: %s', image));

  // emote.convertToPNG(image, function(err, buffer) {
  //   if (err) {
  //     console.error(err);
  //   } else {
  //     var png = temp.path({suffix: '.jpg'});
  //     var writer = fs.createWriteStream(png)
  //     writer.write(buffer, null, () => {
  //       logger.info(sprintf('Converted image to PNG: %s', png));
  //       job.data.path = png;
  //       finish(job.data);
  //     });
  //   }
  // });
  finish(job.data);
}
connectJob('convertToJpg', convertToJpg);

function getVisionData(job, finish) {
  fs.readFile(job.data.path, (err, data) => {
    if (err) {
      console.log(err);
      return;
    }
    let encodedData = data.toString('base64');
    let encodedDataShort = data.toString('base64').substring(0, 200);

    let jsonData = {
      requests: [
        {
          image: {
            content: encodedData
          },
          features: [
            {
              type: 'FACE_DETECTION',
              maxResults: 20
            }
          ]
        }
      ]
    };

    let jsonDataShort = {
      requests: [
        {
          image: {
            content: encodedDataShort
          },
          features: [
            {
              type: 'FACE_DETECTION',
              maxResults: 20
            }
          ]
        }
      ]
    };

    fs.writeFile(path.join(config.outDir, job.data.id + '-req.json'), JSON.stringify(jsonDataShort));

    job.data.reqPath = path.join(config.outDir, job.data.id + '-req.json');

    request({
      method: 'POST',
      uri: 'https://vision.googleapis.com/v1/images:annotate',
      qs: {
        key: config.api_key
      },
      json: jsonData
    }, (err, response, body) => {
      fs.writeFile(path.join(config.outDir, job.data.id + '-resp.json'), JSON.stringify(body), (err) => {
        if (err) {
          console.log('There was an error while recieving response data', err);
          console.log(job.data);
        }
        job.data.respPath = path.join(config.outDir, job.data.id + '-resp.json');
        job.data.response = body;
        finish(job.data);
      });
    });
  });
}

connectJob('getVisionData', getVisionData);

function finishedImage(job, finish) {
  client.publish('new_image', JSON.stringify(job.data));

  job.data.complete = true;
  try {
    sessionImages[job.data.sessionId][job.data.id] = job.data;
  } catch (e) {
    console.log('----------------');
    console.log('ERROR SAVING SESSION');
  }
  console.log('finished image ', job.data.id, job.data.sessionId, sessionIsComplete)
  if (sessionImages[job.data.sessionId].complete) {
    sessionComplete({sessionId: job.data.sessionId});
  }

    imagesProcessing--;

  finish(job.data);
}
connectJob('finishedImage', finishedImage);

function runPhantomPhotoStrip(childArgs) {
  console.log("DONT PRINT ", dontPrint);
  if (!dontPrint) {
    cp.execFile(phantomBinPath, childArgs,
      (err, stdout, stderr) => {
        console.log(err, stdout, stderr);
        if (err) {
          console.log(err);
        } else {
          console.log('completed');
        }
      }
    )
  }
}

function compareScore(a,b) {
  if (a.score < b.score)
    return 1;
  if (a.score > b.score)
    return -1;
  return 0;
}

function processFinalImages(sess) {
  console.log('PROCESS FINAL IMAGES');
  saveSession(sess);
  let incompleteSession = !sess[sess.highestScoredKey].wasProcessed ? sess.highestScoredKey : null;
  let count = 0;
  let done = 0;

  for (let key in sess) {
    if (sess[key]) {
      if (sess[key].id) {
        count++;
      }
      if (sess[key].wasProcessed === 2) {
        done++;
      }
      if (sess[key].wasProcessed !== 2 && !incompleteSession && key !== 'complete' && key !== 'highestScoredKey') {
        incompleteSession = key;
      }
    }
  }
  if (!incompleteSession) {
    console.log('ALL FINAL IMAGES DONE');

    //sess.highestScoredKey = getHighestScoredKey(sess);

    //socket.emit('new_image', JSON.stringify(sess[sess.highestScoredKey]));

    const finalSessionID = (new Date()).getTime();
    sess.id = finalSessionID

    // Use overall session id to create a photostrip image path
    const photostripPath = config.photostripDir + finalSessionID + '/';
    //const renderPhotoStripPath = config.printDir + finalSessionID + '/';
    const renderPhotoStripPath = config.printDir + finalSessionID;

    // If the folder doesn't exist, create it
    if (!fs.existsSync(photostripPath)){
      fs.mkdirSync(photostripPath);
    }

    const photostripImages = [];
    const scoredPhotos = [];

   // Copy each chromeless photo to the photostrip folder

    // First push the scored images
    for (let key in sess) {
      if(sess[key].wasProcessed) {        
        if (sess[key].score > 1) {
          scoredPhotos.push({key: key, score: sess[key].score});
        }
      }
    }

    scoredPhotos.sort(compareScore);

    let numberOfFaces = 1;

    // Then push the unscored images
    for (let key in sess) {
      if(sess[key].faces){
        if (sess[key].faces > numberOfFaces) {
          numberOfFaces = sess[key].faces;
        }
      }
      if(sess[key].wasProcessed) {        
        if (sess[key].score <= 1) {
          let scoreNum = sess[key].score;
          scoredPhotos.push({key: key, score: scoreNum});
        }
      }
    }

    scoredPhotos.forEach((photo, index) => {
      if (index < 4) {
        const imageName = `${ sess[photo.key].id }.jpg`
        const filePath = photostripPath + imageName;
        photostripImages.push(imageName);
        fs.createReadStream(sess[photo.key].chromelessPath).pipe(fs.createWriteStream(filePath));
      }
    });

    // Call print function depending on how many faces there are
    const printFaces = Math.ceil(numberOfFaces / 2);
    for(let i = 0; i < printFaces; i++) {
      const childArgs = [
        path.join(__dirname, 'scripts/phantomPhotostripProcess.js'),
        photostripPath,
        `${ renderPhotoStripPath }-photostrip-${ i }.jpg`,
        photostripImages
      ];
      runPhantomPhotoStrip(childArgs);
    }

    if (argv.share) {
      socialPublisher.share(sess);
    } else {
      saveSession(sess);
    }

    // Remove image from the list of known files and move to completed folder
    for (var key in sess) {
      var tempFilePath = sess[key].path;
      if (tempFilePath) {
        var fileName = tempFilePath.split(config.inDir)[1];
        var index = inFiles.indexOf(fileName)
        inFiles.splice(index, 1);
        fs.rename(tempFilePath, config.inDir + 'completed/' + fileName)
      }
    }
    // sessionIsComplete = false;
  } else {
    console.log(`images processed ${done} / ${count}`);
    var out = path.join(config.outDir, sprintf('%s-final.jpg', sess[incompleteSession].id));
    sess[incompleteSession].finalPathChrome = out;

    var outChromeless = path.join(config.outDir, sprintf('%s-final-chromeless.jpg', sess[incompleteSession].id));
    sess[incompleteSession].finalPath = outChromeless;

    sess[incompleteSession].wasProcessed++;

    // logger.info(sprintf('Saving finished image: %s', out));

    var outJs = path.join(config.outDir, sprintf('%s.js', sess[incompleteSession].id));
    fs.writeFileSync(outJs, `newImage('${JSON.stringify(sess[incompleteSession])}')`)

    var childArgs = [
      path.join(__dirname, 'scripts/phantomChildProcess.js'),
      outJs,
      sess[incompleteSession].wasProcessed === 1 ? outChromeless: out,
      sess[incompleteSession].wasProcessed === 1 ? 'finalOnlyNoChrome' : 'finalOnly',
      5000
    ]

    console.log('running render on ', sess[incompleteSession].id);
    runPhantom(childArgs, sess[incompleteSession]);
  }
}

function saveSession(sess, id) {
  // for (let key in sess) {
  //   if (sess[key]) {
  //     if (sess[key].origPath) {

  //     }
  //   }
  // }
  client.hset('image-data', sess.id, JSON.stringify(sess));
}

function runPhantom(childArgs, incompleteSession) {
  console.log('RUN PHANTOM');
  cp.execFile(phantomBinPath, childArgs,
    (err, stdout, stderr) => {
      //console.log('complete');
      // console.log(err, stdout, stderr);

      if (err) {
        console.log('error rendering final', incompleteSession.id);
        console.log(err);
        // setTimeout(() => {
          //runPhantom(childArgs, incompleteSession);
        // }, 3000)
      }
      if (incompleteSession) {
        logger.info(sprintf('Saved finished image: %s', incompleteSession.finalPath));
        incompleteSession.complete = true;
        sessionImages[incompleteSession.sessionId][incompleteSession.id] = incompleteSession;

        console.log('Running session ', incompleteSession.sessionId);
        processFinalImages(sessionImages[incompleteSession.sessionId]);
      }
    }
  )
}

function testPhantom() {
  // var childArgs = [ '/vagrant/site/scripts/phantomChildProcess.js',
  // 'out/1479498598505.js',
  // 'out/1479498598505-final-chromeless.jpg',
  // 'finalOnlyNoChrome',
  // 20000 ]

  // runPhantom(childArgs, false);

  var childArgs = [ '/vagrant/site/scripts/phantomPhotostripProcess.js',
  'out-photostrips/1479747280054/',
  'out-print/1479747280054-photostrip-1.jpg',
  [ '1479747261776.jpg' ] ]

  runPhantomPhotoStrip(childArgs);
}

// setTimeout(testPhantom, 1000);

//
// File watcher/job queue interface
//

function fileDiff (a1, a2) {
  var a = [], diff = [];

  for (var i = 0; i < a1.length; i++) {
      a[a1[i]] = true;
  }

  for (var i = 0; i < a2.length; i++) {
      if (a[a2[i]]) {
          delete a[a2[i]];
      } else {
          a[a2[i]] = true;
      }
  }

  for (var k in a) {
      diff.push(k);
  }

  return diff;
};

try {
  fs.mkdirSync(config.inDir + '/completed');
} catch (e) {

}


// Simple file watcher that looks for images added to the in directory
var inFiles = [];
fs.readdir(config.inDir, function(err, files) {
  inFiles = files;
});

// Set an interval to look for the new images and run the functions we need to for new images
setInterval(function() {
  fs.readdir(config.inDir, function(err, files) {
    if (files.length != inFiles.length) {
      var newFiles = fileDiff(inFiles, files);
      for (var key in newFiles) {
        newImage(config.inDir + newFiles[key])
      }
    }
    inFiles = files;
  });
}, 2000);

// Stay alive
process.on('uncaughtException', function(err) {
  logger.error(err);
});

kue.app.listen(config.port);
logger.info(sprintf('Kue admin started on port %s', config.port));








// Images statically linked
app.use('/images', express.static(config.outDir));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/build/index.html');
});

app.get('/single', (req, res) => {
  res.sendFile(__dirname + '/build/single.html');
});

app.get('/buttons', (req, res) => {
  res.sendFile(__dirname + '/build/buttons.html');
});

app.get('/history', (req, res) => {
  res.sendFile(__dirname + '/build/history.html');
});

app.get('/directory', (req, res) => {
  res.sendFile(__dirname + '/build/directory.html');
});

app.get('/history-data', (req, res) => {
  client.hkeys("image-data", function (err, replies) {
    if (replies.length) {

      let filteredReplies = [];

      replies.forEach((reply) => {
        if (reply !== 'undefined') {
          filteredReplies.push(reply);
        }
      });

      client.hmget('image-data', filteredReplies, function(e, r) {
        res.setHeader('Content-Type', 'application/json');
        r.forEach((image, i) => {
          return JSON.parse(image);
        });
        res.send(JSON.stringify(r));
      })
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.send('null');
    }
  });
});

app.get('/delete-session/:id', (req, res) => {
  client.hget('image-data', req.params.id, (e, r) => {
    var data = JSON.parse(r);
    data.deleted = true;

    if (argv.share) {
      socialPublisher.delete(data.gistId, data.tweetId);
    }

    // socialPublisher.delete(data.gistId, data.tweetId);
    client.hset('image-data', req.params.id, JSON.stringify(data));
    io.emit('remove', data);
  });
  res.send(JSON.stringify({response: 'success'}));
});

// Statically link the frontend build
app.use(express.static('deploy'));
//app.use('in', express.static(__dirname + '/in'));
//app.use('out', express.static(__dirname + '/out'));
app.use('', express.static(__dirname + '/build'));

app.use(express.static('.'));

// Image API
var router = express.Router();

router.route('/images')
.get((req, res) => {
  var images = fs.readdirSync(config.outDir);
  images = images.filter((filename) => {
    return filename.endsWith('.json');
  });
  res.json({images: images});
});

router.route('/images/:image_id')
.get((req, res) => {
  var jsonFilename = req.params.image_id + '.json';
  var jsonPath = path.join(config.outDir, jsonFilename);
  fs.readFile(jsonPath, (err, imageJson) => {
    if (err) {
      logger.error(err);
      return res.json({});
    }
    var imageData = JSON.parse(imageJson);
    imageData.url = path.join('/images/', imageData.filename);
    res.json(imageData);
  });
});

app.use('/api', router);

function sendBackPrepopulated() {
  if (prepopulateArray.length > 0) {
    io.emit('returnPrepopulate', prepopulateArray);
  } else {
    setTimeout(sendBackPrepopulated, 1500);
  }
}

function endSessionFunc(data, iterations) {
  if (!iterations) {
    iterations = 0;
  }
  iterations++;
  console.log("IMAGES PROCESSING", imagesProcessing, iterations)
  if (imagesProcessing === 0 || iterations === 15) {
    console.log('END SESSION');
    if (sessionImages[sessionId]) {
      sessionImages[sessionId].complete = true;
    }
    callNextJobs('sessionEnd', {
      id: (new Date()).getTime()
    });
  } else {
    console.log('IMAGES NOT PROCESSED, SESSION NOT ENDING');
    console.log(data, iterations);
    setTimeout(() => {
      endSessionFunc(data, iterations);
    }, 1000);
  }
}

// Socket.io
io.on('connection', function(socket) {
  socket.on('new_image', (data) => {
    setTimeout(function() {
        socket.broadcast.emit('new_image', data);
      }, 5000);
  })

  socket.on('endSession', endSessionFunc);

  // App asks for prepopulate images
  socket.on('getPrepopulate', () =>{
    sendBackPrepopulated();
  });

  // If told not to print from the URL
  socket.on('dontprint', (data) => {
    console.log('dont print!!!!');
    dontPrint = true;
  });

  socket.on('killSession', (data) => {
    console.log('KILL SESSION');
    if (sessionImages[sessionId]) {
      sessionImages[sessionId].kill = true;
    }
    sessionId++;
    callNextJobs('sessionEnd', {
      id: (new Date()).getTime()
    });
  });

  logger.debug('New socket connection');
  // Pass on redis pubsub events re: new images
  var client = redis.createClient();
  client.subscribe('new_image');

  client.on('message', (channel, message) => {
    let jsonMsg = JSON.parse(message);

    let outMsg = {
      id: jsonMsg.id,
      origPath: jsonMsg.origPath,
      finalPath: jsonMsg.finalPath,
      reqPath: jsonMsg.reqPath,
      respPath: jsonMsg.respPath
    };
  });

  // client.keys("*", function (err, replies) {
  //   console.log(err, replies);
  // })
});

// Go!
server.listen(config.displayPort);
logger.info(sprintf('Display started on port %s', config.displayPort));
