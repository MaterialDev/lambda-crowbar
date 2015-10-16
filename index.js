var fs = require('fs');
var AWS = require('aws-sdk');
var extend = require('util')._extend;
var async = require('async');

exports.deploy = function(codePackage, config, callback, logger, lambda) {
  if (!logger) {
    logger = console.log;
  }

  if(!lambda) {
    if("profile" in config) {
      AWS.config.credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
    }

    if (process.env.HTTPS_PROXY) {
      if (!AWS.config.httpOptions) {
        AWS.config.httpOptions = {};
      }
      var HttpsProxyAgent = require('https-proxy-agent');
      AWS.config.httpOptions.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    }

    lambda = new AWS.Lambda({
      region: config.region,
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
    });
  }

  var params = {
    FunctionName: config.functionName,
    Description: config.description,
    Handler: config.handler,
    Role: config.role,
    Timeout: config.timeout,
    MemorySize: config.memorySize
  };

  var updatePushSource = function(callback){
    if (!config.pushSource) {
      callback();
      return;
    }

    var subParams = {
      Protocol: 'lambda',
      Endpoint: config.functionName,
      TopicArn: config.pushSource.TopicArn
    };
    var sns = new AWS.SNS({
      region: config.region,
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
    });
    sns.subscribe(subParams, function(err, data){
      if (err){
        logger('failed to subscribe to topic');
        logger(err);
        callback(err);
      }
    });
  };

  var updateEventSource = function(callback) {
    if(!config.eventSource) {
      callback();
      return;
    }

    var params = extend({
      FunctionName: config.functionName
    }, config.eventSource);

    lambda.listEventSourceMappings({
      FunctionName: params.FunctionName,
      EventSourceArn: params.EventSourceArn
    }, function(err, data) {
      if(err) {
        logger("List event source mapping failed, please make sure you have permission");
        callback(err);
      } else {
        if (data.EventSourceMappings.length === 0) {
          lambda.createEventSourceMapping(params, function(err, data) {
            if(err) {
              logger("Failed to create event source mapping!");
              callback(err);
            } else {
              callback();
            }
          });
        } else {
          async.eachSeries(data.EventSourceMappings, function(mapping, iteratorCallback) {
            lambda.updateEventSourceMapping({
              UUID: mapping.UUID,
              BatchSize: params.BatchSize
            }, iteratorCallback);
          }, function(err) {
            if(err) {
              logger("Update event source mapping failed");
              callback(err);
            }
          });
        }
      }
    });
  };

  var updateFunction = function(callback) {
    fs.readFile(codePackage, function(err, data) {
      if(err) {
        return callback('Error reading specified package "'+ codePackage + '"');
      }

      lambda.updateFunctionCode({FunctionName: params.FunctionName, ZipFile: data}, function(err, data) {
        if (err) {
          var warning = 'Package upload failed. ';
          warning += 'Check your iam:PassRole permissions.';
          gutil.log(warning);
          callback(err)
        } else {
          lambda.updateFunctionConfiguration(params, function(err, data) {
            if (err) {
              var warning = 'Update function configuration failed. ';
              logger(warning);
              callback(err);
            } else {
              updateEventSource(callback);
              updatePushSource(callback);
            }
          });
        }
      });
    });
  };

  var createFunction = function(callback) {
    fs.readFile(codePackage, function(err, data) {
      if(err) {
        return callback('Error reading specified package "'+ codePackage + '"');
      }

      params['Code'] = { ZipFile: data };
      params['Runtime'] = "nodejs";
      lambda.createFunction(params, function(err, data) {
        if (err) {
          var warning = 'Create function failed. ';
          warning += 'Check your iam:PassRole permissions.';
          logger(warning);
          callback(err)
        } else {
          updateEventSource(callback);
        }
      });
    });
  };


  lambda.getFunction({FunctionName: params.FunctionName}, function(err, data) {
    if (err) {
      if (err.statusCode === 404) {
        createFunction(callback);
      } else {
        var warning = 'AWS API request failed. ';
        warning += 'Check your AWS credentials and permissions.';
        logger(warning);
        callback(err);
      }
    } else {
      updateFunction(callback);
    }
  });
};
