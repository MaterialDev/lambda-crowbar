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
var lodash = require('lodash');

var LAMBDA_RUNTIME = 'nodejs4.3';

var nodeAwsLambda = function nodeAwsLambda() {
  return undefined;
};

function deployLambda(codePackage, config, lambdaClient, callback) {
  return deployLambdaFunction(codePackage, config, lambdaClient).asCallback(callback);
}

/**
 * deploys a lambda, creates a rule, and then binds the lambda to the rule by creating a target
 * @param {file} codePackage a zip of the collection
 * @param {object} config note: should include the rule property that is an object of: {name, scheduleExpression, isEnabled, role, targetInput} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @param lambdaClient
 * @param {function} callback the arguments are error and data
 *
 */
function deployScheduleLambda(codePackage, config, lambdaClient, callback) {
  var functionArn = '';

  return deployLambdaFunction(codePackage, config, lambdaClient, callback).then(function (result) {
    functionArn = result.functionArn;

    if (!config.hasOwnProperty('rule') && (!config.rule.hasOwnProperty('name') || !config.rule.hasOwnProperty('scheduleExpression') || !config.rule.hasOwnProperty('isEnabled') || !config.rule.hasOwnProperty('role'))) {
      throw new Error('rule is required. Please include a property called rule that is an object which has the following: {name, scheduleExpression, isEnabled, role}');
    }

    return createCloudWatchEventRuleFunction(config.rule);
  }).then(function (eventResult) {
    var targetInput = config.rule.targetInput ? JSON.stringify(config.rule.targetInput) : null;
    return _createCloudWatchTargetsFunction({ Rule: config.rule.name, Targets: [{ Id: config.functionName + '-' + config.rule.name, Arn: functionArn, Input: targetInput }] });
  }).catch(function (err) {
    console.error('Error: ' + JSON.stringify(err));
    throw err;
  }).asCallback(callback);
}

/**
 * creates a rule
 * @param {object} config should include the rule property that is an object of: {name, scheduleExpression, isEnabled, role, targetInput} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @param {function} callback
 */
function createCloudWatchEventRule(config, callback) {
  return createCloudWatchEventRuleFunction(config).catch(function (err) {
    console.error('Error: ' + JSON.stringify(err));
    throw err;
  }).asCallback(callback);
}

/**
 * sets up a target, which creates the binding of a arn to a cloud watch event rule
 * @param {object} config {Rule, Targets} Rule is string (name of the rule, Targets is an array of {Arn *required*, Id *required*, Input, InputPath}. Arn of source linked to target, Id is a unique name for the target, Input the json
 * @param {function} callback
 */
function createCloudWatchTargets(config, callback) {
  return _createCloudWatchTargetsFunction(config).catch(function (err) {
    console.error('Error: ' + JSON.stringify(err));
    throw true;
  }).asCallback(callback);
}

var deployLambdaFunction = function deployLambdaFunction(codePackage, config, lambdaClient) {
  var functionArn = '';
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
      region: 'region' in config ? config.region : 'us-east-1',
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : '',
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ''
    });

    console.log('Access Key Id From Deployer: ' + config.accessKeyId);
  }

  var snsClient = new AWS.SNS({
    region: 'region' in config ? config.region : 'us-east-1',
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  var cloudWatchLogsClient = new AWS.CloudWatchLogs({
    region: 'region' in config ? config.region : 'us-east-1',
    accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
    secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
  });

  var params = {
    FunctionName: config.functionName,
    Description: config.description,
    Handler: config.handler,
    Role: config.role || 'arn:aws:iam::677310820158:role/lambda_basic_execution',
    Timeout: config.timeout || 10,
    MemorySize: config.memorySize || 128,
    Runtime: config.runtime || LAMBDA_RUNTIME
  };

  return _getLambdaFunction(lambdaClient, params.FunctionName).then(function (getResult) {
    if (!getResult.lambdaExists) {
      return _createLambdaFunction(lambdaClient, codePackage, params).then(function (createFunctionResult) {
        functionArn = createFunctionResult.functionArn;
      }).then(function () {
        return _updateEventSource(lambdaClient, config);
      }).then(function () {
        return _updatePushSource(lambdaClient, snsClient, config, functionArn);
      }).then(function () {
        var localAttachLoggingFunction = function localAttachLoggingFunction() {
          return _attachLogging(lambdaClient, cloudWatchLogsClient, config, params);
        };
        return retry(localAttachLoggingFunction, { max_tries: 3, interval: 1000, backoff: 500 });
      }).catch(function (err) {
        console.error('Error: ' + JSON.stringify(err));
        throw err;
      });
    } else {
      var _ret = function () {
        var existingFunctionArn = getResult.functionArn;
        return {
          v: _updateLambdaFunction(lambdaClient, codePackage, params).then(function () {
            return _updateEventSource(lambdaClient, config);
          }).then(function () {
            return _updatePushSource(lambdaClient, snsClient, config, existingFunctionArn);
          }).then(function () {
            return _publishLambdaVersion(lambdaClient, config);
          }).then(function () {
            var localAttachLoggingFunction = function localAttachLoggingFunction() {
              return _attachLogging(lambdaClient, cloudWatchLogsClient, config, params);
            };
            return retry(localAttachLoggingFunction, { max_tries: 3, interval: 1000, backoff: 500 });
          }).catch(function (err) {
            console.error('Error: ' + JSON.stringify(err));
            throw err;
          })
        };
      }();

      if ((typeof _ret === 'undefined' ? 'undefined' : _typeof(_ret)) === "object") return _ret.v;
    }
  }).catch(function (err) {
    console.error('Error: ' + JSON.stringify(err));
    throw err;
  });
};

/**
 * Creates or Updates rules, this means you can disable or enable the state of this
 * @param {object} config {name, scheduleExpression, isEnabled, role} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @returns {Promise<object>|Promise<Error>}
 * @private
 */
var createCloudWatchEventRuleFunction = function createCloudWatchEventRuleFunction(config) {
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
    Role: config.role || 'arn:aws:iam::677310820158:role/lambda_basic_execution',
    State: config.isEnabled ? 'ENABLED' : 'DISABLED'
  };

  var cloudWatchEvents = new AWS.CloudWatchEvents({
    region: 'region' in config ? config.region : 'us-east-1',
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
    region: 'region' in config ? config.region : 'us-east-1',
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
 * @param functionName
 * @returns {bluebird|exports|module.exports}
 * Resolved Object:
 * lambdaExists - boolean flag that is true if lambda exists
 * functionArn - this is a string that contains arn to the lambda function
 * @private
 */
var _getLambdaFunction = function _getLambdaFunction(lambdaClient, functionName) {
  return new Bluebird(function (resolve, reject) {
    var getFunctionParams = {
      FunctionName: functionName
    };

    lambdaClient.getFunction(getFunctionParams, function (err, data) {
      if (err && err.statusCode !== 404) {
        console.log('AWS API request failed. Check your AWS credentials and permissions. [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else if (err && err.statusCode === 404) {
        console.log('Lambda not found. [LambdaName: ' + functionName + ']');
        resolve({ lambdaExists: false });
      } else {
        console.log('Lambda found! [LambdaName: ' + functionName + ']');
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
 * @param codePackage
 * @param params
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _createLambdaFunction = function _createLambdaFunction(lambdaClient, codePackage, params) {
  return new Bluebird(function (resolve, reject) {
    console.log('Creating LambdaFunction. [FunctionName: ' + params.FunctionName + ']');
    var data = fs.readFileSync(codePackage);

    params.Code = { ZipFile: data };
    lambdaClient.createFunction(params, function (err, data) {
      if (err) {
        console.erroor('Create function failed. Check your iam:PassRole permissions. [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else {
        console.log('Created Lambda successfully. [Data: ' + JSON.stringify(data) + ']');
        resolve({ functionArn: data.FunctionArn });
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param codePackage
 * @param params
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updateLambdaFunction = function _updateLambdaFunction(lambdaClient, codePackage, params) {
  return new Bluebird(function (resolve, reject) {
    console.log('Updating LambdaFunction. [FunctionName: ' + params.FunctionName + ']');
    var data = fs.readFileSync(codePackage);

    var updateFunctionParams = {
      FunctionName: params.FunctionName,
      ZipFile: data,
      Publish: false
    };

    lambdaClient.updateFunctionCode(updateFunctionParams, function (err, data) {
      if (err) {
        console.lerror('UpdateFunction Error: ' + JSON.stringify(err));
        reject(err);
      } else {
        lambdaClient.updateFunctionConfiguration(params, function (err, data) {
          if (err) {
            console.error('UpdateFunctionConfiguration Error: ' + JSON.stringify(err));
            reject(err);
          } else {
            console.log('Successfully updated lambda. [FunctionName: ' + params.FunctionName + '] [Data: ' + JSON.stringify(data) + ']');
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
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updateEventSource = function _updateEventSource(lambdaClient, config) {
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
        console.error("List event source mapping failed, please make sure you have permission");
        console.error('error: ' + err);
        reject(err);
      } else if (data.EventSourceMappings.length === 0) {
        lambdaClient.createEventSourceMapping(localParams, function (err, data) {
          if (err) {
            console.error('Failed to create event source mapping! Error: ' + err);
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
            console.error('Update event source mapping failed. ' + err);
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
 * @param functionArn
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updatePushSource = function _updatePushSource(lambdaClient, snsClient, config, functionArn) {
  if (!config.pushSource) {
    return Bluebird.resolve(true);
  }

  return Bluebird.each(config.pushSource, function (currentTopic, currentIndex, length) {
    console.log('Executing Topic ' + currentIndex + ' of ' + length);
    console.log('Current Topic: ' + JSON.stringify(currentTopic));
    var currentTopicNameArn = currentTopic.TopicArn;
    var currentTopicStatementId = currentTopic.StatementId;
    var topicName = currentTopic.TopicArn.split(':').pop();

    return _createTopicIfNotExists(snsClient, topicName).then(function () {
      return _subscribeLambdaToTopic(lambdaClient, snsClient, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId);
    }).catch(function (err) {
      console.error('Error: ' + JSON.stringify(err));
      throw err;
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
        console.error('Failed to list to topic. Error: ' + JSON.stringify(err));
        reject(err);
      } else {
        var foundTopic = lodash.find(data.Topics, function (o) {
          return o.TopicArn === topicName;
        });
        if (!lodash.isUndefined(foundTopic)) {
          resolve();
        } else {
          var createParams = {
            Name: topicName
          };

          snsClient.createTopic(createParams, function (err, data) {
            if (err) {
              console.error('Failed to create to topic. Error ' + JSON.stringify(err));
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
 * @param config
 * @param functionArn
 * @param topicName
 * @param currentTopicNameArn
 * @param currentTopicStatementId
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _subscribeLambdaToTopic = function _subscribeLambdaToTopic(lambdaClient, snsClient, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId) {
  return new Bluebird(function (resolve, reject) {

    var subParams = {
      Protocol: 'lambda',
      Endpoint: functionArn,
      TopicArn: currentTopicNameArn
    };

    snsClient.subscribe(subParams, function (err, data) {
      if (err) {
        console.error('Failed to subscribe to topic. [Topic Name: ' + topicName + '] [TopicArn: ' + subParams.TopicArn + '] [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else {
        var removePermissionParams = {
          FunctionName: config.functionName,
          StatementId: currentTopicStatementId
        };
        lambdaClient.removePermission(removePermissionParams, function (err, data) {
          if (err && err.StatusCode === 404) {
            console.error('Permission does not exist. [Error: ' + JSON.stringify(err) + ']');
          } else if (err && err.statusCode !== 404) {
            console.error('Unable to delete permission. [Error: ' + JSON.stringify(err) + ']');
          } else {
            console.log('Permission deleted successfully! [Data: ' + JSON.stringify(data) + ']');
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
              console.error('Failed to add permission. [Error: ' + JSON.stringify(err) + ']');
              reject(err);
            } else {
              console.log('Succeeded in adding permission. [Data: ' + JSON.stringify(data) + ']');
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
 * @param config
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _publishLambdaVersion = function _publishLambdaVersion(lambdaClient, config) {
  return _publishVersion(lambdaClient, config).then(function () {
    return _listVersionsByFunction(lambdaClient, config);
  }).then(function (listVersionsResult) {

    var versionsToDelete = [];
    var last = listVersionsResult.Versions[listVersionsResult.Versions.length - 1].Version;
    for (var index = 0; index < listVersionsResult.Versions.length; ++index) {
      var version = listVersionsResult.Versions[index].Version;
      if (version !== "$LATEST" && version !== last) {
        versionsToDelete.push(_deleteLambdaFunctionVersion(lambdaClient, config, version));
      }
    }

    return Bluebird.all(versionsToDelete);
  });
};

/**
 *
 * @param lambdaClient
 * @param config
 * @returns {Promise}
 * @private
 */
var _publishVersion = function _publishVersion(lambdaClient, config) {
  return new Bluebird(function (resolve, reject) {
    var publishVersionParams = { FunctionName: config.functionName };

    lambdaClient.publishVersion(publishVersionParams, function (err, data) {
      if (err) {
        console.error('Error Publishing Version. [Error: ' + JSON.stringify(err) + ']');
        reject(err);
      } else {
        console.log('Successfully published version. [Data: ' + JSON.stringify(data) + ']');
        resolve(data);
      }
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param config
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _listVersionsByFunction = function _listVersionsByFunction(lambdaClient, config) {
  return new Bluebird(function (resolve, reject) {
    var listVersionsParams = { FunctionName: config.functionName };
    lambdaClient.listVersionsByFunction(listVersionsParams, function (listErr, data) {
      if (listErr) {
        console.error('Error Listing Versions for Lambda Function. [Error: ' + JSON.stringify(listErr) + ']');
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
 * @param config
 * @param version
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _deleteLambdaFunctionVersion = function _deleteLambdaFunctionVersion(lambdaClient, config, version) {
  return new Bluebird(function (resolve) {

    var deleteFunctionParams = {
      FunctionName: config.functionName,
      Qualifier: version
    };

    lambdaClient.deleteFunction(deleteFunctionParams, function (err, data) {
      if (err) {
        console.error('Failed to delete lambda version. [FunctionName: ' + config.functionName + '] [Version: ' + version + ']');
      } else {
        console.log('Successfully deleted lambda version. [FunctionName: ' + config.functionName + '] [Version: ' + version + ']');
      }
      resolve();
    });
  });
};

/**
 *
 * @param lambdaClient
 * @param cloudWatchLogsClient
 * @param config
 * @param params
 * @returns {*}
 * @private
 */
var _attachLogging = function _attachLogging(lambdaClient, cloudWatchLogsClient, config, params) {
  if (!config.logging) {
    return Promise.resolve('no logging to attach');
  }
  return _addLoggingLambdaPermissionToLambda(lambdaClient, config).then(function () {
    return _updateCloudWatchLogsSubscription(cloudWatchLogsClient, config, params);
  }).catch(function (err) {
    var parsedStatusCode = lodash.get(err, 'statusCode', '');
    console.error('Error occurred in _attachLogging. [StatusCode: ' + parsedStatusCode + ']');
    if (parsedStatusCode !== 429 && err.statusCode !== '429') {
      console.error('Received a non-retry throttle error');
      throw new retry.StopError('Recieved non-retry throttle error.  [Error: ' + JSON.stringify(err) + ']');
    }
  });
};

/**
 *
 * @param lambdaClient
 * @param config
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _addLoggingLambdaPermissionToLambda = function _addLoggingLambdaPermissionToLambda(lambdaClient, config) {
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
          console.log('Lambda function already contains loggingIndex [Function: ' + permissionParams.FunctionName + '] [Permission StatementId: ' + permissionParams.StatementId + ']');
          resolve();
        } else {
          console.error('Error Adding Logging Permission to Lambda. [Error: ' + JSON.stringify(err) + ']', err.stack);
          reject(err);
        }
      } else {
        console.log(JSON.stringify(data, null, 2));
        resolve();
      }
    });
  });
};

/**
 *
 * @param cloudWatchLogsClient
 * @param config
 * @param params
 * @returns {bluebird|exports|module.exports}
 * @private
 */
var _updateCloudWatchLogsSubscription = function _updateCloudWatchLogsSubscription(cloudWatchLogsClient, config, params) {
  return new Bluebird(function (resolve, reject) {
    var cloudWatchParams = {
      destinationArn: config.logging.Arn, /* required */
      filterName: 'LambdaStream_' + params.FunctionName,
      filterPattern: '',
      logGroupName: '/aws/lambda/' + params.FunctionName
    };
    console.log('Function Name: ' + params.FunctionName);
    console.log('Filter Name: ' + cloudWatchParams.filterName);
    console.log('Log Group Name: ' + cloudWatchParams.logGroupName);
    cloudWatchLogsClient.putSubscriptionFilter(cloudWatchParams, function (err, data) {
      if (err) {
        if (err.message.match(/The specified log group does not exist./i)) {
          //this error shouldn't stop the deploy since its due to the lambda having never been executed in order to create the log group in Cloud Watch Logs,
          // so we are going to ignore this error
          // ..we should recover from this by creating the log group or it will be resolved on next execution after the lambda has been run once
          console.error('Failed to add subscription filter to lambda due it log group not existing.  [LogGroupName: ' + cloudWatchParams.logGroupName + '][FilterName: ' + cloudWatchParams.filterName + ']');
          resolve();
        } else {
          console.error('Failed To Add Mapping For Logger. [Error: ' + JSON.stringify(err) + ']');
          reject(err);
        }
      } else {
        console.log('Successfully added subscription Filter. [LogGroupName: ' + cloudWatchParams.logGroupName + '][FilterName: ' + cloudWatchParams.filterName + '] [Response: ' + JSON.stringify(data) + ']');
        resolve();
      }
    });
  });
};

module.exports = nodeAwsLambda;
//# sourceMappingURL=index.js.map
