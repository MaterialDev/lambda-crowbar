var fs = require('fs');
var AWS = require('aws-sdk');
var extend = require('util')._extend;
var async = require('async');

exports.deploy = function(codePackage, config, callback, logger, lambda) {
  var functionArn = "";
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
      Endpoint: functionArn,
      TopicArn: config.pushSource.TopicArn
    };
    var createParams ={
      Name: config.pushSource.TopicArn
      TopicName: config.pushSource.TopicArn
    };
    var listTopicParams = {};
    var sns = new AWS.SNS({
      region: config.region,
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
    });
    sns.listTopics(listTopicParams, function(err, data){
      if (err){
        logger('Failed to list to topic');
        logger(err);
        callback(err);
      }else{
        var topicFound = false;
        for (var index = 0; index < data.Topics.length; index++){
          logger('Topic Names:');
          logger(data.Topics[index].TopicArn);
          logger('Configuration Names:');
          logger(config.functionName);
          if (data.Topics[index].TopicArn == config.functionName)
          {
            logger('Topic Found!');
            topicFound = true;
            break;
          }
        }

        if (topicFound == false)
        {
          sns.createTopic(createParams, function(err, data){
            if(err)
            {
              logger('Failed to create to topic');
              logger('Topic Name');
              logger(createParams.Name);
              logger(createParams.TopicName);
              logger(err);
              callback(err);
            }
          });
        }
      }
    });
    sns.subscribe(subParams, function(err, data){
      if (err){
        logger('failed to subscribe to topic');
        logger(err);
        callback(err);
      }else{
        var removePermissionParams = {
          FunctionName: config.functionName,
          StatementId: config.pushSource.StatementId
        };
        lambda.removePermission(removePermissionParams, function(err, data){
          if (err){
            if (err.statusCode !== 404){
              logger('unable to delete permission')
              logger(err);
            }else{
              logger('permission does not exist');
            }}
          else {
            logger(data);
          }
          var permissionParams = {
            FunctionName: config.functionName,
            Action: "lambda:InvokeFunction",
            Principal: "sns.amazonaws.com",
            StatementId: config.pushSource.StatementId,
            SourceArn: config.pushSource.TopicArn
          };
          lambda.addPermission(permissionParams, function(err, data){
            if (err){
              logger('failed to add permission');
              logger(err);
              callback(err);
            }
            else {
              logger('succeeded in adding permission');
              logger(data);
            }
          });
        });
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

      lambda.updateFunctionCode({FunctionName: params.FunctionName, ZipFile: data, Publish: false}, function(err, data) {
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
              publishVersion(callback);
            }
          });
        }
      });
    });
  };

  var publishVersion = function(callback){
    lambda.publishVersion({FunctionName: config.functionName}, function(err, data){
      if(err){
        logger(err);
      }else{
        logger(data);
        callback();
      }
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
          logger(data);
          functionArn = data.FunctionArn;
          updateEventSource(callback);
          updatePushSource(callback);
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
      logger(data);
      functionArn = data.Configuration.FunctionArn;
      updateFunction(callback);
    }
  });
};
