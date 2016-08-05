const fs = require('fs');
const AWS = require('aws-sdk');
const extend = require('util')._extend;
const async = require('async');
const HttpsProxyAgent = require('https-proxy-agent');
const Bluebird = require('bluebird');
const retry = require('bluebird-retry');
const lodash = require('lodash');

const LAMBDA_RUNTIME = 'nodejs4.3';

const nodeAwsLambda = () => {
  return this;
};

nodeAwsLambda.prototype.deploy = (codePackage, config, lambdaClient) => {
  return deployLambdaFunction(codePackage, config, lambdaClient);
};

/**
 * deploys a lambda, creates a rule, and then binds the lambda to the rule by creating a target
 * @param {file} codePackage a zip of the collection
 * @param {object} config note: should include the rule property that is an object of: {name, scheduleExpression, isEnabled, role, targetInput} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @param lambdaClient
 *
 */
function deployScheduleLambda(codePackage, config, lambdaClient) {
  let functionArn = '';

  return deployLambdaFunction(codePackage, config, lambdaClient)
      .then(result => {
        functionArn = result.functionArn;

        if (!config.hasOwnProperty('rule') &&
            (!config.rule.hasOwnProperty('name') ||
             !config.rule.hasOwnProperty('scheduleExpression') ||
             !config.rule.hasOwnProperty('isEnabled') ||
             !config.rule.hasOwnProperty('role'))){
          throw new Error('rule is required. Please include a property called rule that is an object which has the following: {name, scheduleExpression, isEnabled, role}');
        }

       return createCloudWatchEventRuleFunction(config.rule);
      }).then(eventResult => {
        let targetInput = config.rule.targetInput ? JSON.stringify(config.rule.targetInput) : null;
        return createCloudWatchTargetsFunction({Rule: config.rule.name, Targets: [{Id: `${config.functionName}-${config.rule.name}`, Arn: functionArn, Input: targetInput}]})
      }).catch((err) => {
        console.error(`Error: ${JSON.stringify(err)}`);
        throw err;
      });
}

/**
 * creates a rule
 * @param {object} config should include the rule property that is an object of: {name, scheduleExpression, isEnabled, role, targetInput} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 */
function createCloudWatchEventRule(config){
  return createCloudWatchEventRuleFunction(config)
      .catch((err) => {
        console.error(`Error: ${JSON.stringify(err)}`);
        throw err;
      });
}

/**
 * sets up a target, which creates the binding of a arn to a cloud watch event rule
 * @param {object} config {Rule, Targets} Rule is string (name of the rule, Targets is an array of {Arn *required*, Id *required*, Input, InputPath}. Arn of source linked to target, Id is a unique name for the target, Input the json
 */
function createCloudWatchTargets(config){
  return createCloudWatchTargetsFunction(config)
      .catch((err) => {
        console.error(`Error: ${JSON.stringify(err)}`);
        throw true;
      });
}

let deployLambdaFunction = function(codePackage, config, lambdaClient){
  let functionArn = '';
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
      region: 'region' in config ? config.region : 'us-east-1',
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : '',
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ''
    });

    console.log(`Access Key Id From Deployer: ${config.accessKeyId}`);
  }

  let snsClient = new AWS.SNS({
    region: 'region' in config ? config.region : 'us-east-1',
    accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
    secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
  });

  let cloudWatchLogsClient = new AWS.CloudWatchLogs({
    region: 'region' in config ? config.region : 'us-east-1',
    accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
    secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
  });

  let params = {
    FunctionName: config.functionName,
    Description: config.description,
    Handler: config.handler,
    Role: config.role || 'arn:aws:iam::677310820158:role/lambda_basic_execution',
    Timeout: config.timeout || 10,
    MemorySize: config.memorySize || 128,
    Runtime: config.runtime || LAMBDA_RUNTIME
  };

  return getLambdaFunction(lambdaClient, params.FunctionName)
      .then((getResult) => {
        if (!getResult.lambdaExists) {
          return createLambdaFunction(lambdaClient, codePackage, params)
              .then((createFunctionResult) => {
                functionArn = createFunctionResult.functionArn;
              })
              .then(() => updateEventSource(lambdaClient, config))
              .then(() => updatePushSource(lambdaClient, snsClient, config, functionArn))
              .then(() => {
                let localAttachLoggingFunction = () => {return attachLogging(lambdaClient, cloudWatchLogsClient, config, params)};
                return retry(localAttachLoggingFunction, {max_tries: 3, interval: 1000, backoff: 500});
              })
              .catch((err) => {
                console.error(`Error: ${JSON.stringify(err)}`);
                throw err;
              });
        }else {
          let existingFunctionArn = getResult.functionArn;
          return updateLambdaFunction(lambdaClient, codePackage, params)
              .then(() => updateEventSource(lambdaClient, config))
              .then(() => updatePushSource(lambdaClient, snsClient, config, existingFunctionArn))
              .then(() => publishLambdaVersion(lambdaClient, config))
              .then(() => {
                let localAttachLoggingFunction = () => {return attachLogging(lambdaClient, cloudWatchLogsClient, config, params)};
                return retry(localAttachLoggingFunction, {max_tries: 3, interval: 1000, backoff: 500});
              })
              .catch((err) => {
                console.error(`Error: ${JSON.stringify(err)}`);
                throw err;
              });
        }
      })
      .catch((err) => {
        console.error(`Error: ${JSON.stringify(err)}`);
        throw err;
      });
};

/**
 * Creates or Updates rules, this means you can disable or enable the state of this
 * @param {object} config {name, scheduleExpression, isEnabled, role} scheduleExpression is a duration, you can write it like so: 'cron(0 20 * * ? *)', 'rate(5 minutes)'. Note if using rate, you can also have seconds, minutes, hours. isEnabled true or false
 * @returns {Promise<object>|Promise<Error>}
 * @private
 */
const createCloudWatchEventRuleFunction = function (config) {
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
    Role: config.role || 'arn:aws:iam::677310820158:role/lambda_basic_execution',
    State: config.isEnabled ? 'ENABLED' : 'DISABLED'
  };

  let cloudWatchEvents = new AWS.CloudWatchEvents({
    region: 'region' in config ? config.region : 'us-east-1',
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

const createCloudWatchTargetsFunction = function(config) {
  let cloudWatchEvents = new AWS.CloudWatchEvents({
    region: 'region' in config ? config.region : 'us-east-1',
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
 * @param functionName
 * @returns {bluebird|exports|module.exports}
 * Resolved Object:
 * lambdaExists - boolean flag that is true if lambda exists
 * functionArn - this is a string that contains arn to the lambda function
 * @private
 */
const getLambdaFunction = function (lambdaClient, functionName) {
  return new Bluebird((resolve, reject) => {
    let getFunctionParams = {
      FunctionName: functionName
    };

    lambdaClient.getFunction(getFunctionParams, function (err, data) {
      if (err && err.statusCode !== 404) {
        console.log(`AWS API request failed. Check your AWS credentials and permissions. [Error: ${JSON.stringify(err)}]`);
        reject(err);
      }
      else if (err && err.statusCode === 404) {
        console.log(`Lambda not found. [LambdaName: ${functionName}]`);
        resolve({lambdaExists: false});
      }
      else {
        console.log(`Lambda found! [LambdaName: ${functionName}]`);
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
const createLambdaFunction = function (lambdaClient, codePackage, params) {
  return new Bluebird((resolve, reject) => {
    console.log(`Creating LambdaFunction. [FunctionName: ${params.FunctionName}]`);
    let data = fs.readFileSync(codePackage);

    params.Code = {ZipFile: data};
    lambdaClient.createFunction(params, function (err, data) {
      if (err) {
        console.erroor(`Create function failed. Check your iam:PassRole permissions. [Error: ${JSON.stringify(err)}]`);
        reject(err);
      } else {
        console.log(`Created Lambda successfully. [Data: ${JSON.stringify(data)}]`);
        resolve({functionArn: data.FunctionArn});
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
const updateLambdaFunction = function (lambdaClient, codePackage, params) {
  return new Bluebird((resolve, reject) => {
    console.log(`Updating LambdaFunction. [FunctionName: ${params.FunctionName}]`);
    let data = fs.readFileSync(codePackage);

    let updateFunctionParams = {
      FunctionName: params.FunctionName,
      ZipFile: data,
      Publish: false
    };

    lambdaClient.updateFunctionCode(updateFunctionParams, function (err, data) {
      if (err) {
        console.lerror(`UpdateFunction Error: ${JSON.stringify(err)}`);
        reject(err);
      } else {
        lambdaClient.updateFunctionConfiguration(params, function (err, data) {
          if (err) {
            console.error(`UpdateFunctionConfiguration Error: ${JSON.stringify(err)}`);
            reject(err);
          } else {
            console.log(`Successfully updated lambda. [FunctionName: ${params.FunctionName}] [Data: ${JSON.stringify(data)}]`);
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
const updateEventSource = function (lambdaClient, config) {
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
        console.error("List event source mapping failed, please make sure you have permission");
        console.error(`error: ${err}`);
        reject(err);
      } else if (data.EventSourceMappings.length === 0) {
        lambdaClient.createEventSourceMapping(localParams, function (err, data) {
          if (err) {
            console.error(`Failed to create event source mapping! Error: ${err}`);
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
            console.error(`Update event source mapping failed. ${err}`);
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
 * @param functionArn
 * @returns {bluebird|exports|module.exports}
 * @private
 */
const updatePushSource = function (lambdaClient, snsClient, config, functionArn) {
  if (!config.pushSource) {
    return Bluebird.resolve(true);
  }

  return Bluebird.each(config.pushSource, (currentTopic, currentIndex, length) => {
    console.log(`Executing Topic ${currentIndex} of ${length}`);
    console.log(`Current Topic: ${JSON.stringify(currentTopic)}`);
    let currentTopicNameArn = currentTopic.TopicArn;
    let currentTopicStatementId = currentTopic.StatementId;
    let topicName = currentTopic.TopicArn.split(':').pop();

    return createTopicIfNotExists(snsClient, topicName)
      .then(() => subscribeLambdaToTopic(lambdaClient, snsClient, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId))
      .catch((err) => {
        console.error(`Error: ${JSON.stringify(err)}`);
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
const createTopicIfNotExists = function (snsClient, topicName) {
  return new Bluebird((resolve, reject) => {
    var listTopicParams = {};

    snsClient.listTopics(listTopicParams, function (err, data) {
      if (err) {
        console.error(`Failed to list to topic. Error: ${JSON.stringify(err)}`);
        reject(err);
      }
      else {
        let foundTopic = lodash.find(data.Topics, (o) => o.TopicArn === topicName);
        if (!lodash.isUndefined(foundTopic)) {
          resolve();
        } else {
          let createParams = {
            Name: topicName
          };

          snsClient.createTopic(createParams, function (err, data) {
            if (err) {
              console.error(`Failed to create to topic. Error ${JSON.stringify(err)}`);
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
 * @param config
 * @param functionArn
 * @param topicName
 * @param currentTopicNameArn
 * @param currentTopicStatementId
 * @returns {bluebird|exports|module.exports}
 * @private
 */
const subscribeLambdaToTopic = function (lambdaClient, snsClient, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId) {
  return new Bluebird((resolve, reject) => {

    let subParams = {
      Protocol: 'lambda',
      Endpoint: functionArn,
      TopicArn: currentTopicNameArn
    };

    snsClient.subscribe(subParams, function (err, data) {
      if (err) {
        console.error(`Failed to subscribe to topic. [Topic Name: ${topicName}] [TopicArn: ${subParams.TopicArn}] [Error: ${JSON.stringify(err)}]`);
        reject(err);
      }
      else {
        let removePermissionParams = {
          FunctionName: config.functionName,
          StatementId: currentTopicStatementId
        };
        lambdaClient.removePermission(removePermissionParams, function (err, data) {
          if (err && err.StatusCode === 404) {
            console.error(`Permission does not exist. [Error: ${JSON.stringify(err)}]`);
          }
          else if (err && err.statusCode !== 404) {
            console.error(`Unable to delete permission. [Error: ${JSON.stringify(err)}]`);
          }
          else {
            console.log(`Permission deleted successfully! [Data: ${JSON.stringify(data)}]`);
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
              console.error(`Failed to add permission. [Error: ${JSON.stringify(err)}]`);
              reject(err);
            }
            else {
              console.log(`Succeeded in adding permission. [Data: ${JSON.stringify(data)}]`);
              resolve();
            }
          });
        });
      }
    });
  });
};

const publishLambdaVersion = function (lambdaClient, config) {
  return publishVersion(lambdaClient, config)
    .then(() => listVersionsByFunction(lambdaClient, config))
    .then((listVersionsResult) => {

      let versionsToDelete = [];
      let last = listVersionsResult.Versions[listVersionsResult.Versions.length - 1].Version;
      for (let index = 0; index < listVersionsResult.Versions.length; ++index) {
        let version = listVersionsResult.Versions[index].Version;
        if (version !== "$LATEST" && version !== last) {
          versionsToDelete.push(deleteLambdaFunctionVersion(lambdaClient, config, version));
        }
      }

      return Bluebird.all(versionsToDelete);

    });
};

const publishVersion = function (lambdaClient, config) {
  return new Bluebird((resolve, reject) => {
    let publishVersionParams = {FunctionName: config.functionName};

    lambdaClient.publishVersion(publishVersionParams, function (err, data) {
      if (err) {
        console.error(`Error Publishing Version. [Error: ${JSON.stringify(err)}]`);
        reject(err);
      } else {
        console.log(`Successfully published version. [Data: ${JSON.stringify(data)}]`);
        resolve(data);
      }
    });
  });
};

const listVersionsByFunction = function (lambdaClient, config) {
  return new Bluebird((resolve, reject) => {
    let listVersionsParams = {FunctionName: config.functionName};
    lambdaClient.listVersionsByFunction(listVersionsParams, function (listErr, data) {
      if (listErr) {
        console.error(`Error Listing Versions for Lambda Function. [Error: ${JSON.stringify(listErr)}]`);
        reject(listErr);
      } else {
        resolve(data);
      }
    });
  });
};

const deleteLambdaFunctionVersion = function (lambdaClient, config, version) {
  return new Bluebird((resolve) => {

    let deleteFunctionParams = {
      FunctionName: config.functionName,
      Qualifier: version
    };

    lambdaClient.deleteFunction(deleteFunctionParams, function (err, data) {
      if (err) {
        console.error(`Failed to delete lambda version. [FunctionName: ${config.functionName}] [Version: ${version}]`);
      }
      else {
        console.log(`Successfully deleted lambda version. [FunctionName: ${config.functionName}] [Version: ${version}]`);
      }
      resolve();
    });
  });
};

const attachLogging = function (lambdaClient, cloudWatchLogsClient, config, params) {
  if (!config.logging) {
    return Promise.resolve('no logging to attach');
  }
  return addLoggingLambdaPermissionToLambda(lambdaClient, config)
    .then(() => updateCloudWatchLogsSubscription(cloudWatchLogsClient, config, params))
    .catch(err => {
      let parsedStatusCode = lodash.get(err, 'statusCode', '');
      console.error(`Error occurred in _attachLogging. [StatusCode: ${parsedStatusCode}]`);
      if(parsedStatusCode !== 429 && err.statusCode !== '429') {
        console.error(`Received a non-retry throttle error`);
        throw new retry.StopError(`Recieved non-retry throttle error.  [Error: ${JSON.stringify(err)}]`);
      }
    });
};

const addLoggingLambdaPermissionToLambda = function (lambdaClient, config) {
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
          console.log(`Lambda function already contains loggingIndex [Function: ${permissionParams.FunctionName}] [Permission StatementId: ${permissionParams.StatementId}]`);
          resolve();
        } else {
          console.error(`Error Adding Logging Permission to Lambda. [Error: ${JSON.stringify(err)}]`, err.stack);
          reject(err);
        }
      }
      else {
        console.log(JSON.stringify(data, null, 2));
        resolve();
      }
    });
  });
};

const updateCloudWatchLogsSubscription = function (cloudWatchLogsClient, config, params) {
  return new Bluebird((resolve, reject) => {
    let cloudWatchParams = {
      destinationArn: config.logging.Arn, /* required */
      filterName: `LambdaStream_${params.FunctionName}`,
      filterPattern: '',
      logGroupName: `/aws/lambda/${params.FunctionName}`
    };
    console.log(`Function Name: ${params.FunctionName}`);
    console.log(`Filter Name: ${cloudWatchParams.filterName}`);
    console.log(`Log Group Name: ${cloudWatchParams.logGroupName}`);
    cloudWatchLogsClient.putSubscriptionFilter(cloudWatchParams, (err, data) => {
      if (err) {
        if (err.message.match(/The specified log group does not exist./i)) {
          //this error shouldn't stop the deploy since its due to the lambda having never been executed in order to create the log group in Cloud Watch Logs,
          // so we are going to ignore this error
          // ..we should recover from this by creating the log group or it will be resolved on next execution after the lambda has been run once
          console.error(`Failed to add subscription filter to lambda due it log group not existing.  [LogGroupName: ${cloudWatchParams.logGroupName}][FilterName: ${cloudWatchParams.filterName}]`);
          resolve();
        }
        else {
          console.error(`Failed To Add Mapping For Logger. [Error: ${JSON.stringify(err)}]`);
          reject(err);
        }
      }
      else {
        console.log(`Successfully added subscription Filter. [LogGroupName: ${cloudWatchParams.logGroupName}][FilterName: ${cloudWatchParams.filterName}] [Response: ${JSON.stringify(data)}]`);
        resolve();
      }
    });
  });
};

module.exports = nodeAwsLambda;
