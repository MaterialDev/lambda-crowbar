'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj; };

exports.deployLambda = deployLambda;
exports.deployScheduleLambda = deployScheduleLambda;
exports.createCloudWatchEventRule = createCloudWatchEventRule;
exports.createCloudWatchTargets = createCloudWatchTargets;
var fs = require('fs');
var AWS = require('aws-sdk');
var extend = require('util')._extend;
var async = require('async');
var HttpsProxyAgent = require('https-proxy-agent');
var Bluebird = require('bluebird');
var retry = require('bluebird-retry');
var __ = require('lodash');

var LAMBDA_RUNTIME = 'nodejs4.3';

function deployLambda(codePackage, config, logger, lambdaClient, callback) {
  return _deployLambdaFunction(codePackage, config, logger, lambdaClient).asCallback(callback);
}

/**
 * deploys a lambda, creates a rule, and then binds the lambda to the rule by creating a target
 * @param {file} codePackage a zip of the collection
 * @param {object} config note: should include the rule property that is an object of: {name, scheduleExpression, isEnabled, role, targetInput} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @param logger
 * @param lambdaClient
 * @param {function} callback the arguments are error and data
 *
 */
function deployScheduleLambda(codePackage, config, logger, lambdaClient, callback) {
  var functionArn = '';

  return _deployLambdaFunction(codePackage, config, logger, lambdaClient, callback).then(function (result) {
    functionArn = result.functionArn;

    if (!config.hasOwnProperty('rule') && (!config.rule.hasOwnProperty('name') || !config.rule.hasOwnProperty('scheduleExpression') || !config.rule.hasOwnProperty('isEnabled') || !config.rule.hasOwnProperty('role'))) {
      throw new Error('rule is required. Please include a property called rule that is an object which has the following: {name, scheduleExpression, isEnabled, role}');
    }

    return _createCloudWatchEventRuleFunction(config.rule);
  }).then(function (eventResult) {
    var targetInput = config.rule.targetInput ? JSON.stringify(config.rule.targetInput) : null;
    return _createCloudWatchTargetsFunction({ Rule: config.rule.name, Targets: [{ Id: config.functionName + '-' + config.rule.name, Arn: functionArn, Input: targetInput }] });
  }).catch(function (err) {
    logger('Error: ' + JSON.stringify(err));
    throw true;
  }).asCallback(callback);
}

/**
 * creates a rule
 * @param {object} config should include the rule property that is an object of: {name, scheduleExpression, isEnabled, role, targetInput} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @param {function} callback
 */
function createCloudWatchEventRule(config, callback) {
  return _createCloudWatchEventRuleFunction(config).catch(function (err) {
    logger('Error: ' + JSON.stringify(err));
    throw true;
  }).asCallback(callback);
}

/**
 * sets up a target, which creates the binding of a arn to a cloud watch event rule
 * @param {object} config {Rule, Targets} Rule is string (name of the rule, Targets is an array of {Arn *required*, Id *required*, Input, InputPath}. Arn of source linked to target, Id is a unique name for the target, Input the json
 * @param {function} callback
 */
function createCloudWatchTargets(config, callback) {
  return _createCloudWatchTargetsFunction(config).catch(function (err) {
    logger('Error: ' + JSON.stringify(err));
    throw true;
  }).asCallback(callback);
}

var _deployLambdaFunction = function _deployLambdaFunction(codePackage, config, logger, lambdaClient) {
  var functionArn = '';
  if (!logger) {
    logger = console.log;
  }
  if (!lambdaClient) {
    if ("profile" in config) {
      AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile: config.profile });
    }

    if (process.env.HTTPS_PROXY) {
      if (!AWS.config.httpOptions) {
        AWS.config.httpOptions = {};
      }

      AWS.config.httpOptions.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    }

    lambdaClient = new AWS.Lambda({
      region: config.region,
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : '',
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ''
    });

    logger('Access Key Id From Deployer: ' + config.accessKeyId);
  }

  var snsClient = new AWS.SNS({
    region: config.region,
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  var cloudWatchLogsClient = new AWS.CloudWatchLogs({
    region: config.region,
    accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
    secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
  });

  var params = {
    FunctionName: config.functionName,
    Description: config.description,
    Handler: config.handler,
    Role: config.role,
    Timeout: config.timeout || 10,
    MemorySize: config.memorySize || 128,
    Runtime: config.runtime || LAMBDA_RUNTIME
  };

  return _getLambdaFunction(lambdaClient, logger, params.FunctionName).then(function (getResult) {
    if (!getResult.lambdaExists) {
      return _createLambdaFunction(lambdaClient, logger, codePackage, params).then(function (createFunctionResult) {
        functionArn = createFunctionResult.functionArn;
      }).then(function () {
        return _updateEventSource(lambdaClient, config, logger);
      }).then(function () {
        return _updatePushSource(lambdaClient, snsClient, config, logger, functionArn);
      }).then(function () {
        var localAttachLoggingFunction = function localAttachLoggingFunction() {
          return _attachLogging(lambdaClient, cloudWatchLogsClient, logger, config, params);
        };
        return retry(localAttachLoggingFunction, { max_tries: 3, interval: 1000, backoff: 500 });
      }).catch(function (err) {
        logger('Error: ' + JSON.stringify(err));
        throw true;
      });
    } else {
      var _ret = function () {
        var existingFunctionArn = getResult.functionArn;
        return {
          v: _updateLambdaFunction(lambdaClient, logger, codePackage, params).then(function () {
            return _updateEventSource(lambdaClient, config, logger);
          }).then(function () {
            return _updatePushSource(lambdaClient, snsClient, config, logger, existingFunctionArn);
          }).then(function () {
            return _publishLambdaVersion(lambdaClient, logger, config);
          }).then(function () {
            var localAttachLoggingFunction = function localAttachLoggingFunction() {
              return _attachLogging(lambdaClient, cloudWatchLogsClient, logger, config, params);
            };
            return retry(localAttachLoggingFunction, { max_tries: 3, interval: 1000, backoff: 500 });
          }).catch(function (err) {
            logger('Error: ' + JSON.stringify(err));
            throw true;
          })
        };
      }();

      if ((typeof _ret === 'undefined' ? 'undefined' : _typeof(_ret)) === "object") return _ret.v;
    }
  }).catch(function (err) {
    logger('Error: ' + JSON.stringify(err));
    throw true;
  });
};

/**
 * Creates or Updates rules, this means you can disable or enable the state of this
 * @param {object} config {name, scheduleExpression, isEnabled, role} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @returns {Promise<object>|Promise<Error>}
 * @private
 */
var _createCloudWatchEventRuleFunction = function _createCloudWatchEventRuleFunction(config) {
  /* params
   {Name: 'STRING_VALUE', // required!//
    Description: 'STRING_VALUE',
    EventPattern: 'STRING_VALUE',
    RoleArn: 'STRING_VALUE',
    ScheduleExpression: 'STRING_VALUE',
    State: 'ENABLED | DISABLED' }
  */

  var params = {
    Name: config.name,
    ScheduleExpression: config.scheduleExpression,
    RoleArn: config.role,
    State: config.isEnabled ? 'ENABLED' : 'DISABLED'
  };

  var cloudWatchEvents = new AWS.CloudWatchEvents({
    region: config.region,
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  return new Bluebird(function (resolve, reject) {
    cloudWatchEvents.putRule(params, function (err, data) {
      if (err) {
        return reject(err);
      }

      return resolve(data);
    });
  });
};

var _createCloudWatchTargetsFunction = function _createCloudWatchTargetsFunction(config) {
  var cloudWatchEvents = new AWS.CloudWatchEvents({
    region: config.region,
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  //targets[{Id, Arn, Input}] Input is the JSON text sent to target
  return new Bluebird(function (resolve, reject) {
    cloudWatchEvents.putTargets(params, function (err, data) {
      if (err) {
        return reject(err);
      }

      return resolve(data);
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param functionName
 * @returns {bluebird|exports|module.exports}
 * Resolved Object:
 * lambdaExists - boolean flag that is true if lambda exists
 * functionArn - this is a string that contains arn to the lambda function
 * @private
 */
var _getLambdaFunction = function _getLambdaFunction(lambdaClient, logger, functionName) {
  return new Bluebird(function (resolve, reject) {
    var getFunctionParams = {
      FunctionName: functionName
    };

    lambdaClient.getFunction(getFunctionParams, function (err, data) {
      if (err && err.statusCode !== 404) {
        logger('AWS API request failed. Check your AWS credentials and permissions. [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else if (err && err.statusCode === 404) {
        logger('Lambda not found. [LambdaName: ' + functionName + ']');
        resolve({ lambdaExists: false });
      } else {
        logger('Lambda found! [LambdaName: ' + functionName + ']');
        resolve({
          lambdaExists: true,
          functionArn: data.Configuration.FunctionArn
        });
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param codePackage
 * @param params
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _createLambdaFunction = function _createLambdaFunction(lambdaClient, logger, codePackage, params) {
  return new Bluebird(function (resolve, reject) {
    logger('Creating LambdaFunction. [FunctionName: ' + params.FunctionName + ']');
    var data = fs.readFileSync(codePackage);

    params.Code = { ZipFile: data };
    lambdaClient.createFunction(params, function (err, data) {
      if (err) {
        logger('Create function failed. Check your iam:PassRole permissions. [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else {
        logger('Created Lambda successfully. [Data: ' + JSON.stringify(data) + ']');
        resolve({ functionArn: data.FunctionArn });
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param codePackage
 * @param params
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updateLambdaFunction = function _updateLambdaFunction(lambdaClient, logger, codePackage, params) {
  return new Bluebird(function (resolve, reject) {
    logger('Updating LambdaFunction. [FunctionName: ' + params.FunctionName + ']');
    var data = fs.readFileSync(codePackage);

    var updateFunctionParams = {
      FunctionName: params.FunctionName,
      ZipFile: data,
      Publish: false
    };

    lambdaClient.updateFunctionCode(updateFunctionParams, function (err, data) {
      if (err) {
        logger('UpdateFunction Error: ' + JSON.stringify(err));
        reject(err);
      } else {
        lambdaClient.updateFunctionConfiguration(params, function (err, data) {
          if (err) {
            logger('UpdateFunctionConfiguration Error: ' + JSON.stringify(err));
            reject(err);
          } else {
            logger('Successfully updated lambda. [FunctionName: ' + params.FunctionName + '] [Data: ' + JSON.stringify(data) + ']');
            resolve();
          }
        });
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param config
 * @param logger
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updateEventSource = function _updateEventSource(lambdaClient, config, logger) {
  return new Bluebird(function (resolve, reject) {
    if (!config.eventSource) {
      resolve();
      return;
    }

    var localParams = extend({
      FunctionName: config.functionName
    }, config.eventSource);

    var getEventSourceMappingsParams = {
      FunctionName: localParams.FunctionName,
      EventSourceArn: localParams.EventSourceArn
    };

    lambdaClient.listEventSourceMappings(getEventSourceMappingsParams, function (err, data) {
      if (err) {
        logger("List event source mapping failed, please make sure you have permission");
        reject(err);
      } else if (data.EventSourceMappings.length === 0) {
        lambdaClient.createEventSourceMapping(localParams, function (err, data) {
          if (err) {
            logger('Failed to create event source mapping! Error: ' + err);
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        async.eachSeries(data.EventSourceMappings, function (mapping, iteratorCallback) {

          var updateEventSourceMappingParams = {
            UUID: mapping.UUID,
            BatchSize: localParams.BatchSize
          };

          lambdaClient.updateEventSourceMapping(updateEventSourceMappingParams, iteratorCallback);
        }, function (err) {
          if (err) {
            logger('Update event source mapping failed. ' + err);
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param snsClient
 * @param config
 * @param logger
 * @param functionArn
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updatePushSource = function _updatePushSource(lambdaClient, snsClient, config, logger, functionArn) {
  if (!config.pushSource) {
    return Bluebird.resolve(true);
  }

  return Bluebird.each(config.pushSource, function (currentTopic, currentIndex, length) {
    logger('Executing Topic ' + currentIndex + ' of ' + length);
    logger('Current Topic: ' + JSON.stringify(currentTopic));
    var currentTopicNameArn = currentTopic.TopicArn;
    var currentTopicStatementId = currentTopic.StatementId;
    var topicName = currentTopic.TopicArn.split(':').pop();

    return _createTopicIfNotExists(snsClient, topicName).then(function () {
      return _subscribeLambdaToTopic(lambdaClient, snsClient, logger, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId);
    }).catch(function (err) {
      logger('Error: ' + JSON.stringify(err));
      throw true;
    });
  });
};

/**
 *
 * @param snsClient
 * @param topicName
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _createTopicIfNotExists = function _createTopicIfNotExists(snsClient, topicName) {
  return new Bluebird(function (resolve, reject) {
    var listTopicParams = {};

    snsClient.listTopics(listTopicParams, function (err, data) {
      if (err) {
        logger('Failed to list to topic. Error: ' + JSON.stringify(err));
        reject(err);
      } else {
        var foundTopic = __.find(data.Topics, function (o) {
          return o.TopicArn === topicName;
        });
        if (!__.isUndefined(foundTopic)) {
          resolve();
        } else {
          var createParams = {
            Name: topicName
          };

          snsClient.createTopic(createParams, function (err, data) {
            if (err) {
              logger('Failed to create to topic. Error ' + JSON.stringify(err));
              reject(err);
            } else {
              resolve();
            }
          });
        }
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param snsClient
 * @param logger
 * @param config
 * @param functionArn
 * @param topicName
 * @param currentTopicNameArn
 * @param currentTopicStatementId
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _subscribeLambdaToTopic = function _subscribeLambdaToTopic(lambdaClient, snsClient, logger, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId) {
  return new Bluebird(function (resolve, reject) {

    var subParams = {
      Protocol: 'lambda',
      Endpoint: functionArn,
      TopicArn: currentTopicNameArn
    };

    snsClient.subscribe(subParams, function (err, data) {
      if (err) {
        logger('Failed to subscribe to topic. [Topic Name: ' + topicName + '] [TopicArn: ' + subParams.TopicArn + '] [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else {
        var removePermissionParams = {
          FunctionName: config.functionName,
          StatementId: currentTopicStatementId
        };
        lambdaClient.removePermission(removePermissionParams, function (err, data) {
          if (err && err.StatusCode === 404) {
            logger('Permission does not exist. [Error: ' + JSON.stringify(err) + ']');
          } else if (err && err.statusCode !== 404) {
            logger('Unable to delete permission. [Error: ' + JSON.stringify(err) + ']');
          } else {
            logger('Permission deleted successfully! [Data: ' + JSON.stringify(data) + ']');
          }

          var permissionParams = {
            FunctionName: config.functionName,
            Action: "lambda:InvokeFunction",
            Principal: "sns.amazonaws.com",
            StatementId: currentTopicStatementId,
            SourceArn: currentTopicNameArn
          };
          lambdaClient.addPermission(permissionParams, function (err, data) {
            if (err) {
              logger('Failed to add permission. [Error: ' + JSON.stringify(err) + ']');
              reject(err);
            } else {
              logger('Succeeded in adding permission. [Data: ' + JSON.stringify(data) + ']');
              resolve();
            }
          });
        });
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param config
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _publishLambdaVersion = function _publishLambdaVersion(lambdaClient, logger, config) {
  return _publishVersion(lambdaClient, logger, config).then(function () {
    return _listVersionsByFunction(lambdaClient, logger, config);
  }).then(function (listVersionsResult) {

    var versionsToDelete = [];
    var last = listVersionsResult.Versions[listVersionsResult.Versions.length - 1].Version;
    for (var index = 0; index < listVersionsResult.Versions.length; ++index) {
      var version = listVersionsResult.Versions[index].Version;
      if (version !== "$LATEST" && version !== last) {
        versionsToDelete.push(_deleteLambdaFunctionVersion(lambdaClient, logger, config, version));
      }
    }

    return Bluebird.all(versionsToDelete);
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param config
 * @returns {Promise}
 * @private
 */
var _publishVersion = function _publishVersion(lambdaClient, logger, config) {
  return new Bluebird(function (resolve, reject) {
    var publishVersionParams = { FunctionName: config.functionName };

    lambdaClient.publishVersion(publishVersionParams, function (err, data) {
      if (err) {
        logger('Error Publishing Version. [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else {
        logger('Successfully published version. [Data: ' + JSON.stringify(data) + ']');
        resolve(data);
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param config
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _listVersionsByFunction = function _listVersionsByFunction(lambdaClient, logger, config) {
  return new Bluebird(function (resolve, reject) {
    var listVersionsParams = { FunctionName: config.functionName };
    lambdaClient.listVersionsByFunction(listVersionsParams, function (listErr, data) {
      if (listErr) {
        logger('Error Listing Versions for Lambda Function. [Error: ' + JSON.stringify(listErr) + ']');
        reject(listErr);
      } else {
        resolve(data);
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param config
 * @param version
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _deleteLambdaFunctionVersion = function _deleteLambdaFunctionVersion(lambdaClient, logger, config, version) {
  return new Bluebird(function (resolve) {

    var deleteFunctionParams = {
      FunctionName: config.functionName,
      Qualifier: version
    };

    lambdaClient.deleteFunction(deleteFunctionParams, function (err, data) {
      if (err) {
        logger('Failed to delete lambda version. [FunctionName: ' + config.functionName + '] [Version: ' + version + ']');
      } else {
        logger('Successfully deleted lambda version. [FunctionName: ' + config.functionName + '] [Version: ' + version + ']');
      }
      resolve();
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param cloudWatchLogsClient
 * @param logger
 * @param config
 * @param params
 * @returns {*}
 * @private
 */
var _attachLogging = function _attachLogging(lambdaClient, cloudWatchLogsClient, logger, config, params) {
  if (!config.logging) {
    return Promise.resolve('no logging to attach');
  }
  return _addLoggingLambdaPermissionToLambda(lambdaClient, logger, config).then(function () {
    return _updateCloudWatchLogsSubscription(cloudWatchLogsClient, logger, config, params);
  }).catch(function (err) {
    var parsedStatusCode = __.get(err, 'statusCode', '');
    logger('Error occurred in _attachLogging. [StatusCode: ' + parsedStatusCode + ']');
    if (parsedStatusCode !== 429 && err.statusCode !== '429') {
      logger('Recieved a non-retry throttle error');
      throw new retry.StopError('Recieved non-retry throttle error.  [Error: ' + JSON.stringify(err) + ']');
    }
  });
};

/**
 *
 * @param lambdaClient
 * @param logger
 * @param config
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _addLoggingLambdaPermissionToLambda = function _addLoggingLambdaPermissionToLambda(lambdaClient, logger, config) {
  return new Bluebird(function (resolve, reject) {
    // Need to add the permission once, but if it fails the second time no worries.
    var permissionParams = {
      Action: 'lambda:InvokeFunction',
      FunctionName: config.logging.LambdaFunctionName,
      Principal: config.logging.Principal,
      StatementId: config.logging.LambdaFunctionName + 'LoggingId'
    };
    lambdaClient.addPermission(permissionParams, function (err, data) {
      if (err) {
        if (err.message.match(/The statement id \(.*?\) provided already exists. Please provide a new statement id, or remove the existing statement./i)) {
          logger('Lambda function already contains loggingIndex [Function: ' + permissionParams.FunctionName + '] [Permission StatementId: ' + permissionParams.StatementId + ']');
          resolve();
        } else {
          logger('Error Adding Logging Permission to Lambda. [Error: ' + JSON.stringify(err) + ']', err.stack);
          reject(err);
        }
      } else {
        logger(data);
        resolve();
      }
    });
  });
};

/**
 *
 * @param cloudWatchLogsClient
 * @param logger
 * @param config
 * @param params
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updateCloudWatchLogsSubscription = function _updateCloudWatchLogsSubscription(cloudWatchLogsClient, logger, config, params) {
  return new Bluebird(function (resolve, reject) {
    var cloudWatchParams = {
      destinationArn: config.logging.Arn, /* required */
      filterName: 'LambdaStream_' + params.FunctionName,
      filterPattern: '',
      logGroupName: '/aws/lambda/' + params.FunctionName
    };
    logger('Function Name: ' + params.FunctionName);
    logger('Filter Name: ' + cloudWatchParams.filterName);
    logger('Log Group Name: ' + cloudWatchParams.logGroupName);
    cloudWatchLogsClient.putSubscriptionFilter(cloudWatchParams, function (err, data) {
      if (err) {
        if (err.message.match(/The specified log group does not exist./i)) {
          //this error shouldn't stop the deploy since its due to the lambda having never been executed in order to create the log group in Cloud Watch Logs,
          // so we are going to ignore this error
          // ..we should recover from this by creating the log group or it will be resolved on next execution after the lambda has been run once
          logger('Failed to add subscription filter to lambda due it log group not existing.  [LogGroupName: ' + cloudWatchParams.logGroupName + '][FilterName: ' + cloudWatchParams.filterName + ']');
          resolve();
        } else {
          logger('Failed To Add Mapping For Logger. [Error: ' + JSON.stringify(err) + ']');
          reject(err);
        }
      } else {
        logger('Successfully added subscription Filter. [LogGroupName: ' + cloudWatchParams.logGroupName + '][FilterName: ' + cloudWatchParams.filterName + '] [Response: ' + JSON.stringify(data) + ']');
        resolve();
      }
    });
  });
};
//# sourceMappingURL=index.js.map
