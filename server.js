// reference the http module so we can create a webserver
// Note: when spawning a server on Cloud9 IDE, 
// listen on the process.env.PORT and process.env.IP environment variables

// Click the 'Run' button at the top to start your server,
// then click the URL that is emitted to the Output tab of the console


var mongoClient = require('mongodb').MongoClient;
var ObjectID = require('mongodb').ObjectID;
var http = require('http');
var express = require('express');
var app = express();
var WebSocketServer = require('ws').Server;

var openid = require('openid');
var url = require('url');
var querystring = require('querystring');


var server = http.createServer(app);
server.listen(process.env.PORT || 3000, process.env.IP || "0.0.0.0", function () {
  var addr = server.address();
  console.log("Chat server listening at", addr.address + ":" + addr.port);
});

var extensions = [new openid.UserInterface(),
                  new openid.SimpleRegistration(
                      {
                        "email": true
                      }),
                  new openid.AttributeExchange(
                      {
                        "http://axschema.org/contact/email": "required",
                        "http://axschema.org/namePerson/friendly": "required",
                        "http://axschema.org/namePerson": "required"
                      }),
                  new openid.PAPE(
                      {
                        "max_auth_age": 24 * 60 * 60, // one day
                        "preferred_auth_policies": "none" //no auth method preferred.
                      })];

var relyingParty = new openid.RelyingParty('http://mongo-cli-nodejs.herokuapp.com/verify', // Verification URL (yours)
  null, // Realm (optional, specifies realm for OpenID authentication)
  false, // Use stateless verification
  false, // Strict mode
  extensions); // List of extensions to enable and include


var prefix = "tests.";
var tokens = {}; //token : email
var emails = {}; //email : token

var db = null;

mongoClient.connect('mongodb://user:pass@ds053978.mongolab.com:53978/jfx', function (err, _db) {
  if (err) throw err;
  console.log("Connected to Database");
  db = _db;
});

//clients grouped by the collection they subscribe to
var conns = {};
var connsAuth = {};

var wss = new WebSocketServer({
  server: server,
  path: '/api'
});
wss.broadcast = function (d, coll, fn, _i, ws) {
  //  this.clients not used
  if (Array.isArray(d)) {
    d.forEach(function (c) { wss.broadcast(c, coll, fn, _i, ws); });
  }
  else {
    var reply = JSON.stringify({ fn: fn, msg: d });
    if (d._canRead && d._canRead.length !== 0) {
      d._canRead.forEach(function (i) {
        var wsis = connsAuth[coll][i];
        if (wsis && wsis.length)
          wsis.forEach(function (wsi) {
            if (wsi === ws) wsi.send(JSON.stringify({ _i: _i, fn: fn, msg: d }));
            else wsi.send(reply);
          });
      });
    }
    else {
      conns[coll].forEach(function (wsi) {
        if (ws === wsi) ws.send(JSON.stringify({ _i: _i, fn: fn, msg: d }));
        else wsi.send(reply);
      });
    }
  }
};


wss.on('connection', function (ws) {

  console.log(ws.upgradeReq.url);
  var query = querystring.parse(url.parse(ws.upgradeReq.url).query);

  console.log(query.token, query.coll);
  var token = query.token;
  var email = tokens[token];
  var coll = query.coll ? db.collection(prefix + query.coll) : null;
  if (conns[coll.collectionName] === undefined)
    conns[coll.collectionName] = [];
  conns[coll.collectionName].push(ws);
  var accessControl = accessControlAnonymous;
  if (email) {
    if (connsAuth[coll.collectionName] === undefined)
      connsAuth[coll.collectionName] = {};
    if (connsAuth[coll.collectionName][email] === undefined)
      connsAuth[coll.collectionName][email] = [ws];
    else
      connsAuth[coll.collectionName][email].push(ws);
    accessControl = accessControlAuthenticated;
  }

  if (coll) {
    ws.on('message', function (message) {

      var r = JSON.parse(message);
      /*if(r.token){
         token = r.token;
        email = tokens[token];
        if (email ){
          conns[email] = ws;
        }
       }
       if (r.coll){
         coll = db.collection(prefix+r.coll);
       }*/

      if (accessControl.hasOwnProperty(r.fn)) {
        try {
          accessControl[r.fn](r.args, email);
        } catch (e) {
          console.log(e);
          send({ _i: r._i, msg: { error: e } });
        }

        console.log('r ', JSON.stringify(r.args));
        r.args.push(function (err, obj) {
          if (r.fn == 'find') { //obj.toArray) { 
            obj.toArray(function (err, data) {
              send({ _i: r._i, msg: data });
            })
          }
          else if (typeof obj == 'object' && obj !== null) { //worth broadcasting
            //send({_i:r._i, msg: obj});
            wss.broadcast(obj, coll.collectionName, r.fn, r._i, ws);
          } else {
            send({ _i: r._i, msg: obj });
          }
        })
        coll[r.fn].apply(coll, r.args);
      }
      else if (r.fn == 'auth') {
        send({ _i: r._i, msg: email });

      } else {//echo
        send(r);
      }

    });
  }
  else {
    ws.on('message', function (message) {
      ws.send(JSON.stringify({ error: 'put token and coll in the url querystring' }));
    });
  }

  function send(o) {
    ws.send(JSON.stringify(o));
  }


  ws.on('close', function () {
    //.log('b4 ', conns._.length);
    conns[coll.collectionName].splice(conns[coll.collectionName].indexOf(ws), 1);
    //  console.log('a4 ', conns._.length);
    if (email) {
      var wsis = connsAuth[coll.collectionName][email];
      var idx = wsis.indexOf(ws);
      if (idx >= 0)
        wsis.splice(idx, 1);
      //if length=0 might remove the array as well
    }
  });
});

app.get('/authenticate', function (request, response) {
  var identifier = request.query.openid_identifier;

  // Resolve identifier, associate, and build authentication URL
  relyingParty.authenticate(identifier, false, function (error, authUrl) {
    if (error) {
      response.writeHead(200);
      response.end('Authentication failed: ' + error.message);
    }
    else if (!authUrl) {
      response.writeHead(200);
      response.end('Authentication failed');
    }
    else {
      response.writeHead(302, { Location: authUrl });
      response.end();
    }
  });
});

app.get('/verify', function (request, res) {
  // Verify identity assertion
  // NOTE: Passing just the URL is also possible
  relyingParty.verifyAssertion(request, function (error, result) {
    res.writeHead(200);
    if (!error && result.authenticated) {
      var token = Math.ceil(1e16 * Math.random()).toString(16);
      emails[result.email] = token;
      tokens[token] = result.email;
      result.token = token;
      console.log(result);
      res.end(
      '<script>var r = ' + JSON.stringify(result) + ';function receiveMessage(event){' +
          'event.source.postMessage(JSON.stringify(r), event.origin);window.close();}' +
        'window.addEventListener("message", receiveMessage, false);</script>');
    } else
      res.end('Failure :('); // TODO: show some error message!
  });
});

console.log('static serve: ', __dirname + '/app');
app.use('/', express.static('app'));
//app.use(express.static(__dirname + '/app'));


var accessAnonymous = {
  read: function (email) { return [{ _canRead: null }, { _canRead: { $size: 0 } }] },
  upsert: function (email) { return [{ _canUpsert: null }, { _canUpsert: { $size: 0 } }] },
  remove: function (email) { return [{ _canRemove: null }, { _canRemove: { $size: 0 } }] }
};
var accessAuthenticated = {
  read: function (email) { return [{ _canRead: null }, { _canRead: { $size: 0 } }, { _canRead: { $in: [email] } }] },
  upsert: function (email) { return [{ _canUpsert: null }, { _canUpsert: { $size: 0 } }, { _canUpsert: { $in: [email] } }] },
  remove: function (email) { return [{ _canRemove: null }, { _canRemove: { $size: 0 } }, { _canRemove: { $in: [email] } }] }
};

var accessControlAnonymous = new AccessControl(accessAnonymous);
var accessControlAuthenticated = new AccessControl(accessAuthenticated);

function AccessControl(access) {

  this.find = function (args, email) {
    if (args.length > 0) {
      if (args[0].hasOwnProperty('$query')) {
        if (args[0].$query.$or) {
          args[0].$query = { $and: [args[0].$query, { $or: access.read(email) }] };
        } else {
          args[0].$query.$or = access.read(email);
        }
      } else {
        if (args[0].$or) {
          args[0] = { $and: [args[0], { $or: access.read(email) }] };
        } else {
          args[0].$or = access.read(email);
        }
      }
    }
  };
  this.insert = function (args, email) {
    if (!email) {
      if (Array.isArray(args)) {
        for (var i = 0; i < args.length; i++)
          removeSpecialFields(args[i]);
      } else {
        removeSpecialFields(args);
      }
    }
  };
  this.remove = function (args, email) {
    if (args[0].$or) {
      args[0] = { $and: [args[0], { $or: access.remove(email) }] };
    } else {
      args[0].$or = access.remove(email);
    }
  };
  this.update = function (args, email) {
    if (args[0].$or) {
      args[0] = { $and: [args[0], { $or: access.upsert(email) }] };
    } else {
      args[0].$or = access.upsert(email);
    }

    if (!email) {
      //update object is either the last or before last if options are given// (broken with findAndModify(q,sort,doc) .. todo
      if (args.length == 2) {
        removeSpecialFields(args[1]);
      } else if (args.length > 2) {
        removeSpecialFields(args[args.length - 2]);
      }
    }
    /*if (args[0]._id)
        args[0]._id = new ObjectID(args[0]._id);*/
  };

  this.findAndModify = this.update;
  this.findAndRemove = this.remove;
  this.save = this.insert;
};


function removeSpecialFields(o) {
  if (o.hasOwnProperty('$set')) {
    delete o.$set._canUpsert;
    delete o.$set._canRemove;
    delete o.$set._canRead;
  }
  if (o.hasOwnProperty('$push')) {
    delete o.$push._canUpsert;
    delete o.$push._canRemove;
    delete o.$push._canRead;
  }
  delete o._canUpsert;
  delete o._canRemove;
  delete o._canRead;
}
