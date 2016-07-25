let fs = require('fs');
let AWS = require('aws-sdk');
let extend = require('util')._extend;
let async = require('async');
let HttpsProxyAgent = require('https-proxy-agent');
let Bluebird = require('bluebird');
let retry = require('bluebird-retry');
let __ = require('lodash');

const LAMBDA_RUNTIME = 'nodejs4.3';

export function deployLambda(codePackage, config, logger, lambdaClient, callback) {
  return _deployLambdaFunction(codePackage, config, logger, lambdaClient)
    .asCallback(callback);
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
export function deployScheduleLambda(codePackage, config, logger, lambdaClient, callback) {
  let functionArn = '';

  return _deployLambdaFunction(codePackage, config, logger, lambdaClient, callback)
      .then(result => {
        functionArn = result.functionArn;

        if (!config.hasOwnProperty('rule') &&
            (!config.rule.hasOwnProperty('name') ||
             !config.rule.hasOwnProperty('scheduleExpression') ||
             !config.rule.hasOwnProperty('isEnabled') ||
             !config.rule.hasOwnProperty('role'))){
          throw new Error('rule is required. Please include a property called rule that is an object which has the following: {name, scheduleExpression, isEnabled, role}');
        }

       return _createCloudWatchEventRuleFunction(config.rule);
      }).then(eventResult => {
        let targetInput = config.rule.targetInput ? JSON.stringify(config.rule.targetInput) : null;
        return _createCloudWatchTargetsFunction({Rule: config.rule.name, Targets: [{Id: `${config.functionName}-${config.rule.name}`, Arn: functionArn, Input: targetInput}]})
      }).catch((err) => {
        logger(`Error: ${JSON.stringify(err)}`);
        throw true;
      }).asCallback(callback)
}

/**
 * creates a rule
 * @param {object} config should include the rule property that is an object of: {name, scheduleExpression, isEnabled, role, targetInput} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @param {function} callback
 */
export function createCloudWatchEventRule(config, callback){
  return _createCloudWatchEventRuleFunction(config)
      .catch((err) => {
        logger(`Error: ${JSON.stringify(err)}`);
        throw true;
      }).asCallback(callback);
}

/**
 * sets up a target, which creates the binding of a arn to a cloud watch event rule
 * @param {object} config {Rule, Targets} Rule is string (name of the rule, Targets is an array of {Arn *required*, Id *required*, Input, InputPath}. Arn of source linked to target, Id is a unique name for the target, Input the json
 * @param {function} callback
 */
export function createCloudWatchTargets(config, callback){
  return _createCloudWatchTargetsFunction(config)
      .catch((err) => {
        logger(`Error: ${JSON.stringify(err)}`);
        throw true;
      })
      .asCallback(callback)
}

let _deployLambdaFunction = function(codePackage, config, logger, lambdaClient){
  let functionArn = '';
  if (!logger) {
    logger = console.log;
  }
  if (!lambdaClient) {
    if ("profile" in config) {
      AWS.config.credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
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

    logger(`Access Key Id From Deployer: ${config.accessKeyId}`);
  }

  let snsClient = new AWS.SNS({
    region: config.region,
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  let cloudWatchLogsClient = new AWS.CloudWatchLogs({
    region: config.region,
    accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
    secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
  });

  let params = {
    FunctionName: config.functionName,
    Description: config.description,
    Handler: config.handler,
    Role: config.role,
    Timeout: config.timeout || 10,
    MemorySize: config.memorySize || 128,
    Runtime: config.runtime || LAMBDA_RUNTIME
  };

  return _getLambdaFunction(lambdaClient, logger, params.FunctionName)
      .then((getResult) => {
        if (!getResult.lambdaExists) {
          return _createLambdaFunction(lambdaClient, logger, codePackage, params)
              .then((createFunctionResult) => {
                functionArn = createFunctionResult.functionArn;
              })
              .then(() => _updateEventSource(lambdaClient, config, logger))
              .then(() => _updatePushSource(lambdaClient, snsClient, config, logger, functionArn))
              .then(() => {
                let localAttachLoggingFunction = () => {return _attachLogging(lambdaClient, cloudWatchLogsClient, logger, config, params)};
                return retry(localAttachLoggingFunction, {max_tries: 3, interval: 1000, backoff: 500});
              })
              .catch((err) => {
                logger(`Error: ${JSON.stringify(err)}`);
                throw true;
              });
        }else {
          let existingFunctionArn = getResult.functionArn;
          return _updateLambdaFunction(lambdaClient, logger, codePackage, params)
              .then(() => _updateEventSource(lambdaClient, config, logger))
              .then(() => _updatePushSource(lambdaClient, snsClient, config, logger, existingFunctionArn))
              .then(() => _publishLambdaVersion(lambdaClient, logger, config))
              .then(() => {
                let localAttachLoggingFunction = () => {return _attachLogging(lambdaClient, cloudWatchLogsClient, logger, config, params)};
                return retry(localAttachLoggingFunction, {max_tries: 3, interval: 1000, backoff: 500});
              })
              .catch((err) => {
                logger(`Error: ${JSON.stringify(err)}`);
                throw true;
              });
        }
      })
      .catch((err) => {
        logger(`Error: ${JSON.stringify(err)}`);
        throw true;
      });
};

/**
 * Creates or Updates rules, this means you can disable or enable the state of this
 * @param {object} config {name, scheduleExpression, isEnabled, role} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @returns {Promise<object>|Promise<Error>}
 * @private
 */
let _createCloudWatchEventRuleFunction = function (config) {
  /* params
   {Name: 'STRING_VALUE', // required!//
    Description: 'STRING_VALUE',
    EventPattern: 'STRING_VALUE',
    RoleArn: 'STRING_VALUE',
    ScheduleExpression: 'STRING_VALUE',
    State: 'ENABLED | DISABLED' }
  */

  let params = {
    Name: config.name,
    ScheduleExpression: config.scheduleExpression,
    RoleArn: config.role,
    State: config.isEnabled ? 'ENABLED' : 'DISABLED'
  };

  let cloudWatchEvents = new AWS.CloudWatchEvents({
    region: config.region,
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  return new Bluebird((resolve, reject) => {
    cloudWatchEvents.putRule(params, function (err, data) {
      if (err) {
        return reject(err);
      }

      return resolve(data);
    });
  });
};

let _createCloudWatchTargetsFunction = function(config) {
  let cloudWatchEvents = new AWS.CloudWatchEvents({
    region: config.region,
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  //targets[{Id, Arn, Input}] Input is the JSON text sent to target
  return new Bluebird((resolve, reject) => {
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
let _getLambdaFunction = function (lambdaClient, logger, functionName) {
  return new Bluebird((resolve, reject) => {
    let getFunctionParams = {
      FunctionName: functionName
    };

    lambdaClient.getFunction(getFunctionParams, function (err, data) {
      if (err && err.statusCode !== 404) {
        logger(`AWS API request failed. Check your AWS credentials and permissions. [Error: ${JSON.stringify(err)}]`);
        reject(err);
      }
      else if (err && err.statusCode === 404) {
        logger(`Lambda not found. [LambdaName: ${functionName}]`);
        resolve({lambdaExists: false});
      }
      else {
        logger(`Lambda found! [LambdaName: ${functionName}]`);
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
let _createLambdaFunction = function (lambdaClient, logger, codePackage, params) {
  return new Bluebird((resolve, reject) => {
    logger(`Creating LambdaFunction. [FunctionName: ${params.FunctionName}]`);
    let data = fs.readFileSync(codePackage);

    params.Code = {ZipFile: data};
    lambdaClient.createFunction(params, function (err, data) {
      if (err) {
        logger(`Create function failed. Check your iam:PassRole permissions. [Error: ${JSON.stringify(err)}]`);
        reject(err);
      } else {
        logger(`Created Lambda successfully. [Data: ${JSON.stringify(data)}]`);
        resolve({functionArn: data.FunctionArn});
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
let _updateLambdaFunction = function (lambdaClient, logger, codePackage, params) {
  return new Bluebird((resolve, reject) => {
    logger(`Updating LambdaFunction. [FunctionName: ${params.FunctionName}]`);
    let data = fs.readFileSync(codePackage);

    let updateFunctionParams = {
      FunctionName: params.FunctionName,
      ZipFile: data,
      Publish: false
    };

    lambdaClient.updateFunctionCode(updateFunctionParams, function (err, data) {
      if (err) {
        logger(`UpdateFunction Error: ${JSON.stringify(err)}`);
        reject(err);
      } else {
        lambdaClient.updateFunctionConfiguration(params, function (err, data) {
          if (err) {
            logger(`UpdateFunctionConfiguration Error: ${JSON.stringify(err)}`);
            reject(err);
          } else {
            logger(`Successfully updated lambda. [FunctionName: ${params.FunctionName}] [Data: ${JSON.stringify(data)}]`);
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
let _updateEventSource = function (lambdaClient, config, logger) {
  return new Bluebird((resolve, reject) => {
    if (!config.eventSource) {
      resolve();
      return;
    }

    let localParams = extend({
      FunctionName: config.functionName
    }, config.eventSource);

    let getEventSourceMappingsParams = {
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
            logger(`Failed to create event source mapping! Error: ${err}`);
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        async.eachSeries(data.EventSourceMappings, function (mapping, iteratorCallback) {

          let updateEventSourceMappingParams = {
            UUID: mapping.UUID,
            BatchSize: localParams.BatchSize
          };

          lambdaClient.updateEventSourceMapping(updateEventSourceMappingParams, iteratorCallback);
        }, function (err) {
          if (err) {
            logger(`Update event source mapping failed. ${err}`);
            reject(err);
          }
          else {
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
let _updatePushSource = function (lambdaClient, snsClient, config, logger, functionArn) {
  if (!config.pushSource) {
    return Bluebird.resolve(true);
  }

  return Bluebird.each(config.pushSource, (currentTopic, currentIndex, length) => {
    logger(`Executing Topic ${currentIndex} of ${length}`);
    logger(`Current Topic: ${JSON.stringify(currentTopic)}`);
    let currentTopicNameArn = currentTopic.TopicArn;
    let currentTopicStatementId = currentTopic.StatementId;
    let topicName = currentTopic.TopicArn.split(':').pop();

    return _createTopicIfNotExists(snsClient, topicName)
      .then(() => _subscribeLambdaToTopic(lambdaClient, snsClient, logger, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId))
      .catch((err) => {
        logger(`Error: ${JSON.stringify(err)}`);
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
let _createTopicIfNotExists = function (snsClient, topicName) {
  return new Bluebird((resolve, reject) => {
    var listTopicParams = {};

    snsClient.listTopics(listTopicParams, function (err, data) {
      if (err) {
        logger(`Failed to list to topic. Error: ${JSON.stringify(err)}`);
        reject(err);
      }
      else {
        let foundTopic = __.find(data.Topics, (o) => o.TopicArn === topicName);
        if (!__.isUndefined(foundTopic)) {
          resolve();
        } else {
          let createParams = {
            Name: topicName
          };

          snsClient.createTopic(createParams, function (err, data) {
            if (err) {
              logger(`Failed to create to topic. Error ${JSON.stringify(err)}`);
              reject(err);
            }
            else {
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
let _subscribeLambdaToTopic = function (lambdaClient, snsClient, logger, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId) {
  return new Bluebird((resolve, reject) => {

    let subParams = {
      Protocol: 'lambda',
      Endpoint: functionArn,
      TopicArn: currentTopicNameArn
    };

    snsClient.subscribe(subParams, function (err, data) {
      if (err) {
        logger(`Failed to subscribe to topic. [Topic Name: ${topicName}] [TopicArn: ${subParams.TopicArn}] [Error: ${JSON.stringify(err)}]`);
        reject(err);
      }
      else {
        let removePermissionParams = {
          FunctionName: config.functionName,
          StatementId: currentTopicStatementId
        };
        lambdaClient.removePermission(removePermissionParams, function (err, data) {
          if (err && err.StatusCode === 404) {
            logger(`Permission does not exist. [Error: ${JSON.stringify(err)}]`);
          }
          else if (err && err.statusCode !== 404) {
            logger(`Unable to delete permission. [Error: ${JSON.stringify(err)}]`);
          }
          else {
            logger(`Permission deleted successfully! [Data: ${JSON.stringify(data)}]`);
          }

          let permissionParams = {
            FunctionName: config.functionName,
            Action: "lambda:InvokeFunction",
            Principal: "sns.amazonaws.com",
            StatementId: currentTopicStatementId,
            SourceArn: currentTopicNameArn
          };
          lambdaClient.addPermission(permissionParams, function (err, data) {
            if (err) {
              logger(`Failed to add permission. [Error: ${JSON.stringify(err)}]`);
              reject(err);
            }
            else {
              logger(`Succeeded in adding permission. [Data: ${JSON.stringify(data)}]`);
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
let _publishLambdaVersion = function (lambdaClient, logger, config) {
  return _publishVersion(lambdaClient, logger, config)
    .then(() => _listVersionsByFunction(lambdaClient, logger, config))
    .then((listVersionsResult) => {

      let versionsToDelete = [];
      let last = listVersionsResult.Versions[listVersionsResult.Versions.length - 1].Version;
      for (let index = 0; index < listVersionsResult.Versions.length; ++index) {
        let version = listVersionsResult.Versions[index].Version;
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
let _publishVersion = function (lambdaClient, logger, config) {
  return new Bluebird((resolve, reject) => {
    let publishVersionParams = {FunctionName: config.functionName};

    lambdaClient.publishVersion(publishVersionParams, function (err, data) {
      if (err) {
        logger(`Error Publishing Version. [Error: ${JSON.stringify(err)}]`);
        reject(err);
      } else {
        logger(`Successfully published version. [Data: ${JSON.stringify(data)}]`);
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
let _listVersionsByFunction = function (lambdaClient, logger, config) {
  return new Bluebird((resolve, reject) => {
    let listVersionsParams = {FunctionName: config.functionName};
    lambdaClient.listVersionsByFunction(listVersionsParams, function (listErr, data) {
      if (listErr) {
        logger(`Error Listing Versions for Lambda Function. [Error: ${JSON.stringify(listErr)}]`);
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
let _deleteLambdaFunctionVersion = function (lambdaClient, logger, config, version) {
  return new Bluebird((resolve) => {

    let deleteFunctionParams = {
      FunctionName: config.functionName,
      Qualifier: version
    };

    lambdaClient.deleteFunction(deleteFunctionParams, function (err, data) {
      if (err) {
        logger(`Failed to delete lambda version. [FunctionName: ${config.functionName}] [Version: ${version}]`);
      }
      else {
        logger(`Successfully deleted lambda version. [FunctionName: ${config.functionName}] [Version: ${version}]`);
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
let _attachLogging = function (lambdaClient, cloudWatchLogsClient, logger, config, params) {
  if (!config.logging) {
    return Promise.resolve('no logging to attach');
  }
  return _addLoggingLambdaPermissionToLambda(lambdaClient, logger, config)
    .then(() => _updateCloudWatchLogsSubscription(cloudWatchLogsClient, logger, config, params))
    .catch(err => {
      let parsedStatusCode = __.get(err, 'statusCode', '');
      logger(`Error occurred in _attachLogging. [StatusCode: ${parsedStatusCode}]`);
      if(parsedStatusCode !== 429 && err.statusCode !== '429') {
        logger(`Recieved a non-retry throttle error`);
        throw new retry.StopError(`Recieved non-retry throttle error.  [Error: ${JSON.stringify(err)}]`);
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
let _addLoggingLambdaPermissionToLambda = function (lambdaClient, logger, config) {
  return new Bluebird((resolve, reject) => {
    // Need to add the permission once, but if it fails the second time no worries.
    let permissionParams = {
      Action: 'lambda:InvokeFunction',
      FunctionName: config.logging.LambdaFunctionName,
      Principal: config.logging.Principal,
      StatementId: `${config.logging.LambdaFunctionName}LoggingId`
    };
    lambdaClient.addPermission(permissionParams, (err, data) => {
      if (err) {
        if (err.message.match(/The statement id \(.*?\) provided already exists. Please provide a new statement id, or remove the existing statement./i)) {
          logger(`Lambda function already contains loggingIndex [Function: ${permissionParams.FunctionName}] [Permission StatementId: ${permissionParams.StatementId}]`);
          resolve();
        } else {
          logger(`Error Adding Logging Permission to Lambda. [Error: ${JSON.stringify(err)}]`, err.stack);
          reject(err);
        }
      }
      else {
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
let _updateCloudWatchLogsSubscription = function (cloudWatchLogsClient, logger, config, params) {
  return new Bluebird((resolve, reject) => {
    let cloudWatchParams = {
      destinationArn: config.logging.Arn, /* required */
      filterName: `LambdaStream_${params.FunctionName}`,
      filterPattern: '',
      logGroupName: `/aws/lambda/${params.FunctionName}`
    };
    logger(`Function Name: ${params.FunctionName}`);
    logger(`Filter Name: ${cloudWatchParams.filterName}`);
    logger(`Log Group Name: ${cloudWatchParams.logGroupName}`);
    cloudWatchLogsClient.putSubscriptionFilter(cloudWatchParams, (err, data) => {
      if (err) {
        if (err.message.match(/The specified log group does not exist./i)) {
          //this error shouldn't stop the deploy since its due to the lambda having never been executed in order to create the log group in Cloud Watch Logs,
          // so we are going to ignore this error
          // ..we should recover from this by creating the log group or it will be resolved on next execution after the lambda has been run once
          logger(`Failed to add subscription filter to lambda due it log group not existing.  [LogGroupName: ${cloudWatchParams.logGroupName}][FilterName: ${cloudWatchParams.filterName}]`);
          resolve();
        }
        else {
          logger(`Failed To Add Mapping For Logger. [Error: ${JSON.stringify(err)}]`);
          reject(err);
        }
      }
      else {
        logger(`Successfully added subscription Filter. [LogGroupName: ${cloudWatchParams.logGroupName}][FilterName: ${cloudWatchParams.filterName}] [Response: ${JSON.stringify(data)}]`);
        resolve();
      }
    });
  });
};