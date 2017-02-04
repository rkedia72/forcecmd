"use strict";
let fs = require("graceful-fs");
let url = require("url");
let SalesforceConnection = require("./salesforce");

function async(generator) {
  return function(...args) {
    let iterator = generator.apply(this, args);
    return new Promise((resolve, reject) => {
      function await(step) {
        if (step.done) {
          resolve(step.value);
          return;
        }
        Promise.resolve(step.value).then(iterator.next.bind(iterator), iterator.throw.bind(iterator)).then(await, reject);
      }
      await(iterator.next());
    });
  };
}

let timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

let login = async(function*(options) {
  let filePromise = nfcall(fs.readFile, "forcecmd.json", "utf-8");
  let file = yield filePromise;
  let config = JSON.parse(file);
  let excludeDirs = config.excludeDirs || [];
  let objects = config.objects || {};
  if (config.includeObjects) throw "includeObjects is obsolete";
  if (config.excludeObjects) throw "excludeObjects is obsolete";
  let apiVersion = config.apiVersion;
  let sfConn = yield loginAs(Object.assign({robust: true}, config, options));
  return {sfConn, apiVersion, excludeDirs, objects};
});

let loginAs = async(function*({apiVersion, loginUrl, username, password, robust, verbose, netlog}) {
  if (!apiVersion) throw "Missing apiVersion";

  if (!loginUrl) throw "Missing loginUrl";
  let loginUrlParsed = url.parse(loginUrl);
  if (loginUrlParsed.protocol != "https:") throw "loginUrl must start with https://";
  if (loginUrlParsed.port) throw "loginUrl must use the default port";
  let hostname = loginUrlParsed.hostname;

  if (!username) throw "Missing username";

  if (!password && process.env.FORCEPW) {
    if (verbose) {
      console.log("- Using password from FORCEPW environment variable");
    }
    password = process.env.FORCEPW;
  }

  if (!password) {
    let pwfileName = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json";
    if (verbose) {
      console.log("- Looking for password in file: " + pwfileName);
    }
    let pwfilePromise = nfcall(fs.readFile, pwfileName, "utf-8");
    let pwfile = yield pwfilePromise;
    let pwKey = loginUrl + "$" + username;
    if (verbose) {
      console.log("- Looking for password with key: " + pwKey);
    }
    password = JSON.parse(pwfile).passwords[pwKey];
  }
  if (!password) throw "Missing password";

  let sfConn = new SalesforceConnection();

  /* eslint-disable no-underscore-dangle */
  if (netlog) {
    let oldRequestNetlog = sfConn._request;
    sfConn._request = function(...args) {
      let [httpsOptions, requestBody] = args;
      return oldRequestNetlog.apply(this, args).then(res => {
        console.log("request success");
        console.log("request options:", httpsOptions);
        console.log("request body:", requestBody);
        console.log("response body:", res.responseBody);
        return res;
      }, err => {
        console.log("request error");
        console.log("request options:", httpsOptions);
        console.log("request body:", requestBody);
        console.log("response:", err);
        throw err;
      });
    };
  }

  if (robust) {
    let oldRequest = sfConn._request;
    sfConn._request = function(...args) {
      let doRequest = retries =>
        oldRequest.apply(this, args).catch(err => {
          if (err && err.networkError && err.networkError.errno == "ETIMEDOUT" && err.networkError.syscall == "connect" && retries > 0) {
            console.log("(Got connect ETIMEDOUT, retrying)");
            return doRequest(retries - 1);
          }
          if (err && err.networkError && err.networkError.errno == "ECONNRESET" && err.networkError.syscall == "read" && retries > 0) {
            console.log("(Got read ECONNRESET, retrying)");
            return doRequest(retries - 1);
          }
          throw err;
        });
      return doRequest(10);
    };
  }
  /* eslint-enable no-underscore-dangle */

  console.log("Login " + hostname + " " + username + " " + apiVersion);
  yield sfConn.partnerLogin({hostname, apiVersion, username, password});
  return sfConn;
});

function nfcall(fn, ...args) {
  return new Promise((resolve, reject) => {
    function nodeResolver(error, ...values) {
      if (error) {
        reject(error);
      } else if (values.length > 1) {
        resolve(values);
      } else {
        resolve(values[0]);
      }
    }
    try {
      fn.apply(undefined, [...args, nodeResolver]);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {async, timeout, login, loginAs, nfcall};
