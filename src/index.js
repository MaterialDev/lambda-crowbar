let fs = require('fs');
let AWS = require('aws-sdk');
let extend = require('util')._extend;
let async = require('async');
let HttpsProxyAgent = require('https-proxy-agent');
let Bluebird = require('bluebird');
let __ = require('lodash');

const LAMBDA_RUNTIME = 'nodejs';

export function deployLambda(codePackage, config, logger, lambdaClient, callback) {
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
    Timeout: config.timeout,
    MemorySize: config.memorySize
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
          .then(() => _attachLogging(lambdaClient, cloudWatchLogsClient, logger, config, params))
          .catch((err) => {
            logger(`Error: ${JSON.stringify(err)}`);
            throw true;
          });
      }
      else {
        functionArn = getResult.functionArn;
        return _updateLambdaFunction(lambdaClient, logger, codePackage, params)
          .then(() => _updateEventSource(lambdaClient, config, logger))
          .then(() => _updatePushSource(lambdaClient, snsClient, config, logger, functionArn))
          .then(() => _publishLambdaVersion(lambdaClient, logger, config))
          .then(() => _attachLogging(lambdaClient, cloudWatchLogsClient, logger, config, params))
          .catch((err) => {
            logger(`Error: ${JSON.stringify(err)}`);
            throw true;
          });
      }
    })
    .catch((err) => {
      logger(`Error: ${JSON.stringify(err)}`);
      throw true;
    })
    .asCallback(callback);
}

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
let _getLambdaFunction = function (lambdaClient, logger, functionName) {
  return new Bluebird((resolve, reject) => {
    let getFunctionParams = {
      FunctionName: functionName
    };

    lambdaClient.getFunction(getFunctionParams, function (err, data) {
      if (err && err.statusCode !== 404) {
        logger('AWS API request failed. Check your AWS credentials and permissions.');
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
    logger(`Creating LambdaFunction. [FunctionName: ${params.FunctionName}`);
    let data = fs.readFileSync(codePackage);

    params.Code = {ZipFile: data};
    params.Runtime = LAMBDA_RUNTIME;
    lambdaClient.createFunction(params, function (err, data) {
      if (err) {
        logger('Create function failed. Check your iam:PassRole permissions.');
        reject(err);
      } else {
        logger(`CreateLambda Data: ${JSON.stringify(data)}`);
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
    logger(`Creating LambdaFunction. [FunctionName: ${params.FunctionName}`);
    let data = fs.readFileSync(codePackage);

    let updateFunctionParams = {
      FunctionName: params.FunctionName,
      ZipFile: data,
      Publish: false
    };

    lambdaClient.updateFunctionCode(updateFunctionParams, function (err, data) {
      if (err) {
        logger(`UpdateFunction Error: ${err}`);
        reject(err);
      } else {
        lambdaClient.updateFunctionConfiguration(params, function (err, data) {
          if (err) {
            logger(`UpdateFunctionConfiguration Error: ${err}`);
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

  //for (let topicNameCounter = 0; topicNameCounter < config.pushSource.length; topicNameCounter++) {
  //
  //  let currentTopic = config.pushSource[topicNameCounter];
  //  logger(`Current Topic: ${currentTopic}`);
  //  let currentTopicNameArn = currentTopic.TopicArn;
  //  let currentTopicStatementId = currentTopic.StatementId;
  //  let topicName = currentTopic.TopicArn.split(':').pop();
  //
  //  let subParams = {
  //    Protocol: 'lambda',
  //    Endpoint: functionArn,
  //    TopicArn: currentTopicNameArn
  //  };
  //
  //  _createTopicIfNotExists(snsClient, topicName)
  //    .then(() => _subscribeLambdaToTopic(lambdaClient, snsClient, logger, config, functionArn, topicName, currentTopicNameArn, currentTopicStatementId));

  //var listTopicParams = {};
  //
  //snsClient.listTopics(listTopicParams, function (err, data) {
  //  if (err) {
  //    logger(`Failed to list to topic. Error: ${err}`);
  //    reject(err);
  //  } else {
  //    let foundTopic = __.find(data.Topics, (o) => o.TopicArn === topicName);
  //    if (__.isUndefined(foundTopic)) {
  //      let createParams = {
  //        Name: topicName
  //      };
  //
  //      snsClient.createTopic(createParams, function (err, data) {
  //        if (err) {
  //          logger(`Failed to create to topic. Error ${err}`);
  //          reject(err);
  //        }
  //      });
  //    }
  //  }
  //});


  //snsClient.subscribe(subParams, function (err, data) {
  //  if (err) {
  //    logger(`Failed to subscribe to topic. [Topic Name: ${topicName}] [TopicArn: ${subParams.TopicArn}] [Error: ${err}]`);
  //    reject(err);
  //  } else {
  //    let removePermissionParams = {
  //      FunctionName: config.functionName,
  //      StatementId: currentTopicStatementId
  //    };
  //    lambdaClient.removePermission(removePermissionParams, function (err, data) {
  //      if (err) {
  //        if (err.statusCode !== 404) {
  //          logger(`Unable to delete permission. [Error: ${err}]`);
  //        } else {
  //          logger('Permission does not exist.');
  //        }
  //      }
  //      else {
  //        logger(`Permission deleted successfully! [Data: ${JSON.stringify(data)}]`);
  //      }
  //
  //      let permissionParams = {
  //        FunctionName: config.functionName,
  //        Action: "lambda:InvokeFunction",
  //        Principal: "sns.amazonaws.com",
  //        StatementId: currentTopicStatementId,
  //        SourceArn: currentTopicNameArn
  //      };
  //      lambdaClient.addPermission(permissionParams, function (err, data) {
  //        if (err) {
  //          logger(`Failed to add permission. [Error: ${err}]`);
  //          reject(err);
  //        }
  //        else {
  //          logger(`Succeeded in adding permission. [Data: ${JSON.stringify(data)}]`);
  //        }
  //      });
  //    });
  //  }
  //});
  //  }
  //});
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
        logger(`Failed to list to topic. Error: ${err}`);
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
              logger(`Failed to create to topic. Error ${err}`);
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
        logger(`Failed to subscribe to topic. [Topic Name: ${topicName}] [TopicArn: ${subParams.TopicArn}] [Error: ${err}]`);
        reject(err);
      }
      else {
        let removePermissionParams = {
          FunctionName: config.functionName,
          StatementId: currentTopicStatementId
        };
        lambdaClient.removePermission(removePermissionParams, function (err, data) {
          if (err && err.StatusCode === 404) {
            logger(`Permission does not exist. [Error: ${err}]`);
          }
          else if (err && err.statusCode !== 404) {
            logger(`Unable to delete permission. [Error: ${err}]`);
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
              logger(`Failed to add permission. [Error: ${err}]`);
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
        logger(`Error Publishing Version. [Error: ${err}]`);
        reject(err);
      } else {
        logger(`Successfully published version. [Data: ${data}]`);
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
        logger(`Error Listing Versions for Lambda Function. [Error: ${listErr}]`);
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
  return _addLoggingLambdaPermissionToLambda(lambdaClient, logger, config)
    .then(() => _updateCloudWatchLogsSubscription(cloudWatchLogsClient, logger, config, params));
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
      FunctionName: config.loggingLambdaFunctionName,
      Principal: config.loggingPrincipal,
      StatementId: `${config.loggingLambdaFunctionName}LoggingId`
    };
    lambdaClient.addPermission(permissionParams, (err, data) => {
      if (err) {
        if (err.message.match(/The statement id \(.*?\) provided already exists. Please provide a new statement id, or remove the existing statement./i)) {
          logger(`Lambda function already contains loggingIndex [Function: ${permissionParams.FunctionName}] [Permission StatementId: ${permissionParams.StatementId}]`);
          resolve();
        } else {
          logger(err, err.stack);
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
      destinationArn: config.loggingArn, /* required */
      filterName: `LambdaStream_${params.FunctionName}`,
      filterPattern: '',
      logGroupName: `/aws/lambda/${params.FunctionName}`
    };
    logger(`Function Name: ${params.FunctionName}`);
    logger(`Filter Name: ${cloudWatchParams.filterName}`);
    logger(`Log Group Name: ${cloudWatchParams.logGroupName}`);
    cloudWatchLogsClient.putSubscriptionFilter(cloudWatchParams, (err, data) => {
      if (err) {
        logger(`Failed To Add Mapping For Logger. [Error: ${err}]`);
        reject(err);
      }
      else {
        logger(`Put Subscription Filter. Response: ${JSON.stringify(data)}`);
        resolve();
      }
    });
  });
};

export function deploy(codePackage, config, callback, logger, lambda) {
  let functionArn = '';
  if (!logger) {
    logger = console.log;
  }

  if (!lambda) {
    if ("profile" in config) {
      AWS.config.credentials = new AWS.SharedIniFileCredentials({profile: config.profile});
    }

    if (process.env.HTTPS_PROXY) {
      if (!AWS.config.httpOptions) {
        AWS.config.httpOptions = {};
      }

      AWS.config.httpOptions.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    }

    lambda = new AWS.Lambda({
      region: config.region,
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : '',
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ''
    });

    logger(`Access Key Id From Deployer: ${config.accessKeyId}`);
  }

  let params = {
    FunctionName: config.functionName,
    Description: config.description,
    Handler: config.handler,
    Role: config.role,
    Timeout: config.timeout,
    MemorySize: config.memorySize
  };

  var createFunction = function (callback) {
    fs.readFile(codePackage, function (err, data) {
      if (err) {
        return callback('Error reading specified package "' + codePackage + '"');
      }

      params['Code'] = {ZipFile: data};
      params['Runtime'] = "nodejs";
      lambda.createFunction(params, function (err, data) {
        if (err) {
          let warning = 'Create function failed. ';
          warning += 'Check your iam:PassRole permissions.';
          logger(warning);
          callback(err);
          throw true;
        } else {
          logger(data);
          functionArn = data.FunctionArn;
          updateEventSource(callback);
          updatePushSource(callback);
          attachLogging(callback);
        }
      });
    });
  };

  var updateFunction = function (callback) {
    fs.readFile(codePackage, function (err, data) {
      if (err) {
        return callback(`Error reading specified package '${codePackage}'`);
      }

      lambda.updateFunctionCode({
        FunctionName: params.FunctionName,
        ZipFile: data,
        Publish: false
      }, function (err, data) {
        if (err) {
          logger(err);
          callback(err);
          throw true;
        } else {
          lambda.updateFunctionConfiguration(params, function (err, data) {
            if (err) {
              logger(err);
              callback(err);
              throw true;
            } else {
              updateEventSource(callback);
              updatePushSource(callback);
              publishVersion(callback);
              attachLogging(callback);
            }
          });
        }
      });
    });
  };

  var updatePushSource = function (callback) {
    if (!config.pushSource) {
      callback();
      return;
    }
    var sns = new AWS.SNS({
      region: config.region,
      accessKeyId: 'accessKeyId' in config ? config.accessKeyId : '',
      secretAccessKey: 'secretAccessKey' in config ? config.secretAccessKey : ''
    });
    for (var topicNameCounter = 0; topicNameCounter < config.pushSource.length; topicNameCounter++) {
      logger(config.pushSource[topicNameCounter]);
      var currentTopicNameArn = config.pushSource[topicNameCounter].TopicArn;
      var currentTopicStatementId = config.pushSource[topicNameCounter].StatementId;
      var subParams = {
        Protocol: 'lambda',
        Endpoint: functionArn,
        TopicArn: currentTopicNameArn
      };
      var topicName = config.pushSource[topicNameCounter].TopicArn.split(':').pop();
      var createParams = {
        Name: topicName
      };
      var listTopicParams = {};

      sns.listTopics(listTopicParams, function (err, data) {
        if (err) {
          logger('Failed to list to topic');
          logger(err);
          callback(err);
        } else {
          var topicFound = false;
          for (var index = 0; index < data.Topics.length; index++) {
            if (data.Topics[index].TopicArn == topicName) {
              logger('Topic Found!');
              topicFound = true;
              break;
            }
          }

          if (topicFound === false) {
            sns.createTopic(createParams, function (err, data) {
              if (err) {
                logger('Failed to create to topic');
                logger(err);
                callback(err);
              }
            });
          }
        }
      });
      sns.subscribe(subParams, function (err, data) {
        if (err) {
          logger('failed to subscribe to topic');
          logger('Topic Name');
          logger(subParams.TopicArn);
          logger(err);
          callback(err);
        } else {
          var removePermissionParams = {
            FunctionName: config.functionName,
            StatementId: currentTopicStatementId
          };
          lambda.removePermission(removePermissionParams, function (err, data) {
            if (err) {
              if (err.statusCode !== 404) {
                logger('unable to delete permission');
                logger(err);
              } else {
                logger('permission does not exist');
              }
            }
            else {
              logger(data);
            }
            var permissionParams = {
              FunctionName: config.functionName,
              Action: "lambda:InvokeFunction",
              Principal: "sns.amazonaws.com",
              StatementId: currentTopicStatementId,
              SourceArn: currentTopicNameArn
            };
            lambda.addPermission(permissionParams, function (err, data) {
              if (err) {
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
    }
  };

  var updateEventSource = function (callback) {
    if (!config.eventSource) {
      callback();
      return;
    }

    var params = extend({
      FunctionName: config.functionName
    }, config.eventSource);

    lambda.listEventSourceMappings({
      FunctionName: params.FunctionName,
      EventSourceArn: params.EventSourceArn
    }, function (err, data) {
      if (err) {
        logger("List event source mapping failed, please make sure you have permission");
        callback(err);
      } else {
        if (data.EventSourceMappings.length === 0) {
          lambda.createEventSourceMapping(params, function (err, data) {
            if (err) {
              logger("Failed to create event source mapping!");
              callback(err);
            } else {
              callback();
            }
          });
        } else {
          async.eachSeries(data.EventSourceMappings, function (mapping, iteratorCallback) {
            lambda.updateEventSourceMapping({
              UUID: mapping.UUID,
              BatchSize: params.BatchSize
            }, iteratorCallback);
          }, function (err) {
            if (err) {
              logger('Update event source mapping failed.');
              callback(err);
            }
          });
        }
      }
    });
  };

  var publishVersion = function (callback) {
    lambda.publishVersion({FunctionName: config.functionName}, function (err, data) {
      if (err) {
        logger(err);
      } else {
        logger(data);
        callback();
      }
      lambda.listVersionsByFunction({FunctionName: config.functionName}, function (listErr, data) {
        if (listErr) {
          logger(listErr);
        } else {
          var last = data.Versions[data.Versions.length - 1].Version;
          for (let index = 0; index < data.Versions.length; ++index) {
            let version = data.Versions[index].Version;
            if (version !== "$LATEST" && version !== last) {
              lambda.deleteFunction({
                FunctionName: config.functionName,
                Qualifier: version
              }, function (deleteErr, deleteData) {
                if (deleteErr) {
                  logger(deleteErr);
                }

              });
            }
          }
        }
      });
    });
  };

  var attachLogging = function (callback) {
    // Need to add the permission once, but if it fails the second time no worries.
    let permissionParams = {
      Action: 'lambda:InvokeFunction',
      FunctionName: config.loggingLambdaFunctionName,
      Principal: config.loggingPrincipal,
      StatementId: `${config.loggingLambdaFunctionName}LoggingId`
    };
    lambda.addPermission(permissionParams, (err, data) => {
      if (err) {
        if (err.message.match(/The statement id \(.*?\) provided already exists. Please provide a new statement id, or remove the existing statement./i)) {
          logger(`Lambda function already contains loggingIndex [Function: ${permissionParams.FunctionName}] [Permission StatementId: ${permissionParams.StatementId}]`);
        } else {
          logger(err, err.stack);
        }
      }
      else {
        logger(data);
        callback();
      }
    });
    let cloudWatchLogs = new AWS.CloudWatchLogs({
      region: config.region,
      accessKeyId: "accessKeyId" in config ? config.accessKeyId : "",
      secretAccessKey: "secretAccessKey" in config ? config.secretAccessKey : ""
    });
    let cloudWatchParams = {
      destinationArn: config.loggingArn, /* required */
      filterName: `LambdaStream_${params.FunctionName}`,
      filterPattern: '',
      logGroupName: `/aws/lambda/${params.FunctionName}`
    };
    logger(`Function Name: ${params.FunctionName}`);
    logger(`Filter Name: ${cloudWatchParams.filterName}`);
    logger(`Log Group Name: ${cloudWatchParams.logGroupName}`);
    cloudWatchLogs.putSubscriptionFilter(cloudWatchParams, (err, data) => {
      if (err) {
        logger('Failed To Add Mapping For Logger');
        logger(err);
      }
      else {
        logger(`Put Subscription Filter. Response: ${JSON.stringify(data)}`);
      }
    });
  };

  lambda.getFunction({FunctionName: params.FunctionName}, function (err, data) {
    if (err) {
      if (err.statusCode === 404) {
        createFunction(callback);
      } else {

        let warning = 'AWS API request failed. ';
        warning += 'Check your AWS credentials and permissions.';
        logger(warning);
        callback(err);
        throw true;
      }
    } else {
      logger(data);
      functionArn = data.Configuration.FunctionArn;
      updateFunction(callback);
    }
  });
}
